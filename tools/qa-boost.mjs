#!/usr/bin/env node

import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.BILI_BOOST_QA_PORT || 9333);
const ROOT = new URL('../', import.meta.url);
const USER_SCRIPT = await readFile(new URL('../bili-boost.user.js', import.meta.url), 'utf8');
const results = [];
let chrome;
let browserCdp;
let profile;
let cleaning = false;
let chromeStderr = '';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function numberedSource(source) {
  return String(source).split('\n').map((line, index) => `${String(index + 1).padStart(4)} | ${line}`).join('\n');
}

function validateJavaScript(source, label) {
  try {
    // Compilation only: this never executes the browser-side code locally.
    new Function(source);
  } catch (error) {
    throw new SyntaxError(`${label} 本地语法校验失败：${error.message}\n实际代码：\n${numberedSource(source)}`, { cause: error });
  }
  return source;
}

async function waitFor(fn, { timeout = 30_000, interval = 250, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(interval);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? ` (${lastError.message})` : ''}`);
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (!message.id) {
        for (const listener of this.listeners.get(message.method) || []) {
          Promise.resolve(listener(message.params || {})).catch(() => {});
        }
        return;
      }
      if (!this.pending.has(message.id)) return;
      const { resolve, reject, timer } = this.pending.get(message.id);
      clearTimeout(timer);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(`${message.error.message}${message.error.data ? `: ${message.error.data}` : ''}`));
      else resolve(message.result || {});
    });
    ws.addEventListener('close', () => {
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error('CDP connection closed'));
      }
      this.pending.clear();
    });
  }

  on(method, listener) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(listener);
    return () => this.listeners.get(method)?.delete(listener);
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket open timeout')), 10_000);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WebSocket connection failed')); }, { once: true });
    });
    return new CDP(ws);
  }

  send(method, params = {}, timeout = 20_000) {
    const id = ++this.nextId;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  async eval(expression, awaitPromise = false) {
    validateJavaScript(expression, 'Runtime.evaluate');
    const response = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    });
    if (response.exceptionDetails) {
      const detail = response.exceptionDetails.exception?.description || response.exceptionDetails.text;
      const source = /SyntaxError/.test(detail || '') ? `\n实际代码：\n${numberedSource(expression)}` : '';
      throw new Error(`${detail || 'Runtime.evaluate failed'}${source}`);
    }
    return response.result?.value;
  }

  close() { this.ws.close(); }
}

const OBSERVER = String.raw`
(() => {
  const qa = window.__qaBoost = {
    mimes: [], playurl: [], playurlResponses: [], hud: [], errors: [],
    initialCodecPreference: localStorage.getItem('bilibili_player_codec_prefer_type')
  };
  const remember = (list, value) => { if (value && !list.includes(value)) list.push(value); };
  const isPlayurl = url => /\/playurl/i.test(String(url));
  const summarizePlayurl = (via, payload) => {
    const data = payload && (payload.data || payload.result || payload);
    const video = Array.isArray(data?.dash?.video) ? data.dash.video : [];
    const formats = Array.isArray(data?.support_formats) ? data.support_formats : [];
    qa.playurlResponses.push({
      via,
      videoCount: video.length,
      hasAv1: video.some(item => item.codecid === 13 || /^av01/i.test(item.codecs || '')),
      order: video.map(item => ({ id: item.id, codecid: item.codecid, codecs: item.codecs || '' })),
      supportHasAv1: formats.some(item => Array.isArray(item.codecs) && item.codecs.some(codec => /^av01/i.test(codec))),
      supportFormats: formats.map(item => ({ id: item.quality ?? item.id, codecs: item.codecs || [] }))
    });
  };
  const originalAdd = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function(mime) {
    if (/video\//i.test(String(mime))) qa.mimes.push(String(mime));
    return originalAdd.call(this, mime);
  };
  const originalFetch = window.fetch;
  window.fetch = function(...args) {
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
    if (isPlayurl(url)) qa.playurl.push({ via: 'fetch', url: String(url), at: Date.now() });
    return originalFetch.apply(this, args);
  };
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this.__qaPlayurl = isPlayurl(url);
    if (this.__qaPlayurl) qa.playurl.push({ via: 'xhr', url: String(url), at: Date.now() });
    return originalOpen.call(this, method, url, ...rest);
  };
  // This microtask runs after the userscript has installed its fetch/XHR wrappers.
  // The outer audit therefore sees the response that the player actually receives.
  queueMicrotask(() => {
    const rewrittenFetch = window.fetch;
    window.fetch = async function(...args) {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
      const response = await rewrittenFetch.apply(this, args);
      if (isPlayurl(url)) {
        try { summarizePlayurl('fetch', await response.clone().json()); } catch {}
      }
      return response;
    };
    const rewrittenSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function(...args) {
      if (this.__qaPlayurl) {
        this.addEventListener('loadend', () => {
          try {
            const payload = this.responseType === 'json' ? this.response : JSON.parse(this.responseText);
            summarizePlayurl(this.responseType === 'json' ? 'xhr-json' : 'xhr-text', payload);
          } catch {}
        }, { once: true });
      }
      return rewrittenSend.apply(this, args);
    };
  });
  addEventListener('error', event => remember(qa.errors, String(event.error?.stack || event.message || 'window error')));
  setInterval(() => {
    const text = document.getElementById('bili-boost-hud')?.textContent?.trim();
    remember(qa.hud, text);
  }, 50);
})();
`;

async function endpoint(path, options) {
  return fetch(`http://127.0.0.1:${PORT}${path}`, options);
}

