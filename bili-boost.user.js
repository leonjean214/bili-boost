// ==UserScript==
// @name         哔哩哔哩播放优化（CDN 测速切源 + 强制硬解编码）
// @namespace    https://github.com/leonjean214/bili-boost
// @version      1.4.0
// @description  CDN 两阶段多点测速切源，并剔除 AV1、优先 HEVC/H.264，降低海外播放卡顿与软解发热。
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

  // ---- CDN 配置 ----
  const CANDIDATES = [
    'upos-sz-mirror08c.bilivideo.com',
    'upos-sz-mirrorali.bilivideo.com',
    'upos-sz-mirrorcos.bilivideo.com',
    'upos-sz-mirrorhw.bilivideo.com',
    'upos-sz-mirrorcosov.bilivideo.com',
  ];
  // 不主动把 bilivideo URL 合成为 Akamai：跨供应商签名可能绑定 host，实测常见 403。
  // 若播放器原地址本来就是 akamaized.net，它仍会作为 origHost 参加测速，但不会跨域族改写。
  const QUICK_BYTES = 131072;
  const FULL_BYTES = 786432;
  const PRECISION_POINT_BYTES = Math.floor(FULL_BYTES / 2);
  const MID_RANGE_OFFSET = 1024 * 1024;
  const FINALISTS = 3;
  const PROBE_TIMEOUT = 8000;
  const DECODING_INFO_TIMEOUT = 3000;
  const AV1_HW_CACHE_TTL = 30 * 24 * 3600e3;
  const FETCH_MEASURE_TIMEOUT = 30000;
  const FETCH_MEASURE_MAX_BYTES = 32 * 1024 * 1024;
  // 没有可靠的 Wi-Fi/VPN 变更信号；缓存过长会让同一视频在换网后粘住旧源。
  const CACHE_TTL = 30 * 60e3;
  const MIN_GAIN = 1.25;
  const RETEST_COOLDOWN = 45e3;
  const PERF_WINDOW = 6;

  // ---- 主机健康档案：跨会话统计成功率。稳定性优先于峰值速度——
  // 一台“70% 时候飞快、30% 超时”的主机，体验差于一台始终中等的主机。 ----
  const HEALTH_KEY = 'bhw_health';
  const HEALTH_MIN_ATTEMPTS = 3;     // 样本不足先按最佳档探索；每轮快筛都会让它很快脱离该档
  const HEALTH_RATIO_DELTA = 0.15;   // 成功率分档宽度；同一档内再比本轮速度
  const HEALTH_MAX_AGE = 7 * 24 * 3600e3;
  const HEALTH_MAX_HOSTS = 32;
  const HEALTH_MAX_ATTEMPTS = 24;    // 到上限后衰减旧样本，避免陈年成功率支配当前网络
  const HEALTH_SPEED_ALPHA = 0.4;    // 速度/TTFB 走指数滑动平均，新样本权重
  const IDLE_BUFFER_SEC = 12;
  const IDLE_MAX_WAIT = 8000;
  const STALL_CONFIRM_MS = 1200;
  const STALL_SEEK_GRACE = 2500;
  const STALL_LOAD_GRACE = 3000;
  const STALL_DEDUP_MS = 3000;

  function normalizeHealth(raw, now = Date.now()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return Object.create(null);
    const entries = [];
    for (const [host, value] of Object.entries(raw)) {
      if (!host || host.length > 253 || !value || typeof value !== 'object') continue;
      const oldAttempts = Math.floor(value.attempts);
      const oldSuccesses = Math.floor(value.successes);
      const at = Number(value.at);
      if (!Number.isFinite(oldAttempts) || oldAttempts < 1 ||
          !Number.isFinite(oldSuccesses) || oldSuccesses < 0 ||
          !Number.isFinite(at) || now - at >= HEALTH_MAX_AGE) continue;
      const attempts = Math.min(oldAttempts, HEALTH_MAX_ATTEMPTS);
      const successes = Math.min(attempts,
        Math.round(Math.min(oldSuccesses, oldAttempts) / oldAttempts * attempts));
      const kbps = Math.round(value.kbps);
      const ttfb = Math.round(value.ttfb);
      entries.push([host, {
        attempts,
        successes,
        kbps: Number.isFinite(kbps) && kbps > 0 ? kbps : 0,
        ttfb: Number.isFinite(ttfb) && ttfb >= 0 ? ttfb : 0,
        at: Math.min(at, now),
      }]);
    }
    entries.sort((a, b) => b[1].at - a[1].at || a[0].localeCompare(b[0]));
    const out = Object.create(null);
    entries.slice(0, HEALTH_MAX_HOSTS).forEach(([host, value]) => { out[host] = value; });
    return out;
  }

  function loadHealth() {
    try { return normalizeHealth(JSON.parse(localStorage.getItem(HEALTH_KEY) || '{}')); }
    catch (e) { return Object.create(null); }
  }
  let health = loadHealth();
  let healthDirty = false;
  function saveHealth(force = false) {
    if (!force && !healthDirty) return;
    health = normalizeHealth(health);
    try {
      localStorage.setItem(HEALTH_KEY, JSON.stringify(health));
      healthDirty = false;
    } catch (e) { }
  }
  function probeSucceeded(result) {
    // 超时只拿到一截数据仍可展示速度，但对“稳定可用”应记作失败。
    // note 只负责展示；Range 不可用等提示可以与成功状态并存。
    return !!result && result.ok === true && result.kbps > 0;
  }
  function recordProbe(result) {
    if (!result || !result.host) return;
    const r = health[result.host] || (health[result.host] = { attempts: 0, successes: 0, kbps: 0, at: 0 });
    if (r.attempts >= HEALTH_MAX_ATTEMPTS) {
      const kept = Math.floor(HEALTH_MAX_ATTEMPTS / 2);
      r.successes = Math.round(r.successes / r.attempts * kept);
      r.attempts = kept;
    }
    r.attempts++;
    if (probeSucceeded(result)) {
      r.successes++;
      r.kbps = r.kbps
        ? Math.round(r.kbps * (1 - HEALTH_SPEED_ALPHA) + result.kbps * HEALTH_SPEED_ALPHA)
        : result.kbps;
      if (Number.isFinite(result.ttfb) && result.ttfb >= 0) {
        r.ttfb = r.ttfb
          ? Math.round(r.ttfb * (1 - HEALTH_SPEED_ALPHA) + result.ttfb * HEALTH_SPEED_ALPHA)
          : Math.round(result.ttfb);
      }
    }
    r.at = Date.now();
    healthDirty = true;
  }
  function ratioOf(host) {
    const r = health[host];
    if (!r || r.attempts < HEALTH_MIN_ATTEMPTS) return null;
    return r.successes / r.attempts;
  }
  function healthTier(host) {
    const ratio = ratioOf(host);
    if (ratio === null) return 0;     // 乐观探索，但最多两个样本后就会得到真实分档
    return Math.floor(Math.max(0, 1 - ratio - Number.EPSILON) / HEALTH_RATIO_DELTA);
  }
  // 用“首字节 + 传输时间”估算一个标准精测样本的交付耗时，让 TTFB 与净吞吐各自有意义。
  function deliveryMs(result) {
    if (Number.isFinite(result?.deliveryMs) && result.deliveryMs >= 0) return result.deliveryMs;
    if (!result || !Number.isFinite(result.kbps) || result.kbps <= 0) return Infinity;
    const ttfb = Number.isFinite(result.ttfb) && result.ttfb >= 0 ? result.ttfb : 0;
    return ttfb + FULL_BYTES / 1024 / result.kbps * 1000;
  }
  // 严格排序键：本轮成功 > 健康档 > 估算交付耗时 > TTFB > host。
  // 每一级都是普通数值/字符串全序，避免带容差的两两比较产生非传递环。
  function compareHosts(a, b) {
    const current = Number(probeSucceeded(b)) - Number(probeSucceeded(a));
    if (current) return current;
    const tier = healthTier(a.host) - healthTier(b.host);
    if (tier) return tier;
    const delivery = deliveryMs(a) - deliveryMs(b);
    if (delivery) return delivery;
    const aTtfb = Number.isFinite(a.ttfb) ? a.ttfb : Infinity;
    const bTtfb = Number.isFinite(b.ttfb) ? b.ttfb : Infinity;
    return aTtfb - bTtfb || a.host.localeCompare(b.host);
  }

  // 精测合计要下 2MB+，播放中做等于跟正片抢带宽，可能自己造成卡顿。
  // 等缓冲充足或暂停再测；代次变化或等待期间真卡顿时立即停止等待。
  function waitForIdle(maxWait, shouldStop) {
    return new Promise(resolve => {
      const deadline = Date.now() + maxWait;
      const check = () => {
        try { if (shouldStop && shouldStop()) return resolve(); } catch (e) { return resolve(); }
        const v = document.querySelector('video');
        if (!v || v.paused) return resolve();
        try {
          const b = v.buffered;
          for (let i = 0; i < b.length; i++) {
            if (b.start(i) <= v.currentTime + 0.25 && b.end(i) >= v.currentTime &&
                b.end(i) - v.currentTime >= IDLE_BUFFER_SEC) return resolve();
          }
        } catch (e) { return resolve(); }
        if (Date.now() >= deadline) return resolve();
        setTimeout(check, 500);
      };
      check();
    });
  }

  const UPOS_HOST = /(^|\.)((upos-[a-z0-9-]+\.bilivideo\.com)|(upos-[a-z0-9-]+\.akamaized\.net))$/;
  const MEDIA_EXT = /\.(m4s|mp4|flv)$/;
  const VIDEO_PATH = /^\/(video\/|bangumi\/play\/|list\/|festival\/)/;
  const CODEC_NAME = { 7: 'AVC/H.264', 12: 'HEVC/H.265', 13: 'AV1' };
  const AV1 = 13;

  // 本脚本刻意不加 @noframes —— CDN 模块要在 iframe 内嵌播放器里继续生效。
  // 但 B站有同源 iframe（如登录轮询用的 /correspond/），脚本在里面照样会跑，
  // 那里既不是视频页也拦不到分片。HUD 必须只由顶层窗口绘制，
  // 否则 iframe 会画出第二个 HUD，内容是「没拦到分片请求 / 未检测编码」。
  const SCRIPT_VERSION = 'v1.4.0';   // ⚠️ 改版本时要和文件头的 @version 一起改

  const IS_TOP = (() => { try { return window.top === window.self; } catch (e) { return false; } })();

  // 已确认与媒体无关的同源 iframe 直接退出，连 hook 和定时器都不装。
  // /correspond/ 是 B站登录态轮询用的，实测就是它画出了第二个 HUD。
  // 其余未知 iframe 仍保留被动 CDN hook —— 万一里面是内嵌播放器，切源依然要生效。
  const NON_MEDIA_FRAME = /^\/correspond\//;
  if (!IS_TOP && NON_MEDIA_FRAME.test(location.pathname)) return;

  const origFetch = window.fetch;
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  // 两个模块的状态严格隔离。全局坏源/赢家沿用会话语义，其余按媒体重置。
  const cdnState = {
    blacklist: new Set(),
    rejected: new Map(),
    picked: new Map(),
    manual: new Map(),
    probing: new Set(),
    perf: [],
    lastResults: null,
    lastWinner: loadGlobalWinner(),
    stalls: 0,
    lastRetest: 0,
    sawMedia: false,
    missedWarning: false,
    curKey: null,
    activeHost: null,
    lastProbeUrl: null,
  };
  const codecState = { stripped: 0, picked: null, offered: [], efficient: null };
  const playbackState = {
    video: null,
    hasAdvanced: false,
    lastTime: 0,
    lastAdvanceAt: 0,
    suppressUntil: performance.now() + STALL_LOAD_GRACE,
    pending: null,
    lastConfirmedAt: 0,
  };
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
  // 编码模块三态：'auto'（默认，按本机有没有 AV1 硬解自动决定）| true 强制开 | false 强制关。
  // 有 AV1 硬解的机器（RTX 40/50 系、Arc、较新核显）不该剔除 AV1——那等于放弃压缩率更高的编码
  // 去换 HEVC，费带宽又掉画质；无硬解的机器（M1/M2 Mac）则必须剔除，否则软解发热卡顿。
  let codecMode = configGet('codec', 'auto');
  if (codecMode !== true && codecMode !== false) codecMode = 'auto';

  // 本机 AV1 硬解能力缓存：null 未知 / true 有 / false 无。
  // 缓存同时绑定浏览器环境并设 30 天 TTL；旧版裸 boolean 会自动失效并重探一次。
  function av1CacheEnvironment() {
    return [navigator.userAgent || '', navigator.platform || '', navigator.hardwareConcurrency || ''].join('|');
  }
  function loadAv1HwCache() {
    const cached = configGet('av1hw', null);
    const at = Number(cached?.at);
    const valid = cached && typeof cached === 'object' && !Array.isArray(cached) &&
      (cached.value === true || cached.value === false) && Number.isFinite(at) &&
      at <= Date.now() && Date.now() - at < AV1_HW_CACHE_TTL && cached.env === av1CacheEnvironment();
    if (valid) return cached.value;
    // 旧版裸 boolean、过期值和环境不匹配值都显式清掉；若重探失败，存储和内存都保持 null。
    if (cached !== null) configSet('av1hw', null);
    return null;
  }
  let av1Hw = loadAv1HwCache();
  let av1ProbePromise = null;
  let av1ProbeGeneration = 0;
  let av1ProbePending = false;

  // auto 下“未知”一律按“无硬解”处理：误判成有硬解会让软解机器发热卡顿（后果重），
  // 误判成无硬解只是多费点带宽（后果轻）。不确定时选后果轻的那边。
  function codecActive() {
    if (codecMode === true) return true;
    if (codecMode === false) return false;
    return av1Hw !== true;
  }

  function codecModeLabel() {
    if (codecMode === true) return '强制开';
    if (codecMode === false) return '强制关（仅 CDN 加速）';
    const d = av1Hw === true ? '本机有 AV1 硬解 → 不干预'
            : av1Hw === false ? '本机无 AV1 硬解 → 剔除 AV1'
            : av1ProbePending ? '探测中 → 暂按剔除 AV1'
            : '未知 → 暂按剔除 AV1';
    return '自动｜' + d;
  }

  // 某些 Chromium 环境的 decodingInfo promise 会永久 pending；超时后只放弃等待，
  // 原 promise 即使稍后 resolve/reject 也不会再写回状态。
  function withTimeout(promise, timeout) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('timeout'));
      }, timeout);
      Promise.resolve(promise).then(value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      }, error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  // 只在没有缓存时跑一次。探测失败保持 null（下次再探），绝不按机型或编码名猜。
  function probeAv1Hw(force = false) {
    if (!force && av1Hw !== null) return Promise.resolve(av1Hw);
    if (!force && av1ProbePromise) return av1ProbePromise;

    const generation = ++av1ProbeGeneration;
    if (force) {
      av1Hw = null;
      configSet('av1hw', null);
    }
    av1ProbePending = true;
    renderHud(false);
    const task = (async () => {
      let ok = null;
      try {
        const info = await withTimeout(navigator.mediaCapabilities.decodingInfo({
          type: 'media-source',
          video: {
            contentType: 'video/mp4; codecs="av01.0.08M.08"',
            width: 1920, height: 1080, bitrate: 4000000, framerate: 30,
          },
        }), DECODING_INFO_TIMEOUT);
        if (info && info.supported === false) ok = false;
        else if (info && info.supported === true && typeof info.powerEfficient === 'boolean') ok = info.powerEfficient;
      } catch (e) { ok = null; }

      // 手动重探会使旧探测失效，防止较晚返回的旧结果覆盖新结果。
      if (generation !== av1ProbeGeneration) return av1Hw;
      if (ok !== null) {
        av1Hw = ok;
        configSet('av1hw', { value: ok, at: Date.now(), env: av1CacheEnvironment() });
      }
      return av1Hw;
    })();
    av1ProbePromise = task.finally(() => {
      if (generation !== av1ProbeGeneration) return;
      av1ProbePending = false;
      av1ProbePromise = null;
      renderHud(false);
    });
    return av1ProbePromise;
  }
  let hudOn = (() => {
    let cdnOn = true;
    try { cdnOn = localStorage.getItem('biliCdnHud') !== 'off'; } catch (e) { }
    return cdnOn && configGet('hud', true);
  })();
  let hudExpanded = false;
  let debugApi = null;

  // 旧版会安装自己的 fetch/XHR hook，无法可靠拆除；这里只识别、告警并隐藏旧 HUD。
  // __biliCdn 可能先被旧版占用，也可能在本脚本设置别名后又被覆盖，所以检测既在
  // 初始化末尾执行，也复用顶层窗口现有的 500ms 状态同步持续检查。
  const legacyConflict = { detected: false, signals: new Set(), warned: false };
  function detectLegacyConflict() {
    if (!IS_TOP) return false;
    const wasDetected = legacyConflict.detected;
    const legacyHud = document.getElementById('bili-cdn-hud');
    if (legacyHud) {
      legacyConflict.signals.add('#bili-cdn-hud');
      legacyHud.style.setProperty('display', 'none', 'important');
    }
    if (window.__biliCdn && window.__biliCdn !== debugApi) {
      legacyConflict.signals.add('window.__biliCdn 指向其他脚本');
    }
    legacyConflict.detected = legacyConflict.signals.size > 0;
    if (legacyConflict.detected && !legacyConflict.warned) {
      legacyConflict.warned = true;
      console.warn('[bili-boost] 检测到旧版 bili-cdn-fix 仍在运行；请到 Userscripts / AdGuard → Extensions / Tampermonkey 中停用旧脚本。');
    }
    return !wasDetected && legacyConflict.detected;
  }

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
    cdnState.manual.clear();
    cdnState.probing.clear();
    cdnState.perf.length = 0;
    cdnState.lastResults = null;
    cdnState.stalls = 0;
    cdnState.lastRetest = 0;
    cdnState.sawMedia = false;
    cdnState.missedWarning = false;
    cdnState.curKey = null;
    cdnState.activeHost = null;
    cdnState.lastProbeUrl = null;
    codecState.stripped = 0;
    codecState.picked = null;
    codecState.offered = [];
    codecState.efficient = null;
    resetPlaybackTracking(document.querySelector('video'), STALL_LOAD_GRACE);
    renderHud(false);
    scheduleMediaWarning(mediaGeneration);
    console.log('[bili-boost] 新媒体状态已重置：' + reason);
  }
  function syncMediaIdentity() {
    const conflictChanged = detectLegacyConflict();
    const next = mediaIdentity();
    if (next !== currentMediaId) resetMediaState('页面切换', next);
    else if (conflictChanged) renderHud(false);
  }
  // SPA 路由监听只有顶层需要：iframe 不画 HUD，也不展示媒体态，
  // 每个 iframe 再起一个 500ms 轮询纯属浪费。
  if (IS_TOP) {
    addEventListener('popstate', syncMediaIdentity);
    addEventListener('hashchange', syncMediaIdentity);
    setInterval(syncMediaIdentity, 500);
  }

  function scheduleMediaWarning(generation = mediaGeneration) {
    // 只有顶层视频页才该提示「没拦到分片」。iframe 不显示 HUD，
    // 非视频页（首页/空间/动态）本来就没有分片请求，报了就是误报。
    if (!IS_TOP || !isVideoPage()) return;
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
  const hostFamily = host => host.endsWith('.bilivideo.com') ? 'bilivideo'
    : host.endsWith('.akamaized.net') ? 'akamai' : 'other';
  const canRewriteHost = (from, to) => from === to ||
    (hostFamily(from) === 'bilivideo' && hostFamily(to) === 'bilivideo');
  function compatibleHostPool(origHost = cdnState.lastResults?.origHost || cdnState.lastProbeUrl?.hostname) {
    if (!origHost) return [];
    return [origHost, ...CANDIDATES].filter((host, index, all) =>
      all.indexOf(host) === index && UPOS_HOST.test(host) && canRewriteHost(origHost, host));
  }
  const currentCdnSource = (key = cdnState.curKey) => key
    ? (cdnState.manual.get(key) || cdnState.activeHost || cdnState.picked.get(key) || null)
    : cdnState.lastWinner;
  function clearCdnCache(key) {
    try { sessionStorage.removeItem('biliCdn:' + key); } catch (e) { }
  }

  function probeMetrics(got, firstChunkBytes, started, firstAt, ended) {
    const totalMs = Math.max(1, ended - started);
    const ttfb = firstAt == null ? null : Math.max(0, Math.round(firstAt - started));
    const afterFirst = Math.max(0, got - firstChunkBytes);
    const transferMs = firstAt == null ? 0 : ended - firstAt;
    // 去掉等待首字节和首块，得到较纯的传输吞吐；样本太短时退回端到端速度。
    const kbps = afterFirst >= 32768 && transferMs >= 10
      ? Math.round(afterFirst / 1024 / (transferMs / 1000))
      : Math.round(got / 1024 / (totalMs / 1000));
    const effectiveKbps = Math.round(got / 1024 / (totalMs / 1000));
    return {
      kbps,
      effectiveKbps,
      ttfb,
      deliveryMs: (ttfb || 0) + FULL_BYTES / 1024 / Math.max(1, kbps) * 1000,
    };
  }

  // ---- CDN：单个候选、单个位置测速 ----
  async function probeCdn(url, host, bytes, { offset = 0, point = '头部' } = {}) {
    const target = new URL(url.toString());
    target.hostname = host;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT);
    const headers = offset > 0 ? { Range: `bytes=${offset}-${offset + bytes - 1}` } : undefined;
    let got = 0;
    let firstAt = null;
    let firstChunkBytes = 0;
    const started = performance.now();
    try {
      const res = await origFetch.call(window, target.toString(), {
        credentials: 'omit', cache: 'no-store', signal: ctl.signal, headers,
      });
      // 中段 Range 是额外诊断能力：服务器不支持或签名不允许时退回头部结果，
      // 不能因此误判一个真实播放仍可用的 host 为坏源。
      if (offset > 0 && res.status !== 206) {
        res.body?.cancel().catch(() => { });
        return { host, ok: false, skipped: true, kbps: 0, ttfb: Math.round(performance.now() - started), point,
          note: `Range 不可用(HTTP ${res.status})` };
      }
      if (!res.ok || !res.body) {
        cdnState.blacklist.add(host);
        return { host, ok: false, kbps: 0, ttfb: Math.round(performance.now() - started), point,
          note: 'HTTP ' + res.status };
      }
      const reader = res.body.getReader();
      while (got < bytes) {
        const { done, value } = await reader.read();
        if (done) break;
        const now = performance.now();
        if (firstAt == null) {
          firstAt = now;
          firstChunkBytes = value.length;
        }
        got += value.length;
      }
      reader.cancel().catch(() => { });
      const ended = performance.now();
      if (got < 32768) {
        return { host, ok: false, skipped: offset > 0, kbps: 0,
          ttfb: firstAt == null ? Math.round(ended - started) : Math.round(firstAt - started), point,
          note: offset > 0 ? '中段数据不足' : '数据不足' };
      }
      return { host, ok: true, ...probeMetrics(got, firstChunkBytes, started, firstAt, ended), bytes: got, point };
    } catch (e) {
      const ended = performance.now();
      // 无数据的中段请求可能只是浏览器/服务端不接受 Range，保守退回头部，不污染黑名单。
      if (offset > 0 && got === 0 && e.name !== 'AbortError') {
        return { host, ok: false, skipped: true, kbps: 0, ttfb: Math.round(ended - started), point,
          note: 'Range 请求失败' };
      }
      if (offset === 0 && e.name !== 'AbortError') cdnState.blacklist.add(host);
      const metrics = got >= 32768
        ? probeMetrics(got, firstChunkBytes, started, firstAt, ended)
        : { kbps: 0, effectiveKbps: 0, ttfb: firstAt == null ? Math.round(ended - started) : Math.round(firstAt - started), deliveryMs: Infinity };
      return { host, ok: false, ...metrics, bytes: got, point,
        note: e.name === 'AbortError' ? (got ? '超时截断' : '超时') : '失败' };
    } finally {
      clearTimeout(timer);
    }
  }

  async function probePrecision(url, host) {
    const head = await probeCdn(url, host, PRECISION_POINT_BYTES, { point: '头' });
    if (!probeSucceeded(head)) {
      return { ...head, stage: '精测(头+中)', points: [head], note: '头部' + (head.note || '失败') };
    }
    const middle = await probeCdn(url, host, PRECISION_POINT_BYTES,
      { offset: MID_RANGE_OFFSET, point: '中' });
    const points = [head, middle];
    const usable = points.filter(probeSucceeded);
    const ok = probeSucceeded(head) && (middle.skipped || probeSucceeded(middle));
    return {
      host,
      ok,
      kbps: Math.min(...usable.map(item => item.kbps)),
      effectiveKbps: Math.min(...usable.map(item => item.effectiveKbps || item.kbps)),
      ttfb: Math.max(...usable.map(item => Number.isFinite(item.ttfb) ? item.ttfb : 0)),
      deliveryMs: Math.max(...usable.map(deliveryMs)),
      bytes: usable.reduce((sum, item) => sum + (item.bytes || 0), 0),
      stage: '精测(头+中)',
      points,
      note: ok ? (middle.skipped ? '中段' + middle.note : '') : '中段' + (middle.note || '失败'),
    };
  }

  // ---- CDN：两阶段测速 ----
  async function runCdnProbe(url, why) {
    const key = keyOf(url);
    const generation = mediaGeneration;
    const probeKey = generation + ':' + key;
    if (cdnState.probing.has(probeKey)) return;
    cdnState.probing.add(probeKey);
    try {
      const origHost = url.hostname;
      const bad = cdnState.rejected.get(key) || new Set();
      const pool = compatibleHostPool(origHost).filter(host =>
        !cdnState.blacklist.has(host) && !bad.has(host)
      );
      if (!pool.length) return;

      const quick = await Promise.all(pool.map(host => probeCdn(url, host, QUICK_BYTES)));
      quick.forEach(result => { result.stage = '快筛'; recordProbe(result); });
      quick.sort(compareHosts);

      const finalists = quick.filter(probeSucceeded).slice(0, FINALISTS);
      if (!finalists.length) return;
      const full = [];
      const stallsBeforeWait = cdnState.stalls;
      if (why !== '卡顿重测') {
        await waitForIdle(IDLE_MAX_WAIT,
          () => generation !== mediaGeneration || cdnState.stalls !== stallsBeforeWait);
      }
      if (generation !== mediaGeneration) return;
      for (const finalist of finalists) {
        const latestBad = cdnState.rejected.get(key);
        if (cdnState.blacklist.has(finalist.host) || (latestBad && latestBad.has(finalist.host))) continue;
        const result = await probePrecision(url, finalist.host);
        recordProbe(result);
        full.push(result);
        if (generation !== mediaGeneration) return;
      }
      full.sort(compareHosts);

      const merged = full.concat(quick.filter(q => !full.some(f => f.host === q.host)));
      // 测速期间也可能因真实播放卡顿把临时源加入拒绝名单；最终选择必须读取最新集合。
      const latestBad = cdnState.rejected.get(key);
      const eligible = full.filter(result => probeSucceeded(result) &&
        !cdnState.blacklist.has(result.host) && !(latestBad && latestBad.has(result.host)));
      const best = eligible[0];
      if (!best || generation !== mediaGeneration) return;
      const orig = eligible.find(result => result.host === origHost);
      // 原始源保护只在同一健康档内生效；候选的估算交付时间至少快 25% 才切走。
      const keepOrig = orig && healthTier(orig.host) === healthTier(best.host) &&
        deliveryMs(best) >= deliveryMs(orig) / MIN_GAIN;
      const win = keepOrig ? origHost : best.host;

      // 用户在测速期间手选了源时，只更新自动结论和缓存，不夺回控制权。
      const manualHost = cdnState.manual.get(key);
      if (!manualHost) cdnState.picked.set(key, win);
      saveCdnCache(key, win);
      if (win !== origHost) {
        cdnState.lastWinner = win;
        saveGlobalWinner(win);
      } else if (cdnState.lastWinner) {
        // 本轮已证明原始源更合适，不能让旧的全局赢家继续污染后续视频的临时选源。
        cdnState.lastWinner = null;
        try { localStorage.removeItem('biliCdnWinner'); } catch (e) { }
      }
      cdnState.lastResults = { list: merged, win, origHost, why, ts: Date.now() };
      if (!manualHost) cdnState.perf.length = 0;
      console.log('[bili-cdn] 测速(' + why + ')',
        merged.map(result => `${shortName(result.host)}=${result.kbps}KB/s TTFB=${result.ttfb ?? '—'}ms` +
          (result.note ? '(' + result.note + ')' : '(' + result.stage + ')')).join('  '),
        '→ 自动选择', win, manualHost ? `（手选 ${manualHost} 保持不变）` : '');
      renderHud(true);
    } finally {
      // 一轮快筛 + 精测只落盘一次，避免每个候选都同步写 localStorage。
      saveHealth();
      cdnState.probing.delete(probeKey);
    }
  }

  function selectManualSource(host) {
    const key = cdnState.curKey;
    if (!key || !compatibleHostPool().includes(host)) return '只能选择当前媒体的兼容源';
    cdnState.blacklist.delete(host);
    cdnState.rejected.get(key)?.delete(host);
    cdnState.manual.set(key, host);
    cdnState.picked.set(key, host);
    cdnState.perf.length = 0;
    suppressStallChecks(STALL_LOAD_GRACE);
    renderHud(false);
    return '已手动切到 ' + host;
  }

  function restoreAutomaticSource() {
    const key = cdnState.curKey;
    if (!key) return '还没拦到分片';
    cdnState.manual.delete(key);
    cdnState.picked.delete(key);
    clearCdnCache(key);
    cdnState.perf.length = 0;
    suppressStallChecks(STALL_LOAD_GRACE);
    if (cdnState.lastProbeUrl) runCdnProbe(cdnState.lastProbeUrl, '恢复自动');
    renderHud(false);
    return '已恢复自动测速';
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
    let target = cdnState.manual.get(key) || cdnState.picked.get(key) || loadCdnCache(key);
    if (target && canRewriteHost(url.hostname, target)) cdnState.picked.set(key, target);
    else if (target) {
      target = null;
      cdnState.manual.delete(key);
      cdnState.picked.delete(key);
      clearCdnCache(key);
    }

    const bad = cdnState.rejected.get(key);
    if (target && (cdnState.blacklist.has(target) || (bad && bad.has(target)))) {
      target = null;
      cdnState.manual.delete(key);
      cdnState.picked.delete(key);
      clearCdnCache(key);
    }
    if (!target) {
      runCdnProbe(url, '开播');
      target = cdnState.lastWinner;
      if (target && canRewriteHost(url.hostname, target) &&
          !cdnState.blacklist.has(target) && !(bad && bad.has(target))) {
        // 记录测速完成前使用的会话赢家，让真实卡顿可以立即淘汰它。
        cdnState.picked.set(key, target);
      } else {
        if (target && target === cdnState.lastWinner) {
          // v1.3 可能留下跨域族 Akamai 赢家；升级后第一次遇到就迁移清掉。
          cdnState.lastWinner = null;
          try { localStorage.removeItem('biliCdnWinner'); } catch (e) { }
        }
        target = null;
      }
    }
    cdnState.activeHost = target || url.hostname;
    if (!target || target === url.hostname) return raw;
    url.hostname = target;
    return url.toString();
  }

  // ---- 编码模块：播放数据改写，与 CDN 状态完全无关 ----
  function rewritePlayinfo(payload) {
    if (!codecActive()) return payload;
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
    if (!codecActive()) return;
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
  const XHR_PLAYURL = Symbol('biliBoostPlayurl');
  const XHR_CDN = Symbol('biliBoostCdn');
  const XHR_RESPONSE_HOOKED = Symbol('biliBoostResponseHooked');

  function recordRealTransfer(request, got, started, firstAt, firstChunkBytes, ended, via) {
    if (request.generation !== mediaGeneration || request.key !== cdnState.curKey ||
        got <= 65536 || ended - started <= 50) return;
    const metrics = probeMetrics(got, firstChunkBytes, started, firstAt, ended);
    cdnState.perf.push({ host: request.host, kbps: metrics.kbps, effectiveKbps: metrics.effectiveKbps,
      ttfb: metrics.ttfb, bytes: got, via });
    if (cdnState.perf.length > PERF_WINDOW) cdnState.perf.shift();
    renderHud(false);
  }

  // clone() 保留原 Response 的 url/type/redirected/body 语义；只流式读取副本计数，不缓存整段。
  // 超时或超过 32MB 就取消观测分支，绝不 abort 播放器持有的原分支。
  function observeFetchSegment(response, request, started) {
    if (!response?.ok || !response.body) return;
    let clone;
    try { clone = response.clone(); } catch (e) { return; }
    if (!clone.body) return;
    const reader = clone.body.getReader();
    let got = 0;
    let firstAt = null;
    let firstChunkBytes = 0;
    let finished = false;
    const timer = setTimeout(() => {
      if (!finished) reader.cancel('bili-boost measure timeout').catch(() => { });
    }, FETCH_MEASURE_TIMEOUT);
    (async () => {
      try {
        while (got < FETCH_MEASURE_MAX_BYTES) {
          const { done, value } = await reader.read();
          if (done) break;
          const now = performance.now();
          if (firstAt == null) {
            firstAt = now;
            firstChunkBytes = value.length;
          }
          got += value.length;
        }
        if (got >= FETCH_MEASURE_MAX_BYTES) reader.cancel('bili-boost measure limit').catch(() => { });
      } catch (e) { /* 观测失败不能影响原响应 */ }
      finally {
        finished = true;
        clearTimeout(timer);
        recordRealTransfer(request, got, started, firstAt, firstChunkBytes, performance.now(), 'fetch');
      }
    })();
  }
  XMLHttpRequest.prototype.open = function (method, rawUrl, ...rest) {
    // XMLHttpRequest 可以复用；清掉上一次 playurl 请求装在实例上的 getter 和状态。
    if (this[XHR_RESPONSE_HOOKED]) {
      try { delete this.responseText; } catch (e) { }
      try { delete this.response; } catch (e) { }
      this[XHR_RESPONSE_HOOKED] = false;
    }
    const playerData = isVideoPage() && isPlayurl(rawUrl);
    const playurl = codecActive() && playerData;
    if (playerData) suppressStallChecks(STALL_LOAD_GRACE);
    const out = typeof rawUrl === 'string' || rawUrl instanceof URL ? rewriteSegmentUrl(rawUrl) : rawUrl;
    this[XHR_PLAYURL] = playurl;
    this[XHR_CDN] = null;
    try {
      const url = new URL(out, location.href);
      if (isMedia(url)) this[XHR_CDN] = {
        host: url.hostname, url, key: keyOf(url), generation: mediaGeneration,
      };
    } catch (e) { }
    return origOpen.call(this, method, out, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    const cdnRequest = this[XHR_CDN];
    if (cdnRequest) {
      const started = performance.now();
      let firstAt = null;
      let firstLoaded = 0;
      const onProgress = event => {
        if (firstAt == null && event.loaded > 0) {
          firstAt = performance.now();
          firstLoaded = event.loaded;
        }
      };
      this.addEventListener('progress', onProgress);
      this.addEventListener('loadend', event => {
        this.removeEventListener('progress', onProgress);
        recordRealTransfer(cdnRequest, event.loaded, started, firstAt, firstLoaded,
          performance.now(), 'xhr');
      }, { once: true });
    }

    if (this[XHR_PLAYURL]) {
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
        this[XHR_RESPONSE_HOOKED] = true;
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
        this[XHR_RESPONSE_HOOKED] = true;
      } catch (e) { console.warn('[硬解] response 劫持失败，已放行：', e); }
    }
    return origSend.apply(this, args);
  };

  window.fetch = async function (input, init) {
    const originalUrl = typeof input === 'string' || input instanceof URL ? String(input) : (input && input.url) || '';
    const playerData = isVideoPage() && isPlayurl(originalUrl);
    if (playerData) suppressStallChecks(STALL_LOAD_GRACE);
    if (typeof input === 'string' || input instanceof URL) {
      input = rewriteSegmentUrl(input);
    } else if (input instanceof Request) {
      const rewritten = rewriteSegmentUrl(input.url);
      if (rewritten !== input.url) input = new Request(rewritten, input);
    }
    let cdnRequest = null;
    try {
      const requestUrl = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, location.href);
      const method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
      if (method === 'GET' && isMedia(requestUrl)) cdnRequest = {
        host: requestUrl.hostname, url: requestUrl, key: keyOf(requestUrl), generation: mediaGeneration,
      };
    } catch (e) { }
    const started = cdnRequest ? performance.now() : 0;
    const response = await origFetch.call(this, input, init);
    if (cdnRequest) observeFetchSegment(response, cdnRequest, started);
    if (!codecActive() || !playerData) return response;
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
        suppressStallChecks(STALL_LOAD_GRACE);
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
      const info = await withTimeout(navigator.mediaCapabilities.decodingInfo({
        type: 'media-source',
        video: {
          contentType: picked,
          width: video?.videoWidth || 1920,
          height: video?.videoHeight || 1080,
          bitrate: 4000000,
          framerate: 30,
        },
      }), DECODING_INFO_TIMEOUT);
      efficient = info.powerEfficient;
    } catch (e) { /* 查询失败必须保持“未知”，不能按编码名猜 */ }
    if (generation !== mediaGeneration || picked !== codecState.picked) return;
    codecState.efficient = efficient;
    renderHud(false);
  }

  // ---- 播放闭环：事件先去误报，再确认真卡顿 ----
  function cancelPendingStall() {
    if (!playbackState.pending) return;
    clearTimeout(playbackState.pending.timer);
    playbackState.pending = null;
  }

  function suppressStallChecks(ms = STALL_LOAD_GRACE) {
    playbackState.suppressUntil = Math.max(playbackState.suppressUntil, performance.now() + ms);
    cancelPendingStall();
  }

  function resetPlaybackTracking(video, grace = STALL_LOAD_GRACE) {
    cancelPendingStall();
    playbackState.video = video || null;
    playbackState.hasAdvanced = false;
    playbackState.lastTime = Number(video?.currentTime) || 0;
    playbackState.lastAdvanceAt = 0;
    playbackState.suppressUntil = performance.now() + grace;
  }

  function bufferAhead(video) {
    try {
      for (let i = 0; i < video.buffered.length; i++) {
        if (video.buffered.start(i) <= video.currentTime + 0.25 &&
            video.buffered.end(i) >= video.currentTime) return video.buffered.end(i) - video.currentTime;
      }
    } catch (e) { }
    return 0;
  }

  function confirmCdnStall(key, current) {
    const now = Date.now();
    if (now - playbackState.lastConfirmedAt < STALL_DEDUP_MS) return;
    playbackState.lastConfirmedAt = now;
    cdnState.stalls++;
    renderHud(false);
    if (!current || now - cdnState.lastRetest < RETEST_COOLDOWN) return;
    cdnState.lastRetest = now;
    if (!cdnState.rejected.has(key)) cdnState.rejected.set(key, new Set());
    cdnState.rejected.get(key).add(current);
    cdnState.manual.delete(key);
    cdnState.picked.delete(key);
    if (cdnState.activeHost === current) cdnState.activeHost = null;
    clearCdnCache(key);
    cdnState.perf.length = 0;
    console.warn('[bili-cdn] 确认卡顿 → 弃用', current, '重新测速');
    if (cdnState.lastProbeUrl) runCdnProbe(cdnState.lastProbeUrl, '卡顿重测');
  }

  function onPotentialStall(event) {
    const video = event.target;
    if (!(video instanceof HTMLVideoElement)) return;
    if (playbackState.video !== video) {
      resetPlaybackTracking(video);
      return;
    }
    const now = performance.now();
    const key = cdnState.curKey;
    const current = currentCdnSource(key);
    if (!key || !current || !playbackState.hasAdvanced || now < playbackState.suppressUntil ||
        video.paused || video.ended || video.seeking || video.readyState >= 3 || bufferAhead(video) > 0.75 ||
        playbackState.pending) return;

    const snapshot = {
      generation: mediaGeneration,
      key,
      current,
      time: video.currentTime,
      started: now,
      timer: null,
    };
    snapshot.timer = setTimeout(() => {
      if (playbackState.pending !== snapshot) return;
      playbackState.pending = null;
      if (snapshot.generation !== mediaGeneration || playbackState.video !== video ||
          snapshot.key !== cdnState.curKey || snapshot.current !== currentCdnSource(snapshot.key) ||
          performance.now() < playbackState.suppressUntil || playbackState.lastAdvanceAt > snapshot.started ||
          video.paused || video.ended || video.seeking || video.readyState >= 3 ||
          Math.abs(video.currentTime - snapshot.time) >= 0.1 || bufferAhead(video) > 0.75) return;
      confirmCdnStall(snapshot.key, snapshot.current);
    }, STALL_CONFIRM_MS);
    playbackState.pending = snapshot;
  }

  function onPlaybackProgress(event) {
    const video = event.target;
    if (!(video instanceof HTMLVideoElement)) return;
    if (playbackState.video !== video) resetPlaybackTracking(video, 0);
    const current = Number(video.currentTime) || 0;
    const delta = current - playbackState.lastTime;
    if (!video.seeking && delta >= 0.05 && delta < 1.5) {
      playbackState.hasAdvanced = true;
      playbackState.lastAdvanceAt = performance.now();
      if (playbackState.pending && Math.abs(current - playbackState.pending.time) >= 0.1) cancelPendingStall();
    }
    playbackState.lastTime = current;
  }

  function onMediaLifecycle(event) {
    const video = event.target;
    if (!(video instanceof HTMLVideoElement)) return;
    if (event.type === 'emptied' || event.type === 'loadstart') {
      resetPlaybackTracking(video);
    } else if (event.type === 'seeking') {
      suppressStallChecks(STALL_SEEK_GRACE);
      playbackState.lastTime = Number(video.currentTime) || 0;
    } else if (event.type === 'seeked') {
      suppressStallChecks(1000);
      playbackState.lastTime = Number(video.currentTime) || 0;
    } else {
      cancelPendingStall();
    }
  }

  document.addEventListener('waiting', onPotentialStall, true);
  document.addEventListener('stalled', onPotentialStall, true);
  document.addEventListener('timeupdate', onPlaybackProgress, true);
  for (const type of ['playing', 'canplay', 'seeking', 'seeked', 'loadstart', 'emptied']) {
    document.addEventListener(type, onMediaLifecycle, true);
  }

  function currentPerf() {
    const current = currentCdnSource();
    return current ? cdnState.perf.filter(item => item.host === current) : [];
  }
  function medianMetric(name) {
    const values = currentPerf().map(item => item[name]).filter(Number.isFinite).sort((a, b) => a - b);
    return values.length ? values[Math.floor(values.length / 2)] : null;
  }
  function medianKbps() { return medianMetric('kbps'); }
  function medianTtfb() { return medianMetric('ttfb'); }
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
    // 背景必须足够不透明：早期版本用 .88，B站页面的评论/推荐标题会透上来，
    // 看着像是出现了第二个 HUD。backdrop-filter 在 Safari 必须带 -webkit- 前缀，
    // 而且不能只依赖它 —— 不生效时要靠不透明度兜底。
    box.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;background:rgba(18,18,20,.97);' +
      '-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);' +
      'color:#ddd;font:11px/1.55 ui-monospace,Menlo,monospace;padding:6px 10px;border-radius:7px;' +
      'border:1px solid rgba(255,255,255,.08);' +
      'box-shadow:0 3px 14px rgba(0,0,0,.5);white-space:pre;transition:opacity .4s;cursor:pointer;user-select:none';
    box.addEventListener('click', event => {
      const actionNode = event.target.closest('[data-action]');
      const action = actionNode?.dataset.action;
      if (action === 'source') {
        event.stopPropagation();
        selectManualSource(actionNode.dataset.host);
        return;
      }
      if (action === 'auto-source') {
        event.stopPropagation();
        restoreAutomaticSource();
        return;
      }
      if (action === 'codec') {
        event.stopPropagation();
        codecMode = codecMode === 'auto' ? true : codecMode === true ? false : 'auto';
        configSet('codec', codecMode);
        location.reload();
        return;
      }
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
    if (!IS_TOP) return;   // 见 IS_TOP 定义处：iframe 里不画 HUD
    detectLegacyConflict();
    if (!hudOn) return;
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', () => renderHud(expand), { once: true });
      return;
    }
    if (expand) hudExpanded = true;
    const box = ensureHud();
    const current = currentCdnSource();
    const manual = cdnState.curKey && cdnState.manual.get(cdnState.curKey);
    const real = medianKbps();
    const realTtfb = medianTtfb();
    const cdnLine = (cdnState.missedWarning ? '<span style="color:#ec9">⚠️ 没拦到分片请求</span> · ' : '') +
      `<b style="color:#fb7299">${current ? shortName(current) : '未选源'}</b>` +
      (manual ? ' <span style="color:#8cf">(手选)</span>' : '') +
      (real != null ? ` · 实测 <b style="color:${real > 400 ? '#6c6' : '#ec9'}">${real}</b> KB/s` : ' · 实测 —') +
      (realTtfb != null ? ` · TTFB ${realTtfb}ms` : '') +
      (cdnState.stalls ? ` · <span style="color:#f66">卡顿 ${cdnState.stalls}</span>` : ' · 卡顿 0');
    const [status, statusColor] = efficiencyText();
    const codecLine = `<span style="color:${statusColor}">${status}</span> · ${codecLabel(codecState.picked)}`;
    const conflictLine = legacyConflict.detected
      ? '<span style="color:#ff6b6b;font-weight:bold">⚠️ 旧版 bili-cdn-fix 仍在运行，请到脚本管理器停用</span>'
      : '';
    const conflictPrefix = conflictLine ? conflictLine + '<br>' : '';

    if (!hudExpanded) {
      box.innerHTML = conflictPrefix + cdnLine + '<br>' + codecLine;
      return;
    }

    const sourceLink = host => `<span data-action="source" data-host="${host}" style="color:#8cf">${shortName(host).padEnd(7)}</span>`;
    let probeRows = '<span style="color:#888">尚无完整测速结果</span>';
    const shownHosts = new Set();
    if (cdnState.lastResults) {
      probeRows = cdnState.lastResults.list.map(result => {
        shownHosts.add(result.host);
        const selectedManually = result.host === manual;
        const mark = selectedManually ? '🖐' : result.host === cdnState.lastResults.win ? '✅'
          : (result.host === cdnState.lastResults.origHost ? '原' : '　');
        const color = !probeSucceeded(result) ? '#f66' : result.kbps > 400 ? '#6c6' : '#ec9';
        const tag = result.note || result.stage;
        const ttfb = Number.isFinite(result.ttfb) ? ` · ${String(result.ttfb).padStart(4)}ms` : '';
        let row = `${mark} ${sourceLink(result.host)} <span style="color:${color}">${String(result.kbps || 0).padStart(5)}</span> KB/s${ttfb} <span style="color:#888">${tag}</span>`;
        if (result.points?.length > 1) {
          row += '<br><span style="color:#777">　↳ ' + result.points.map(point =>
            `${point.point} ${point.kbps || 0}KB/s/${Number.isFinite(point.ttfb) ? point.ttfb + 'ms' : '—'}${point.note ? '(' + point.note + ')' : ''}`
          ).join(' · ') + '</span>';
        }
        return row;
      }).join('<br>');
      if (cdnState.lastResults.win === cdnState.lastResults.origHost) {
        probeRows += '<br><span style="color:#888">原始源够快，未改写</span>';
      }
    }
    const unlisted = compatibleHostPool().filter(host => !shownHosts.has(host));
    if (unlisted.length) {
      probeRows += '<br>' + unlisted.map(host =>
        `${host === manual ? '🖐' : '　'} ${sourceLink(host)} <span style="color:#777">未进入本轮测速，可强制尝试</span>`
      ).join('<br>');
    }
    if (cdnState.lastResults || unlisted.length) {
      probeRows += manual
        ? '<br><span data-action="auto-source" style="color:#8cf">恢复自动测速（点击）</span>'
        : '<br><span style="color:#777">点击蓝色源可手动切线</span>';
    }
    const offered = codecState.offered.length ? codecState.offered.join(' / ') : '—';
    const conflictDetails = legacyConflict.detected
      ? `${conflictLine}<br><span style="color:#ec9">可能位置：Userscripts / AdGuard → Extensions / Tampermonkey</span>` +
        `<hr style="border:0;border-top:1px solid #444;margin:5px 0">`
      : '';
    box.innerHTML = conflictDetails + `<span style="color:#888">CDN 测速${cdnState.lastResults ? '(' + cdnState.lastResults.why + ') · 精测=头部+1MB中段，显示净吞吐/TTFB' : ''}</span><br>${probeRows}` +
      `<hr style="border:0;border-top:1px solid #444;margin:5px 0"><span style="color:#888">编码信息</span><br>` +
      `${codecLine}<br>编码：${codecLabel(codecState.picked)}<br>powerEfficient：${codecState.efficient == null ? '未知' : codecState.efficient}<br>` +
      `已剔除 AV1：${codecState.stripped} 条<br>B站提供：${offered}` +
      `<hr style="border:0;border-top:1px solid #444;margin:5px 0">` +
      `<span data-action="codec" style="color:#8cf">编码模块：${codecModeLabel()}（点击轮换）</span><br>` +
      (codecActive() ? `<span data-action="prefer" style="color:#8cf">编码偏好：${prefer === 'avc' ? 'H.264' : 'H.265'}（点击切换）</span><br>` : '') +
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
  debugApi = {
    get 当前源() { return currentCdnSource(); },
    get 手动源() { return cdnState.curKey ? cdnState.manual.get(cdnState.curKey) || null : null; },
    get 实测速度() {
      const value = medianKbps();
      return (value == null ? '—' : value) + ' KB/s（当前源最近 ' + currentPerf().length + ' 个分片中位数）';
    },
    get 首字节延迟() {
      const value = medianTtfb();
      return value == null ? '—' : value + ' ms（当前源分片中位数）';
    },
    get 分片明细() { return cdnState.perf.slice(); },
    get 测速结果() { return cdnState.lastResults; },
    get 卡顿次数() { return cdnState.stalls; },
    get 黑名单() { return [...cdnState.blacklist]; },
    重测() {
      if (cdnState.lastProbeUrl) {
        cdnState.manual.delete(cdnState.curKey);
        cdnState.picked.delete(cdnState.curKey);
        clearCdnCache(cdnState.curKey);
        cdnState.perf.length = 0;
        runCdnProbe(cdnState.lastProbeUrl, '手动');
        return '测速中…';
      }
      return '还没拦到分片';
    },
    手动选源(host) { return selectManualSource(String(host || '')); },
    自动选源() { return restoreAutomaticSource(); },
    面板(on) { return setHudEnabled(on) ? '已开' : '已关'; },
    get 当前编码() { return codecState.picked; },
    get 编码名称() { return codecLabel(codecState.picked); },
    get 硬解状态() { return codecState.efficient === true ? '硬解' : codecState.efficient === false ? '软解' : '未知'; },
    get 已剔除AV1() { return codecState.stripped; },
    get B站提供编码() { return codecState.offered.slice(); },
    get 主机健康() {
      const out = {};
      for (const host in health) {
        const r = health[host];
        out[shortName(host)] = `${r.successes}/${r.attempts} 成功` +
          (r.attempts >= HEALTH_MIN_ATTEMPTS ? ` (${Math.round(r.successes / r.attempts * 100)}%)` : ' (样本不足)') +
          (r.kbps ? ` · 滑动均速 ${r.kbps}KB/s` : '') +
          (r.ttfb ? ` · TTFB ${r.ttfb}ms` : '');
      }
      return out;
    },
    清空主机健康() {
      health = Object.create(null);
      healthDirty = true;
      saveHealth();
      return '已清空，下次测速重新积累';
    },
    get 编码偏好() { return prefer; },
    get 编码模块() { return codecModeLabel(); },
    get AV1硬解() { return av1Hw === null ? '未探测' : av1Hw ? '有' : '无'; },
    // 传 'auto' / true / false
    编码模块开关(v) {
      codecMode = (v === true || v === false) ? v : 'auto';
      configSet('codec', codecMode);
      return codecModeLabel() + '，刷新生效';
    },
    重新探测AV1() {
      return probeAv1Hw(true).then(r => r === null ? '探测失败，保持未知' : (r ? '本机有 AV1 硬解' : '本机无 AV1 硬解'));
    },
    get 冲突() {
      return legacyConflict.detected ? {
        旧脚本: 'bili-cdn-fix',
        信号: [...legacyConflict.signals],
        处理: '请在 Userscripts / AdGuard → Extensions / Tampermonkey 中停用旧脚本',
      } : null;
    },
  };
  // 必须在写入兼容别名前检查一次，才能捕获“旧版先注入”的顺序。
  detectLegacyConflict();
  window.__biliBoost = debugApi;
  window.__biliCdn = debugApi;

  console.log('[bili-boost] ' + SCRIPT_VERSION + ' 已注入，控制台优先用 __biliBoost 查看状态（__biliCdn 为兼容别名）');
  renderHud(false);
  // 首次播放先按保守策略（剔除 AV1）跑，探测结果落盘后从下一次加载起生效。
  // 只在视频页自动探测，避免首页和无关 iframe 同时发起能力查询。
  if (codecMode === 'auto' && isVideoPage()) probeAv1Hw().then(() => renderHud(false));
  scheduleMediaWarning();
})();
