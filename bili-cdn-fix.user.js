// ==UserScript==
// @name         B站 CDN 自动测速切源
// @version      3.0
// @description  两阶段测速（并发快筛 + 串行精测）挑最快的 upos 镜像；播放中用真实分片速度和卡顿事件闭环验证，卡了就自动换源并记住坏源。原始 host 参与竞速，它够快就不动。
// @match        *://www.bilibili.com/*
// @match        *://t.bilibili.com/*
// @match        *://space.bilibili.com/*
// @match        *://m.bilibili.com/*
// @match        *://*.bilibili.com/*
// @run-at       document-start
// @grant        none
// @inject-into  page
// @author       leonjean214
// @downloadURL  https://raw.githubusercontent.com/leonjean214/bili-cdn-switcher/main/bili-cdn-fix.user.js
// @updateURL    https://raw.githubusercontent.com/leonjean214/bili-cdn-switcher/main/bili-cdn-fix.user.js
// ==/UserScript==
(function () {
  'use strict';

  // ---- 配置 ----
  const CANDIDATES = [
    'upos-sz-mirror08c.bilivideo.com',      // 中国移动，海外实测长期最快
    'upos-sz-mirrorali.bilivideo.com',      // 阿里国内
    'upos-sz-mirrorcos.bilivideo.com',      // 腾讯国内
    'upos-sz-mirrorhw.bilivideo.com',       // 华为国内
    'upos-sz-mirrorcosov.bilivideo.com',    // Gcore 海外（缓存命中时极快，未命中很慢）
    'upos-hz-mirrorakam.akamaized.net',     // Akamai，对部分内容 403
  ];
  const QUICK_BYTES = 131072;   // 阶段1 并发快筛：各 128KB，只为淘汰死源和极慢源
  const FULL_BYTES = 786432;    // 阶段2 串行精测：768KB，跨过 TCP 慢启动
  const FINALISTS = 3;          // 进入精测的候选数
  const PROBE_TIMEOUT = 8000;
  const CACHE_TTL = 30 * 60e3;
  const MIN_GAIN = 1.25;        // 候选要比原 host 快 25% 以上才值得切
  const RETEST_COOLDOWN = 45e3; // 卡顿触发重测的冷却时间
  const PERF_WINDOW = 6;        // 实测速度滑动窗口（分片数）

  const UPOS_HOST = /(^|\.)((upos-[a-z0-9-]+\.bilivideo\.com)|(upos-[a-z0-9-]+\.akamaized\.net))$/;
  const MEDIA_EXT = /\.(m4s|mp4|flv)$/;

  const origFetch = window.fetch.bind(window);
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  // ---- 状态 ----
  const blacklist = new Set();   // 探测失败/403 的 host，本会话不再选
  const rejected = new Map();    // key -> Set(host)：本视频播放中被证明不够快的源
  const picked = new Map();      // key -> host
  const probing = new Set();
  const perf = [];               // 最近分片的真实下载速度
  let lastResults = null;        // 最近一次测速明细
  let lastWinner = loadGlobal();
  let stalls = 0;                // 卡顿次数
  let lastRetest = 0;
  let sawMedia = false;
  let curKey = null;
  let lastProbeUrl = null;       // 最近一个真实分片 URL，重测时当探针用

  function loadGlobal() {
    try {
      const v = JSON.parse(localStorage.getItem('biliCdnWinner') || 'null');
      if (v && Date.now() - v.ts < CACHE_TTL) return v.host;
    } catch (e) { /* 存储不可用时忽略 */ }
    return null;
  }
  function saveGlobal(host) {
    try { localStorage.setItem('biliCdnWinner', JSON.stringify({ host, ts: Date.now() })); } catch (e) { }
  }
  function loadCache(key) {
    try {
      const v = JSON.parse(sessionStorage.getItem('biliCdn:' + key) || 'null');
      if (v && Date.now() - v.ts < CACHE_TTL) return v.host;
    } catch (e) { }
    return null;
  }
  function saveCache(key, host) {
    try { sessionStorage.setItem('biliCdn:' + key, JSON.stringify({ host, ts: Date.now() })); } catch (e) { }
  }

  // 同一视频的所有分片共用一条测速结果：用 upgcxcode 路径的目录部分做 key
  const keyOf = (url) => url.pathname.replace(/\/[^/]*$/, '');
  const isMedia = (url) => UPOS_HOST.test(url.hostname) && MEDIA_EXT.test(url.pathname);
  const shortName = (h) => h.replace(/^upos-[a-z]{2}-(mirror|upcdn)?/, '').split('.')[0];

  // ---- 单个候选测速 ----
  async function probe(url, host, bytes) {
    const u = new URL(url.toString());
    u.hostname = host;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT);
    let got = 0, tFirst = 0;
    try {
      const res = await origFetch(u.toString(), { credentials: 'omit', cache: 'no-store', signal: ctl.signal });
      if (!res.ok || !res.body) {
        blacklist.add(host);
        return { host, kbps: 0, note: 'HTTP ' + res.status };
      }
      const reader = res.body.getReader();
      while (got < bytes) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!tFirst) tFirst = performance.now();   // 从首字节算，排除握手延迟
        got += value.length;
      }
      reader.cancel().catch(() => { });
      const dt = (performance.now() - tFirst) / 1000;
      if (!tFirst || got < 32768 || dt <= 0) return { host, kbps: 0, note: '数据不足' };
      return { host, kbps: Math.round(got / 1024 / dt) };
    } catch (e) {
      if (e.name !== 'AbortError') blacklist.add(host);
      if (tFirst && got >= 32768) {   // 超时截断时按已下载量估算，仍是有效的慢速信号
        const dt = (performance.now() - tFirst) / 1000;
        return { host, kbps: Math.round(got / 1024 / dt), note: '超时截断' };
      }
      return { host, kbps: 0, note: e.name === 'AbortError' ? '超时' : '失败' };
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- 两阶段测速 ----
  async function runProbe(url, why) {
    const key = keyOf(url);
    if (probing.has(key)) return;
    probing.add(key);
    try {
      const origHost = url.hostname;
      const bad = rejected.get(key) || new Set();
      const pool = [origHost, ...CANDIDATES].filter(
        (h, i, a) => a.indexOf(h) === i && !blacklist.has(h) && !bad.has(h)
      );
      if (!pool.length) return;

      // 阶段1：并发快筛。会互相抢带宽，所以只用来淘汰死源，不用来排名
      const quick = await Promise.all(pool.map((h) => probe(url, h, QUICK_BYTES)));
      quick.forEach((r) => { r.stage = '快筛'; });
      quick.sort((a, b) => b.kbps - a.kbps);

      // 阶段2：串行精测前几名，独占带宽，这才是可信的排名依据
      const finalists = quick.filter((r) => r.kbps > 0).slice(0, FINALISTS);
      const full = [];
      for (const f of finalists) {
        const r = await probe(url, f.host, FULL_BYTES);
        r.stage = '精测';
        full.push(r);
      }
      full.sort((a, b) => b.kbps - a.kbps);

      const merged = full.concat(quick.filter((q) => !full.some((f) => f.host === q.host)));
      const best = full[0];
      if (!best) return;
      const orig = full.find((r) => r.host === origHost);
      // 原 host 够快就不折腾，避免丢掉 Gcore 的缓存命中
      const win = orig && best.kbps <= orig.kbps * MIN_GAIN ? origHost : best.host;

      picked.set(key, win);
      saveCache(key, win);
      if (win !== origHost) { lastWinner = win; saveGlobal(win); }
      lastResults = { list: merged, win, origHost, why, ts: Date.now() };
      perf.length = 0;   // 换源后重新统计实测速度
      console.log('[bili-cdn] 测速(' + why + ')',
        merged.map((r) => `${shortName(r.host)}=${r.kbps}KB/s${r.note ? '(' + r.note + ')' : '(' + r.stage + ')'}`).join('  '),
        '→ 选用', win);
      render(true);
    } finally {
      probing.delete(key);
    }
  }

  // ---- 改写 ----
  function rewrite(raw) {
    let url;
    try { url = new URL(raw, location.href); } catch (e) { return raw; }
    if (!isMedia(url)) return raw;

    sawMedia = true;
    const key = keyOf(url);
    curKey = key;
    lastProbeUrl = new URL(url.toString());   // 存改写前的原始 URL
    let target = picked.get(key) || loadCache(key);
    if (target) picked.set(key, target);

    if (!target) {
      runProbe(url, '开播');   // 后台开测，本次先用上次的全局赢家顶着
      target = lastWinner;
    }
    const bad = rejected.get(key);
    if (!target || target === url.hostname || blacklist.has(target) || (bad && bad.has(target))) return raw;

    url.hostname = target;
    return url.toString();
  }

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    const out = typeof url === 'string' ? rewrite(url) : url;
    try {
      const u = new URL(out, location.href);
      if (isMedia(u)) this.__cdn = { host: u.hostname, url: u };
    } catch (e) { }
    return origOpen.call(this, method, out, ...rest);
  };

  // 真实分片速度：播放器实际下载的每一片都计一次，这是验证选择对不对的依据
  XMLHttpRequest.prototype.send = function (...args) {
    if (this.__cdn) {
      const t0 = performance.now();
      this.addEventListener('loadend', (e) => {
        const dt = (performance.now() - t0) / 1000;
        if (e.loaded > 65536 && dt > 0.05) {
          perf.push({ host: this.__cdn.host, kbps: Math.round(e.loaded / 1024 / dt) });
          if (perf.length > PERF_WINDOW) perf.shift();
          render(false);
        }
      });
    }
    return origSend.apply(this, args);
  };

  window.fetch = function (input, init) {
    if (typeof input === 'string') {
      input = rewrite(input);
    } else if (input instanceof Request) {
      const r = rewrite(input.url);
      if (r !== input.url) input = new Request(r, input);
    }
    return origFetch(input, init);
  };

  // ---- 闭环验证：真卡了就换源 ----
  // 媒体事件不冒泡，但捕获阶段仍会经过 document，所以这里能抓到播放器的 video
  function onStall() {
    stalls++;
    render(false);
    const key = curKey;
    const cur = key && picked.get(key);
    if (!cur || Date.now() - lastRetest < RETEST_COOLDOWN) return;
    lastRetest = Date.now();
    if (!rejected.has(key)) rejected.set(key, new Set());
    rejected.get(key).add(cur);            // 当前源已被实际播放证伪
    picked.delete(key);
    try { sessionStorage.removeItem('biliCdn:' + key); } catch (e) { }
    console.warn('[bili-cdn] 卡顿 → 弃用', cur, '重新测速');
    if (lastProbeUrl) runProbe(lastProbeUrl, '卡顿重测');
  }
  document.addEventListener('waiting', onStall, true);
  document.addEventListener('stalled', onStall, true);

  // ---- HUD ----
  let hudOn = (() => { try { return localStorage.getItem('biliCdnHud') !== 'off'; } catch (e) { return true; } })();

  function medianKbps() {
    if (!perf.length) return null;
    const v = perf.map((p) => p.kbps).sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)];
  }

  function render(expand) {
    if (!hudOn) return;
    if (!document.body) { document.addEventListener('DOMContentLoaded', () => render(expand)); return; }
    let box = document.getElementById('bili-cdn-hud');
    if (!box) {
      box = document.createElement('div');
      box.id = 'bili-cdn-hud';
      box.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;background:rgba(20,20,22,.88);' +
        'color:#ddd;font:11px/1.55 ui-monospace,Menlo,monospace;padding:6px 10px;border-radius:7px;' +
        'box-shadow:0 3px 14px rgba(0,0,0,.4);pointer-events:none;white-space:pre;transition:opacity .4s';
      document.body.appendChild(box);
    }
    const cur = (curKey && picked.get(curKey)) || lastWinner;
    const real = medianKbps();
    const line = `<b style="color:#fb7299">${cur ? shortName(cur) : '未选源'}</b>` +
      (real ? ` · 实测 <b style="color:${real > 400 ? '#6c6' : '#ec9'}">${real}</b> KB/s` : ' · 实测 —') +
      (stalls ? ` · <span style="color:#f66">卡顿 ${stalls}</span>` : ' · 卡顿 0');

    if (expand && lastResults) {
      const rows = lastResults.list.map((r) => {
        const mark = r.host === lastResults.win ? '✅' : (r.host === lastResults.origHost ? '原' : '　');
        const color = r.kbps === 0 ? '#f66' : r.kbps > 400 ? '#6c6' : '#ec9';
        const tag = r.note ? r.note : r.stage;
        return `${mark} ${shortName(r.host).padEnd(7)} <span style="color:${color}">${String(r.kbps).padStart(5)}</span> KB/s <span style="color:#888">${tag}</span>`;
      }).join('<br>');
      box.innerHTML = `<span style="color:#888">测速(${lastResults.why}) · 精测为准</span><br>${rows}` +
        (lastResults.win === lastResults.origHost ? '<br><span style="color:#888">原始源够快，未改写</span>' : '') +
        `<hr style="border:0;border-top:1px solid #444;margin:5px 0">${line}`;
      clearTimeout(box.__t);
      box.__t = setTimeout(() => render(false), 10000);
    } else {
      box.innerHTML = line;
    }
    box.style.opacity = '1';
  }

  // ---- 启动自检 ----
  console.log('[bili-cdn] v3.0 已注入，控制台可用 __biliCdn 查看状态');
  render(false);
  setTimeout(() => {
    if (!sawMedia) {
      console.warn('[bili-cdn] 5 秒内未拦截到 m4s/mp4/flv 请求');
      const box = document.getElementById('bili-cdn-hud');
      if (box) box.innerHTML = '<span style="color:#ec9">⚠️ 没拦到分片请求</span>';
    }
  }, 5000);

  // ---- 调试接口 ----
  window.__biliCdn = {
    get 当前源() { return (curKey && picked.get(curKey)) || lastWinner; },
    get 实测速度() { return medianKbps() + ' KB/s（最近 ' + perf.length + ' 个分片中位数）'; },
    get 分片明细() { return perf.slice(); },
    get 测速结果() { return lastResults; },
    get 卡顿次数() { return stalls; },
    get 黑名单() { return [...blacklist]; },
    重测() { if (lastProbeUrl) { picked.delete(curKey); runProbe(lastProbeUrl, '手动'); return '测速中…'; } return '还没拦到分片'; },
    面板(on) { hudOn = on !== false; try { localStorage.setItem('biliCdnHud', hudOn ? 'on' : 'off'); } catch (e) { } if (!hudOn) { const b = document.getElementById('bili-cdn-hud'); if (b) b.remove(); } else render(false); return hudOn ? '已开' : '已关'; },
  };
})();