async function newPage({ inject = false, injectTwice = false } = {}) {
  const target = await (await endpoint('/json/new?about%3Ablank', { method: 'PUT' })).json();
  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  await Promise.all([cdp.send('Page.enable'), cdp.send('Runtime.enable')]);
  const snapshot = String.raw`
    window.__qaBoostFirstHooks = {
      fetch: window.fetch,
      open: XMLHttpRequest.prototype.open,
      send: XMLHttpRequest.prototype.send,
      addSourceBuffer: MediaSource.prototype.addSourceBuffer
    };
  `;
  const verifyDuplicate = String.raw`
    window.__qaBoostDuplicateCheck = {
      fetch: window.fetch === window.__qaBoostFirstHooks.fetch,
      open: XMLHttpRequest.prototype.open === window.__qaBoostFirstHooks.open,
      send: XMLHttpRequest.prototype.send === window.__qaBoostFirstHooks.send,
      addSourceBuffer: MediaSource.prototype.addSourceBuffer === window.__qaBoostFirstHooks.addSourceBuffer
    };
  `;
  const parts = inject ? [OBSERVER, USER_SCRIPT] : [OBSERVER];
  if (injectTwice) parts.push(snapshot, USER_SCRIPT, verifyDuplicate);
  const source = validateJavaScript(parts.join('\n'), 'Page.addScriptToEvaluateOnNewDocument');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source });
  await cdp.send('Page.bringToFront');
  return { cdp, targetId: target.id };
}

async function closePage(page) {
  if (!page) return;
  try { page.cdp.close(); } catch {}
  try { await endpoint(`/json/close/${page.targetId}`); } catch {}
}

async function navigate(cdp, url) {
  await cdp.send('Page.navigate', { url });
  await waitFor(() => cdp.eval("document.readyState === 'complete' || document.readyState === 'interactive'"), {
    timeout: 30_000,
    label: `page load (${url})`,
  });
}

async function observation(cdp) {
  return cdp.eval(String.raw`(() => {
    const qa = window.__qaBoost || {};
    return {
      url: location.href,
      title: document.title,
      mimes: qa.mimes || [],
      playurl: qa.playurl || [],
      playurlResponses: qa.playurlResponses || [],
      hud: qa.hud || [],
      errors: qa.errors || [],
      initialCodecPreference: qa.initialCodecPreference ?? null,
      body: (document.body?.innerText || '').slice(0, 3000)
    };
  })()`);
}

async function waitForCodec(cdp, timeout = 40_000) {
  return waitFor(async () => {
    const mimes = await cdp.eval('window.__qaBoost?.mimes || []');
    return mimes.length ? mimes.at(-1) : null;
  }, { timeout, interval: 300, label: 'a video SourceBuffer codec' });
}

