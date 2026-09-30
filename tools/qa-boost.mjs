#!/usr/bin/env node

import { execFile, execFileSync, spawn } from 'node:child_process';
// 用户 2026-09-27：Mac 上开 Chrome 播视频太吵 → 在 macOS 上直接转交 tools/qa-on-win.sh 在 Win 台式机跑。
// 确需在 Mac 本机跑时设 BILI_BOOST_QA_ALLOW_MAC=1。
if (process.platform === 'darwin' && process.env.BILI_BOOST_QA_ALLOW_MAC !== '1') {
  const { spawnSync } = await import('node:child_process');
  console.error('[qa-boost] macOS：转到 Win 台式机运行（tools/qa-on-win.sh）；本机强制运行请设 BILI_BOOST_QA_ALLOW_MAC=1');
  const r = spawnSync(new URL('./qa-on-win.sh', import.meta.url).pathname, [], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Chrome 路径：BILI_BOOST_QA_CHROME 优先，否则按平台取默认安装位置（Win 上由 tools/qa-on-win.sh 调用）
const CHROME = process.env.BILI_BOOST_QA_CHROME || (process.platform === 'win32'
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
// BILI_BOOST_QA_HEADLESS=1：无窗口运行（ssh 远程会话没有桌面时用）
const HEADLESS = process.env.BILI_BOOST_QA_HEADLESS === '1';
const PORT = Number(process.env.BILI_BOOST_QA_PORT || 9333);
const ROOT = new URL('../', import.meta.url);
const ROOT_PATH = fileURLToPath(ROOT);
const USER_SCRIPT = await readFile(new URL('../bili-boost.user.js', import.meta.url), 'utf8');
let LEGACY_CDN_SCRIPT = null;
// 远程机器没有 git 时（Win），由 tools/qa-on-win.sh 预先取出旧脚本并用环境变量传路径
if (process.env.BILI_BOOST_QA_LEGACY) {
  try { LEGACY_CDN_SCRIPT = await readFile(process.env.BILI_BOOST_QA_LEGACY, 'utf8'); } catch {}
} else try {
  LEGACY_CDN_SCRIPT = execFileSync('git', ['show', 'bb6d614:bili-cdn-fix.user.js'], {
    cwd: ROOT_PATH,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
} catch {}
const results = [];
let chrome;
let browserCdp;
let profile;
let cleaning = false;
let chromeStderr = '';
const qaStartedAt = Date.now();

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
    this.closedPromise = new Promise(resolve => { this.resolveClosed = resolve; });
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
      this.resolveClosed();
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
      const cleanup = () => {
        clearTimeout(timer);
        ws.removeEventListener('open', onOpen);
        ws.removeEventListener('error', onError);
      };
      const onOpen = () => { cleanup(); resolve(); };
      const onError = () => {
        cleanup();
        try { ws.close(); } catch {}
        reject(new Error('WebSocket connection failed'));
      };
      const timer = setTimeout(() => {
        cleanup();
        try { ws.close(); } catch {}
        reject(new Error('WebSocket open timeout'));
      }, 10_000);
      ws.addEventListener('open', onOpen);
      ws.addEventListener('error', onError);
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

  async close(timeout = 1_000) {
    try {
      if (this.ws.readyState < 2) this.ws.close();
    } catch {}
    await Promise.race([this.closedPromise, sleep(timeout)]);
  }
}

const OBSERVER = String.raw`
(() => {
  const qa = window.__qaBoost = {
    mimes: [], playurl: [], playurlResponses: [], hud: [], errors: [], warnings: [],
    initialCodecPreference: localStorage.getItem('bilibili_player_codec_prefer_type')
  };
  const remember = (list, value) => { if (value && !list.includes(value)) list.push(value); };
  const originalWarn = console.warn;
  console.warn = function(...args) {
    qa.warnings.push(args.map(value => String(value)).join(' '));
    return originalWarn.apply(this, args);
  };
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

async function newPage({ inject = false, injectTwice = false, legacyOrder = null, beforeObserver = '', prelude = '' } = {}) {
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
  const parts = [];
  // 对照页的存储清理必须早于 Observer，才能记录真正的初始状态；prelude 则仍在
  // Observer 之后、用户脚本之前执行，用于模拟其他浏览器的 API 形态。
  if (beforeObserver) parts.push(beforeObserver);
  parts.push(OBSERVER);
  // prelude 在观测器之后、用户脚本之前执行，用于模拟其他浏览器的 API 形态。
  if (prelude) parts.push(prelude);
  if (inject) {
    if (legacyOrder === 'before' && LEGACY_CDN_SCRIPT) parts.push(LEGACY_CDN_SCRIPT);
    parts.push(USER_SCRIPT);
    if (legacyOrder === 'after' && LEGACY_CDN_SCRIPT) parts.push(LEGACY_CDN_SCRIPT);
  }
  if (injectTwice) parts.push(snapshot, USER_SCRIPT, verifyDuplicate);
  const source = validateJavaScript(parts.join('\n'), 'Page.addScriptToEvaluateOnNewDocument');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source });
  await cdp.send('Page.bringToFront');
  return { cdp, targetId: target.id };
}

async function closePage(page) {
  if (!page) return;
  try { await endpoint(`/json/close/${page.targetId}`); } catch {}
  try { await page.cdp.close(); } catch {}
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
      warnings: qa.warnings || [],
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

function liveCodecPolicy(av1Hardware, kind, policy) {
  const allowed = av1Hardware ? ['AV1', 'HEVC', 'AVC'] : ['HEVC', 'AVC'];
  const policyOk = policy.hardware === (av1Hardware ? '有' : '无') &&
    (av1Hardware ? /有 AV1 硬解 → 不干预/.test(policy.mode) : /无 AV1 硬解 → 剔除 AV1/.test(policy.mode));
  return { allowed, pass: allowed.includes(kind) && policyOk };
}

function responseOrder(response) {
  const names = { 7: 'AVC', 12: 'HEVC', 13: 'AV1' };
  return (response?.order || []).map(item => `${names[item.codecid] || item.codecid}/${item.id}`);
}

function segmentClassifierBenchmark() {
  const urls = Array.from({ length: 20_000 }, (_, index) => index % 10
    ? `https://api.bilibili.com/x/player/wbi/playurl?cid=${index}&qn=32`
    : `https://upos-sz-mirror08c.bilivideo.com/video/${index}/seg-${index}.m4s?deadline=1`);
  const oldClassifier = raw => {
    const url = new URL(raw);
    return /(^|\.)((upos-[a-z0-9-]+\.bilivideo\.com)|(upos-[a-z0-9-]+\.akamaized\.net))$/.test(url.hostname) &&
      /\.(m4s|mp4|flv)$/.test(url.pathname);
  };
  const fastClassifier = raw => {
    const end = raw.indexOf('?') < 0 ? raw.length : raw.indexOf('?');
    const tail = raw.slice(Math.max(0, end - 5), end).toLowerCase();
    if (!tail.endsWith('.m4s') && !tail.endsWith('.mp4') && !tail.endsWith('.flv')) return false;
    const url = new URL(raw);
    return url.hostname.startsWith('upos-') &&
      (url.hostname.endsWith('.bilivideo.com') || url.hostname.endsWith('.akamaized.net'));
  };
  const run = classifier => {
    let count = 0;
    const started = performance.now();
    for (let round = 0; round < 10; round++) for (const url of urls) count += Number(classifier(url));
    return { ms: performance.now() - started, count };
  };
  run(oldClassifier); run(fastClassifier);
  const old = run(oldClassifier);
  const fast = run(fastClassifier);
  return { old, fast, ratio: old.ms / fast.ms };
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
const RESET_CODEC_PREFERENCE = String.raw`
  try { localStorage.removeItem('bilibili_player_codec_prefer_type'); } catch {}
`;
const RESET_CODEC_AUTO = String.raw`
  try {
    localStorage.setItem('bhw_codec', JSON.stringify('auto'));
    localStorage.setItem('bhw_av1hw', 'null');
    localStorage.removeItem('bilibili_player_codec_prefer_type');
  } catch {}
`;
function codecAutoCacheSetup(av1Hardware) {
  return String.raw`
    try {
      const env = [navigator.userAgent || '', navigator.platform || '', navigator.hardwareConcurrency || ''].join('|');
      localStorage.setItem('bhw_codec', JSON.stringify('auto'));
      localStorage.setItem('bhw_av1hw', JSON.stringify({ value: ${Boolean(av1Hardware)}, at: Date.now(), env }));
      localStorage.removeItem('bilibili_player_codec_prefer_type');
    } catch {}
  `;
}
function codecProbePrelude(av1Hardware) {
  return String.raw`
    (() => {
      const original = navigator.mediaCapabilities.decodingInfo.bind(navigator.mediaCapabilities);
      Object.defineProperty(navigator.mediaCapabilities, 'decodingInfo', {
        configurable: true,
        value(config) {
          if (/av01/i.test(config?.video?.contentType || '')) {
            return Promise.resolve({ supported: true, smooth: true, powerEfficient: ${Boolean(av1Hardware)} });
          }
          return original(config);
        }
      });
    })();
  `;
}
const HEALTH_BOUNDARY_SETUP = String.raw`
  try {
    const now = Date.now();
    const hosts = {};
    for (let i = 0; i < 32; i++) hosts['upos-qa-history-' + i + '.bilivideo.com'] = {
      attempts: 1, successes: 1, kbps: 100 + i, ttfb: 10 + i, at: now - i
    };
    localStorage.setItem('bhw_health', JSON.stringify({ version: 2, updatedAt: now, hosts }));
    window.__qaHealthMax = 32;
    window.__qaHealthWatch = setInterval(() => {
      const count = window.__biliBoost?.诊断状态?.health;
      if (Number.isFinite(count)) window.__qaHealthMax = Math.max(window.__qaHealthMax, count);
    }, 10);
  } catch {}
`;
const FALLBACK_MULTI_BVIDS = ['BV1kqaN6NEh3', 'BV1JXbV6jEA3'];
const FALLBACK_BANGUMI_URLS = [
  'https://www.bilibili.com/bangumi/play/ep6319566',
  'https://www.bilibili.com/bangumi/play/ep6256501',
  'https://www.bilibili.com/bangumi/play/ep3537948',
];
const MAX_LIVE_ATTEMPTS = 3;

function addResult(name, status, details = {}) {
  results.push({ name, status, codec: details.codec || '—', reason: details.reason || '', powerEfficient: details.powerEfficient });
}

async function runScenario(name, fn, {
  inject = name !== '对照组（不注入）', injectTwice = false, legacyOrder = null,
  beforeObserver = '', prelude = '', attempts = 1,
} = {}) {
  const errors = [];
  const resultCount = results.length;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let page;
    try {
      page = await newPage({ inject, injectTwice, legacyOrder, beforeObserver, prelude });
      await fn(page.cdp, attempt);
      if (results.length === resultCount) throw new Error('场景结束但没有记录结果');
      return;
    } catch (error) {
      // 业务断言已经形成 PASS/FAIL/SKIPPED 时不重试；只重试新建页面、导航、CDP
      // 和网络等待等基础设施异常，且每次都用全新的 target。
      if (results.length > resultCount) return;
      errors.push(`尝试 ${attempt + 1}/${attempts}: ${error.message}`);
      if (attempt + 1 < attempts) await sleep(500);
    } finally {
      await closePage(page);
    }
  }
  addResult(name, 'FAIL', { reason: errors.join('；') });
}

async function probeUgcCandidate(candidate) {
  let controlPage;
  let injectedPage;
  const url = `https://www.bilibili.com/video/${candidate.bvid}`;
  try {
    controlPage = await newPage({ beforeObserver: RESET_CODEC_PREFERENCE });
    await navigate(controlPage.cdp, url);
    const controlCodec = await waitForCodec(controlPage.cdp, 15_000);
    const initialPreference = await controlPage.cdp.eval('window.__qaBoost?.initialCodecPreference ?? null');
    if (initialPreference !== null || codecKind(controlCodec) !== 'AV1') return null;
    const av1Hardware = await powerEfficient(controlPage.cdp, controlCodec);
    if (typeof av1Hardware !== 'boolean') return null;
    await closePage(controlPage);
    controlPage = null;

    injectedPage = await newPage({ inject: true, beforeObserver: codecAutoCacheSetup(av1Hardware) });
    await navigate(injectedPage.cdp, url);
    const injectedCodec = await waitForCodec(injectedPage.cdp, 15_000);
    const injectedKind = codecKind(injectedCodec);
    if (av1Hardware ? injectedKind !== 'AV1' : !['HEVC', 'AVC'].includes(injectedKind)) return null;
    return { ...candidate, controlCodec, injectedCodec, av1Hardware };
  } catch {
    return null;
  } finally {
    await closePage(controlPage);
    await closePage(injectedPage);
  }
}

async function discoverOnce() {
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

    const bvids = [...new Set([...FALLBACK_MULTI_BVIDS, ...found.videos])].slice(0, 42);
    const pages = await cdp.eval(String.raw`Promise.all(${JSON.stringify(bvids)}.map(async bvid => {
      try {
        const json = await (await fetch('https://api.bilibili.com/x/player/pagelist?bvid=' + bvid)).json();
        return { bvid, pages: Array.isArray(json.data) ? json.data.length : 0 };
      } catch (error) { return { bvid, pages: 0, error: String(error) }; }
    }))`, true);

    // 首页会混入未开播、付费或充电专属卡片；共享 profile 还可能被播放器写入编码偏好。
    // 每个候选都在独立 target 的 document-start、Observer 之前清理偏好；干净对照必须
    // 创建 AV1 SourceBuffer，注入页则按实测硬解能力保留 AV1 或改选 HEVC/AVC。优先多 P，最多验证 12 个候选。
    const ordered = [...pages.filter(item => item.pages > 1), ...pages.filter(item => item.pages <= 1)];
    const playable = [];
    for (const candidate of ordered.slice(0, 12)) {
      const probed = await probeUgcCandidate(candidate);
      if (probed) playable.push(probed);
      if (playable.length >= MAX_LIVE_ATTEMPTS && playable.some(item => item.pages > 1)) break;
    }
    if (!playable.length) {
      throw new Error(`有界验证了 ${Math.min(ordered.length, 12)} 个 BV，但没有候选同时满足干净 AV1 对照和能力分支断言`);
    }
    const capabilities = new Set(playable.map(item => item.av1Hardware));
    if (capabilities.size !== 1) throw new Error(`候选 AV1 硬解探测结果不一致：${[...capabilities].join(', ')}`);
    const bangumi = [...new Set([found.bangumi, ...FALLBACK_BANGUMI_URLS].filter(Boolean))];
    return {
      ugc: playable.slice(0, MAX_LIVE_ATTEMPTS),
      candidates: pages.map(item => item.bvid),
      multi: playable.filter(item => item.pages > 1).slice(0, MAX_LIVE_ATTEMPTS),
      bangumi: bangumi.slice(0, MAX_LIVE_ATTEMPTS),
      av1Hardware: playable[0].av1Hardware,
    };
  } finally {
    await closePage(page);
  }
}

async function discover() {
  const errors = [];
  for (let attempt = 0; attempt < MAX_LIVE_ATTEMPTS; attempt++) {
    try {
      return await discoverOnce();
    } catch (error) {
      errors.push(`发现尝试 ${attempt + 1}/${MAX_LIVE_ATTEMPTS}: ${error.message}`);
      if (attempt + 1 < MAX_LIVE_ATTEMPTS) await sleep(750);
    }
  }
  throw new Error(errors.join('；'));
}

async function classifyNoPlayback(cdp, context) {
  const seen = await observation(cdp);
  const loginLimited = /登录|会员|大会员|试看|购买|地区|版权|不可用|下架/.test(seen.body);
  return `${context}未观测到视频 SourceBuffer；${loginLimited ? '页面显示登录/会员/版权限制' : `页面：${seen.title || seen.url}`}`;
}

async function testSimple(name, urls, expected, { inject = true, beforeObserver = '' } = {}) {
  const candidates = Array.isArray(urls) ? urls : [urls];
  await runScenario(name, async (cdp, attempt) => {
    await navigate(cdp, candidates[attempt % candidates.length]);
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
  }, { inject, beforeObserver, attempts: Math.min(MAX_LIVE_ATTEMPTS, candidates.length) });
}

async function main() {
  profile = await mkdtemp(join(tmpdir(), 'qa-boost-'));
  chrome = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',                       // 会真实播放 B 站视频：一律静音（用户 2026-09-27 反映 Mac 上太吵）
    ...(HEADLESS ? ['--headless=new'] : []),
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
  console.log(`UGC: ${targets.ugc.map(item => item.bvid).join(', ')}`);
  console.log(`多 P: ${targets.multi.length ? targets.multi.map(item => `${item.bvid} (${item.pages} P)`).join(', ') : '未发现'}`);
  console.log(`番剧候选: ${targets.bangumi.join(', ')}`);
  console.log(`AV1 硬解实测: ${targets.av1Hardware ? '有' : '无'}（后续 live 断言按此分支）`);

  const benchmark = segmentClassifierBenchmark();
  const benchmarkPass = benchmark.old.count === benchmark.fast.count && benchmark.old.count === 20_000;
  addResult('分片热路径微基准', benchmarkPass ? 'PASS' : 'FAIL', {
    codec: `${benchmark.old.ms.toFixed(1)}ms → ${benchmark.fast.ms.toFixed(1)}ms`,
    reason: `${benchmark.ratio.toFixed(2)}x；20 万次混合请求分类（90% 非分片），计数=${benchmark.fast.count}`,
  });

  const ugcUrls = targets.ugc.map(item => `https://www.bilibili.com/video/${item.bvid}`);
  const ugcAttempts = Math.min(MAX_LIVE_ATTEMPTS, ugcUrls.length);
  const ugcUrlFor = attempt => ugcUrls[attempt % ugcUrls.length];
  const actualCodecSetup = codecAutoCacheSetup(targets.av1Hardware);
  const expectedLiveCodecs = targets.av1Hardware ? ['AV1'] : ['HEVC', 'AVC'];
  await runScenario('对照组（不注入）', async (cdp, attempt) => {
    await navigate(cdp, ugcUrlFor(attempt));
    let codec;
    try { codec = await waitForCodec(cdp); }
    catch { throw new Error(await classifyNoPlayback(cdp, '对照组')); }
    const efficient = await powerEfficient(cdp, codec);
    const initialPreference = await cdp.eval('window.__qaBoost?.initialCodecPreference ?? null');
    const cleanControl = initialPreference === null;
    const pass = cleanControl && codecKind(codec) === 'AV1' && efficient === targets.av1Hardware;
    if (!pass) {
      throw new Error(`候选不再满足干净 AV1 对照：初始值=${JSON.stringify(initialPreference)}，实际=${codecKind(codec)}，powerEfficient=${efficient}`);
    }
    addResult('对照组（不注入）', 'PASS', {
      codec, powerEfficient: efficient, reason: `AV1 硬解实测=${efficient ? '有' : '无'}`,
    });
  }, { attempts: ugcAttempts, beforeObserver: RESET_CODEC_PREFERENCE });

  await runScenario('编码三态向后兼容', async cdp => {
    await navigate(cdp, 'https://www.bilibili.com/robots.txt');
    const readModeAfterReload = async (stored, suffix, clearHw = false) => {
      await cdp.eval(`localStorage.setItem('bhw_codec', ${JSON.stringify(JSON.stringify(stored))});` +
        (clearHw ? "localStorage.setItem('bhw_av1hw', 'null');" : ''));
      await navigate(cdp, `https://www.bilibili.com/robots.txt?qa_codec=${suffix}`);
      return waitFor(() => cdp.eval(String.raw`(() => window.__biliBoost ? ({
        mode: window.__biliBoost.编码模块,
        av1: window.__biliBoost.AV1硬解
      }) : null)()`), { timeout: 3_000, label: `codec mode ${suffix}` });
    };
    const forcedOn = await readModeAfterReload(true, 'true');
    const forcedOff = await readModeAfterReload(false, 'false');
    const automatic = await readModeAfterReload('auto', 'auto', true);
    const hardwarePolicy = { hardware: '有', mode: '自动｜本机有 AV1 硬解 → 不干预' };
    const softwarePolicy = { hardware: '无', mode: '自动｜本机无 AV1 硬解 → 剔除 AV1' };
    const liveOraclePass = ['AV1', 'HEVC', 'AVC'].every(kind => liveCodecPolicy(true, kind, hardwarePolicy).pass) &&
      ['HEVC', 'AVC'].every(kind => liveCodecPolicy(false, kind, softwarePolicy).pass) &&
      !liveCodecPolicy(false, 'AV1', softwarePolicy).pass;
    const pass = /^强制开/.test(forcedOn.mode) && /^强制关/.test(forcedOff.mode) &&
      /自动｜未知 → 暂按剔除 AV1/.test(automatic.mode) && automatic.av1 === '未探测' && liveOraclePass;
    addResult('编码三态向后兼容', pass ? 'PASS' : 'FAIL', {
      reason: pass ? '旧 bhw_codec=true/false 语义不变；auto+null 仍保守剔除 AV1；live oracle 双能力矩阵正确' :
        JSON.stringify({ forcedOn, forcedOff, automatic, liveOraclePass }),
    });
  });

  await runScenario('健康档案旧数据迁移与双上限', async cdp => {
    await navigate(cdp, 'https://www.bilibili.com/robots.txt');
    await cdp.eval(String.raw`(() => {
      const now = Date.now();
      const legacy = {};
      for (let i = 0; i < 40; i++) legacy['upos-test-' + i + '.bilivideo.com'] = {
        attempts: 100, successes: 80, kbps: 100 + i, ttfb: i, at: now - i * 1000
      };
      for (let i = 0; i < 5; i++) legacy['upos-expired-' + i + '.bilivideo.com'] = {
        attempts: 2, successes: 2, kbps: 999, at: now - 8 * 24 * 3600_000
      };
      localStorage.setItem('bhw_health', JSON.stringify(legacy));
    })()`);
    await navigate(cdp, 'https://www.bilibili.com/robots.txt?qa_health_migration=1');
    const audit = await cdp.eval(String.raw`(() => {
      const now = Date.now();
      const stored = JSON.parse(localStorage.getItem('bhw_health'));
      const hosts = Object.entries(stored.hosts || {});
      return {
        version: stored.version,
        count: hosts.length,
        expired: hosts.some(([host]) => host.includes('expired')),
        attemptsCapped: hosts.every(([, value]) => value.attempts <= 24),
        oldestAge: Math.max(...hosts.map(([, value]) => now - value.at)),
        apiCount: Object.keys(window.__biliBoost?.主机健康 || {}).length,
      };
    })()`);
    const pass = audit.version === 2 && audit.count === 32 && audit.apiCount === 32 &&
      !audit.expired && audit.attemptsCapped && audit.oldestAge < 7 * 24 * 3600_000;
    addResult('健康档案旧数据迁移与双上限', pass ? 'PASS' : 'FAIL', {
      reason: pass ? 'v1 字典自动迁移为 v2 envelope；按 32 条、7 天裁剪并衰减旧样本' : JSON.stringify(audit),
    });
  });

  await runScenario('AV1 硬解缓存过期', async (cdp, attempt) => {
    await navigate(cdp, 'https://www.bilibili.com/robots.txt');
    const staleAt = Date.now() - 31 * 24 * 3600_000;
    await cdp.eval(String.raw`(() => {
      const env = [navigator.userAgent || '', navigator.platform || '', navigator.hardwareConcurrency || ''].join('|');
      localStorage.setItem('bhw_codec', JSON.stringify('auto'));
      localStorage.setItem('bhw_av1hw', JSON.stringify({ value: true, at: ${staleAt}, env }));
    })()`);
    await navigate(cdp, ugcUrlFor(attempt));
    const codec = await waitForCodec(cdp);
    const refreshed = await waitFor(() => cdp.eval(String.raw`(() => {
      try {
        const value = JSON.parse(localStorage.getItem('bhw_av1hw'));
        return value && typeof value === 'object' && typeof value.value === 'boolean' && value.at > ${staleAt}
          ? value : null;
      } catch { return null; }
    })()`), { timeout: 8_000, interval: 100, label: 'refreshed AV1 hardware cache metadata' });
    const pass = ['HEVC', 'AVC'].includes(codecKind(codec)) && refreshed.at > staleAt;
    addResult('AV1 硬解缓存过期', pass ? 'PASS' : 'FAIL', {
      codec,
      reason: pass ? '31 天旧结论未被信任，首屏保守剔除 AV1，并写回带环境/时间的新结论' : JSON.stringify(refreshed),
    });
  }, { attempts: ugcAttempts });

  await testSimple('普通 UGC 视频页', ugcUrls, expectedLiveCodecs, { beforeObserver: actualCodecSetup });

  await runScenario('CDN 模块', async (cdp, attempt) => {
    await navigate(cdp, ugcUrlFor(attempt));
    const result = await waitFor(() => cdp.eval(String.raw`(() => {
      const api = window.__biliCdn;
      const names = ['当前源', '实测速度', '首字节延迟', '分片明细', '测速结果', '卡顿次数',
        '黑名单', '重测', '手动选源', '自动选源', '面板'];
      if (!api?.测速结果) return null;
      const list = api.测速结果.list || [];
      const precise = list.find(item => item.ok === true && Array.isArray(item.points) && item.points.length > 1);
      const choice = list.find(item => item.ok === true);
      const source = api.当前源;
      let manualOk = false;
      if (choice) {
        api.手动选源(choice.host);
        manualOk = api.手动源 === choice.host && api.当前源 === choice.host;
        api.自动选源();
      }
      return {
        alias: api === window.__biliBoost,
        publicApi: names.every(name => name in api),
        resultCount: list.length,
        stallsType: typeof api.卡顿次数,
        source,
        speed: api.实测速度,
        timingOk: !!precise && Number.isFinite(precise.ttfb) &&
          precise.points.some(point => point.point === '中'),
        manualOk
      };
    })()`), { timeout: 55_000, interval: 500, label: 'CDN 两阶段多点测速结果' });
    const healthBound = await cdp.eval(String.raw`(() => {
      clearInterval(window.__qaHealthWatch);
      return {
        max: window.__qaHealthMax,
        current: window.__biliBoost?.诊断状态?.health,
      };
    })()`);
    const healthBounded = healthBound.max <= 32 && healthBound.current <= 32;
    const pass = result.alias && result.publicApi && result.resultCount > 0 &&
      result.stallsType === 'number' && result.timingOk && result.manualOk && healthBounded;
    addResult('CDN 模块', pass ? 'PASS' : 'FAIL', {
      codec: result.source || '未选源',
      reason: `${pass ? '' : 'CDN 公开接口、多点计时、手动切源或健康上限不完整；'}测速条目=${result.resultCount}，实测=${result.speed}，healthMax=${healthBound.max}，healthNow=${healthBound.current}`,
    });
  }, { attempts: ugcAttempts, beforeObserver: HEALTH_BOUNDARY_SETUP });

  // 用户反馈的 08h 节点只作为新增候选：成功才进入自动选择，故障时不应成为播放地址。
  const candidate08h = 'upos-sz-mirror08h.bilivideo.com';
  for (const available of [true, false]) {
    const name = `新增 CDN 候选（${available ? '可用' : '不可用回退'}）`;
    await runScenario(name, async cdp => {
      await navigate(cdp, 'https://www.bilibili.com/robots.txt');
      const original = 'upos-sz-mirrorali.bilivideo.com';
      const path = `/qa-candidate-${available ? 'ok' : 'fail'}/qa-new-cdn.m4s`;
      const resource = `https://${original}${path}`;
      const data = Buffer.alloc(512 * 1024, 0x91);
      const body = data.toString('base64');
      const requested = [];
      let interceptionError;
      const off = cdp.on('Fetch.requestPaused', async event => {
        try {
          const url = new URL(event.request.url);
          requested.push(url.hostname);
          const success = available && url.hostname === candidate08h;
          const middle = !!event.request.headers.Range || !!event.request.headers.range;
          await cdp.send('Fetch.fulfillRequest', {
            requestId: event.requestId,
            responseCode: success ? (middle ? 206 : 200) : 503,
            responseHeaders: [
              { name: 'Content-Type', value: 'video/mp4' },
              { name: 'Access-Control-Allow-Origin', value: '*' },
              { name: 'Access-Control-Allow-Headers', value: 'Range' },
              ...(middle && success ? [{ name: 'Content-Range', value: 'bytes 1048576-1572863/2097152' }] : []),
            ],
            body: success ? body : '',
          });
        } catch (error) { interceptionError = error; }
      });
      try {
        await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*qa-new-cdn.m4s*' }] });
        await cdp.eval(`new XMLHttpRequest().open('GET', ${JSON.stringify(resource)});`);
        await waitFor(() => cdp.eval('window.__biliBoost?.诊断状态?.probing === 0 && window.__biliBoost?.黑名单?.length > 0'), {
          timeout: 20_000, interval: 100, label: 'new CDN candidate probe settled',
        });
        if (interceptionError) throw interceptionError;
        const audit = await cdp.eval(`(() => {
          const api = window.__biliBoost;
          new XMLHttpRequest().open('GET', ${JSON.stringify(resource)});
          const result = api.测速结果;
          return {
            win: result?.win || null,
            precise: result?.list.find(item => item.host === ${JSON.stringify(candidate08h)} && item.ok && item.points?.length === 2) != null,
            source: api.当前源,
            blacklisted: api.黑名单.includes(${JSON.stringify(candidate08h)}),
            manual: ${available ? `api.手动选源(${JSON.stringify(candidate08h)})` : "'未手选故障源'"},
          };
        })()`);
        const attempted = requested.includes(candidate08h);
        const pass = available
          ? attempted && audit.win === candidate08h && audit.precise &&
            audit.source === candidate08h && !audit.blacklisted && audit.manual.includes(candidate08h)
          : attempted && audit.win === null && audit.source === original && audit.blacklisted;
        addResult(name, pass ? 'PASS' : 'FAIL', {
          reason: pass ? (available ? '08h 经头部/中段测速后可自动及手动选择' : '08h 测速失败后加入黑名单并沿用原始源') :
            JSON.stringify({ attempted, audit, requested }),
        });
      } finally {
        off();
        try { await cdp.send('Fetch.disable'); } catch {}
      }
    }, { beforeObserver: String.raw`try { localStorage.removeItem('biliCdnWinner'); localStorage.removeItem('bhw_health'); } catch {}` });
  }

  await runScenario('fetch 实测速与卡顿过滤', async cdp => {
    await navigate(cdp, 'https://www.bilibili.com/robots.txt');
    const host = 'upos-sz-mirrorcosov.bilivideo.com';
    await cdp.eval(String.raw`(() => {
      sessionStorage.setItem('biliCdn:/qa', JSON.stringify({
        host: ${JSON.stringify('upos-sz-mirrorcosov.bilivideo.com')}, ts: Date.now()
      }));
    })()`);
    const payload = Buffer.alloc(96 * 1024, 0xab);
    let interceptionError;
    const off = cdp.on('Fetch.requestPaused', async event => {
      try {
        await sleep(180);
        await cdp.send('Fetch.fulfillRequest', {
          requestId: event.requestId,
          responseCode: 200,
          responseHeaders: [
            { name: 'Content-Type', value: 'video/mp4' },
            { name: 'Content-Length', value: String(payload.length) },
            { name: 'Access-Control-Allow-Origin', value: '*' },
          ],
          body: payload.toString('base64'),
        });
      } catch (error) {
        interceptionError = error;
      }
    });
    try {
      await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*qa-fetch-segment.m4s*' }] });
      const request = await cdp.eval(String.raw`(async () => {
        const response = await fetch('https://${host}/qa/qa-fetch-segment.m4s');
        return {
          bytes: (await response.arrayBuffer()).byteLength,
          url: response.url,
          status: response.status,
          redirected: response.redirected,
          type: response.type
        };
      })()`, true);
      if (interceptionError) throw interceptionError;
      const sample = await waitFor(() => cdp.eval(String.raw`(() =>
        window.__biliBoost?.分片明细.find(item => item.via === 'fetch') || null
      )()`), { timeout: 5_000, interval: 100, label: 'fetch segment telemetry' });
      const stallAudit = await cdp.eval(String.raw`(async () => {
        const api = window.__biliBoost;
        const state = { time: 0, seeking: false };
        const video = document.createElement('video');
        Object.defineProperties(video, {
          paused: { configurable: true, get: () => false },
          ended: { configurable: true, get: () => false },
          seeking: { configurable: true, get: () => state.seeking },
          readyState: { configurable: true, get: () => 2 },
          currentTime: { configurable: true, get: () => state.time, set: value => { state.time = value; } },
        });
        document.body.appendChild(video);
        const emit = type => video.dispatchEvent(new Event(type));

        emit('waiting');
        await new Promise(resolve => setTimeout(resolve, 1400));
        const initial = api.卡顿次数;

        state.seeking = true;
        emit('seeking');
        state.seeking = false;
        emit('seeked');
        state.time = 0.2;
        emit('timeupdate');
        emit('waiting');
        await new Promise(resolve => setTimeout(resolve, 1400));
        const seeking = api.卡顿次数;

        await new Promise(resolve => setTimeout(resolve, 1300));
        state.time = 0.4;
        emit('timeupdate');
        emit('waiting');
        setTimeout(() => emit('playing'), 200);
        await new Promise(resolve => setTimeout(resolve, 1400));
        const recovered = api.卡顿次数;
        video.remove();
        return { initial, seeking, recovered };
      })()`, true);
      const stallFilterOk = Object.values(stallAudit).every(value => value === 0);
      const pass = request.bytes === payload.length && request.status === 200 &&
        request.url.includes('/qa/qa-fetch-segment.m4s') && request.redirected === false &&
        sample.host === host && sample.bytes === payload.length && sample.kbps > 0 && sample.ttfb >= 100 &&
        stallFilterOk;
      addResult('fetch 实测速与卡顿过滤', pass ? 'PASS' : 'FAIL', {
        codec: `${sample.kbps}KB/s · ${sample.ttfb}ms`,
        reason: pass ? '原 Response 语义不变；fetch 吞吐/TTFB 已记录；初始、seek、瞬时 waiting 均未误判' :
          JSON.stringify({ request, sample, stallAudit }),
      });
    } finally {
      off();
      try { await cdp.send('Fetch.disable'); } catch {}
    }
  });

  const testLongPlayback = async av1Hardware => {
    const capabilityLabel = av1Hardware ? '有 AV1 硬解' : '无 AV1 硬解';
    const name = `长时播放与媒体切换有界（${capabilityLabel}）`;
    await runScenario(name, async cdp => {
      await navigate(cdp, `https://www.bilibili.com/robots.txt?qa_long=${Number(av1Hardware)}`);
      const detected = await cdp.eval('window.__biliBoost.重新探测AV1()', true);
      const codecState = await cdp.eval('({ hardware: window.__biliBoost.AV1硬解, mode: window.__biliBoost.编码模块 })');
      const expectedHardware = av1Hardware ? '有' : '无';
      const capabilityOk = codecState.hardware === expectedHardware &&
        (av1Hardware ? /有 AV1 硬解 → 不干预/.test(codecState.mode) : /无 AV1 硬解 → 剔除 AV1/.test(codecState.mode));
      const audit = await cdp.eval(String.raw`(async () => {
        const host = 'upos-sz-mirror08c.bilivideo.com';
        const openOnly = url => {
          const xhr = new XMLHttpRequest();
          xhr.open('GET', url);
        };
        for (let i = 0; i < 2000; i++) {
          openOnly('https://' + host + '/qa/long-play/segment-' + i + '.m4s?token=qa');
        }
        const afterSegments = window.__biliBoost.诊断状态;
        window.__biliBoost.手动选源(host);
        const beforeSwitch = window.__biliBoost.诊断状态;
        for (let i = 1; i <= 20; i++) {
          history.pushState({}, '', '/video/BV1QATEST?p=' + i);
          dispatchEvent(new PopStateEvent('popstate'));
          openOnly('https://' + host + '/qa/spa-' + i + '/segment.m4s');
        }
        const afterSpa = window.__biliBoost.诊断状态;

        // 同 URL 内的 playurl 参数变化确定性模拟“切清晰度”；cid 变化模拟“切分 P”。
        openOnly('https://api.bilibili.com/x/player/playurl?bvid=BV1QATEST&cid=100&qn=32&fnval=16');
        const beforeQuality = window.__biliBoost.诊断状态;
        openOnly('https://api.bilibili.com/x/player/playurl?bvid=BV1QATEST&cid=100&qn=64&fnval=16');
        const afterQuality = window.__biliBoost.诊断状态;
        openOnly('https://api.bilibili.com/x/player/playurl?bvid=BV1QATEST&cid=101&qn=64&fnval=16');
        const afterPart = window.__biliBoost.诊断状态;
        await new Promise(resolve => setTimeout(resolve, 100));
        return { afterSegments, beforeSwitch, afterSpa, beforeQuality, afterQuality, afterPart,
          settled: window.__biliBoost.诊断状态 };
      })()`, true);
      const bounded = Object.values(audit).every(state =>
        state.rejected <= 1 && state.picked <= 1 && state.manual <= 1 && state.probing <= 1 &&
        state.perf <= 6 && state.blacklist <= 64 && state.probeControllers <= 6 &&
        state.fetchObservers <= 32 && state.health <= 32 && state.warningTimers <= 1);
      const transitionsReset = audit.afterSpa.generation >= audit.afterSegments.generation + 20 &&
        audit.afterSpa.manual === 0 && audit.afterQuality.generation > audit.beforeQuality.generation &&
        audit.afterPart.generation > audit.afterQuality.generation && audit.afterPart.picked === 0 &&
        audit.afterPart.manual === 0;
      const pass = capabilityOk && bounded && transitionsReset;
      addResult(name, pass ? 'PASS' : 'FAIL', {
        codec: `${codecState.hardware}｜${codecState.mode}`,
        reason: pass ? `${detected}；确定性模拟 2000 分片 + 20 次 SPA + 切清晰度/分 P；资源有界且媒体态重置` :
          JSON.stringify({ detected, codecState, audit }),
      });
    }, { beforeObserver: RESET_CODEC_AUTO, prelude: codecProbePrelude(av1Hardware) });
  };
  await testLongPlayback(false);
  await testLongPlayback(true);

  await runScenario('防重复注入', async (cdp, attempt) => {
    await navigate(cdp, ugcUrlFor(attempt));
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
  }, { injectTwice: true, beforeObserver: actualCodecSetup, attempts: ugcAttempts });

  // iPhone Safari 只暴露 ManagedMediaSource（继承 MediaSource），全局没有 MediaSource。
  // 在 Chrome 里按 WebKit IDL 的继承关系造出同形环境：脚本必须完整初始化，
  // 并且经 ManagedMediaSource 调 addSourceBuffer 时仍能记录编码。
  const IPHONE_MSE_SHAPE = String.raw`
    (() => {
      const RealMediaSource = window.MediaSource;
      window.ManagedMediaSource = class ManagedMediaSource extends RealMediaSource {};
      window.__qaBaseAddSourceBuffer = RealMediaSource.prototype.addSourceBuffer;
      delete window.MediaSource;
    })();
  `;
  await runScenario('Safari：仅 ManagedMediaSource', async (cdp, attempt) => {
    await navigate(cdp, ugcUrlFor(attempt));
    const probed = await waitFor(() => cdp.eval(String.raw`(() => {
      const api = window.__biliBoost;
      if (!api || typeof window.ManagedMediaSource !== 'function') return null;
      const mime = 'video/mp4; codecs="hvc1.1.6.L120.90"';
      const base = Object.getPrototypeOf(ManagedMediaSource.prototype);
      let threw = null;
      try { new ManagedMediaSource().addSourceBuffer(mime); } catch (error) { threw = error.name; }
      return {
        mediaSourceGlobal: typeof window.MediaSource,
        hooked: base.addSourceBuffer !== window.__qaBaseAddSourceBuffer,
        ownOnManaged: Object.prototype.hasOwnProperty.call(ManagedMediaSource.prototype, 'addSourceBuffer'),
        picked: api.当前编码,
        mime,
        threw,
        hasRetest: typeof api.重测 === 'function'
      };
    })()`), { timeout: 10_000, label: 'ManagedMediaSource-only init' });
    const pass = probed.mediaSourceGlobal === 'undefined' && probed.hooked && !probed.ownOnManaged &&
      probed.picked === probed.mime && probed.hasRetest;
    addResult('Safari：仅 ManagedMediaSource', pass ? 'PASS' : 'FAIL', {
      reason: pass ? '无 MediaSource 全局时完整初始化；经 ManagedMediaSource 调用仍记录编码（基类原型只包一次）'
        : JSON.stringify(probed),
    });
  }, { prelude: IPHONE_MSE_SHAPE, attempts: ugcAttempts });

  // macOS Safari 17+ 同时暴露两个构造器，但 addSourceBuffer 由共同的 MediaSource
  // 原型提供。两条查找路径必须落到同一个 owner prototype，不能重复包装副作用。
  const DUAL_MSE_SHAPE = String.raw`
    (() => {
      const RealMediaSource = window.MediaSource;
      const sentinel = {};
      const state = window.__qaDualMse = {
        baseCalls: 0,
        hookMicrotasks: 0,
        sentinel,
      };
      const nativeQueueMicrotask = window.queueMicrotask;
      window.queueMicrotask = callback => {
        state.hookMicrotasks += 1;
        return nativeQueueMicrotask.call(window, callback);
      };
      RealMediaSource.prototype.addSourceBuffer = function() {
        state.baseCalls += 1;
        return sentinel;
      };
      state.baseAddSourceBuffer = RealMediaSource.prototype.addSourceBuffer;
      window.ManagedMediaSource = class ManagedMediaSource extends RealMediaSource {};
    })();
  `;
  await runScenario('Safari：MediaSource / ManagedMediaSource 双全局', async (cdp, attempt) => {
    await navigate(cdp, ugcUrlFor(attempt));
    const probed = await waitFor(() => cdp.eval(String.raw`(() => {
      const api = window.__biliBoost;
      const state = window.__qaDualMse;
      if (!api || !state || typeof window.ManagedMediaSource !== 'function') return null;
      const shared = MediaSource.prototype;
      const managedBase = Object.getPrototypeOf(ManagedMediaSource.prototype);
      const wrapped = shared.addSourceBuffer;
      state.baseCalls = 0;
      state.hookMicrotasks = 0;
      const mime = 'video/mp4; codecs="hvc1.1.6.L120.90"';
      const mediaResult = new MediaSource().addSourceBuffer(mime);
      const managedResult = new ManagedMediaSource().addSourceBuffer(mime);
      return {
        sharedOwner: managedBase === shared,
        inheritedMethod: ManagedMediaSource.prototype.addSourceBuffer === wrapped,
        ownOnManaged: Object.prototype.hasOwnProperty.call(ManagedMediaSource.prototype, 'addSourceBuffer'),
        hooked: wrapped !== state.baseAddSourceBuffer,
        baseCalls: state.baseCalls,
        hookMicrotasks: state.hookMicrotasks,
        returnPreserved: mediaResult === state.sentinel && managedResult === state.sentinel,
        picked: api.当前编码,
        mime,
      };
    })()`), { timeout: 10_000, label: 'MediaSource / ManagedMediaSource shared prototype init' });
    const pass = probed.sharedOwner && probed.inheritedMethod && !probed.ownOnManaged && probed.hooked &&
      probed.baseCalls === 2 && probed.hookMicrotasks === 2 && probed.returnPreserved && probed.picked === probed.mime;
    addResult('Safari：MediaSource / ManagedMediaSource 双全局', pass ? 'PASS' : 'FAIL', {
      reason: pass ? '两个构造器共享同一 owner prototype；各调用一次时底层调用和编码副作用均恰好两次，返回值原样透传'
        : JSON.stringify(probed),
    });
  }, { prelude: DUAL_MSE_SHAPE, attempts: ugcAttempts });

  for (const [legacyOrder, orderLabel] of [['before', '旧版先注入'], ['after', '旧版后注入']]) {
    const name = `旧版冲突检测（${orderLabel}）`;
    if (!LEGACY_CDN_SCRIPT) {
      addResult(name, 'SKIPPED', { reason: '无法从 git 历史读取 bb6d614:bili-cdn-fix.user.js' });
      continue;
    }
    await runScenario(name, async cdp => {
      await navigate(cdp, 'https://www.bilibili.com/robots.txt');
      await waitFor(() => cdp.eval(String.raw`(() => {
        const api = window.__biliBoost;
        const oldHud = document.getElementById('bili-cdn-hud');
        const boostHud = document.getElementById('bili-boost-hud');
        return api?.冲突 && oldHud && boostHud && getComputedStyle(oldHud).display === 'none';
      })()`), { timeout: 10_000, label: `${orderLabel}的冲突告警和旧 HUD 隐藏` });
      await cdp.eval("document.getElementById('bili-boost-hud').click()");
      await sleep(750); // 让现有 500ms 同步再检查一次，顺便验证 console.warn 不会重复。
      const audit = await cdp.eval(String.raw`(() => {
        const api = window.__biliBoost;
        const oldHud = document.getElementById('bili-cdn-hud');
        const text = document.getElementById('bili-boost-hud')?.textContent || '';
        return {
          boostAvailable: !!api,
          conflict: api?.冲突 || null,
          oldHudDisplay: oldHud ? getComputedStyle(oldHud).display : null,
          warningVisible: /旧版 bili-cdn-fix 仍在运行/.test(text),
          managerLocationsVisible: /Userscripts/.test(text) && /AdGuard/.test(text) && /Tampermonkey/.test(text),
          warningCount: (window.__qaBoost?.warnings || []).filter(line => /\[bili-boost\] 检测到旧版 bili-cdn-fix/.test(line)).length,
          aliasOwnedByBoost: window.__biliCdn === api,
        };
      })()`);
      const expectedAliasOwnership = legacyOrder === 'before';
      const pass = audit.boostAvailable && audit.conflict && audit.oldHudDisplay === 'none' &&
        audit.warningVisible && audit.managerLocationsVisible && audit.warningCount === 1 &&
        audit.aliasOwnedByBoost === expectedAliasOwnership;
      addResult(name, pass ? 'PASS' : 'FAIL', {
        reason: pass ? '冲突提示可见、展开态列出管理器、旧 HUD 已隐藏、console.warn 仅一次、__biliBoost 仍可用' : JSON.stringify(audit),
      });
    }, { legacyOrder });
  }

  const testPlayurlMock = async av1Hardware => {
    const capabilityLabel = av1Hardware ? '有 AV1 硬解' : '无 AV1 硬解';
    const name = `playurl 劫持层（mock，${capabilityLabel}）`;
    await runScenario(name, async cdp => {
      await navigate(cdp, `${ugcUrlFor(0)}?qa_playurl=${Number(av1Hardware)}`);
      const detected = await cdp.eval('window.__biliBoost.重新探测AV1()', true);
      const codecState = await cdp.eval('({ hardware: window.__biliBoost.AV1硬解, mode: window.__biliBoost.编码模块 })');
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

        const expected = av1Hardware
          ? ['AVC/80', 'AV1/80', 'HEVC/80', 'AVC/32', 'AV1/32', 'HEVC/32']
          : ['HEVC/80', 'AVC/80', 'HEVC/32', 'AVC/32'];
        const failures = [];
        const expectedHardware = av1Hardware ? '有' : '无';
        if (codecState.hardware !== expectedHardware) failures.push(`能力状态=${codecState.hardware}`);
        if (av1Hardware ? !/有 AV1 硬解 → 不干预/.test(codecState.mode) : !/无 AV1 硬解 → 剔除 AV1/.test(codecState.mode)) {
          failures.push(`自动模式=${codecState.mode}`);
        }
        for (const [channel, payload] of Object.entries(outputs)) {
          const data = payload?.data || payload?.result || payload;
          const response = {
            order: (data?.dash?.video || []).map(item => ({ id: item.id, codecid: item.codecid })),
          };
          const order = responseOrder(response);
          const hasAv1 = (data?.dash?.video || []).some(item => item.codecid === 13);
          const supportHasAv1 = (data?.support_formats || []).some(format =>
            format.codecs?.some(codec => /^av01/i.test(codec)));
          if (hasAv1 !== av1Hardware) failures.push(`${channel}: dash AV1=${hasAv1}`);
          if (supportHasAv1 !== av1Hardware) failures.push(`${channel}: support_formats AV1=${supportHasAv1}`);
          if (JSON.stringify(order) !== JSON.stringify(expected)) failures.push(`${channel}: 顺序=${order.join(', ')}`);
        }
        addResult(name, failures.length ? 'FAIL' : 'PASS', {
          codec: expected.join(', '),
          reason: failures.length ? failures.join('；') :
            `${detected}；fetch / xhr.responseText / xhr.responseType=json 均按 auto ${av1Hardware ? '保留' : '清除'} AV1`,
        });
      } finally {
        off();
        try { await cdp.send('Fetch.disable'); } catch {}
      }
    }, { beforeObserver: RESET_CODEC_AUTO, prelude: codecProbePrelude(av1Hardware) });
  };
  await testPlayurlMock(false);
  await testPlayurlMock(true);

  if (!targets.bangumi.length) {
    addResult('番剧页', 'FAIL', { reason: '没有可供有界重试的番剧候选' });
  } else {
    // 番剧候选没有“干净对照必须选 AV1”的前置条件，服务端可合法选择任一可播编码。
    // auto 的业务语义是有 AV1 硬解时不干预（接受 AV1/HEVC/AVC），无硬解时才禁止 AV1。
    await runScenario('番剧页', async (cdp, attempt) => {
      const url = targets.bangumi[attempt % targets.bangumi.length];
      await navigate(cdp, url);
      let codec;
      try { codec = await waitForCodec(cdp); }
      catch { throw new Error(await classifyNoPlayback(cdp, `番剧页 ${url}`)); }
      const efficient = await powerEfficient(cdp, codec);
      const kind = codecKind(codec);
      const policy = await cdp.eval('({ hardware: window.__biliBoost?.AV1硬解, mode: window.__biliBoost?.编码模块 })');
      const verdict = liveCodecPolicy(targets.av1Hardware, kind, policy);
      addResult('番剧页', verdict.pass ? 'PASS' : 'FAIL', {
        codec, powerEfficient: efficient,
        reason: verdict.pass ? `实测${policy.hardware} AV1 硬解，auto ${targets.av1Hardware ? '不干预' : '剔除 AV1'}；服务端选择 ${kind}` :
          JSON.stringify({ kind, allowed: verdict.allowed, policy }),
      });
    }, { beforeObserver: actualCodecSetup, attempts: Math.min(MAX_LIVE_ATTEMPTS, targets.bangumi.length) });
  }

  if (!targets.multi.length) {
    addResult('多 P 视频切 P', 'SKIPPED', { reason: `首页动态发现的 ${targets.candidates.length} 个 BV 中没有多 P 视频` });
  } else {
    await runScenario('多 P 视频切 P', async (cdp, attempt) => {
      const multi = targets.multi[attempt % targets.multi.length];
      await navigate(cdp, `https://www.bilibili.com/video/${multi.bvid}`);
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
      const pass = response.hasAv1 === targets.av1Hardware && response.supportHasAv1 === targets.av1Hardware;
      addResult('多 P 视频切 P', pass ? 'PASS' : 'FAIL', {
        codec, powerEfficient: efficient,
        reason: `${pass ? '' : `AV1 能力分支不符（dash=${response.hasAv1}, support=${response.supportHasAv1}）；`}顺序=${responseOrder(response).join(', ')}; playurl=${calls.at(-1)}`,
      });
    }, { beforeObserver: actualCodecSetup, attempts: Math.min(MAX_LIVE_ATTEMPTS, targets.multi.length) });
  }

  await runScenario('切清晰度', async (cdp, attempt) => {
    await navigate(cdp, ugcUrlFor(attempt));
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
    const pass = response.hasAv1 === targets.av1Hardware && response.supportHasAv1 === targets.av1Hardware;
    addResult('切清晰度', pass ? 'PASS' : 'FAIL', {
      codec, powerEfficient: efficient,
      reason: `${pass ? '' : `AV1 能力分支不符（dash=${response.hasAv1}, support=${response.supportHasAv1}）；`}${action.via}→${action.text}; 顺序=${responseOrder(response).join(', ')}; playurl=${calls.at(-1)}`,
    });
  }, { beforeObserver: actualCodecSetup, attempts: ugcAttempts });

  await runScenario('HUD 检查', async (cdp, attempt) => {
    await navigate(cdp, ugcUrlFor(attempt));
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
    const labelOk = kind === 'AV1' ? /编码：AV1/.test(hud) :
      kind === 'HEVC' ? /编码：HEVC\/H\.265/.test(hud) : kind === 'AVC' && /编码：AVC\/H\.264/.test(hud);
    const efficiencyOk = efficient === true && /🟢 硬解/.test(hud) && /powerEfficient：true/.test(hud);
    const policyOk = targets.av1Hardware
      ? kind === 'AV1' && /已剔除 AV1：0 条/.test(hud) && /自动｜本机有 AV1 硬解 → 不干预/.test(hud)
      : ['HEVC', 'AVC'].includes(kind) && /B站提供：.*AV1/.test(hud) && /已剔除 AV1：[1-9]\d* 条/.test(hud) &&
        /自动｜本机无 AV1 硬解 → 剔除 AV1/.test(hud);
    const pass = labelOk && efficiencyOk && policyOk;
    addResult('HUD 检查', pass ? 'PASS' : 'FAIL', {
      codec,
      powerEfficient: efficient,
      reason: `${pass ? `实测${targets.av1Hardware ? '有' : '无'} AV1 硬解，HUD 与 auto 分支一致；` : 'HUD 字段与实际能力分支不一致；'}HUD=${JSON.stringify(hud)}`,
    });
  }, { beforeObserver: actualCodecSetup, attempts: ugcAttempts });
}

