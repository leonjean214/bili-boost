// ==UserScript==
// @name         哔哩哔哩播放优化（CDN 测速切源 + 强制硬解编码）
// @namespace    https://github.com/leonjean214/bili-boost
// @version      1.7.0
// @description  CDN 测速切源（播放前方测速点 + 真实分片融合 + 滞回防横跳 + 缓冲不足禁测），并剔除 AV1、优先 HEVC/H.264，降低海外播放卡顿与软解发热。
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
    'upos-sz-mirror08h.bilivideo.com',
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
  const HEALTH_SCHEMA_VERSION = 2;
  const HEALTH_MIN_ATTEMPTS = 3;     // 样本不足先按最佳档探索；每轮快筛都会让它很快脱离该档
  const HEALTH_RATIO_DELTA = 0.15;   // 成功率分档宽度；同一档内再比本轮速度
  const HEALTH_MAX_AGE = 7 * 24 * 3600e3;
  const HEALTH_MAX_HOSTS = 32;
  const HEALTH_MAX_ATTEMPTS = 24;    // 到上限后衰减旧样本，避免陈年成功率支配当前网络
  const HEALTH_SPEED_ALPHA = 0.4;    // 速度/TTFB 走指数滑动平均，新样本权重
  // 实播指标闭环：真实分片有效速度（滑动平均）和卡顿次数写进同一份健康档案（同受 7 天 / 32 条双上限），
  // 下次开播、本会话还没有该源的真实分片时，作为先验与探测值融合（探测常被头部缓存抬高）。
  const HEALTH_PRIOR_MIN_SEGMENTS = 3;  // 至少 3 片真实分片才当先验
  const HEALTH_PRIOR_MAX_AGE = 24 * 3600e3; // 先验只看 24 小时内的实播（换网/换 VPN 后不长期粘住）
  const HEALTH_PRIOR_WEIGHT = 0.35;  // 先验权重低于本会话真实分片（0.6/0.8），高于“没有”
  const HEALTH_STALL_WEIGHT = 4;     // 每次卡顿折算为 4 片的惩罚：每 4 片 1 次卡顿 → 先验减半
  const HEALTH_REAL_SAVE_INTERVAL = 30e3; // 实播样本最多 30 秒落盘一次；不加定时器，随分片顺带检查
  // v1.7.0：前向缓冲低于 15 秒时禁止一切探测（快筛、精测、重测），只用已有数据决策。
  // 开播前（还没开始前进）和暂停时不受限：那时没有正在播放的分片可抢带宽。
  const PROBE_BUFFER_MIN = 15;
  const IDLE_MAX_WAIT = 20000;       // 精测最多等 20 秒缓冲恢复；等不到就放弃精测，不再“到点照跑”
  const PROBE_ROUND_MAX = 90e3;      // 整轮测速看门狗：超过即强制清理 probing/controller
  const SWITCH_MIN_INTERVAL = 60e3;  // 同一视频 60 秒内最多自动切源 1 次（手动不受限）
  const HYSTERESIS_SEGMENTS = 3;     // 滞回：旧源连续 N 片低于码率，或新源连续 N 片优于旧源
  const HEAD_CACHE_RATIO = 5;        // 头部/前方速度比超过 5× 视为头部命中缓存，以前方点为准
  const FALLBACK_AHEAD_OFFSET = 4 * 1024 * 1024;  // 还不知道播放器读到哪时的前方测速点
  const FALLBACK_REQUIRED_KBPS = 400; // playurl 未给码率时的保守需求（约 1080P）
  const BITRATE_HEADROOM = 1.2;
  // 码率告警只认新鲜数据：其他源超过 3 分钟没有新的测速/真实分片，就不再凭旧数字撑住“还有源够快”。
  const BITRATE_EVIDENCE_TTL = 180e3;
  const REAL_SAMPLES_MAX = 8;
  const REAL_WEIGHT_FEW = 0.6;       // 有 1~2 片真实数据时真实速度权重
  const REAL_WEIGHT_MANY = 0.8;      // 有 ≥N 片时
  const DOWNGRADE_COOLDOWN = 60e3;
  // 自动降档后的回升：只回到降档前的清晰度，逐档上调，门槛（1.5×）高于降档门槛（1.2×）形成滞回。
  const UPGRADE_HEADROOM = 1.5;      // 当前源连续 N 片都 ≥ 目标档码率 × 1.5 才回升
  const UPGRADE_SEGMENTS = 5;
  const UPGRADE_QUIET = 120e3;       // 距上次降档/卡顿至少 2 分钟；回升失败一次翻倍，封顶 30 分钟
  const UPGRADE_QUIET_MAX = 30 * 60e3;
  const UPGRADE_PROBATION = 180e3;   // 回升后 3 分钟内卡顿或跟不上码率 → 退回并计一次失败
  const QUALITY_SETTLE_MS = 15e3;    // 请求换档后 15 秒内不判断“清晰度被手动改过”
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
      const real = normalizeRealHealth(value, now);
      // 只在实播里出现、从未被探测的源（如未改写的原始源）允许 attempts=0，但必须带有效实播数据。
      if (!Number.isFinite(oldAttempts) || oldAttempts < (real ? 0 : 1) ||
          !Number.isFinite(oldSuccesses) || oldSuccesses < 0 ||
          !Number.isFinite(at) || now - at >= HEALTH_MAX_AGE) continue;
      const attempts = Math.min(oldAttempts, HEALTH_MAX_ATTEMPTS);
      const successes = attempts ? Math.min(attempts,
        Math.round(Math.min(oldSuccesses, oldAttempts) / oldAttempts * attempts)) : 0;
      const kbps = Math.round(value.kbps);
      const ttfb = Math.round(value.ttfb);
      entries.push([host, {
        attempts,
        successes,
        kbps: Number.isFinite(kbps) && kbps > 0 ? kbps : 0,
        ttfb: Number.isFinite(ttfb) && ttfb >= 0 ? ttfb : 0,
        at: Math.min(at, now),
        ...real,
      }]);
    }
    entries.sort((a, b) => b[1].at - a[1].at || a[0].localeCompare(b[0]));
    const out = Object.create(null);
    entries.slice(0, HEALTH_MAX_HOSTS).forEach(([host, value]) => { out[host] = value; });
    return out;
  }

  // 实播字段是可选的：旧档案没有它们；字段不合法就整组丢弃，绝不因此丢掉探测统计。
  function normalizeRealHealth(value, now) {
    const realN = Math.floor(value.realN);
    const real = Math.round(value.real);
    const realAt = Number(value.realAt);
    if (!Number.isFinite(realN) || realN < 1 || !Number.isFinite(real) || real <= 0 ||
        !Number.isFinite(realAt) || now - realAt >= HEALTH_MAX_AGE) return null;
    const stalls = Math.floor(value.stalls);
    const n = Math.min(realN, HEALTH_MAX_ATTEMPTS);
    return {
      real,
      realN: n,
      stalls: Number.isFinite(stalls) && stalls > 0 ? Math.min(stalls, n) : 0,
      realAt: Math.min(realAt, now),
    };
  }
  function loadHealth() {
    try {
      const raw = JSON.parse(localStorage.getItem(HEALTH_KEY) || '{}');
      // v1.3/v1.4 直接保存 host 字典；v1.5 用带版本的 envelope，读取时自动迁移并裁剪。
      const current = raw?.version === HEALTH_SCHEMA_VERSION && raw.hosts && typeof raw.hosts === 'object';
      return { records: normalizeHealth(current ? raw.hosts : raw), migrated: !current };
    } catch (e) { return { records: Object.create(null), migrated: true }; }
  }
  const loadedHealth = loadHealth();
  let health = loadedHealth.records;
  let healthDirty = loadedHealth.migrated;
  let healthSavedAt = 0;
  function saveHealth(force = false) {
    if (!force && !healthDirty) return;
    healthSavedAt = Date.now();
    health = normalizeHealth(health);
    try {
      localStorage.setItem(HEALTH_KEY, JSON.stringify({
        version: HEALTH_SCHEMA_VERSION,
        updatedAt: Date.now(),
        hosts: health,
      }));
      healthDirty = false;
    } catch (e) { }
  }
  // 即使本会话没有测速，也把旧格式迁移成有版本、按 7 天和 32 条双上限裁剪的新格式。
  if (healthDirty) saveHealth(true);
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
    // 内存态本身也是公开诊断与后续排序的事实源，不能等整轮测速 finally 落盘时才裁剪。
    // 新 host 记录完成后立即按最近更新时间维持 32 条上限，避免测速进行中短暂暴露第 33 条。
    health = normalizeHealth(health);
    healthDirty = true;
  }
  // 实播样本按片计；到上限后片数与卡顿数一起减半，让旧网络的表现逐步让位。
  function shrinkRealHealth(r) {
    if ((r.realN || 0) < HEALTH_MAX_ATTEMPTS) return;
    const kept = Math.floor(HEALTH_MAX_ATTEMPTS / 2);
    r.stalls = Math.round((r.stalls || 0) / r.realN * kept);
    r.realN = kept;
  }
  function recordRealHealth(host, effectiveKbps) {
    if (!host || !Number.isFinite(effectiveKbps) || effectiveKbps <= 0) return;
    const now = Date.now();
    if (!health[host]) {
      // 新 host 立即按 32 条上限裁剪（同 recordProbe），带上首个实播样本才不会被当作空记录丢掉。
      health[host] = { attempts: 0, successes: 0, kbps: 0, at: now,
        real: Math.round(effectiveKbps), realN: 1, stalls: 0, realAt: now };
      health = normalizeHealth(health);
      healthDirty = true;
      if (now - healthSavedAt >= HEALTH_REAL_SAVE_INTERVAL) saveHealth();
      return;
    }
    const r = health[host];
    shrinkRealHealth(r);
    r.real = r.real && r.realN
      ? Math.round(r.real * (1 - HEALTH_SPEED_ALPHA) + effectiveKbps * HEALTH_SPEED_ALPHA)
      : Math.round(effectiveKbps);
    r.realN = (r.realN || 0) + 1;
    r.stalls = r.stalls || 0;
    r.realAt = r.at = now;
    healthDirty = true;
    if (now - healthSavedAt >= HEALTH_REAL_SAVE_INTERVAL) saveHealth();
  }
  // 卡顿记到当时在用的源上；该源还没有实播片数时不记（没有分母，也说明卡顿不是它的分片造成的）。
  function recordRealStall(host) {
    const r = host && health[host];
    if (!r || !r.realN) return;
    shrinkRealHealth(r);
    r.stalls = Math.min(r.realN, (r.stalls || 0) + 1);
    r.realAt = r.at = Date.now();
    healthDirty = true;
    saveHealth();
  }
  // 上次实播的先验速度：滑动均速按卡顿率折扣。样本不足或超过 24 小时返回 null。
  function realPrior(host) {
    const r = health[host];
    if (!r || !r.real || (r.realN || 0) < HEALTH_PRIOR_MIN_SEGMENTS ||
        Date.now() - (r.realAt || 0) >= HEALTH_PRIOR_MAX_AGE) return null;
    return Math.max(1, Math.round(r.real * r.realN / (r.realN + HEALTH_STALL_WEIGHT * (r.stalls || 0))));
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
  // 等缓冲 ≥15 秒或暂停再测；resolve(true) 才表示可以测。等不到、代次变化或
  // 等待期间真卡顿都 resolve(false)：v1.6 的“8 秒后照跑”正是缓冲不足时抢带宽的来源。
  function waitForIdle(maxWait, shouldStop) {
    return new Promise(resolve => {
      const v = document.querySelector('video');
      const events = ['progress', 'timeupdate', 'pause', 'emptied'];
      let timer;
      let finished = false;
      const done = (idle = false) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        for (const type of events) v?.removeEventListener(type, check);
        if (cdnState.idleWaitCancel === done) cdnState.idleWaitCancel = null;
        resolve(idle);
      };
      const check = () => {
        try { if (shouldStop && shouldStop()) return done(false); } catch (e) { return done(false); }
        if (!v || v.paused) return done(true);
        try { if (bufferAhead(v) >= PROBE_BUFFER_MIN) return done(true); } catch (e) { return done(false); }
      };
      cdnState.idleWaitCancel?.();
      cdnState.idleWaitCancel = done;
      for (const type of events) v?.addEventListener(type, check);
      timer = setTimeout(() => done(false), maxWait);
      check();
    });
  }

  function isUposHost(host) {
    const value = String(host).toLowerCase();
    const suffix = value.endsWith('.bilivideo.com') ? '.bilivideo.com'
      : value.endsWith('.akamaized.net') ? '.akamaized.net' : '';
    if (!suffix) return false;
    const label = value.slice(0, -suffix.length).split('.').pop() || '';
    if (!label.startsWith('upos-') || label.length <= 5) return false;
    for (let i = 5; i < label.length; i++) {
      const code = label.charCodeAt(i);
      if (code !== 45 && (code < 48 || code > 57) && (code < 97 || code > 122)) return false;
    }
    return true;
  }
  function hasMediaExtension(path) {
    const value = String(path).toLowerCase();
    return value.endsWith('.m4s') || value.endsWith('.mp4') || value.endsWith('.flv');
  }
  // 绝大多数 fetch/XHR 都不是分片；先做尾缀 O(1) 快筛，避免每次都构造 URL 再跑正则。
  function looksLikeMediaRaw(raw) {
    const value = typeof raw === 'string' || raw instanceof URL ? String(raw) : raw?.url;
    if (!value) return false;
    let end = value.length;
    const query = value.indexOf('?');
    const hash = value.indexOf('#');
    if (query >= 0 && query < end) end = query;
    if (hash >= 0 && hash < end) end = hash;
    const tail = value.slice(Math.max(0, end - 5), end).toLowerCase();
    return tail.endsWith('.m4s') || tail.endsWith('.mp4') || tail.endsWith('.flv');
  }
  const VIDEO_PATH = /^\/(video\/|bangumi\/play\/|list\/|festival\/)/;
  const CODEC_NAME = { 7: 'AVC/H.264', 12: 'HEVC/H.265', 13: 'AV1' };
  const AV1 = 13;

  // 本脚本刻意不加 @noframes —— CDN 模块要在 iframe 内嵌播放器里继续生效。
  // 但 B站有同源 iframe（如登录轮询用的 /correspond/），脚本在里面照样会跑，
  // 那里既不是视频页也拦不到分片。HUD 必须只由顶层窗口绘制，
  // 否则 iframe 会画出第二个 HUD，内容是「没拦到分片请求 / 未检测编码」。
  const SCRIPT_VERSION = 'v1.7.0';   // ⚠️ 改版本时要和文件头的 @version 一起改

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
    // host → { until, strikes, reason, at }：带期限的黑名单，到期自动恢复（见 banHost）。
    blacklist: new Map(),
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
    warningTimer: null,
    activeProbeControllers: new Set(),
    fetchObservers: new Set(),
    idleWaitCancel: null,
    // v1.7.0：按 host 记录本媒体的真实分片有效速度（不随切源清空），用于融合评分与滞回。
    real: new Map(),
    lastSwitchAt: 0,
    switchLog: [],
    held: null,
    cursors: new Map(),
    totals: new Map(),
    lastVideoUrl: null,
    probeEpoch: 0,
    probeStartedAt: 0,
    pendingProbe: null,
    autoProbed: new Set(),
    lastRoundAt: 0,
    probeBlocked: 0,
    lastStallAt: 0,
  };
  // playurl 里的码率/编码表：按分片路径（跨镜像不变）查当前播放的是哪一路流。
  const bitrateState = { byPath: new Map(), qualities: [], videoPath: null, audioPath: null,
    warn: null, lastDowngradeAt: 0, downgradeNote: '',
    // 自动降档留下的回升计划：{ qn 降档前清晰度, expectQn 脚本最近请求的清晰度, requestedAt, ok 连续达标片数,
    //   failures 回升失败次数, upgradedAt 最近一次回升时间, from 回升前清晰度 }；没有自动降过档时为 null。
    restore: null };
  const codecState = { stripped: 0, picked: null, offered: [], efficient: null, statusPending: null,
    inferred: null, reason: '', via: '' };
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
  let lastPlayRequestId = null;

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
  let hudRenderedSource = null;
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
    // 换视频/分 P 时把上一个视频攒下的实播样本落盘（不足 30 秒节流窗口的部分也不丢）。
    saveHealth();
    cdnState.idleWaitCancel?.();
    codecState.statusPending?.cancel();
    lastPlayRequestId = null;
    if (cdnState.warningTimer) {
      clearTimeout(cdnState.warningTimer);
      cdnState.warningTimer = null;
    }
    for (const controller of cdnState.activeProbeControllers) controller.abort();
    cdnState.activeProbeControllers.clear();
    for (const observer of cdnState.fetchObservers) observer.cancel();
    cdnState.fetchObservers.clear();
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
    cdnState.real.clear();
    cdnState.lastSwitchAt = 0;
    cdnState.switchLog.length = 0;
    cdnState.held = null;
    cdnState.cursors.clear();
    cdnState.totals.clear();
    cdnState.lastVideoUrl = null;
    cdnState.probeEpoch++;
    cdnState.probeStartedAt = 0;
    cdnState.pendingProbe = null;
    cdnState.autoProbed.clear();
    cdnState.lastRoundAt = 0;
    cdnState.lastStallAt = 0;
    bitrateState.videoPath = null;
    bitrateState.audioPath = null;
    bitrateState.warn = null;
    codecState.stripped = 0;
    codecState.picked = null;
    codecState.offered = [];
    codecState.efficient = null;
    codecState.inferred = null;
    codecState.reason = '';
    codecState.via = '';
    resetPlaybackTracking(document.querySelector('video'), STALL_LOAD_GRACE);
    renderHud(false);
    scheduleMediaWarning(mediaGeneration);
    console.log('[bili-boost] 新媒体状态已重置：' + reason);
  }
  function syncMediaIdentity() {
    const conflictChanged = detectLegacyConflict();
    const next = mediaIdentity();
    reapStuckProbe();
    if (cdnState.pendingProbe) maybeRunDeferredProbe();
    if (next !== currentMediaId) resetMediaState('页面切换', next);
    else if (conflictChanged || (hudOn && document.body && hudRenderedSource !== currentCdnSource())) renderHud(false);
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
    if (cdnState.warningTimer) clearTimeout(cdnState.warningTimer);
    cdnState.warningTimer = setTimeout(() => {
      cdnState.warningTimer = null;
      if (generation !== mediaGeneration || cdnState.sawMedia) return;
      cdnState.missedWarning = true;
      console.warn('[bili-cdn] 5 秒内未拦截到 m4s/mp4/flv 请求');
      renderHud(false);
    }, 5000);
  }

  const keyOf = url => url.pathname.slice(0, Math.max(0, url.pathname.lastIndexOf('/')));
  const isMedia = url => isUposHost(url.hostname) && hasMediaExtension(url.pathname);
  const shortName = host => host.replace(/^upos-[a-z]{2}-(mirror|upcdn)?/, '').split('.')[0];
  const isPlayurl = url => String(url).includes('/playurl');
  function notePlayRequest(rawUrl) {
    try {
      const url = new URL(String(rawUrl), location.href);
      const id = ['bvid', 'avid', 'cid', 'ep_id', 'qn', 'fnval']
        .map(key => `${key}=${url.searchParams.get(key) || ''}`).join('&');
      if (lastPlayRequestId !== null && id !== lastPlayRequestId) resetMediaState('分 P / 清晰度切换');
      lastPlayRequestId = id;
    } catch (e) { }
  }
  const hostFamily = host => host.endsWith('.bilivideo.com') ? 'bilivideo'
    : host.endsWith('.akamaized.net') ? 'akamai' : 'other';
  const canRewriteHost = (from, to) => from === to ||
    (hostFamily(from) === 'bilivideo' && hostFamily(to) === 'bilivideo');
  function compatibleHostPool(origHost = cdnState.lastResults?.origHost || cdnState.lastProbeUrl?.hostname) {
    if (!origHost) return [];
    return [origHost, ...CANDIDATES].filter((host, index, all) =>
      all.indexOf(host) === index && isUposHost(host) && canRewriteHost(origHost, host));
  }
  const currentCdnSource = (key = cdnState.curKey) => key
    ? (cdnState.manual.get(key) || cdnState.activeHost || cdnState.picked.get(key) || null)
    : cdnState.lastWinner;
  // 黑名单带期限（半衰期恢复）：首次 2 分钟，到期后 1 小时内再犯则翻倍，最多 30 分钟。
  // 以前一次 403/连不上就整页会话永久拉黑；akam 这类“时好时坏”的源从此再无机会，
  // B站是 SPA，一个标签页连看几小时很常见。到期只是恢复候选资格，仍要重新测速/实测才会被选中。
  const BAN_BASE_MS = 2 * 60e3;
  const BAN_MAX_MS = 30 * 60e3;
  const BAN_STRIKE_MEMORY = 60 * 60e3;
  const BAN_MAX_HOSTS = 64;
  function isBanned(host, now = Date.now()) {
    const entry = cdnState.blacklist.get(host);
    return !!entry && entry.until > now;
  }
  function banHost(host, reason, now = Date.now()) {
    const prev = cdnState.blacklist.get(host);
    if (prev && prev.until > now) return prev;   // 同一禁期内的并发失败不重复加码
    const strikes = prev && now - prev.until < BAN_STRIKE_MEMORY ? prev.strikes + 1 : 1;
    const entry = { until: now + Math.min(BAN_MAX_MS, BAN_BASE_MS * 2 ** (strikes - 1)), strikes, reason, at: now };
    cdnState.blacklist.delete(host);
    cdnState.blacklist.set(host, entry);
    while (cdnState.blacklist.size > BAN_MAX_HOSTS) cdnState.blacklist.delete(cdnState.blacklist.keys().next().value);
    return entry;
  }
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

  // ---- v1.7.0：真实分片统计、融合评分与滞回 ----
  function median(values) {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
  }
  const realRecord = host => (host && cdnState.real.get(host)) || null;
  const realSamples = host => realRecord(host)?.samples || [];
  // 当前视频+音频流的码率（KB/s）。playurl 的 bandwidth 单位是 bit/s。
  function requiredKbps() {
    const video = bitrateState.byPath.get(bitrateState.videoPath);
    if (!video?.bandwidth) return null;
    const audio = bitrateState.byPath.get(bitrateState.audioPath);
    return Math.round((video.bandwidth + (audio?.bandwidth || 0)) / 8 / 1024);
  }
  const needKbps = () => requiredKbps() || FALLBACK_REQUIRED_KBPS;
  function noteRealSample(host, effectiveKbps) {
    let record = cdnState.real.get(host);
    if (!record) {
      record = { samples: [], below: 0 };
      cdnState.real.set(host, record);
      while (cdnState.real.size > 16) cdnState.real.delete(cdnState.real.keys().next().value);
    }
    record.samples.push(effectiveKbps);
    record.at = Date.now();
    if (record.samples.length > REAL_SAMPLES_MAX) record.samples.shift();
    record.below = effectiveKbps < needKbps() ? record.below + 1 : 0;
  }
  // 探测以“有效速度”（含 TTFB 的端到端速度）计；精测结果已只取前方点/较差点。
  function probeEffective(result) {
    if (!probeSucceeded(result)) return null;
    const value = result.effectiveKbps || result.kbps;
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  // 融合评分：开播后真实分片权重高于探测值（1~2 片 0.6，≥3 片 0.8）。
  // 按“每 KB 的交付时间”加权（即速度的加权调和平均）：被缓存抬高 50× 的探测值
  // 不会把真实只有 100KB/s 的源拉回“很快”。
  function fusedKbps(host, probeResult) {
    const real = realSamples(host);
    const probe = probeEffective(probeResult);
    if (!real.length) {
      // 本会话还没有该源的真实分片：用上次实播的先验（24 小时内、≥3 片、按卡顿率折扣）。
      const prior = realPrior(host);
      if (prior == null || probe == null) return prior ?? probe;
      return Math.round(1 / (HEALTH_PRIOR_WEIGHT / prior + (1 - HEALTH_PRIOR_WEIGHT) / probe));
    }
    const realMedian = Math.max(1, median(real));
    if (probe == null) return realMedian;
    const weight = real.length >= HYSTERESIS_SEGMENTS ? REAL_WEIGHT_MANY : REAL_WEIGHT_FEW;
    return Math.round(1 / (weight / realMedian + (1 - weight) / probe));
  }
  function applyFusedScore(result) {
    const fused = fusedKbps(result.host, result);
    if (fused == null) return result;
    result.fusedKbps = fused;
    result.realSamples = realSamples(result.host).length;
    if (!result.realSamples) result.priorKbps = realPrior(result.host);
    result.deliveryMs = FULL_BYTES / 1024 / Math.max(1, fused) * 1000;
    return result;
  }
  // 已有数据的评分：真实分片/测速融合 > 跨会话健康档案（净吞吐常被缓存抬高，打五折）。
  function knownScore(host) {
    if (!host) return null;
    const probe = cdnState.lastResults?.list.find(item => item.host === host);
    const fused = fusedKbps(host, probe);
    const ratio = ratioOf(host);
    if (fused != null) {
      const via = realSamples(host).length ? '真实分片' : realPrior(host) != null ? '历史实播' : '测速';
      // 只有先验、本会话没测过：与旧的“历史均速”同一门槛，成功率 <50% 的源不凭旧实播翻身。
      if (via !== '历史实播' || probe || ratio === null || ratio >= 0.5) return { kbps: fused, via };
    }
    const history = health[host];
    if (history?.kbps && (ratio === null || ratio >= 0.5)) return { kbps: Math.round(history.kbps / 2), via: '历史' };
    return null;
  }
  // 滞回 + 限频：返回 null 表示允许自动切换，否则返回保持原源的原因。手动切源不经过这里。
  function switchBlockedReason(from, to, { stall = false, fromFailed = false } = {}) {
    if (!from || !to || from === to) return null;
    const since = Date.now() - cdnState.lastSwitchAt;
    if (cdnState.lastSwitchAt && since < SWITCH_MIN_INTERVAL) {
      return `60 秒内已自动切过源（${Math.round(since / 1000)} 秒前），保持 ${shortName(from)}`;
    }
    if (fromFailed) return null;
    const fromReal = realSamples(from);
    // 第一次自动选源且旧源真实样本不足 N 片：没有可滞回的依据，按测速结论选。
    if (!cdnState.lastSwitchAt && fromReal.length < HYSTERESIS_SEGMENTS) return null;
    if (stall && !fromReal.length) return null;
    const below = realRecord(from)?.below || 0;
    if (below >= HYSTERESIS_SEGMENTS || (stall && below >= 1)) return null;
    const toReal = realSamples(to);
    if (fromReal.length && toReal.length >= HYSTERESIS_SEGMENTS) {
      const base = median(fromReal.slice(-HYSTERESIS_SEGMENTS));
      if (toReal.slice(-HYSTERESIS_SEGMENTS).every(value => value > base * MIN_GAIN)) return null;
    }
    return `滞回：${shortName(from)} 未连续 ${HYSTERESIS_SEGMENTS} 片低于码率，${shortName(to)} 也未在真实分片上持续更快`;
  }
  // 只改后续请求的目标 host；正在传输的分片保持原连接，绝不 abort 播放器请求。
  function commitAutoSwitch(key, from, to, why) {
    cdnState.picked.set(key, to);
    saveCdnCache(key, to);
    cdnState.held = null;
    if (!from || from === to) return;
    cdnState.lastSwitchAt = Date.now();
    cdnState.switchLog.push({ at: cdnState.lastSwitchAt, from, to, why });
    if (cdnState.switchLog.length > 8) cdnState.switchLog.shift();
  }
  // 缓冲不足时只用已有数据（真实分片、上轮测速、健康档案）挑一个替代源，不发任何探测。
  function decideFromData(key, current, { stall = false } = {}) {
    const bad = cdnState.rejected.get(key);
    const pool = compatibleHostPool().filter(host => host !== current &&
      !isBanned(host) && !(bad && bad.has(host)));
    if (!pool.length) return null;
    const scored = pool.map(host => ({ host, score: knownScore(host) })).filter(item => item.score)
      .sort((a, b) => b.score.kbps - a.score.kbps || a.host.localeCompare(b.host));
    const currentScore = knownScore(current);
    if (scored.length) {
      const best = scored[0];
      if (!stall && currentScore && best.score.kbps < currentScore.kbps * MIN_GAIN) return null;
      return { host: best.host, via: best.score.via, kbps: best.score.kbps };
    }
    // 毫无数据：只有确认卡顿才按候选顺序盲切（历史结论：08c 常最快，排第一）。
    return stall ? { host: pool[0], via: '候选顺序', kbps: null } : null;
  }

  // ---- 测速门控：全局并发 1、缓冲不足禁测、超时必清理 ----
  let probeTail = Promise.resolve();
  function withProbeSlot(task) {
    const run = probeTail.then(task, task);
    probeTail = run.then(() => { }, () => { });
    return run;
  }
  function probeBlockedByBuffer() {
    const video = playbackState.video || document.querySelector('video');
    if (!video || video.paused || video.ended) return false;
    if (!playbackState.hasAdvanced && !(Number(video.currentTime) > 0.5)) return false;
    return bufferAhead(video) < PROBE_BUFFER_MIN;
  }
  function deferProbe(url, why, manual = false) {
    if (!url) return;
    cdnState.pendingProbe = { url: new URL(url.toString()), why, manual, generation: mediaGeneration };
  }
  function maybeRunDeferredProbe() {
    const pending = cdnState.pendingProbe;
    if (!pending || cdnState.probing.size) return;
    if (pending.generation !== mediaGeneration) {
      cdnState.pendingProbe = null;
      return;
    }
    if (!pending.manual && (Date.now() - cdnState.lastRoundAt < RETEST_COOLDOWN || probeBlockedByBuffer())) return;
    cdnState.pendingProbe = null;
    runCdnProbe(pending.url, pending.why, { manual: pending.manual });
  }
  // Safari 中 abort 后 reader.read() 偶尔永不返回（现场 probing=1/probeControllers=1 挂死）。
  // 每轮记录开始时间，超过 90 秒仍未结束就强制作废并清理，释放串行队列。
  function reapStuckProbe() {
    if (!cdnState.probing.size || !cdnState.probeStartedAt ||
        Date.now() - cdnState.probeStartedAt < PROBE_ROUND_MAX) return;
    console.warn('[bili-cdn] 测速超过 90 秒未结束，强制清理');
    cdnState.probeEpoch++;
    cdnState.idleWaitCancel?.();
    for (const controller of cdnState.activeProbeControllers) controller.abort();
    cdnState.activeProbeControllers.clear();
    cdnState.probing.clear();
    cdnState.probeStartedAt = 0;
    probeTail = Promise.resolve();
  }
  function parseRange(value) {
    const match = /^bytes=(\d+)-(\d*)$/i.exec(String(value || '').trim());
    if (!match) return null;
    return { start: Number(match[1]), end: match[2] ? Number(match[2]) : null };
  }
  function rememberBounded(map, key, value, max = 8) {
    map.delete(key);
    map.set(key, value);
    while (map.size > max) map.delete(map.keys().next().value);
  }
  // 播放器最近请求到的字节位置：下一片从 end+1 开始，正是“即将请求”、大概率未被 CDN 缓存的区间。
  function noteCursor(url, rangeValue) {
    const range = parseRange(rangeValue);
    if (!range || !url) return;
    rememberBounded(cdnState.cursors, url.pathname, { start: range.start, end: range.end ?? range.start, at: Date.now() });
  }
  function noteTotal(path, total) {
    if (Number.isSafeInteger(total) && total > 0) rememberBounded(cdnState.totals, path, total);
  }
  function aheadPoint(url) {
    const cursor = cdnState.cursors.get(url.pathname);
    const total = cdnState.totals.get(url.pathname);
    let offset = cursor ? cursor.end + 1 : FALLBACK_AHEAD_OFFSET;
    if (total) offset = Math.min(offset, total - PRECISION_POINT_BYTES);
    if (!Number.isFinite(offset) || offset < QUICK_BYTES) return null;
    return { offset, label: cursor ? '前方' : '中' };
  }
  function probeUrlFor(fallback) {
    const video = cdnState.lastVideoUrl;
    if (video && keyOf(video) === cdnState.curKey) return video;
    return fallback || cdnState.lastProbeUrl;
  }

  // ---- CDN：单个候选、单个位置测速（全局串行） ----
  function probeCdn(url, host, bytes, options = {}) {
    return withProbeSlot(() => probeCdnNow(url, host, bytes, options));
  }
  async function probeCdnNow(url, host, bytes, { offset = 0, point = '头部', epoch = cdnState.probeEpoch } = {}) {
    if (epoch !== cdnState.probeEpoch) {
      return { host, ok: false, cancelled: true, kbps: 0, ttfb: null, point, note: '已取消' };
    }
    const target = new URL(url.toString());
    target.hostname = host;
    const ctl = new AbortController();
    cdnState.activeProbeControllers.add(ctl);
    let reader = null;
    let kill;
    // 超时不只 abort：所有 await 都与 hang 竞速，浏览器不响应 abort 时也能按时退出。
    const hang = new Promise((resolve, reject) => { kill = reject; });
    hang.catch(() => { });
    const timer = setTimeout(() => {
      ctl.abort();
      reader?.cancel().catch(() => { });
      const error = new Error('probe timeout');
      error.name = 'AbortError';
      kill(error);
    }, PROBE_TIMEOUT);
    const headers = offset > 0 ? { Range: `bytes=${offset}-${offset + bytes - 1}` } : undefined;
    let got = 0;
    let firstAt = null;
    let firstChunkBytes = 0;
    const started = performance.now();
    try {
      const fetching = origFetch.call(window, target.toString(), {
        credentials: 'omit', cache: 'no-store', signal: ctl.signal, headers,
      });
      fetching.catch(() => { });
      let res;
      try { res = await Promise.race([fetching, hang]); } catch (e) {
        // 迟到的响应体也要取消，不能留着占连接。
        fetching.then(late => late.body?.cancel().catch(() => { }), () => { });
        throw e;
      }
      // 中段 Range 是额外诊断能力：服务器不支持或签名不允许时退回头部结果，
      // 不能因此误判一个真实播放仍可用的 host 为坏源。
      if (offset > 0 && res.status !== 206) {
        res.body?.cancel().catch(() => { });
        return { host, ok: false, skipped: true, kbps: 0, ttfb: Math.round(performance.now() - started), point,
          note: `Range 不可用(HTTP ${res.status})` };
      }
      if (!res.ok || !res.body) {
        banHost(host, '测速 HTTP ' + res.status);
        return { host, ok: false, kbps: 0, ttfb: Math.round(performance.now() - started), point,
          note: 'HTTP ' + res.status };
      }
      if (offset === 0 && res.status === 200) noteTotal(target.pathname, Number(res.headers.get('content-length')));
      reader = res.body.getReader();
      while (got < bytes) {
        const { done, value } = await Promise.race([reader.read(), hang]);
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
      reader?.cancel().catch(() => { });
      // 无数据的中段请求可能只是浏览器/服务端不接受 Range，保守退回头部，不污染黑名单。
      if (offset > 0 && got === 0 && e.name !== 'AbortError') {
        return { host, ok: false, skipped: true, kbps: 0, ttfb: Math.round(ended - started), point,
          note: 'Range 请求失败' };
      }
      if (offset === 0 && e.name !== 'AbortError') banHost(host, '测速连接失败');
      const metrics = got >= 32768
        ? probeMetrics(got, firstChunkBytes, started, firstAt, ended)
        : { kbps: 0, effectiveKbps: 0, ttfb: firstAt == null ? Math.round(ended - started) : Math.round(firstAt - started), deliveryMs: Infinity };
      return { host, ok: false, ...metrics, bytes: got, point,
        note: e.name === 'AbortError' ? (got ? '超时截断' : '超时') : '失败' };
    } finally {
      clearTimeout(timer);
      cdnState.activeProbeControllers.delete(ctl);
    }
  }

  // 精测 = 文件头 + 播放器“即将请求”的前方区间（不知道位置时取 4MB 处）。
  // 头部常被 CDN 缓存（现场 cosov 头 47MB/s、真实分片仅 50~700KB/s），
  // 头/前方比 >5× 时标记“头部缓存”，评分只用前方点。
  async function probePrecision(url, host, ahead, epoch, shouldStop) {
    const head = await probeCdn(url, host, PRECISION_POINT_BYTES, { point: '头', epoch });
    if (!probeSucceeded(head)) {
      return { ...head, stage: '精测(头+前方)', points: [head], note: '头部' + (head.note || '失败') };
    }
    if (!ahead) return { ...head, stage: '精测(头)', points: [head], note: '文件太小，仅头部' };
    if (shouldStop()) return { ...head, stage: '精测(头)', points: [head], aborted: true, note: '缓冲不足，未测前方' };
    const middle = await probeCdn(url, host, PRECISION_POINT_BYTES,
      { offset: ahead.offset, point: ahead.label, epoch });
    const points = [head, middle];
    const usable = points.filter(probeSucceeded);
    const ok = probeSucceeded(head) && (middle.skipped || probeSucceeded(middle));
    const headCached = probeSucceeded(middle) && head.kbps > middle.kbps * HEAD_CACHE_RATIO;
    const scored = headCached ? [middle] : usable;
    const notes = [];
    if (!ok) notes.push(ahead.label + (middle.note || '失败'));
    else if (middle.skipped) notes.push(ahead.label + middle.note);
    if (headCached) notes.push(`头部疑似缓存(${Math.round(head.kbps / Math.max(1, middle.kbps))}×)，按${ahead.label}计`);
    return {
      host,
      ok,
      kbps: Math.min(...scored.map(item => item.kbps)),
      effectiveKbps: Math.min(...scored.map(item => item.effectiveKbps || item.kbps)),
      ttfb: Math.max(...scored.map(item => Number.isFinite(item.ttfb) ? item.ttfb : 0)),
      deliveryMs: Math.max(...scored.map(deliveryMs)),
      bytes: usable.reduce((sum, item) => sum + (item.bytes || 0), 0),
      stage: '精测(头+' + ahead.label + ')',
      points,
      headCached,
      aheadOffset: ahead.offset,
      note: notes.join('；'),
    };
  }

  // ---- CDN：两阶段测速（串行快筛 → 空闲精测 → 融合评分 → 滞回决策） ----
  async function runCdnProbe(url, why, { manual = false } = {}) {
    if (!url || hostFamily(url.hostname) !== 'bilivideo') return;   // 跨域族源没有可改写的候选
    const key = keyOf(url);
    const generation = mediaGeneration;
    if (cdnState.probing.size) {
      // 全局同时只跑一轮；手动请求排队到本轮结束，自动请求直接丢弃（数据已在路上）。
      if (manual) deferProbe(url, why, true);
      return;
    }
    if (!manual && probeBlockedByBuffer()) {
      cdnState.probeBlocked++;
      deferProbe(url, why === '开播' ? '缓冲恢复后补测' : why);
      return;
    }
    const probeKey = generation + ':' + key;
    const epoch = ++cdnState.probeEpoch;
    cdnState.probing.add(probeKey);
    cdnState.probeStartedAt = Date.now();
    cdnState.lastRoundAt = Date.now();
    const alive = () => epoch === cdnState.probeEpoch && generation === mediaGeneration;
    const blocked = () => {
      if (manual || !probeBlockedByBuffer()) return false;
      cdnState.probeBlocked++;
      return true;
    };
    let incomplete = false;
    try {
      const origHost = url.hostname;
      const bad = cdnState.rejected.get(key) || new Set();
      const pool = compatibleHostPool(origHost).filter(host =>
        !isBanned(host) && !bad.has(host)
      );
      if (!pool.length) return;
      const ahead = aheadPoint(url);

      // 快筛也串行：并发 7 路会和播放器抢带宽。已知播放位置时直接测前方区间。
      const quick = [];
      for (const host of pool) {
        if (!alive()) return;
        if (blocked()) { incomplete = true; break; }
        let result = ahead?.label === '前方'
          ? await probeCdn(url, host, QUICK_BYTES, { offset: ahead.offset, point: '前方', epoch }) : null;
        if (!result || result.skipped) result = await probeCdn(url, host, QUICK_BYTES, { epoch });
        if (!alive()) return;
        result.stage = '快筛';
        recordProbe(result);
        quick.push(applyFusedScore(result));
      }
      quick.sort(compareHosts);

      const finalists = quick.filter(probeSucceeded).slice(0, FINALISTS);
      const full = [];
      if (finalists.length && !incomplete) {
        const stallsBeforeWait = cdnState.stalls;
        const idle = manual || await waitForIdle(IDLE_MAX_WAIT,
          () => !alive() || cdnState.stalls !== stallsBeforeWait);
        if (!alive()) return;
        if (!idle) incomplete = true;
        else for (const finalist of finalists) {
          const latestBad = cdnState.rejected.get(key);
          if (isBanned(finalist.host) || (latestBad && latestBad.has(finalist.host))) continue;
          if (blocked()) { incomplete = true; break; }
          const result = await probePrecision(url, finalist.host, aheadPoint(url), epoch, blocked);
          if (!alive()) return;
          if (result.aborted) { incomplete = true; break; }
          recordProbe(result);
          full.push(applyFusedScore(result));
        }
      }
      full.sort(compareHosts);

      const merged = full.concat(quick.filter(q => !full.some(f => f.host === q.host)));
      // 测速期间也可能因真实播放卡顿把临时源加入拒绝名单；最终选择必须读取最新集合。
      // 精测没跑完（缓冲不足）时只用已有数据：快筛与真实分片融合后决策。
      const latestBad = cdnState.rejected.get(key);
      const eligible = (incomplete ? merged : full).filter(result => probeSucceeded(result) &&
        !isBanned(result.host) && !(latestBad && latestBad.has(result.host))).sort(compareHosts);
      const best = eligible[0];
      if (!best || !alive()) return;
      const manualHost = cdnState.manual.get(key);
      const active = cdnState.activeHost && canRewriteHost(origHost, cdnState.activeHost) ? cdnState.activeHost : null;
      const inUse = (cdnState.curKey === key && (active || cdnState.picked.get(key))) || origHost;
      const incumbent = eligible.find(result => result.host === inUse);
      // 在用源保护只在同一健康档内生效；候选的融合交付时间至少快 25% 才切走。
      const keep = incumbent && healthTier(incumbent.host) === healthTier(best.host) &&
        deliveryMs(best) >= deliveryMs(incumbent) / MIN_GAIN;
      let win = keep ? inUse : best.host;
      let held = null;
      if (win !== inUse && !manual && !manualHost) {
        // 在用源本轮探测失败/已被拉黑才算“坏源”；只是还没测到（缓冲不足提前收工）不算。
        const inUseResult = merged.find(result => result.host === inUse);
        const fromFailed = isBanned(inUse) || !!(latestBad && latestBad.has(inUse)) ||
          (!!inUseResult && !probeSucceeded(inUseResult));
        held = switchBlockedReason(inUse, win, { fromFailed });
        if (held) win = inUse;
      }

      // 用户在测速期间手选了源时，只更新自动结论和缓存，不夺回控制权。
      if (!manualHost) {
        if (win !== inUse) {
          commitAutoSwitch(key, inUse, win, '测速(' + why + ')');
          cdnState.perf.length = 0;
        } else cdnState.picked.set(key, win);
      }
      saveCdnCache(key, win);
      cdnState.held = held ? { at: Date.now(), want: best.host, keep: win, reason: held } : null;
      if (win !== origHost) {
        cdnState.lastWinner = win;
        saveGlobalWinner(win);
      } else if (cdnState.lastWinner) {
        // 本轮已证明原始源更合适，不能让旧的全局赢家继续污染后续视频的临时选源。
        cdnState.lastWinner = null;
        try { localStorage.removeItem('biliCdnWinner'); } catch (e) { }
      }
      cdnState.lastResults = { list: merged, win, origHost, why, ts: Date.now(), incomplete, held };
      console.log('[bili-cdn] 测速(' + why + (incomplete ? '，缓冲不足未完成精测' : '') + ')',
        merged.map(result => `${shortName(result.host)}=${result.effectiveKbps ?? result.kbps}KB/s` +
          (result.fusedKbps ? `→融合${result.fusedKbps}` : '') + ` TTFB=${result.ttfb ?? '—'}ms` +
          (result.note ? '(' + result.note + ')' : '(' + result.stage + ')')).join('  '),
        '→ 选择', win, held ? `（${held}）` : '', manualHost ? `（手选 ${manualHost} 保持不变）` : '');
      renderHud(true);
    } finally {
      // 一轮快筛 + 精测只落盘一次，避免每个候选都同步写 localStorage。
      saveHealth();
      cdnState.probing.delete(probeKey);
      if (epoch === cdnState.probeEpoch) cdnState.probeStartedAt = 0;
      if (incomplete && generation === mediaGeneration && !cdnState.pendingProbe) deferProbe(url, '缓冲恢复后补测');
      if (cdnState.pendingProbe?.manual) Promise.resolve().then(maybeRunDeferredProbe);
    }
  }

  function selectManualSource(host) {
    const key = cdnState.curKey;
    if (!key || !compatibleHostPool().includes(host)) return '只能选择当前媒体的兼容源';
    // 手选优先于黑名单：立即解禁，但保留失败次数，手选源再出错时禁期继续翻倍。
    const ban = cdnState.blacklist.get(host);
    if (ban) ban.until = Math.min(ban.until, Date.now());
    cdnState.rejected.get(key)?.delete(host);
    cdnState.manual.set(key, host);
    cdnState.picked.set(key, host);
    cdnState.held = null;
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
    if (cdnState.lastProbeUrl) runCdnProbe(probeUrlFor(), '恢复自动', { manual: true });
    renderHud(false);
    return '已恢复自动测速';
  }

  // 按分片路径对上 playurl 的流：得到当前码率，并在 SourceBuffer 钩子拿不到时推断编码。
  // Safari/Userscripts 下页面内联的 __playinfo__ 可能早于注入（setter 钩子错过），换分 P 时也可能整体换新对象：
  // 分片对不上时按需从页面当前的 __playinfo__ 重建索引，每个对象只重建一次。
  let indexedPlayinfo = null;
  function reindexFromPagePlayinfo() {
    let info = null;
    try { info = window.__playinfo__; } catch (e) { }
    if (!info || typeof info !== 'object' || info === indexedPlayinfo) return false;
    indexedPlayinfo = info;
    notePlayinfoBitrates(info);
    return true;
  }
  function noteTrack(url) {
    let entry = bitrateState.byPath.get(url.pathname);
    if (!entry && reindexFromPagePlayinfo()) entry = bitrateState.byPath.get(url.pathname);
    if (!entry) return;
    if (entry.kind === 'video') {
      bitrateState.videoPath = url.pathname;
      if (hostFamily(url.hostname) === 'bilivideo') cdnState.lastVideoUrl = new URL(url.toString());
      inferCodecFromSegment(entry);
    } else {
      bitrateState.audioPath = url.pathname;
    }
  }

  // 请求阶段只调用此函数，不接触播放信息响应。
  function rewriteSegmentUrl(raw) {
    if (!looksLikeMediaRaw(raw)) return raw;
    let url;
    try { url = new URL(raw, location.href); } catch (e) { return raw; }
    if (!isMedia(url)) return raw;

    syncMediaIdentity();
    const key = keyOf(url);
    const previousActive = cdnState.activeHost;
    // 跨域族请求（播放器自己回退到 Akamai 等 backup）：签名不能跨族改写，原样放行。
    // v1.6 在这里会清掉已选源和缓存并重新测速，于是 cosov/akam 来回横跳、每 20~30 秒一轮探测。
    if (hostFamily(url.hostname) !== 'bilivideo') {
      cdnState.sawMedia = true;
      cdnState.missedWarning = false;
      if (!cdnState.curKey) cdnState.curKey = key;
      noteTrack(url);
      cdnState.activeHost = url.hostname;
      if (previousActive !== cdnState.activeHost) renderHud(false);
      return raw;
    }
    if (cdnState.curKey && cdnState.curKey !== key) resetMediaState('分片目录变化');
    cdnState.sawMedia = true;
    cdnState.missedWarning = false;
    cdnState.curKey = key;
    cdnState.lastProbeUrl = new URL(url.toString());
    noteTrack(url);
    let target = cdnState.manual.get(key) || cdnState.picked.get(key) || loadCdnCache(key);
    if (target && canRewriteHost(url.hostname, target)) cdnState.picked.set(key, target);
    else if (target) {
      target = null;
      cdnState.manual.delete(key);
      cdnState.picked.delete(key);
      clearCdnCache(key);
    }

    const bad = cdnState.rejected.get(key);
    if (target && (isBanned(target) || (bad && bad.has(target)))) {
      target = null;
      cdnState.manual.delete(key);
      cdnState.picked.delete(key);
      clearCdnCache(key);
    }
    if (!target) {
      // 每个媒体目录只自动开播测速一次；之后只由卡顿/缓冲恢复/手动触发，杜绝逐片重测。
      // 延后一个微任务：播放器通常在 open 之后同步 setRequestHeader('Range')/send，
      // 这样首轮测速就能拿到“播放器读到哪了”，测它即将请求的区间。
      if (!cdnState.autoProbed.has(key)) {
        cdnState.autoProbed.add(key);
        const generation = mediaGeneration;
        const probeUrl = new URL(url.toString());
        Promise.resolve().then(() => {
          if (generation === mediaGeneration) runCdnProbe(probeUrlFor(probeUrl), '开播');
        });
      }
      target = cdnState.lastWinner;
      if (target && canRewriteHost(url.hostname, target) &&
          !isBanned(target) && !(bad && bad.has(target))) {
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
    if (previousActive !== cdnState.activeHost) renderHud(false);
    if (!target || target === url.hostname) return raw;
    url.hostname = target;
    return url.toString();
  }

  // ---- 码率表：只读 playurl，不改写；编码模块关闭时也要记录 ----
  function notePlayinfoBitrates(payload) {
    try {
      const data = payload && (payload.data || payload.result || payload);
      const dash = data?.dash;
      if (!dash || !Array.isArray(dash.video) || !dash.video.length) return;
      const map = new Map();
      const add = (item, kind) => {
        if (!item || typeof item !== 'object') return;
        const info = {
          kind,
          bandwidth: Number(item.bandwidth) || 0,
          id: Number(item.id),
          codecid: item.codecid,
          codecs: typeof item.codecs === 'string' ? item.codecs.slice(0, 64) : '',
          width: Number(item.width) || 0,
          height: Number(item.height) || 0,
          frameRate: parseFloat(item.frameRate || item.frame_rate) || 0,
        };
        const urls = [item.baseUrl, item.base_url]
          .concat(Array.isArray(item.backupUrl) ? item.backupUrl : [], Array.isArray(item.backup_url) ? item.backup_url : []);
        for (const raw of urls) {
          if (typeof raw !== 'string' || map.size >= 256) continue;
          try { map.set(new URL(raw, location.href).pathname, info); } catch (e) { }
        }
      };
      dash.video.slice(0, 64).forEach(item => add(item, 'video'));
      (Array.isArray(dash.audio) ? dash.audio : []).slice(0, 16).forEach(item => add(item, 'audio'));
      if (dash.flac?.audio) add(dash.flac.audio, 'audio');
      (Array.isArray(dash.dolby?.audio) ? dash.dolby.audio : []).slice(0, 4).forEach(item => add(item, 'audio'));
      if (!map.size) return;
      bitrateState.byPath = map;
      const qualities = Array.isArray(data.accept_quality) ? data.accept_quality : dash.video.map(item => item.id);
      bitrateState.qualities = [...new Set(qualities.map(Number).filter(Number.isFinite))]
        .sort((a, b) => b - a).slice(0, 16);
    } catch (e) { }
  }

  // ---- 编码模块：播放数据改写，与 CDN 状态完全无关 ----
  function rewritePlayinfo(payload) {
    notePlayinfoBitrates(payload);
    if (!codecActive()) return payload;
    if (!isVideoPage()) return payload;
    syncMediaIdentity();
    try {
      const data = payload && (payload.data || payload.result || payload);
      if (!data || !data.dash || !Array.isArray(data.dash.video) || !data.dash.video.length) return payload;

      const all = data.dash.video;
      codecState.offered = [...new Set(all.slice(0, 64).map(item => CODEC_NAME[item.codecid] || item.codecid))].slice(0, 16);
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
  const XHR_PLAYINFO_PASSIVE = Symbol('biliBoostPlayinfoPassive');
  const origSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  // 真实分片在脚本改写到的源上返回 403/404/410/5xx（akam 时好时坏、签名不认该 host）：
  // 不等卡顿确认，立刻限期拉黑该源、撤掉本媒体的改写，播放器自己的重试就回到 B站给的原始源。
  // 只处理“我们改写过”的请求：原始源出错是播放器自己的事，脚本不插手；从不 abort 播放器请求。
  function hostOfRaw(raw) {
    try { return new URL(String(raw), location.href).hostname; } catch (e) { return null; }
  }
  function isSegmentHttpFailure(status) {
    return status === 403 || status === 404 || status === 410 || (status >= 500 && status < 600);
  }
  function onSegmentHttpFailure(request, status) {
    if (!request.rewrittenFrom || request.generation !== mediaGeneration || !isSegmentHttpFailure(status)) return;
    const host = request.host;
    const key = request.key;
    const already = isBanned(host);
    const entry = banHost(host, `分片 HTTP ${status}`);
    if (!already) {
      recordProbe({ host, ok: false, kbps: 0 });
      saveHealth();
    }
    if (!cdnState.rejected.has(key)) cdnState.rejected.set(key, new Set());
    cdnState.rejected.get(key).add(host);
    if (cdnState.manual.get(key) === host) cdnState.manual.delete(key);
    if (cdnState.picked.get(key) === host) cdnState.picked.delete(key);
    clearCdnCache(key);
    if (cdnState.lastWinner === host) {
      cdnState.lastWinner = null;
      try { localStorage.removeItem('biliCdnWinner'); } catch (e) { }
    }
    if (cdnState.activeHost === host) cdnState.activeHost = null;
    if (already) return;
    // 原始源只是保底；缓冲恢复后按常规门控补测一次，找有没有比原始源更好的未拉黑源。
    if (!cdnState.pendingProbe) deferProbe(probeUrlFor(), '分片失败后补测');
    // 硬失败不受 60 秒切源限频约束，也不占用限频额度（不改 lastSwitchAt），只记账便于排查。
    cdnState.switchLog.push({ at: Date.now(), from: host, to: request.rewrittenFrom, why: `分片 HTTP ${status}·拉黑` });
    if (cdnState.switchLog.length > 8) cdnState.switchLog.shift();
    console.warn('[bili-cdn] 真实分片 HTTP', status, '→ 拉黑', host, Math.round((entry.until - Date.now()) / 60e3), '分钟，回退原始源',
      request.rewrittenFrom);
    renderHud(false);
  }

  function recordRealTransfer(request, got, started, firstAt, firstChunkBytes, ended, via) {
    if (request.generation !== mediaGeneration || request.key !== cdnState.curKey ||
        got <= 65536 || ended - started <= 50) return;
    const metrics = probeMetrics(got, firstChunkBytes, started, firstAt, ended);
    cdnState.perf.push({ host: request.host, kbps: metrics.kbps, effectiveKbps: metrics.effectiveKbps,
      ttfb: metrics.ttfb, bytes: got, via });
    if (cdnState.perf.length > PERF_WINDOW) cdnState.perf.shift();
    noteRealSample(request.host, metrics.effectiveKbps);
    recordRealHealth(request.host, metrics.effectiveKbps);
    if (!checkBitrateHeadroom()) noteRestoreSample(request.host, metrics.effectiveKbps);
    renderHud(false);
  }

  // ---- 码率感知：所有源的（融合）速度都 < 1.2×码率时提示，可选自动降一档 ----
  let autoDowngrade = configGet('autoDowngrade', false) === true;
  function checkBitrateHeadroom() {
    const required = requiredKbps();
    const current = currentCdnSource();
    let best = 0;
    let measured = 0;
    let stale = 0;
    let staleBest = 0;
    if (required && realSamples(current).length >= HYSTERESIS_SEGMENTS) {
      const now = Date.now();
      // 测速结果整轮过期后不再参与（缓冲不足禁测时，旧探测值可能一直挂着）；当前源始终按自己的真实分片算。
      const probesFresh = !!cdnState.lastResults && now - cdnState.lastResults.ts <= BITRATE_EVIDENCE_TTL;
      const hosts = new Set([...compatibleHostPool(), ...cdnState.real.keys()]);
      for (const host of hosts) {
        if (isBanned(host)) continue;
        const probe = cdnState.lastResults?.list.find(item => item.host === host);
        const realFresh = realSamples(host).length > 0 && now - (realRecord(host).at || 0) <= BITRATE_EVIDENCE_TTL;
        if (host !== current && !realFresh && !probesFresh) {
          const old = fusedKbps(host, probe);
          if (old != null) { stale++; staleBest = Math.max(staleBest, old); }
          continue;
        }
        const value = fusedKbps(host, probesFresh ? probe : null);
        if (value == null) continue;
        measured++;
        best = Math.max(best, value);
      }
    }
    let warn = measured > 0 && best < required * BITRATE_HEADROOM;
    if (warn && staleBest >= required * BITRATE_HEADROOM) {
      // 只有过期数据说“还有源够快”：先补测一轮（照常受冷却和缓冲门控），补测会刷新数据并按滞回决定是否切源。
      // 补测在跑、或缓冲还够补测时先等新数据；缓冲已不足 15 秒（禁测）就不再信旧数字，照常告警。
      if (!cdnState.pendingProbe && !cdnState.probing.size) deferProbe(probeUrlFor(), '旧测速过期，补测');
      if (cdnState.pendingProbe) maybeRunDeferredProbe();
      if (cdnState.probing.size || !probeBlockedByBuffer()) warn = false;
    }
    bitrateState.warn = warn ? { required, best, hosts: measured, stale, at: Date.now() } : null;
    if (warn && autoDowngrade) maybeDowngrade();
    return warn;
  }
  function currentQualityQn() {
    let qn = NaN;
    try {
      const quality = window.player?.getQuality?.();
      qn = Number(quality?.nowQ ?? quality?.realQ ?? quality);
    } catch (e) { }
    return Number.isFinite(qn) ? qn : bitrateState.byPath.get(bitrateState.videoPath)?.id;
  }
  // 某一档清晰度的需求（KB/s）：优先取与当前流同编码的那一路，加上当前音频。
  function qualityRequiredKbps(qn) {
    const current = bitrateState.byPath.get(bitrateState.videoPath);
    let pick = null;
    for (const info of bitrateState.byPath.values()) {
      if (info.kind !== 'video' || info.id !== qn || !info.bandwidth) continue;
      const same = current && info.codecid === current.codecid;
      const pickSame = current && pick && pick.codecid === current.codecid;
      if (!pick || (same && !pickSame) || (same === pickSame && info.bandwidth > pick.bandwidth)) pick = info;
    }
    if (!pick) return null;
    const audio = bitrateState.byPath.get(bitrateState.audioPath);
    return Math.round((pick.bandwidth + (audio?.bandwidth || 0)) / 8 / 1024);
  }
  const restoreQuiet = restore => Math.min(UPGRADE_QUIET_MAX, UPGRADE_QUIET * 2 ** Math.min(8, restore.failures));
  function maybeDowngrade({ revert = false } = {}) {
    const now = Date.now();
    if (!revert && now - bitrateState.lastDowngradeAt < DOWNGRADE_COOLDOWN) return;
    bitrateState.lastDowngradeAt = now;
    const player = window.player;
    if (!player || typeof player.requestQuality !== 'function') {
      bitrateState.downgradeNote = '播放器未暴露 requestQuality，无法自动降档';
      return;
    }
    const currentQn = currentQualityQn();
    const restore = bitrateState.restore;
    // 回升后试用期内跟不上：退回回升前那一档（不是再降一档），并把下次回升的等待时间翻倍。
    const probation = restore?.upgradedAt && now - restore.upgradedAt < UPGRADE_PROBATION;
    const lower = probation && restore.from < currentQn ? restore.from : bitrateState.qualities.find(qn => qn < currentQn);
    if (!lower) {
      bitrateState.downgradeNote = '已是最低一档';
      return;
    }
    try {
      player.requestQuality(lower);
    } catch (e) {
      bitrateState.downgradeNote = '降档调用失败：' + (e?.message || e);
      return;
    }
    const plan = restore || { qn: currentQn, failures: 0 };
    if (probation) plan.failures++;
    Object.assign(plan, { expectQn: lower, requestedAt: now, ok: 0, upgradedAt: 0, from: null });
    bitrateState.restore = plan;
    bitrateState.downgradeNote = `已自动从 ${currentQn} 降到 ${lower}` + (probation ? '（回升后跟不上，退回）' : '') +
      `；网速恢复后自动回升（连续 ${UPGRADE_SEGMENTS} 片 ≥ ${UPGRADE_HEADROOM}×目标码率，至少等 ${Math.round(restoreQuiet(plan) / 60e3)} 分钟）`;
    console.warn('[bili-boost] 所有源都跟不上码率，自动降一档：', currentQn, '→', lower, probation ? '（回升失败退回）' : '');
  }
  // 每片真实分片（且当前没有码率告警）都判断一次是否够回升；达标片数在卡顿/换档/换源后重新计。
  function noteRestoreSample(host, effectiveKbps) {
    const restore = bitrateState.restore;
    if (!restore || !autoDowngrade) return;
    const now = Date.now();
    const current = currentQualityQn();
    if (Number.isFinite(current) && current !== restore.expectQn && now - restore.requestedAt >= QUALITY_SETTLE_MS) {
      bitrateState.restore = null;
      bitrateState.downgradeNote = current >= restore.qn
        ? `已回到 ${current}，自动回升结束`
        : `清晰度被改成 ${current}（不是脚本请求的 ${restore.expectQn}），停止自动回升`;
      return;
    }
    if (restore.upgradedAt && now - restore.upgradedAt >= UPGRADE_PROBATION) {
      restore.upgradedAt = 0;   // 试用期平安度过
      if (restore.expectQn >= restore.qn) {
        bitrateState.restore = null;
        bitrateState.downgradeNote = `已回到降档前的 ${restore.qn}，自动回升结束`;
        return;
      }
    }
    // 试用期内只看当前源：连续 N 片真实分片低于新档码率就退回。全局告警会被其他源的旧探测值撑住，这里不等它。
    if (restore.upgradedAt && host === currentCdnSource() && (realRecord(host)?.below || 0) >= HYSTERESIS_SEGMENTS) {
      maybeDowngrade({ revert: true });
      return;
    }
    if (restore.upgradedAt || host !== currentCdnSource()) return;
    const target = bitrateState.qualities.filter(qn => qn > current && qn <= restore.qn).pop();
    const need = target && qualityRequiredKbps(target);
    if (!target || !need) {
      restore.ok = 0;
      return;
    }
    restore.target = target;
    restore.need = need;
    restore.ok = effectiveKbps >= need * UPGRADE_HEADROOM ? (restore.ok || 0) + 1 : 0;
    if (restore.ok < UPGRADE_SEGMENTS) return;
    const quiet = restoreQuiet(restore);
    if (now - bitrateState.lastDowngradeAt < quiet || now - cdnState.lastStallAt < quiet) return;
    const video = playbackState.video || document.querySelector('video');
    if (!video || bufferAhead(video) < PROBE_BUFFER_MIN) return;
    try {
      window.player.requestQuality(target);
    } catch (e) {
      bitrateState.downgradeNote = '回升调用失败：' + (e?.message || e);
      bitrateState.restore = null;
      return;
    }
    Object.assign(restore, { from: current, expectQn: target, requestedAt: now, upgradedAt: now, ok: 0 });
    bitrateState.downgradeNote = `网速恢复（连续 ${UPGRADE_SEGMENTS} 片 ≥ ${Math.round(need * UPGRADE_HEADROOM)} KB/s），已自动从 ${current} 升回 ${target}` +
      (target < restore.qn ? `，目标 ${restore.qn}` : '');
    console.warn('[bili-boost] 网速恢复，自动回升一档：', current, '→', target);
  }
  // 确认卡顿：回升试用期内立即退回；否则只清零达标计数（安静期由 lastStallAt 保证）。
  function noteRestoreStall() {
    const restore = bitrateState.restore;
    if (!restore || !autoDowngrade) return;
    restore.ok = 0;
    if (restore.upgradedAt && Date.now() - restore.upgradedAt < UPGRADE_PROBATION) maybeDowngrade({ revert: true });
  }
  function setAutoDowngrade(on) {
    autoDowngrade = on === true;
    if (!autoDowngrade) bitrateState.restore = null;
    configSet('autoDowngrade', autoDowngrade);
    renderHud(false);
    return autoDowngrade;
  }

  // clone() 保留原 Response 的 url/type/redirected/body 语义；只流式读取副本计数，不缓存整段。
  // 超时或超过 32MB 就取消观测分支，绝不 abort 播放器持有的原分支。
  function observeFetchSegment(response, request, started) {
    if (!response?.ok || !response.body) return;
    let clone;
    try { clone = response.clone(); } catch (e) { return; }
    if (!clone.body) return;
    const reader = clone.body.getReader();
    const observer = { cancel: () => reader.cancel('bili-boost media changed').catch(() => { }) };
    cdnState.fetchObservers.add(observer);
    // 即使浏览器异常地长期不结束流，也不给观测器集合无界增长的机会。
    if (cdnState.fetchObservers.size > 32) {
      const oldest = cdnState.fetchObservers.values().next().value;
      oldest.cancel();
      cdnState.fetchObservers.delete(oldest);
    }
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
        cdnState.fetchObservers.delete(observer);
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
    this[XHR_PLAYINFO_PASSIVE] = playerData && !playurl;
    if (playerData) {
      notePlayRequest(rawUrl);
      suppressStallChecks(STALL_LOAD_GRACE);
    }
    const out = typeof rawUrl === 'string' || rawUrl instanceof URL ? rewriteSegmentUrl(rawUrl) : rawUrl;
    this[XHR_PLAYURL] = playurl;
    this[XHR_CDN] = null;
    try {
      const url = looksLikeMediaRaw(out) ? new URL(out, location.href) : null;
      if (url && isMedia(url)) this[XHR_CDN] = {
        host: url.hostname, url, key: keyOf(url), generation: mediaGeneration,
        rewrittenFrom: out !== rawUrl ? hostOfRaw(rawUrl) : null,
      };
    } catch (e) { }
    return origOpen.call(this, method, out, ...rest);
  };

  // 只记录分片请求的 Range（播放器读到哪了），不改任何请求头。
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    const cdnRequest = this[XHR_CDN];
    if (cdnRequest && String(name).toLowerCase() === 'range') cdnRequest.range = value;
    return origSetRequestHeader.call(this, name, value);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    const cdnRequest = this[XHR_CDN];
    if (cdnRequest) {
      if (cdnRequest.range) noteCursor(cdnRequest.url, cdnRequest.range);
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
        try {
          const total = /\/(\d+)\s*$/.exec(this.getResponseHeader('content-range') || '');
          if (total) noteTotal(cdnRequest.url.pathname, Number(total[1]));
        } catch (e) { }
        let status = 0;
        try { status = this.status; } catch (e) { }
        if (isSegmentHttpFailure(status)) {
          onSegmentHttpFailure(cdnRequest, status);
          return;
        }
        recordRealTransfer(cdnRequest, event.loaded, started, firstAt, firstLoaded,
          performance.now(), 'xhr');
      }, { once: true });
    }
    if (this[XHR_PLAYINFO_PASSIVE]) {
      // 编码模块关闭时不劫持响应，只在结束后读一次码率表。
      this.addEventListener('loadend', () => {
        try {
          notePlayinfoBitrates(this.responseType === 'json' ? this.response
            : JSON.parse(this.responseType === '' || this.responseType === 'text' ? this.responseText : 'null'));
        } catch (e) { }
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

  function rangeHeaderOf(input, init) {
    try {
      const headers = init?.headers;
      if (headers instanceof Headers) return headers.get('range');
      if (Array.isArray(headers)) return headers.find(pair => String(pair?.[0]).toLowerCase() === 'range')?.[1] || null;
      if (headers && typeof headers === 'object') {
        for (const name of Object.keys(headers)) if (name.toLowerCase() === 'range') return headers[name];
      }
      if (input instanceof Request) return input.headers.get('range');
    } catch (e) { }
    return null;
  }

  window.fetch = async function (input, init) {
    const originalUrl = typeof input === 'string' || input instanceof URL ? String(input) : (input && input.url) || '';
    const playerData = isVideoPage() && isPlayurl(originalUrl);
    if (playerData) {
      notePlayRequest(originalUrl);
      suppressStallChecks(STALL_LOAD_GRACE);
    }
    let rewrittenFrom = null;
    if (typeof input === 'string' || input instanceof URL) {
      const before = String(input);
      input = rewriteSegmentUrl(input);
      if (String(input) !== before) rewrittenFrom = hostOfRaw(before);
    } else if (input instanceof Request) {
      const rewritten = rewriteSegmentUrl(input.url);
      if (rewritten !== input.url) {
        rewrittenFrom = hostOfRaw(input.url);
        input = new Request(rewritten, input);
      }
    }
    let cdnRequest = null;
    try {
      const rawRequestUrl = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
      const requestUrl = looksLikeMediaRaw(rawRequestUrl) ? new URL(rawRequestUrl, location.href) : null;
      const method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
      if (requestUrl && method === 'GET' && isMedia(requestUrl)) {
        cdnRequest = { host: requestUrl.hostname, url: requestUrl, key: keyOf(requestUrl), generation: mediaGeneration,
          rewrittenFrom };
        noteCursor(requestUrl, rangeHeaderOf(input, init));
      }
    } catch (e) { }
    const started = cdnRequest ? performance.now() : 0;
    const response = await origFetch.call(this, input, init);
    if (cdnRequest) {
      if (isSegmentHttpFailure(response.status)) onSegmentHttpFailure(cdnRequest, response.status);
      else observeFetchSegment(response, cdnRequest, started);
    }
    if (playerData && !codecActive()) {
      try { response.clone().json().then(notePlayinfoBitrates, () => { }); } catch (e) { }
    }
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

    // Safari/WebKit：iPhone 只暴露 ManagedMediaSource，全局没有 MediaSource（MDN BCD：
    // "Exposed in Mobile Safari on iPad but not on iPhone"）；macOS Safari 17+ 两者并存，
    // 播放器可任选其一。旧写法直接读 MediaSource.prototype，在 iPhone 上抛 ReferenceError，
    // 会把后面的卡顿监听、调试接口和 HUD 初始化整段打断。
    // WebKit IDL 中 ManagedMediaSource 继承 MediaSource 且不重声明 addSourceBuffer，
    // 所以沿原型链找到真正拥有该方法的原型，去重后每个只包一次；都不存在就跳过。
    const sourceBufferProtos = new Set();
    for (const Ctor of [window.MediaSource, window.ManagedMediaSource]) {
      let proto = typeof Ctor === 'function' ? Ctor.prototype : null;
      while (proto && !Object.prototype.hasOwnProperty.call(proto, 'addSourceBuffer')) {
        proto = Object.getPrototypeOf(proto);
      }
      if (proto && typeof proto.addSourceBuffer === 'function') sourceBufferProtos.add(proto);
    }
    for (const proto of sourceBufferProtos) {
      const addSourceBuffer = proto.addSourceBuffer;
      proto.addSourceBuffer = function (mime) {
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
  }

  function codecLabel(mime) {
    if (/av01/i.test(mime)) return 'AV1';
    if (/hvc1|hev1/i.test(mime)) return 'HEVC/H.265';
    if (/avc1/i.test(mime)) return 'AVC/H.264';
    return mime || '未检测到编码';
  }
  const codecMime = () => codecState.picked || codecState.inferred?.mime || null;
  // Safari/Userscripts 下 addSourceBuffer 钩子可能拿不到（注入晚于播放器初始化），
  // 这时按分片路径对上 playurl 里的那一路流，用它的 codecs 串判定编码与硬解。
  function inferCodecFromSegment(entry) {
    if (!entry.codecs) return;
    const mime = `video/mp4; codecs="${entry.codecs}"`;
    if (codecState.inferred?.mime === mime) return;
    codecState.inferred = { mime, width: entry.width, height: entry.height,
      frameRate: entry.frameRate, bandwidth: entry.bandwidth };
    if (codecState.picked) return;
    codecState.efficient = null;
    codecState.reason = '';
    Promise.resolve().then(updateCodecStatus);
  }
  // 编码查不到时给出原因，而不是笼统的“未知”。
  function codecReasonText() {
    if (codecState.efficient != null) return '';
    if (codecState.statusPending) return '检测中…';
    if (codecMime()) return codecState.reason || '尚未查询硬解能力';
    if (!isVideoPage()) return '非视频页';
    if (!cdnState.sawMedia) return '尚未拦到分片请求';
    if (!bitrateState.byPath.size) return '未拦到 SourceBuffer，且未拿到 playurl（可能早于脚本注入）';
    return '分片路径未匹配 playurl 中的任何视频流';
  }

  // decodingInfo 三步：media-source → hev1 换 hvc1（WebKit 对 hev1 常报不支持）→ file。
  function queryEfficiency(contentType, video, isCancelled) {
    const caps = navigator.mediaCapabilities;
    if (!caps || typeof caps.decodingInfo !== 'function') {
      return Promise.resolve({ efficient: null, reason: '浏览器不支持 mediaCapabilities.decodingInfo' });
    }
    const config = (type, codec) => ({
      type,
      video: { contentType: codec, width: video.width || 1920, height: video.height || 1080,
        bitrate: video.bitrate || 4000000, framerate: video.framerate || 30 },
    });
    const attempts = [['media-source', contentType]];
    if (/hev1/i.test(contentType)) attempts.push(['media-source', contentType.replace(/hev1/ig, 'hvc1')]);
    attempts.push(['file', attempts[attempts.length - 1][1]]);
    return (async () => {
      let lastReason = 'decodingInfo 报告不支持 ' + contentType;
      for (const [type, codec] of attempts) {
        if (isCancelled()) return { efficient: null, reason: '已取消' };
        let info;
        try { info = await caps.decodingInfo(config(type, codec)); } catch (e) {
          lastReason = 'decodingInfo 出错：' + (e?.name || e);
          continue;
        }
        if (info && info.supported !== false && typeof info.powerEfficient === 'boolean') {
          return { efficient: info.powerEfficient, reason: '' };
        }
        if (info?.supported === true) lastReason = 'decodingInfo 未给出 powerEfficient';
      }
      return { efficient: null, reason: lastReason };
    })();
  }

  async function updateCodecStatus() {
    const picked = codecMime();
    if (!picked) return;
    const via = codecState.picked ? 'SourceBuffer' : '分片匹配 playurl';
    const generation = mediaGeneration;
    const previous = codecState.statusPending;
    if (previous?.generation === generation && previous.picked === picked && !previous.cancelled) return;
    previous?.cancel();
    const task = { generation, picked, cancelled: false, cancel: () => { task.cancelled = true; } };
    codecState.statusPending = task;
    const video = document.querySelector('video');
    try {
      if (video && !video.videoWidth) {
        await new Promise(resolve => {
          let timer;
          const done = () => {
            clearTimeout(timer);
            video.removeEventListener('loadedmetadata', done);
            resolve();
          };
          task.cancel = () => { task.cancelled = true; done(); };
          video.addEventListener('loadedmetadata', done, { once: true });
          timer = setTimeout(done, 1500);
        });
      }
      if (task.cancelled) return;
      const hint = codecState.inferred?.mime === picked ? codecState.inferred : {};
      // The capability promise cannot be aborted; cancel our wait and ignore its late result.
      const outcome = await new Promise(resolve => {
        let settled = false;
        let timer;
        const done = value => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        };
        task.cancel = () => { task.cancelled = true; done(null); };
        timer = setTimeout(() => done({ efficient: null, reason: `decodingInfo ${DECODING_INFO_TIMEOUT / 1000} 秒未返回` }),
          DECODING_INFO_TIMEOUT);
        try {
          queryEfficiency(picked, {
            width: video?.videoWidth || hint.width, height: video?.videoHeight || hint.height,
            bitrate: hint.bandwidth, framerate: hint.frameRate,
          }, () => settled).then(done, () => done({ efficient: null, reason: 'decodingInfo 查询失败' }));
        } catch (e) { done({ efficient: null, reason: 'decodingInfo 查询失败' }); }
      });
      if (!outcome || task.cancelled || generation !== mediaGeneration || picked !== codecMime()) return;
      codecState.efficient = outcome.efficient;
      codecState.reason = outcome.reason;
      codecState.via = via;
      renderHud(false);
    } finally {
      if (codecState.statusPending === task) codecState.statusPending = null;
    }
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
    cdnState.lastStallAt = now;
    recordRealStall(current);
    noteRestoreStall();
    cdnState.idleWaitCancel?.();
    renderHud(false);
    if (!current) return;
    // 卡顿时缓冲必然不足：不发任何探测，只用已有数据决定是否切走，并受滞回/60 秒限频约束。
    const decision = decideFromData(key, current, { stall: true });
    const held = decision ? switchBlockedReason(current, decision.host, { stall: true }) : '没有可切换的兼容源';
    if (held) {
      cdnState.held = { at: now, want: decision?.host || null, keep: current, reason: held };
      console.warn('[bili-cdn] 确认卡顿，但保持', current, '：', held);
      renderHud(false);
      return;
    }
    cdnState.lastRetest = now;
    if (!cdnState.rejected.has(key)) cdnState.rejected.set(key, new Set());
    cdnState.rejected.get(key).add(current);
    cdnState.manual.delete(key);
    commitAutoSwitch(key, current, decision.host, '卡顿·' + decision.via);
    if (cdnState.activeHost === current) cdnState.activeHost = null;
    cdnState.perf.length = 0;
    console.warn('[bili-cdn] 确认卡顿 → 弃用', current, '改用', decision.host,
      `（依据：${decision.via}${decision.kbps ? ' ' + decision.kbps + 'KB/s' : ''}；缓冲恢复后再补测）`);
    deferProbe(probeUrlFor(), '卡顿后补测');
    renderHud(false);
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
    // 复用 timeupdate：缓冲回到 15 秒以上再补测，iframe 内嵌播放器也不需要额外定时器。
    if (cdnState.pendingProbe) maybeRunDeferredProbe();
    if (cdnState.probing.size) reapStuckProbe();
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
    if (codecState.statusPending) return ['⏳ 检测中', '#bbb'];
    return ['⚪ 无法判定硬解', '#bbb'];
  }

  function setHudEnabled(on) {
    hudOn = on !== false;
    configSet('hud', hudOn);
    try { localStorage.setItem('biliCdnHud', hudOn ? 'on' : 'off'); } catch (e) { }
    if (!hudOn) {
      const box = document.getElementById('bili-boost-hud');
      if (box) {
        clearTimeout(box.__collapseTimer);
        box.removeEventListener('click', box.__onClick);
        box.remove();
      }
    } else renderHud(false);
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
      'box-shadow:0 3px 14px rgba(0,0,0,.5);white-space:pre;transition:opacity .4s;cursor:pointer;' +
      // Safari 至今只认带前缀的 -webkit-user-select（MDN BCD），否则连点 HUD 会选中文字。
      '-webkit-user-select:none;user-select:none';
    box.__onClick = event => {
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
      if (action === 'copy-diag') {
        event.stopPropagation();
        copyDiagnostics();
        return;
      }
      if (action === 'downgrade') {
        event.stopPropagation();
        setAutoDowngrade(!autoDowngrade);
        return;
      }
      hudExpanded = !hudExpanded;
      diagNote = '';
      renderHud(false);
    };
    box.addEventListener('click', box.__onClick);
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
    // HUD 与 __biliBoost.当前源 读同一个函数；记录渲染时的值，500ms 同步发现不一致就重绘。
    const current = currentCdnSource();
    hudRenderedSource = current;
    const manual = cdnState.curKey && cdnState.manual.get(cdnState.curKey);
    const real = medianKbps();
    const realTtfb = medianTtfb();
    const goodKbps = needKbps() * BITRATE_HEADROOM;
    const cdnLine = (cdnState.missedWarning ? '<span style="color:#ec9">⚠️ 没拦到分片请求</span> · ' : '') +
      `<b style="color:#fb7299">${current ? shortName(current) : '未选源'}</b>` +
      (manual ? ' <span style="color:#8cf">(手选)</span>' : '') +
      (real != null ? ` · 实测 <b style="color:${real >= goodKbps ? '#6c6' : '#ec9'}">${real}</b> KB/s` : ' · 实测 —') +
      (realTtfb != null ? ` · TTFB ${realTtfb}ms` : '') +
      (cdnState.stalls ? ` · <span style="color:#f66">卡顿 ${cdnState.stalls}</span>` : ' · 卡顿 0');
    const warn = bitrateState.warn;
    const bitrateLine = warn
      ? `<span style="color:#f96">⚠️ 所有源都 &lt; 1.2×码率：需 ${warn.required} KB/s，最快约 ${warn.best} KB/s` +
        `${warn.stale ? `（另有 ${warn.stale} 个源超过 3 分钟没有新数据，未计入）` : ''}${autoDowngrade ? '' : '，建议降一档清晰度'}</span>`
      : '';
    const [status, statusColor] = efficiencyText();
    const reason = codecReasonText();
    const codecLine = `<span style="color:${statusColor}">${status}</span> · ${codecLabel(codecMime())}` +
      (codecState.via === '分片匹配 playurl' ? ' <span style="color:#888">(据分片)</span>' : '') +
      (reason ? ` <span style="color:#888">· ${reason}</span>` : '');
    const conflictLine = legacyConflict.detected
      ? '<span style="color:#ff6b6b;font-weight:bold">⚠️ 旧版 bili-cdn-fix 仍在运行，请到脚本管理器停用</span>'
      : '';
    const conflictPrefix = conflictLine ? conflictLine + '<br>' : '';

    if (!hudExpanded) {
      box.innerHTML = conflictPrefix + cdnLine + '<br>' + (bitrateLine ? bitrateLine + '<br>' : '') + codecLine;
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
        const shown = result.fusedKbps || result.effectiveKbps || result.kbps || 0;
        const color = !probeSucceeded(result) ? '#f66' : shown >= goodKbps ? '#6c6' : '#ec9';
        const tag = (result.realSamples ? `融合${result.realSamples}片实测 · ` : '') + (result.note || result.stage);
        const ttfb = Number.isFinite(result.ttfb) ? ` · ${String(result.ttfb).padStart(4)}ms` : '';
        let row = `${mark} ${sourceLink(result.host)} <span style="color:${color}">${String(shown).padStart(5)}</span> KB/s${ttfb} <span style="color:#888">${tag}</span>`;
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
      if (cdnState.lastResults.incomplete) {
        probeRows += '<br><span style="color:#888">缓冲不足，未完成精测：按快筛+真实分片决策，缓冲恢复后补测</span>';
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
    const held = cdnState.held
      ? `<br><span style="color:#ec9">⏸ ${cdnState.held.reason}</span>` : '';
    const need = requiredKbps();
    const bitrateInfo = `<br><span style="color:#888">码率：${need ? `需 ${need} KB/s（1.2× = ${Math.round(need * BITRATE_HEADROOM)}）` : '未知（按 ' + FALLBACK_REQUIRED_KBPS + ' KB/s 估）'}</span>` +
      (bitrateLine ? '<br>' + bitrateLine : '') +
      `<br><span data-action="downgrade" style="color:#8cf">跟不上码率时自动降一档：${autoDowngrade ? '开' : '关'}（点击切换）</span>` +
      (bitrateState.downgradeNote ? `<br><span style="color:#888">${bitrateState.downgradeNote}</span>` : '');
    box.innerHTML = conflictDetails + `<span style="color:#888">CDN 测速${cdnState.lastResults ? '(' + cdnState.lastResults.why + ') · 精测=头部+播放前方，显示有效速度（与真实分片融合）/TTFB' : ''}</span><br>${probeRows}${held}${bitrateInfo}` +
      `<hr style="border:0;border-top:1px solid #444;margin:5px 0"><span style="color:#888">编码信息</span><br>` +
      `${codecLine}<br>编码：${codecLabel(codecMime())}<br>powerEfficient：${codecState.efficient == null ? '无法判定（' + (reason || '—') + '）' : codecState.efficient}<br>` +
      `已剔除 AV1：${codecState.stripped} 条<br>B站提供：${offered}` +
      `<hr style="border:0;border-top:1px solid #444;margin:5px 0">` +
      `<span data-action="codec" style="color:#8cf">编码模块：${codecModeLabel()}（点击轮换）</span><br>` +
      (codecActive() ? `<span data-action="prefer" style="color:#8cf">编码偏好：${prefer === 'avc' ? 'H.264' : 'H.265'}（点击切换）</span><br>` : '') +
      `<span data-action="hud" style="color:#8cf">HUD：开（点击关闭）</span>` +
      `<br><span data-action="copy-diag" style="color:#8cf">复制诊断 JSON（反馈问题时附上）</span>` +
      (diagNote ? `<span style="color:#888"> · ${diagNote}</span>` : '') +
      `<hr style="border:0;border-top:1px solid #444;margin:5px 0">${cdnLine}`;
    if (expand) {
      clearTimeout(box.__collapseTimer);
      box.__collapseTimer = setTimeout(() => {
        hudExpanded = false;
        diagNote = '';
        renderHud(false);
      }, 10000);
    }
  }

  // ---- 诊断报告：一键导出 JSON 供用户反馈 ----
  // 只放 host、速度、计数等排障需要的字段。upos 分片 URL 的查询串里有签名（upsig/deadline/mid 等），
  // 一律在序列化时剥掉；页面地址也只留路径和分 P，不带其它参数。
  const DIAG_MAX_CHARS = 64 * 1024;
  let diagNote = '';
  function stripUrl(value) {
    return value.replace(/\b(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/gi, '$1');
  }
  function diagReplacer(key, value) {
    if (value instanceof URL) return value.origin + value.pathname;
    if (value instanceof Map) return Object.fromEntries(value);
    if (value instanceof Set) return [...value];
    if (typeof value === 'string') return stripUrl(value);
    if (typeof value === 'number' && !Number.isFinite(value)) return null;
    return value;
  }
  const isoTime = ms => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
  function buildDiagnostics() {
    const page = (() => {
      try {
        const part = new URLSearchParams(location.search).get('p');
        return { 路径: location.pathname, 分P: part || null, 顶层窗口: IS_TOP };
      } catch (e) { return { 路径: null, 分P: null, 顶层窗口: IS_TOP }; }
    })();
    const results = cdnState.lastResults;
    const report = {
      格式: 'bili-boost-diag/1',
      版本: SCRIPT_VERSION,
      生成时间: isoTime(Date.now()),
      页面: page,
      环境: {
        UA: String(navigator.userAgent || ''),
        平台: String(navigator.platform || ''),
        AV1硬解: debugApi.AV1硬解,
        编码模块: codecModeLabel(),
        编码偏好: prefer,
      },
      当前源: currentCdnSource(),
      手动源: debugApi.手动源,
      实测速度: debugApi.实测速度,
      首字节延迟: debugApi.首字节延迟,
      卡顿次数: cdnState.stalls,
      诊断状态: debugApi.诊断状态,
      真实速度: debugApi.真实速度,
      分片明细: cdnState.perf.slice(-PERF_WINDOW),
      切源记录: cdnState.switchLog.map(item => ({ ...item, at: isoTime(item.at) })),
      滞回状态: cdnState.held ? { ...cdnState.held, at: isoTime(cdnState.held.at) } : null,
      测速结果: results ? {
        原因: results.why, 时间: isoTime(results.ts), 原始源: results.origHost, 胜出: results.win,
        未完成精测: !!results.incomplete,
        列表: results.list.map(result => ({
          host: result.host, ok: probeSucceeded(result), kbps: result.kbps, effectiveKbps: result.effectiveKbps,
          fusedKbps: result.fusedKbps, priorKbps: result.priorKbps, ttfb: result.ttfb, realSamples: result.realSamples,
          stage: result.stage, note: result.note,
          points: result.points?.map(point => ({ point: point.point, kbps: point.kbps, ttfb: point.ttfb, note: point.note })),
        })),
      } : null,
      码率: debugApi.码率,
      编码检测: debugApi.编码检测,
      B站提供编码: codecState.offered.slice(),
      已剔除AV1: codecState.stripped,
      黑名单详情: debugApi.黑名单详情,
      主机健康: debugApi.主机健康,
      冲突: debugApi.冲突,
    };
    return report;
  }
  function diagnosticsJson() {
    const report = buildDiagnostics();
    let text = JSON.stringify(report, diagReplacer, 2);
    if (text.length <= DIAG_MAX_CHARS) return text;
    // 有界：切源记录/健康档案都已各自有上限，这里再兜一层。依次退成紧凑格式、省略大字段，始终是合法 JSON。
    text = JSON.stringify(report, diagReplacer);
    if (text.length <= DIAG_MAX_CHARS) return text;
    report.主机健康 = '已省略（超长）';
    report.测速结果?.列表.forEach(result => { delete result.points; });
    report.已截断 = true;
    text = JSON.stringify(report, diagReplacer);
    if (text.length <= DIAG_MAX_CHARS) return text;
    return JSON.stringify({ 格式: report.格式, 版本: report.版本, 生成时间: report.生成时间, 页面: report.页面,
      当前源: report.当前源, 卡顿次数: report.卡顿次数, 诊断状态: report.诊断状态, 已截断: true }, diagReplacer);
  }
  // 复制到剪贴板。必须在点击回调里同步发起（Safari 只认用户手势内的剪贴板写入）。
  function copyDiagnostics() {
    const text = diagnosticsJson();
    const legacyCopy = () => {
      try {
        if (!document.body || typeof document.execCommand !== 'function') return false;
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute?.('readonly', '');
        area.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
        document.body.appendChild(area);
        area.select?.();
        let ok = false;
        try { ok = document.execCommand('copy') === true; } finally { area.remove?.(); }
        return ok;
      } catch (e) { return false; }
    };
    const done = ok => {
      if (!ok) console.log('[bili-boost] 诊断 JSON（复制失败，请手动复制）：\n' + text);
      diagNote = ok ? `已复制诊断 JSON（${text.length} 字符）` : '复制失败，诊断 JSON 已打印到控制台';
      renderHud(false);
      return diagNote;
    };
    let pending = null;
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        pending = navigator.clipboard.writeText(text);
      }
    } catch (e) { pending = null; }
    if (!pending || typeof pending.then !== 'function') return Promise.resolve(done(legacyCopy()));
    return pending.then(() => done(true), () => done(legacyCopy()));
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
    get 诊断状态() {
      return {
        generation: mediaGeneration,
        rejected: cdnState.rejected.size,
        picked: cdnState.picked.size,
        manual: cdnState.manual.size,
        probing: cdnState.probing.size,
        perf: cdnState.perf.length,
        blacklist: cdnState.blacklist.size,
        probeControllers: cdnState.activeProbeControllers.size,
        fetchObservers: cdnState.fetchObservers.size,
        health: Object.keys(health).length,
        warningTimers: cdnState.warningTimer ? 1 : 0,
        pendingProbe: cdnState.pendingProbe ? 1 : 0,
        probeBlocked: cdnState.probeBlocked,
        realHosts: cdnState.real.size,
        switches: cdnState.switchLog.length,
      };
    },
    get 真实速度() {
      const out = {};
      for (const [host, record] of cdnState.real) {
        out[shortName(host)] = `中位 ${median(record.samples)} KB/s（${record.samples.length} 片，连续低于码率 ${record.below} 片）`;
      }
      return out;
    },
    get 切源记录() { return cdnState.switchLog.map(item => ({ ...item })); },
    get 滞回状态() { return cdnState.held ? { ...cdnState.held } : null; },
    get 码率() {
      const required = requiredKbps();
      return {
        需要: required == null ? null : required + ' KB/s',
        告警: bitrateState.warn ? { ...bitrateState.warn } : null,
        自动降档: autoDowngrade,
        说明: bitrateState.downgradeNote || '',
        回升: (() => {
          const restore = bitrateState.restore;
          if (!restore) return null;
          return {
            降档前: restore.qn, 当前请求: restore.expectQn, 下一档: restore.target ?? null,
            下一档需要: restore.need ? Math.round(restore.need * UPGRADE_HEADROOM) + ' KB/s' : null,
            连续达标: `${restore.ok || 0}/${UPGRADE_SEGMENTS}`, 失败次数: restore.failures,
            等待: Math.round(restoreQuiet(restore) / 1000) + ' 秒',
            试用中: !!restore.upgradedAt,
          };
        })(),
      };
    },
    自动降档(on) { return setAutoDowngrade(on === true) ? '已开：所有源跟不上码率时自动降一档' : '已关：只提示'; },
    get 编码检测() {
      return {
        编码: codecLabel(codecMime()),
        来源: codecState.via || (codecState.picked ? 'SourceBuffer' : codecState.inferred ? '分片匹配 playurl' : '—'),
        硬解: codecState.efficient,
        原因: codecReasonText(),
      };
    },
    get 测速结果() { return cdnState.lastResults; },
    get 卡顿次数() { return cdnState.stalls; },
    get 黑名单() { const now = Date.now(); return [...cdnState.blacklist.keys()].filter(host => isBanned(host, now)); },
    get 黑名单详情() {
      const now = Date.now();
      return [...cdnState.blacklist].map(([host, entry]) => ({
        host, 原因: entry.reason, 次数: entry.strikes,
        剩余秒: Math.max(0, Math.ceil((entry.until - now) / 1000)),
      }));
    },
    重测() {
      if (cdnState.lastProbeUrl) {
        cdnState.manual.delete(cdnState.curKey);
        cdnState.picked.delete(cdnState.curKey);
        clearCdnCache(cdnState.curKey);
        cdnState.perf.length = 0;
        runCdnProbe(probeUrlFor(), '手动', { manual: true });
        return '测速中…';
      }
      return '还没拦到分片';
    },
    手动选源(host) { return selectManualSource(String(host || '')); },
    自动选源() { return restoreAutomaticSource(); },
    面板(on) { return setHudEnabled(on) ? '已开' : '已关'; },
    get 当前编码() { return codecState.picked; },
    get 编码名称() { return codecLabel(codecMime()); },
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
          (r.ttfb ? ` · TTFB ${r.ttfb}ms` : '') +
          (r.realN ? ` · 实播 ${r.real}KB/s×${r.realN} 片 卡顿 ${r.stalls || 0}` +
            (realPrior(host) != null ? `（先验 ${realPrior(host)}KB/s）` : '') : '');
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
    get 诊断报告() { return JSON.parse(diagnosticsJson()); },
    复制诊断() { return copyDiagnostics(); },
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