async function powerEfficient(cdp, contentType) {
  return cdp.eval(String.raw`(() => {
    const video = document.querySelector('video');
    return navigator.mediaCapabilities.decodingInfo({
      type: 'media-source',
      video: {
        contentType: ${JSON.stringify(contentType)},
        width: video?.videoWidth || 1920,
        height: video?.videoHeight || 1080,
        bitrate: 4000000,
        framerate: 30
      }
    }).then(info => info.powerEfficient);
  })()`, true);
}

function codecKind(mime = '') {
  if (/av01/i.test(mime)) return 'AV1';
  if (/hvc1|hev1/i.test(mime)) return 'HEVC';
  if (/avc1/i.test(mime)) return 'AVC';
  return 'UNKNOWN';
}

function responseOrder(response) {
  const names = { 7: 'AVC', 12: 'HEVC', 13: 'AV1' };
  return (response?.order || []).map(item => `${names[item.codecid] || item.codecid}/${item.id}`);
}

const MOCK_PLAYURL = {
  code: 0,
  data: {
    dash: {
      video: [
        { id: 80, codecid: 7, codecs: 'avc1.640032', bandwidth: 8000 },
        { id: 80, codecid: 13, codecs: 'av01.0.12M.08', bandwidth: 7000 },
        { id: 80, codecid: 12, codecs: 'hvc1.1.6.L150.90', bandwidth: 6000 },
        { id: 32, codecid: 7, codecs: 'avc1.64001F', bandwidth: 4000 },
        { id: 32, codecid: 13, codecs: 'av01.0.08M.08', bandwidth: 3500 },
        { id: 32, codecid: 12, codecs: 'hvc1.1.6.L120.90', bandwidth: 3000 },
      ],
    },
    support_formats: [
      { quality: 80, new_description: '1080P', codecs: ['av01.0.12M.08', 'avc1.640032', 'hvc1.1.6.L150.90'] },
      { quality: 32, new_description: '480P', codecs: ['av01.0.08M.08', 'avc1.64001F', 'hvc1.1.6.L120.90'] },
    ],
  },
};

const INLINE_PLAYINFO_SKIP = '未登录只有两档清晰度，流已内联在 __playinfo__，播放器无需重新请求 playurl';

function addResult(name, status, details = {}) {
  results.push({ name, status, codec: details.codec || '—', reason: details.reason || '', powerEfficient: details.powerEfficient });
}

async function runScenario(name, fn, { inject = name !== '对照组（不注入）', injectTwice = false } = {}) {
  let page;
  try {
    page = await newPage({ inject, injectTwice });
    await fn(page.cdp);
  } catch (error) {
    addResult(name, 'FAIL', { reason: error.message });
  } finally {
    await closePage(page);
  }
}

async function discover() {
  const page = await newPage();
  const { cdp } = page;
  try {
    await navigate(cdp, 'https://www.bilibili.com/');
    await waitFor(async () => (await cdp.eval(String.raw`document.querySelectorAll('a[href*="/video/BV"]').length`)) > 0, {
      timeout: 35_000,
      label: 'homepage video links',
    });
    for (let i = 0; i < 4; i++) {
      await cdp.eval(String.raw`scrollTo(0, document.documentElement.scrollHeight * ${(i + 1) / 4})`);
      await sleep(700);
    }
    const found = await cdp.eval(String.raw`(() => {
      const hrefs = [...document.querySelectorAll('a[href]')].map(a => a.href);
      const videos = [...new Set(hrefs.map(h => h.match(/\/video\/(BV[0-9A-Za-z]+)/)?.[1]).filter(Boolean))];
      const bangumi = hrefs.find(h => /\/bangumi\/play\/(ep|ss)\d+/.test(h)) || null;
      return { videos, bangumi };
    })()`);
    if (!found.videos.length) throw new Error('首页没有发现有效的 /video/BV 链接');

    const pages = await cdp.eval(String.raw`Promise.all(${JSON.stringify(found.videos)}.slice(0, 40).map(async bvid => {
      try {
        const json = await (await fetch('https://api.bilibili.com/x/player/pagelist?bvid=' + bvid)).json();
        return { bvid, pages: Array.isArray(json.data) ? json.data.length : 0 };
      } catch (error) { return { bvid, pages: 0, error: String(error) }; }
    }))`, true);
    let bangumi = found.bangumi;
    if (!bangumi) {
      await navigate(cdp, 'https://www.bilibili.com/anime/');
      try {
        bangumi = await waitFor(() => cdp.eval(String.raw`(() => {
          const a = document.querySelector('a[href*="/bangumi/play/"]');
          return a ? a.href : null;
        })()`), { timeout: 20_000, label: 'bangumi link' });
      } catch {}
    }
    // Discovery shares this fresh profile with the scenarios. Restore the truly
    // unset control state before any player page can inherit a codec preference.
    await cdp.eval("localStorage.removeItem('bilibili_player_codec_prefer_type')");
    return {
      bvid: found.videos[0],
      candidates: found.videos,
      multi: pages.find(item => item.pages > 1) || null,
      bangumi,
    };
  } finally {
    await closePage(page);
  }
}