function waitForChildExit(child, timeout) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    let timer;
    const done = () => {
      clearTimeout(timer);
      child.off('exit', done);
      resolve(true);
    };
    timer = setTimeout(() => {
      child.off('exit', done);
      resolve(false);
    }, timeout);
    child.once('exit', done);
  });
}

async function cleanup() {
  if (cleaning) return;
  cleaning = true;
  if (browserCdp) {
    try { await browserCdp.send('Browser.close', {}, 3_000); } catch {}
    try { await browserCdp.close(); } catch {}
    browserCdp = null;
  }
  if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
    try { chrome.kill('SIGTERM'); } catch {}
    if (!await waitForChildExit(chrome, 3_000)) {
      try { chrome.kill('SIGKILL'); } catch {}
      await waitForChildExit(chrome, 2_000);
    }
  }
  if (chrome?.stderr) {
    chrome.stderr.removeAllListeners('data');
    chrome.stderr.destroy();
  }
  if (chrome) chrome.unref();
  chrome = null;
  // Chrome on macOS can detach a child from the launcher before CDP is ready.
  // Match only this run's random profile so a late-starting test browser cannot leak.
  if (profile) {
    const match = `--user-data-dir=${profile}`;
    if (process.platform === 'win32') {
      const ps = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${profile.replace(/'/g, "''")}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`;
      await new Promise(resolve => execFile('powershell', ['-NoProfile', '-Command', ps], () => resolve()));
      await sleep(500);
    } else {
      await new Promise(resolve => execFile('/usr/bin/pkill', ['-TERM', '-f', match], () => resolve()));
      await sleep(300);
      await new Promise(resolve => execFile('/usr/bin/pkill', ['-KILL', '-f', match], () => resolve()));
    }
    try { await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 }); } catch {}   // Win 上 Chrome 刚退出时文件可能仍被占用
    profile = null;
  }
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
console.log(`耗时: ${((Date.now() - qaStartedAt) / 1000).toFixed(1)}s`);
if (counts.FAIL) process.exitCode = 1;
