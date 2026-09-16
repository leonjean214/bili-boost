// ==UserScript==
// @name         哔哩哔哩播放优化（CDN 测速切源 + 强制硬解编码）
// @namespace    https://github.com/leonjean214/bili-boost
// @version      1.0.0
// @description  CDN 两阶段测速切源，并剔除 AV1、优先 HEVC/H.264，降低海外播放卡顿与软解发热。
// @author       leonjean214
// @match        *://*.bilibili.com/*
// @run-at       document-start
// @grant        none
// @inject-into  page
// @downloadURL  https://raw.githubusercontent.com/leonjean214/bili-boost/main/bili-boost.user.js
// @updateURL    https://raw.githubusercontent.com/leonjean214/bili-boost/main/bili-boost.user.js
// ==/UserScript==

(function () {
  'use strict';

  // 升级期间旧脚本可能尚未停用；本标记至少保证合并版不会重复包装自己。
  if (window.__biliBoostInstalled) return;
  window.__biliBoostInstalled = true;

  // ---- CDN 配置：数值、候选顺序与 v3.0 完全一致 ----
  const CANDIDATES = [
    'upos-sz-mirror08c.bilivideo.com',
    'upos-sz-mirrorali.bilivideo.com',
    'upos-sz-mirrorcos.bilivideo.com',
    'upos-sz-mirrorhw.bilivideo.com',
    'upos-sz-mirrorcosov.bilivideo.com',
    'upos-hz-mirrorakam.akamaized.net',
  ];
  const QUICK_BYTES = 131072;
  const FULL_BYTES = 786432;
  const FINALISTS = 3;
  const PROBE_TIMEOUT = 8000;
  const CACHE_TTL = 30 * 60e3;
  const MIN_GAIN = 1.25;
  const RETEST_COOLDOWN = 45e3;
  const PERF_WINDOW = 6;

  const UPOS_HOST = /(^|\.)((upos-[a-z0-9-]+\.bilivideo\.com)|(upos-[a-z0-9-]+\.akamaized\.net))$/;
  const MEDIA_EXT = /\.(m4s|mp4|flv)$/;
  const VIDEO_PATH = /^\/(video\/|bangumi\/play\/|list\/|festival\/)/;
  const CODEC_NAME = { 7: 'AVC/H.264', 12: 'HEVC/H.265', 13: 'AV1' };
  const AV1 = 13;

  const origFetch = window.fetch;
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  // 两个模块的状态严格隔离。全局坏源/赢家沿用会话语义，其余按媒体重置。
  const cdnState = {
    blacklist: new Set(),
    rejected: new Map(),
    picked: new Map(),
    probing: new Set(),
    perf: [],
    lastResults: null,
    lastWinner: loadGlobalWinner(),
    stalls: 0,
    lastRetest: 0,
    sawMedia: false,
    missedWarning: false,
    curKey: null,
    lastProbeUrl: null,
  };
  const codecState = { stripped: 0, picked: null, offered: [], efficient: null };
  let mediaGeneration = 0;
  let currentMediaId = mediaIdentity();

  // hwdecode 原有的 localStorage fallback；页面上下文不依赖油猴存储 API。
  const configGet = (key, fallback) => {
    try { return JSON.parse(localStorage.getItem('bhw_' + key)) ?? fallback; } catch (e) { return fallback; }
  };
  const configSet = (key, value) => {
    try { localStorage.setItem('bhw_' + key, JSON.stringify(value)); } catch (e) { }
  };
  let prefer = configGet('prefer', 'hevc');
  let hudOn = (() => {
    let cdnOn = true;
    try { cdnOn = localStorage.getItem('biliCdnHud') !== 'off'; } catch (e) { }
    return cdnOn && configGet('hud', true);
  })();
  let hudExpanded = false;

  function loadGlobalWinner() {
    try {
      const value = JSON.parse(localStorage.getItem('biliCdnWinner') || 'null');
      if (value && Date.now() - value.ts < CACHE_TTL) return value.host;
    } catch (e) { /* 存储不可用时忽略 */ }
    return null;
  }
  function saveGlobalWinner(host) {
    try { localStorage.setItem('biliCdnWinner', JSON.stringify({ host, ts: Date.now() })); } catch (e) { }
  }
  function loadCdnCache(key) {
    try {
      const value = JSON.parse(sessionStorage.getItem('biliCdn:' + key) || 'null');
      if (value && Date.now() - value.ts < CACHE_TTL) return value.host;
    } catch (e) { }
    return null;
  }
  function saveCdnCache(key, host) {
    try { sessionStorage.setItem('biliCdn:' + key, JSON.stringify({ host, ts: Date.now() })); } catch (e) { }
  }

  function isVideoPage() { return VIDEO_PATH.test(location.pathname); }
  function mediaIdentity() {
    if (!isVideoPage()) return null;
    const query = new URLSearchParams(location.search);
    return location.pathname + '|p=' + (query.get('p') || '') + '|ep=' + (query.get('ep_id') || '');
  }

  // 新媒体规则：视频路径/分 P 标识变化，或收到与当前不同的分片目录。
  // 只清媒体态；全局赢家、黑名单和带 TTL 的缓存仍保持原脚本语义。
  function resetMediaState(reason, nextId = mediaIdentity()) {
    mediaGeneration++;
    currentMediaId = nextId;
    cdnState.rejected.clear();
    cdnState.picked.clear();
    cdnState.probing.clear();
    cdnState.perf.length = 0;
    cdnState.lastResults = null;
    cdnState.stalls = 0;
    cdnState.lastRetest = 0;
    cdnState.sawMedia = false;
    cdnState.missedWarning = false;
    cdnState.curKey = null;
    cdnState.lastProbeUrl = null;
    codecState.stripped = 0;
    codecState.picked = null;
    codecState.offered = [];
    codecState.efficient = null;
    renderHud(false);
    scheduleMediaWarning(mediaGeneration);
    console.log('[bili-boost] 新媒体状态已重置：' + reason);
  }
  function syncMediaIdentity() {
    const next = mediaIdentity();
    if (next !== currentMediaId) resetMediaState('页面切换', next);
  }
  addEventListener('popstate', syncMediaIdentity);
  addEventListener('hashchange', syncMediaIdentity);
  setInterval(syncMediaIdentity, 500);

  function scheduleMediaWarning(generation = mediaGeneration) {
    setTimeout(() => {
      if (generation !== mediaGeneration || cdnState.sawMedia) return;
      cdnState.missedWarning = true;
      console.warn('[bili-cdn] 5 秒内未拦截到 m4s/mp4/flv 请求');
      renderHud(false);
    }, 5000);
  }

  const keyOf = url => url.pathname.replace(/\/[^/]*$/, '');
  const isMedia = url => UPOS_HOST.test(url.hostname) && MEDIA_EXT.test(url.pathname);
  const shortName = host => host.replace(/^upos-[a-z]{2}-(mirror|upcdn)?/, '').split('.')[0];
  const isPlayurl = url => /\/playurl/.test(String(url));

  // ---- CDN：单个候选测速 ----
  async function probeCdn(url, host, bytes) {
    const target = new URL(url.toString());
    target.hostname = host;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT);
    let got = 0, tFirst = 0;
    try {
      const res = await origFetch.call(window, target.toString(), { credentials: 'omit', cache: 'no-store', signal: ctl.signal });
      if (!res.ok || !res.body) {
        cdnState.blacklist.add(host);
        return { host, kbps: 0, note: 'HTTP ' + res.status };
      }
      const reader = res.body.getReader();
      while (got < bytes) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!tFirst) tFirst = performance.now();
        got += value.length;
      }
      reader.cancel().catch(() => { });
      const dt = (performance.now() - tFirst) / 1000;
      if (!tFirst || got < 32768 || dt <= 0) return { host, kbps: 0, note: '数据不足' };
      return { host, kbps: Math.round(got / 1024 / dt) };
    } catch (e) {
      if (e.name !== 'AbortError') cdnState.blacklist.add(host);
      if (tFirst && got >= 32768) {
        const dt = (performance.now() - tFirst) / 1000;
        return { host, kbps: Math.round(got / 1024 / dt), note: '超时截断' };
      }
      return { host, kbps: 0, note: e.name === 'AbortError' ? '超时' : '失败' };
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- CDN：两阶段测速，逻辑保持 v3.0 ----
  async function runCdnProbe(url, why) {
    const key = keyOf(url);
    const generation = mediaGeneration;
    const probeKey = generation + ':' + key;
    if (cdnState.probing.has(probeKey)) return;
    cdnState.probing.add(probeKey);
    try {
      const origHost = url.hostname;
      const bad = cdnState.rejected.get(key) || new Set();
      const pool = [origHost, ...CANDIDATES].filter(
        (host, index, all) => all.indexOf(host) === index && !cdnState.blacklist.has(host) && !bad.has(host)
      );
      if (!pool.length) return;

      const quick = await Promise.all(pool.map(host => probeCdn(url, host, QUICK_BYTES)));
      quick.forEach(result => { result.stage = '快筛'; });
      quick.sort((a, b) => b.kbps - a.kbps);

      const finalists = quick.filter(result => result.kbps > 0).slice(0, FINALISTS);
      const full = [];
      for (const finalist of finalists) {
        const result = await probeCdn(url, finalist.host, FULL_BYTES);
        result.stage = '精测';
        full.push(result);
      }
      full.sort((a, b) => b.kbps - a.kbps);

      const merged = full.concat(quick.filter(q => !full.some(f => f.host === q.host)));
      const best = full[0];
      if (!best || generation !== mediaGeneration) return;
      const orig = full.find(result => result.host === origHost);
      const win = orig && best.kbps <= orig.kbps * MIN_GAIN ? origHost : best.host;

      cdnState.picked.set(key, win);
      saveCdnCache(key, win);
      if (win !== origHost) {
        cdnState.lastWinner = win;
        saveGlobalWinner(win);
      }
      cdnState.lastResults = { list: merged, win, origHost, why, ts: Date.now() };
      cdnState.perf.length = 0;
      console.log('[bili-cdn] 测速(' + why + ')',
        merged.map(result => `${shortName(result.host)}=${result.kbps}KB/s${result.note ? '(' + result.note + ')' : '(' + result.stage + ')'}`).join('  '),
        '→ 选用', win);
      renderHud(true);
    } finally {
      cdnState.probing.delete(probeKey);
    }
  }

  // 请求阶段只调用此函数，不接触播放信息响应。
  function rewriteSegmentUrl(raw) {
    let url;
    try { url = new URL(raw, location.href); } catch (e) { return raw; }
    if (!isMedia(url)) return raw;

    syncMediaIdentity();
    const key = keyOf(url);
    if (cdnState.curKey && cdnState.curKey !== key) resetMediaState('分片目录变化');
    cdnState.sawMedia = true;
    cdnState.missedWarning = false;
    cdnState.curKey = key;
    cdnState.lastProbeUrl = new URL(url.toString());
    let target = cdnState.picked.get(key) || loadCdnCache(key);
    if (target) cdnState.picked.set(key, target);

    if (!target) {
      runCdnProbe(url, '开播');
      target = cdnState.lastWinner;
    }
    const bad = cdnState.rejected.get(key);
    if (!target || target === url.hostname || cdnState.blacklist.has(target) || (bad && bad.has(target))) return raw;
    url.hostname = target;
    return url.toString();
  }

  // ---- 编码模块：播放数据改写，与 CDN 状态完全无关 ----
  function rewritePlayinfo(payload) {
    if (!isVideoPage()) return payload;
    syncMediaIdentity();
    try {
      const data = payload && (payload.data || payload.result || payload);
      if (!data || !data.dash || !Array.isArray(data.dash.video) || !data.dash.video.length) return payload;

      const all = data.dash.video;
      codecState.offered = [...new Set(all.map(item => CODEC_NAME[item.codecid] || item.codecid))];
      const nonAv1 = all.filter(item => item.codecid !== AV1);
      if (!nonAv1.length) return payload;

      codecState.stripped = all.length - nonAv1.length;
      const rank = prefer === 'avc' ? { 7: 0, 12: 1 } : { 12: 0, 7: 1 };
      const ordered = [...nonAv1];
      const slots = new Map();
      nonAv1.forEach((item, index) => {
        if (item.id == null) return;
        if (!slots.has(item.id)) slots.set(item.id, []);
        slots.get(item.id).push(index);
      });
      slots.forEach(indices => {
        const variants = indices.map(index => nonAv1[index])
          .sort((a, b) => (rank[a.codecid] ?? 9) - (rank[b.codecid] ?? 9));
        indices.forEach((slot, index) => { ordered[slot] = variants[index]; });
      });
      data.dash.video = ordered;

      if (Array.isArray(data.support_formats)) {
        data.support_formats.forEach(format => {
          if (Array.isArray(format.codecs)) {
            const left = format.codecs.filter(codec => !/^av01/i.test(codec));
            if (left.length) format.codecs = left;
          }
        });
      }
      renderHud(false);
    } catch (e) {
      console.warn('[硬解] 改写播放数据失败，已放行原始数据：', e);
    }
    return payload;
  }

  const PREFER_TYPE = { hevc: '1', avc: '2' };
  function patchCodecStrategy() {
    try { localStorage.setItem('bilibili_player_codec_prefer_type', PREFER_TYPE[prefer] || '1'); } catch (e) { }
    try {
      const key = 'bilibili_player_kv_config';
      const kv = JSON.parse(localStorage.getItem(key) || '{}');
      if (!kv.dash_config) return;
      kv.dash_config.default_codec_strategy = prefer === 'avc' ? ['avc', 'hevc'] : ['hevc', 'avc'];
      kv.dash_config.enable_av1 = 0;
      localStorage.setItem(key, JSON.stringify(kv));
    } catch (e) { }
  }

  function installPlayinfoHook() {
    let playinfo;
    try {
      const desc = Object.getOwnPropertyDescriptor(window, '__playinfo__');
      if (desc && !desc.configurable) {
        if (window.__playinfo__ && typeof window.__playinfo__ === 'object') rewritePlayinfo(window.__playinfo__);
        console.warn('[硬解] __playinfo__ 不可配置，只改写了已有值，后续赋值拦不到');
      } else {
        playinfo = rewritePlayinfo(window.__playinfo__);
        Object.defineProperty(window, '__playinfo__', {
          configurable: true,
          get: () => playinfo,
          set: value => { playinfo = rewritePlayinfo(value); },
        });
      }
    } catch (e) {
      console.warn('[硬解] 无法劫持 __playinfo__：', e);
    }
  }

  // ---- 统一劫持层：open / send / fetch 各安装一次 ----
  XMLHttpRequest.prototype.open = function (method, rawUrl, ...rest) {
    const playurl = isVideoPage() && isPlayurl(rawUrl);
    const out = typeof rawUrl === 'string' ? rewriteSegmentUrl(rawUrl) : rawUrl;
    this.__biliBoostPlayurl = playurl;
    try {
      const url = new URL(out, location.href);
      if (isMedia(url)) this.__biliBoostCdn = { host: url.hostname, url };
    } catch (e) { }
    return origOpen.call(this, method, out, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    if (this.__biliBoostCdn) {
      const started = performance.now();
      this.addEventListener('loadend', event => {
        const seconds = (performance.now() - started) / 1000;
        if (event.loaded > 65536 && seconds > 0.05) {
          cdnState.perf.push({ host: this.__biliBoostCdn.host, kbps: Math.round(event.loaded / 1024 / seconds) });
          if (cdnState.perf.length > PERF_WINDOW) cdnState.perf.shift();
          renderHud(false);
        }
      });
    }

    if (this.__biliBoostPlayurl) {
      const self = this;
      let rawText, outText, hasText = false, rawObject, outObject;
      const fromText = raw => {
        if (hasText && raw === rawText) return outText;
        try {
          const done = JSON.stringify(rewritePlayinfo(JSON.parse(raw)));
          rawText = raw;
          outText = done;
          hasText = true;
          return done;
        } catch (e) { return raw; }
      };
      const protoGetter = name => Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, name).get;
      try {
        Object.defineProperty(this, 'responseText', {
          configurable: true,
          get() { return fromText(protoGetter('responseText').call(self)); },
        });
      } catch (e) { console.warn('[硬解] responseText 劫持失败，已放行：', e); }
      try {
        Object.defineProperty(this, 'response', {
          configurable: true,
          get() {
            const raw = protoGetter('response').call(self);
            if (typeof raw === 'string') return fromText(raw);
            if (!raw || typeof raw !== 'object') return raw;
            if (raw === rawObject) return outObject;
            rawObject = raw;
            outObject = rewritePlayinfo(raw);
            return outObject;
          },
        });
      } catch (e) { console.warn('[硬解] response 劫持失败，已放行：', e); }
    }
    return origSend.apply(this, args);
  };

  window.fetch = async function (input, init) {
    const originalUrl = typeof input === 'string' ? input : (input && input.url) || '';
    if (typeof input === 'string') {
      input = rewriteSegmentUrl(input);
    } else if (input instanceof Request) {
      const rewritten = rewriteSegmentUrl(input.url);
      if (rewritten !== input.url) input = new Request(rewritten, input);
    }
    const response = await origFetch.call(this, input, init);
    if (!isVideoPage() || !isPlayurl(originalUrl)) return response;
    try {
      const body = JSON.stringify(rewritePlayinfo(await response.clone().json()));
      const headers = new Headers(response.headers);
      headers.delete('content-length');
      headers.delete('content-encoding');
      return new Response(body, { status: response.status, statusText: response.statusText, headers });
    } catch (e) {
      return response;
    }
  };

  // ---- 编码页专属初始化必须在 document-start 同步完成 ----
  if (isVideoPage()) {
    patchCodecStrategy();
    installPlayinfoHook();

    const addSourceBuffer = MediaSource.prototype.addSourceBuffer;
    MediaSource.prototype.addSourceBuffer = function (mime) {
      if (/video\//i.test(String(mime))) {
        syncMediaIdentity();
        codecState.picked = String(mime);
        codecState.efficient = null;
        queueMicrotask(updateCodecStatus);
      }
      return addSourceBuffer.call(this, mime);
    };
  }

  function codecLabel(mime) {
    if (/av01/i.test(mime)) return 'AV1';
    if (/hvc1|hev1/i.test(mime)) return 'HEVC/H.265';
    if (/avc1/i.test(mime)) return 'AVC/H.264';
    return mime || '未检测编码';
  }

  async function updateCodecStatus() {
    if (!codecState.picked) return;
    const generation = mediaGeneration;
    const picked = codecState.picked;
    const video = document.querySelector('video');
    if (video && !video.videoWidth) {
      await new Promise(resolve => {
        let timer;
        const done = () => {
          clearTimeout(timer);
          video.removeEventListener('loadedmetadata', done);
          resolve();
        };
        video.addEventListener('loadedmetadata', done, { once: true });
        timer = setTimeout(done, 1500);
      });
    }

    let efficient = null;
    try {
      const info = await navigator.mediaCapabilities.decodingInfo({
        type: 'media-source',
        video: {
          contentType: picked,
          width: video?.videoWidth || 1920,
          height: video?.videoHeight || 1080,
          bitrate: 4000000,
          framerate: 30,
        },
      });
      efficient = info.powerEfficient;
    } catch (e) { /* 查询失败必须保持“未知”，不能按编码名猜 */ }
    if (generation !== mediaGeneration || picked !== codecState.picked) return;
    codecState.efficient = efficient;
    renderHud(false);
  }

  // ---- 播放闭环：真卡了就换源 ----
  function onStall() {
    cdnState.stalls++;
    renderHud(false);
    const key = cdnState.curKey;
    const current = key && cdnState.picked.get(key);
    if (!current || Date.now() - cdnState.lastRetest < RETEST_COOLDOWN) return;
    cdnState.lastRetest = Date.now();
    if (!cdnState.rejected.has(key)) cdnState.rejected.set(key, new Set());
    cdnState.rejected.get(key).add(current);
    cdnState.picked.delete(key);
    try { sessionStorage.removeItem('biliCdn:' + key); } catch (e) { }
    console.warn('[bili-cdn] 卡顿 → 弃用', current, '重新测速');
    if (cdnState.lastProbeUrl) runCdnProbe(cdnState.lastProbeUrl, '卡顿重测');
  }
  document.addEventListener('waiting', onStall, true);
  document.addEventListener('stalled', onStall, true);

  function medianKbps() {
    if (!cdnState.perf.length) return null;
    const values = cdnState.perf.map(item => item.kbps).sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)];
  }
  function efficiencyText() {
    if (codecState.efficient === true) return ['🟢 硬解', '#6c6'];
    if (codecState.efficient === false) return ['🔴 软解', '#f66'];
    return ['⚪ 未知', '#bbb'];
  }

  function setHudEnabled(on) {
    hudOn = on !== false;
    configSet('hud', hudOn);
    try { localStorage.setItem('biliCdnHud', hudOn ? 'on' : 'off'); } catch (e) { }
    if (!hudOn) document.getElementById('bili-boost-hud')?.remove();
    else renderHud(false);
    return hudOn;
  }

  function ensureHud() {
    let box = document.getElementById('bili-boost-hud');
    if (box) return box;
    box = document.createElement('div');
    box.id = 'bili-boost-hud';
    box.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;background:rgba(20,20,22,.88);' +
      'color:#ddd;font:11px/1.55 ui-monospace,Menlo,monospace;padding:6px 10px;border-radius:7px;' +
      'box-shadow:0 3px 14px rgba(0,0,0,.4);white-space:pre;transition:opacity .4s;cursor:pointer;user-select:none';
    box.addEventListener('click', event => {
      const action = event.target.closest('[data-action]')?.dataset.action;
      if (action === 'prefer') {
        event.stopPropagation();
        prefer = prefer === 'avc' ? 'hevc' : 'avc';
        configSet('prefer', prefer);
        patchCodecStrategy();
        location.reload();
        return;
      }
      if (action === 'hud') {
        event.stopPropagation();
        setHudEnabled(false);
        return;
      }
      hudExpanded = !hudExpanded;
      renderHud(false);
    });
    document.body.appendChild(box);
    return box;
  }

  function renderHud(expand) {
    if (!hudOn) return;
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', () => renderHud(expand), { once: true });
      return;
    }
    if (expand) hudExpanded = true;
    const box = ensureHud();
    const current = (cdnState.curKey && cdnState.picked.get(cdnState.curKey)) || cdnState.lastWinner;
    const real = medianKbps();
    const cdnLine = (cdnState.missedWarning ? '<span style="color:#ec9">⚠️ 没拦到分片请求</span> · ' : '') +
      `<b style="color:#fb7299">${current ? shortName(current) : '未选源'}</b>` +
      (real ? ` · 实测 <b style="color:${real > 400 ? '#6c6' : '#ec9'}">${real}</b> KB/s` : ' · 实测 —') +
      (cdnState.stalls ? ` · <span style="color:#f66">卡顿 ${cdnState.stalls}</span>` : ' · 卡顿 0');
    const [status, statusColor] = efficiencyText();
    const codecLine = `<span style="color:${statusColor}">${status}</span> · ${codecLabel(codecState.picked)}`;

    if (!hudExpanded) {
      box.innerHTML = cdnLine + '<br>' + codecLine;
      return;
    }

    let probeRows = '<span style="color:#888">尚无测速结果</span>';
    if (cdnState.lastResults) {
      probeRows = cdnState.lastResults.list.map(result => {
        const mark = result.host === cdnState.lastResults.win ? '✅' : (result.host === cdnState.lastResults.origHost ? '原' : '　');
        const color = result.kbps === 0 ? '#f66' : result.kbps > 400 ? '#6c6' : '#ec9';
        const tag = result.note ? result.note : result.stage;
        return `${mark} ${shortName(result.host).padEnd(7)} <span style="color:${color}">${String(result.kbps).padStart(5)}</span> KB/s <span style="color:#888">${tag}</span>`;
      }).join('<br>');
      if (cdnState.lastResults.win === cdnState.lastResults.origHost) {
        probeRows += '<br><span style="color:#888">原始源够快，未改写</span>';
      }
    }
    const offered = codecState.offered.length ? codecState.offered.join(' / ') : '—';
    box.innerHTML = `<span style="color:#888">CDN 测速${cdnState.lastResults ? '(' + cdnState.lastResults.why + ') · 精测为准' : ''}</span><br>${probeRows}` +
      `<hr style="border:0;border-top:1px solid #444;margin:5px 0"><span style="color:#888">编码信息</span><br>` +
      `${codecLine}<br>编码：${codecLabel(codecState.picked)}<br>powerEfficient：${codecState.efficient == null ? '未知' : codecState.efficient}<br>` +
      `已剔除 AV1：${codecState.stripped} 条<br>B站提供：${offered}` +
      `<hr style="border:0;border-top:1px solid #444;margin:5px 0">` +
      `<span data-action="prefer" style="color:#8cf">编码偏好：${prefer === 'avc' ? 'H.264' : 'H.265'}（点击切换）</span><br>` +
      `<span data-action="hud" style="color:#8cf">HUD：开（点击关闭）</span>` +
      `<hr style="border:0;border-top:1px solid #444;margin:5px 0">${cdnLine}`;
    if (expand) {
      clearTimeout(box.__collapseTimer);
      box.__collapseTimer = setTimeout(() => {
        hudExpanded = false;
        renderHud(false);
      }, 10000);
    }
  }

  // ---- 调试接口：原 __biliCdn 八项保持不变，在其上增加编码字段 ----
  const debugApi = {
    get 当前源() { return (cdnState.curKey && cdnState.picked.get(cdnState.curKey)) || cdnState.lastWinner; },
    get 实测速度() { return medianKbps() + ' KB/s（最近 ' + cdnState.perf.length + ' 个分片中位数）'; },
    get 分片明细() { return cdnState.perf.slice(); },
    get 测速结果() { return cdnState.lastResults; },
    get 卡顿次数() { return cdnState.stalls; },
    get 黑名单() { return [...cdnState.blacklist]; },
    重测() {
      if (cdnState.lastProbeUrl) {
        cdnState.picked.delete(cdnState.curKey);
        runCdnProbe(cdnState.lastProbeUrl, '手动');
        return '测速中…';
      }
      return '还没拦到分片';
    },
    面板(on) { return setHudEnabled(on) ? '已开' : '已关'; },
    get 当前编码() { return codecState.picked; },
    get 编码名称() { return codecLabel(codecState.picked); },
    get 硬解状态() { return codecState.efficient === true ? '硬解' : codecState.efficient === false ? '软解' : '未知'; },
    get 已剔除AV1() { return codecState.stripped; },
    get B站提供编码() { return codecState.offered.slice(); },
    get 编码偏好() { return prefer; },
  };
  window.__biliBoost = debugApi;
  window.__biliCdn = debugApi;

  console.log('[bili-boost] v1.0.0 已注入，控制台可用 __biliBoost / __biliCdn 查看状态');
  renderHud(false);
  scheduleMediaWarning();
})();