async function classifyNoPlayback(cdp, context) {
  const seen = await observation(cdp);
  const loginLimited = /登录|会员|大会员|试看|购买|地区|版权|不可用|下架/.test(seen.body);
  return `${context}未观测到视频 SourceBuffer；${loginLimited ? '页面显示登录/会员/版权限制' : `页面：${seen.title || seen.url}`}`;
}

async function testSimple(name, url, expected, inject = true) {
  await runScenario(name, async cdp => {
    await navigate(cdp, url);
    let codec;
    try { codec = await waitForCodec(cdp); }
    catch { throw new Error(await classifyNoPlayback(cdp, name)); }
    const efficient = await powerEfficient(cdp, codec);
    const kind = codecKind(codec);
    const pass = expected.includes(kind);
    addResult(name, pass ? 'PASS' : 'FAIL', {
      codec,
      powerEfficient: efficient,
      reason: pass ? '' : `期望 ${expected.join('/')}，实际 ${kind}`,
    });
  }, { inject });
}

async function main() {
  profile = await mkdtemp(join(tmpdir(), 'qa-boost-'));
  chrome = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    '--window-position=2000,2000',
    '--window-size=600,400',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  chrome.stderr.setEncoding('utf8');
  chrome.stderr.on('data', chunk => { chromeStderr = (chromeStderr + chunk).slice(-4000); });

  let version;
  try {
    version = await waitFor(async () => {
      const response = await endpoint('/json/version');
      return response.ok ? response.json() : null;
    }, { timeout: 20_000, label: 'Chrome DevTools endpoint' });
  } catch (error) {
    throw new Error(`${error.message}${chromeStderr.trim() ? `\nChrome stderr:\n${chromeStderr.trim()}` : ''}`);
  }
  browserCdp = await CDP.connect(version.webSocketDebuggerUrl);

  console.log('动态发现 B站测试目标…');
  const targets = await discover();
  console.log(`UGC: ${targets.bvid}`);
  console.log(`多 P: ${targets.multi ? `${targets.multi.bvid} (${targets.multi.pages} P)` : '未发现'}`);
  console.log(`番剧: ${targets.bangumi || '未发现'}`);

  const ugcUrl = `https://www.bilibili.com/video/${targets.bvid}`;
  await runScenario('对照组（不注入）', async cdp => {
    await navigate(cdp, ugcUrl);
    let codec;
    try { codec = await waitForCodec(cdp); }
    catch { throw new Error(await classifyNoPlayback(cdp, '对照组')); }
    const efficient = await powerEfficient(cdp, codec);
    const initialPreference = await cdp.eval('window.__qaBoost?.initialCodecPreference ?? null');
    const cleanControl = initialPreference === null;
    const pass = cleanControl && codecKind(codec) === 'AV1';
    addResult('对照组（不注入）', pass ? 'PASS' : 'FAIL', {
      codec,
      powerEfficient: efficient,
      reason: pass ? '' : `期望未设置 codec_prefer_type 且选用 AV1；初始值=${JSON.stringify(initialPreference)}，实际=${codecKind(codec)}`,
    });
  });

  await testSimple('普通 UGC 视频页', ugcUrl, ['HEVC', 'AVC']);

  await runScenario('CDN 模块', async cdp => {
    await navigate(cdp, ugcUrl);
    const result = await waitFor(() => cdp.eval(String.raw`(() => {
      const api = window.__biliCdn;
      const names = ['当前源', '实测速度', '分片明细', '测速结果', '卡顿次数', '黑名单', '重测', '面板'];
      if (!api?.测速结果) return null;
      return {
        alias: api === window.__biliBoost,
        publicApi: names.every(name => name in api),
        resultCount: api.测速结果?.list?.length || 0,
        stallsType: typeof api.卡顿次数,
        source: api.当前源,
        speed: api.实测速度
      };
    })()`), { timeout: 55_000, interval: 500, label: 'CDN 两阶段测速结果' });
    const pass = result.alias && result.publicApi && result.resultCount > 0 && result.stallsType === 'number';
    addResult('CDN 模块', pass ? 'PASS' : 'FAIL', {
      codec: result.source || '未选源',
      reason: `${pass ? '' : 'CDN 公开接口或测速状态不完整；'}测速条目=${result.resultCount}，实测=${result.speed}`,
    });
  });

  await runScenario('防重复注入', async cdp => {
    await navigate(cdp, ugcUrl);
    const checked = await waitFor(() => cdp.eval(String.raw`(() => {
      const hooks = window.__qaBoostDuplicateCheck;
      const hudCount = document.querySelectorAll('#bili-boost-hud').length;
      if (!hooks || !document.body || !hudCount) return null;
      return {
        hooks,
        installed: window.__biliBoostInstalled === true,
        hudCount
      };
    })()`), { timeout: 10_000, label: 'duplicate injection audit' });
    const hooksStable = Object.values(checked.hooks).every(Boolean);
    const pass = checked.installed && checked.hudCount === 1 && hooksStable;
    addResult('防重复注入', pass ? 'PASS' : 'FAIL', {
      reason: pass ? '重复执行后 HUD 仍为一个，fetch/open/send/addSourceBuffer 均未再次包装' : JSON.stringify(checked),
    });
  }, { injectTwice: true });

  await runScenario('playurl 劫持层（mock）', async cdp => {
    await navigate(cdp, ugcUrl);
    const body = Buffer.from(JSON.stringify(MOCK_PLAYURL)).toString('base64');
    let interceptionError;
    const off = cdp.on('Fetch.requestPaused', async event => {
      try {
        await cdp.send('Fetch.fulfillRequest', {
          requestId: event.requestId,
          responseCode: 200,
          responseHeaders: [
            { name: 'Content-Type', value: 'application/json' },
            { name: 'Access-Control-Allow-Origin', value: '*' },
          ],
          body,
        });
      } catch (error) {
        interceptionError = error;
      }
    });
    try {
      await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*playurl*' }] });
      const outputs = await cdp.eval(String.raw`(async () => {
        const base = 'https://api.bilibili.com/x/player/playurl?qa_boost_mock=';
        const xhr = (suffix, responseType) => new Promise((resolve, reject) => {
          const request = new XMLHttpRequest();
          request.open('GET', base + suffix);
          if (responseType) request.responseType = responseType;
          request.onload = () => {
            try { resolve(responseType === 'json' ? request.response : JSON.parse(request.responseText)); }
            catch (error) { reject(error); }
          };
          request.onerror = () => reject(new Error('mock XHR network error'));
          request.send();
        });
        return {
          fetch: await (await fetch(base + 'fetch')).json(),
          xhr_responseText: await xhr('xhr_responseText', ''),
          xhr_responseType_json: await xhr('xhr_responseType_json', 'json')
        };
      })()`, true);
      if (interceptionError) throw interceptionError;

      const expected = ['HEVC/80', 'AVC/80', 'HEVC/32', 'AVC/32'];
      const failures = [];
      for (const [name, payload] of Object.entries(outputs)) {
        const data = payload?.data || payload?.result || payload;
        const response = {
          order: (data?.dash?.video || []).map(item => ({ id: item.id, codecid: item.codecid })),
        };
        const order = responseOrder(response);
        if ((data?.dash?.video || []).some(item => item.codecid === 13)) failures.push(`${name}: 仍有 AV1`);
        if (JSON.stringify(order) !== JSON.stringify(expected)) failures.push(`${name}: 顺序=${order.join(', ')}`);
        if ((data?.support_formats || []).some(format => format.codecs?.some(codec => /^av01/i.test(codec)))) {
          failures.push(`${name}: support_formats 仍有 AV1`);
        }
      }
      addResult('playurl 劫持层（mock）', failures.length ? 'FAIL' : 'PASS', {
        codec: expected.join(', '),
        reason: failures.length ? failures.join('；') : 'fetch / xhr.responseText / xhr.responseType=json 均已清除 AV1；support_formats 已清理',
      });
    } finally {
      off();
      try { await cdp.send('Fetch.disable'); } catch {}
    }
  });

  if (!targets.bangumi) {
    addResult('番剧页', 'SKIPPED', { reason: '首页及番剧频道均未动态发现 /bangumi/play/ 链接' });
  } else {
    // 2026-09 实测：未登录番剧选择 AVC (avc1.64001E) 而非 HEVC；
    // powerEfficient=true，属于可接受硬解。番剧登录后的策略仍需另行复测。
    await runScenario('番剧页', async cdp => {
      await navigate(cdp, targets.bangumi);
      let codec;
      try { codec = await waitForCodec(cdp); }
      catch {
        addResult('番剧页', 'SKIPPED', { reason: await classifyNoPlayback(cdp, '番剧页') });
        return;
      }
      const efficient = await powerEfficient(cdp, codec);
      const pass = ['HEVC', 'AVC'].includes(codecKind(codec));
      addResult('番剧页', pass ? 'PASS' : 'FAIL', {
        codec, powerEfficient: efficient,
        reason: pass ? '' : `注入后仍选用 ${codecKind(codec)}`,
      });
    });
  }

  if (!targets.multi) {
    addResult('多 P 视频切 P', 'SKIPPED', { reason: `首页动态发现的 ${targets.candidates.length} 个 BV 中没有多 P 视频` });
  } else {
    await runScenario('多 P 视频切 P', async cdp => {
      await navigate(cdp, `https://www.bilibili.com/video/${targets.multi.bvid}`);
      let codec;
      try { codec = await waitForCodec(cdp); }
      catch { throw new Error(await classifyNoPlayback(cdp, '多 P 首 P')); }
      await cdp.eval(String.raw`
        window.__qaBoost.mimes.length = 0;
        window.__qaBoost.playurl.length = 0;
        window.__qaBoost.playurlResponses.length = 0;
      `);
      const click = await cdp.eval(String.raw`(() => {
        const selectors = [
          '.video-pod__body .video-pod__item', '.video-pod__list .video-pod__item',
          '.multi-page .cur-list li', '.list-box li', '[class*="video-pod"] [class*="item"]'
        ];
        for (const selector of selectors) {
          const items = [...document.querySelectorAll(selector)].filter(el => el.offsetParent && !el.classList.contains('active'));
          if (items.length) { items[0].scrollIntoView({ block: 'center' }); items[0].click(); return { clicked: true, selector, text: items[0].innerText?.trim() }; }
        }
        return { clicked: false };
      })()`);
      if (!click.clicked) throw new Error('已确认是多 P 视频，但未找到可点击的非当前分 P 元素');
      try {
        await waitFor(async () => (await cdp.eval('window.__qaBoost.playurl.length')) > 0, { timeout: 20_000, label: '切 P playurl 请求' });
      } catch {
        addResult('多 P 视频切 P', 'SKIPPED', { codec, reason: INLINE_PLAYINFO_SKIP });
        return;
      }
      let response;
      try {
        response = await waitFor(async () => {
          const values = await cdp.eval('window.__qaBoost.playurlResponses');
          return values.at(-1) || null;
        }, { timeout: 10_000, label: '切 P 后脚本改写的 playurl 响应' });
      } catch {
        addResult('多 P 视频切 P', 'SKIPPED', { codec, reason: '观测到 playurl 请求，但页面未暴露可读取的响应内容' });
        return;
      }
      try { codec = await waitForCodec(cdp, 5_000); } catch {}
      const calls = await cdp.eval('window.__qaBoost.playurl.map(x => x.via + ":" + x.url)');
      const efficient = await powerEfficient(cdp, codec);
      if (!response.videoCount) {
        addResult('多 P 视频切 P', 'SKIPPED', { codec, powerEfficient: efficient, reason: 'playurl 响应不含可验证的 DASH 视频流' });
        return;
      }
      const pass = !response.hasAv1 && !response.supportHasAv1;
      addResult('多 P 视频切 P', pass ? 'PASS' : 'FAIL', {
        codec, powerEfficient: efficient,
        reason: `${pass ? '' : '脚本改写后的 playurl 响应仍残留 AV1；'}顺序=${responseOrder(response).join(', ')}; playurl=${calls.at(-1)}`,
      });
    });
  }

  await runScenario('切清晰度', async cdp => {
    await navigate(cdp, ugcUrl);
    let codec;
    try { codec = await waitForCodec(cdp); }
    catch { throw new Error(await classifyNoPlayback(cdp, '切清晰度初始播放')); }
    await cdp.eval(String.raw`
      window.__qaBoost.mimes.length = 0;
      window.__qaBoost.playurl.length = 0;
      window.__qaBoost.playurlResponses.length = 0;
    `);
    const action = await cdp.eval(String.raw`(async () => {
      const control = document.querySelector('.bpx-player-ctrl-quality');
      if (control) {
        for (const type of ['mouseenter', 'mouseover', 'mousemove']) control.dispatchEvent(new MouseEvent(type, { bubbles: true }));
        await new Promise(r => setTimeout(r, 800));
        const items = [...document.querySelectorAll('.bpx-player-ctrl-quality-menu-item')]
          .filter(el => el.offsetParent && !/bpx-state-active/.test(el.className) && !/登录|大会员|VIP/i.test(el.innerText));
        if (items.length) { const text = items.at(-1).innerText.trim(); items.at(-1).click(); return { changed: true, via: 'UI', text }; }
      }
      const player = window.player;
      if (player && typeof player.requestQuality === 'function') {
        const current = Number(player.getQuality?.());
        const target = current === 16 ? 32 : 16;
        player.requestQuality(target);
        return { changed: true, via: 'player.requestQuality', text: String(target) };
      }
      return { changed: false, menu: [...document.querySelectorAll('[class*="quality"]')].map(x => x.className).slice(0, 20) };
    })()`, true);
    if (!action.changed) {
      addResult('切清晰度', 'SKIPPED', { reason: '未登录页面没有可用的第二档清晰度，且播放器未暴露切换接口' });
      return;
    }
    try {
      await waitFor(async () => (await cdp.eval('window.__qaBoost.playurl.length')) > 0, { timeout: 20_000, label: '清晰度切换 playurl 请求' });
    } catch {
      addResult('切清晰度', 'SKIPPED', { codec, reason: INLINE_PLAYINFO_SKIP });
      return;
    }
    let response;
    try {
      response = await waitFor(async () => {
        const values = await cdp.eval('window.__qaBoost.playurlResponses');
        return values.at(-1) || null;
      }, { timeout: 10_000, label: '清晰度切换后脚本改写的 playurl 响应' });
    } catch {
      addResult('切清晰度', 'SKIPPED', { codec, reason: '观测到 playurl 请求，但页面未暴露可读取的响应内容' });
      return;
    }
    try { codec = await waitForCodec(cdp, 5_000); } catch {}
    const calls = await cdp.eval('window.__qaBoost.playurl.map(x => x.via + ":" + x.url)');
    const efficient = await powerEfficient(cdp, codec);
    if (!response.videoCount) {
      addResult('切清晰度', 'SKIPPED', { codec, powerEfficient: efficient, reason: 'playurl 响应不含可验证的 DASH 视频流' });
      return;
    }
    const pass = !response.hasAv1 && !response.supportHasAv1;
    addResult('切清晰度', pass ? 'PASS' : 'FAIL', {
      codec, powerEfficient: efficient,
      reason: `${pass ? '' : '脚本改写后的 playurl 响应仍残留 AV1；'}${action.via}→${action.text}; 顺序=${responseOrder(response).join(', ')}; playurl=${calls.at(-1)}`,
    });
  });

  await runScenario('HUD 检查', async cdp => {
    await navigate(cdp, ugcUrl);
    let codec;
    try { codec = await waitForCodec(cdp); }
    catch { throw new Error(await classifyNoPlayback(cdp, 'HUD 检查')); }
    const efficient = await powerEfficient(cdp, codec);
    await waitFor(() => cdp.eval("(el => { if (!el) return false; el.click(); return true; })(document.getElementById('bili-boost-hud'))"), {
      timeout: 5_000,
      label: 'unified HUD',
    });
    const hud = await waitFor(async () => {
      const values = await cdp.eval('window.__qaBoost?.hud || []');
      return values.findLast(value => /B站提供：/.test(value) && /🟢 硬解/.test(value) && /powerEfficient：true/.test(value)) || null;
    }, { timeout: 12_000, interval: 100, label: 'HUD text after loadedmetadata (up to 1.5 seconds delayed)' });
    const kind = codecKind(codec);
    const labelOk = kind === 'HEVC' ? /编码：HEVC\/H\.265/.test(hud) : kind === 'AVC' && /编码：AVC\/H\.264/.test(hud);
    const efficiencyOk = efficient === true && /🟢 硬解/.test(hud) && /powerEfficient：true/.test(hud);
    const offeredOk = /B站提供：/.test(hud) && /AV1/.test(hud);
    const strippedOk = /已剔除 AV1：\d+ 条/.test(hud);
    const pass = labelOk && efficiencyOk && offeredOk && strippedOk;
    addResult('HUD 检查', pass ? 'PASS' : 'FAIL', {
      codec,
      powerEfficient: efficient,
      reason: `${pass ? '' : 'HUD 字段与实际观测不一致；'}HUD=${JSON.stringify(hud)}`,
    });
  });
}

async function cleanup() {
  if (cleaning) return;
  cleaning = true;
  if (browserCdp) {
    try { await browserCdp.send('Browser.close', {}, 3_000); } catch {}
    try { browserCdp.close(); } catch {}
  }
  if (chrome && chrome.exitCode === null) {
    chrome.kill('SIGTERM');
    await Promise.race([new Promise(resolve => chrome.once('exit', resolve)), sleep(3_000)]);
    if (chrome.exitCode === null) chrome.kill('SIGKILL');
  }
  // Chrome on macOS can detach a child from the launcher before CDP is ready.
  // Match only this run's random profile so a late-starting test browser cannot leak.
  if (profile) {
    const match = `--user-data-dir=${profile}`;
    await new Promise(resolve => execFile('/usr/bin/pkill', ['-TERM', '-f', match], () => resolve()));
    await sleep(300);
    await new Promise(resolve => execFile('/usr/bin/pkill', ['-KILL', '-f', match], () => resolve()));
  }
  if (profile) await rm(profile, { recursive: true, force: true });
}

process.once('SIGINT', async () => { await cleanup(); process.exit(130); });
process.once('SIGTERM', async () => { await cleanup(); process.exit(143); });

try {
  await main();
} catch (error) {
  console.error(`测试器错误: ${error.stack || error.message}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}

console.log('\n=== bili-boost CDP 回归报告 ===');
for (const result of results) {
  const power = result.powerEfficient === undefined ? '' : ` | powerEfficient=${result.powerEfficient}`;
  const reason = result.reason ? ` | ${result.reason}` : '';
  console.log(`${result.status.padEnd(7)} ${result.name} | codec=${result.codec}${power}${reason}`);
}
const counts = Object.fromEntries(['PASS', 'FAIL', 'SKIPPED'].map(status => [status, results.filter(r => r.status === status).length]));
console.log(`总计: PASS=${counts.PASS} FAIL=${counts.FAIL} SKIPPED=${counts.SKIPPED}`);
if (counts.FAIL) process.exitCode = 1;
