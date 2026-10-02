#!/usr/bin/env node
// v1.7.0 卡顿优化回归：不启动浏览器、不访问网络。
// 用 node:vm 跑真实的 bili-boost.user.js，fetch / XHR / <video> / 定时器全部是模拟的，
// 时间走虚拟时钟（几分钟的播放在几秒内跑完）。Mac / Win / Linux 都可以直接跑：
//   node tools/qa-stall.mjs            # 跑全部
//   node tools/qa-stall.mjs --verbose  # 同时打印脚本日志
//   node tools/qa-stall.mjs --contrast # 额外用 main 分支旧版跑同场景做对照（需要 git）
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const VERBOSE = process.argv.includes('--verbose');
const CONTRAST = process.argv.includes('--contrast');
const SCRIPT = await readFile(new URL('../bili-boost.user.js', import.meta.url), 'utf8');
const KB = 1024;
const MB = 1024 * 1024;
const SEG_BYTES = 512 * KB;           // 一片 = 2 秒视频
const SEG_SECONDS = 2;
const VIDEO_BANDWIDTH = 2_097_152;    // 2 Mbps = 256 KB/s
const AUDIO_BANDWIDTH = 131_072;      // 128 kbps = 16 KB/s → 需求 272 KB/s，1.2× = 326 KB/s
const VIDEO_PATH = '/upgcxcode/09/61/1234567/1234567-1-30080.m4s';
const AUDIO_PATH = '/upgcxcode/09/61/1234567/1234567-1-30280.m4s';
const FILE_BYTES = 64 * MB;
const H = name => `upos-sz-mirror${name}.bilivideo.com`;
const AKAM = 'upos-hz-mirrorakam.akamaized.net';

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };

class Clock {
  constructor() {
    this.now = 1_790_000_000_000;
    this.origin = this.now;
    this.seq = 0;
    this.timers = new Map();
  }
  setTimeout(fn, ms = 0, ...args) {
    const id = ++this.seq;
    this.timers.set(id, { at: this.now + Math.max(0, Number(ms) || 0), fn, args, every: null });
    return id;
  }
  setInterval(fn, ms = 0, ...args) {
    const id = ++this.seq;
    const every = Math.max(1, Number(ms) || 0);
    this.timers.set(id, { at: this.now + every, fn, args, every });
    return id;
  }
  clear(id) { this.timers.delete(id); }
  perf() { return this.now - this.origin + 1000; }
  async advance(ms) {
    const target = this.now + ms;
    for (;;) {
      await flush();
      let nextId = null;
      let next = null;
      for (const [id, timer] of this.timers) {
        if (timer.at > target) continue;
        if (!next || timer.at < next.at || (timer.at === next.at && id < nextId)) { next = timer; nextId = id; }
      }
      if (!next) break;
      this.now = Math.max(this.now, next.at);
      if (next.every) next.at = this.now + next.every;
      else this.timers.delete(nextId);
      next.fn(...next.args);
    }
    this.now = target;
    await flush();
  }
}

class Storage {
  constructor() { this.map = new Map(); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
}

class Emitter {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, fn, options) {
    if (!fn) return;
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    const list = this.listeners.get(type);
    if (!list.some(item => item.fn === fn)) list.push({ fn, once: typeof options === 'object' && !!options?.once });
  }
  removeEventListener(type, fn) {
    const list = this.listeners.get(type);
    if (list) this.listeners.set(type, list.filter(item => item.fn !== fn));
  }
  emitLocal(type, event) {
    for (const item of [...(this.listeners.get(type) || [])]) {
      if (item.once) this.removeEventListener(type, item.fn);
      item.fn.call(this, event);
    }
  }
}

function abortError() {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

// 一个模拟页面：真实脚本 + 模拟网络/播放器。model 决定每个 host 在每个字节位置的速度。
function createPage(model, { hud = true, mediaCapabilities = 'safari', source = SCRIPT } = {}) {
  const clock = new Clock();
  const logs = [];
  const net = {
    probes: [],            // 每个探测请求（cache:no-store 的 fetch）
    probeActive: 0,
    probePeak: 0,
    segments: [],          // 播放器分片 XHR
    xhrAborts: 0,
  };
  const document = new Emitter();
  const elements = new Map();
  class Element extends Emitter {
    constructor(tag) {
      super();
      this.tagName = tag.toUpperCase();
      this.style = { cssText: '', setProperty() { } };
      this.html = '';
      this.id = '';
    }
    set innerHTML(value) { this.html = String(value); }
    get innerHTML() { return this.html; }
    get textContent() {
      return this.html.replace(/<br>/g, '\n').replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    }
    remove() { if (elements.get(this.id) === this) elements.delete(this.id); }
    click() { this.emitLocal('click', { target: { closest: () => null }, stopPropagation() { } }); }
  }
  class FakeVideo extends Element {
    constructor() {
      super('video');
      this.currentTime = 0;
      this.paused = true;
      this.ended = false;
      this.seeking = false;
      this.readyState = 0;
      this.videoWidth = 1920;
      this.videoHeight = 1080;
      this.bufferedEnd = 0;
    }
    get buffered() {
      const end = this.bufferedEnd;
      return { length: end > 0 ? 1 : 0, start: () => 0, end: () => end };
    }
    emit(type) {
      const event = { type, target: this };
      for (const item of [...(document.listeners.get(type) || [])]) item.fn.call(document, event);
      this.emitLocal(type, event);
    }
  }
  let video = null;
  document.body = { appendChild(element) { elements.set(element.id, element); return element; } };
  document.createElement = tag => new Element(tag);
  document.getElementById = id => elements.get(id) || null;
  document.querySelector = selector => (selector === 'video' ? video : null);

  const speedOf = (host, offset, kind) => model.speed(host, offset, kind, clock.now);
  const ttfbOf = host => (model.ttfb ? model.ttfb(host) : 80);

  function fakeResponse({ host, offset, size, status, signal, kind, onDone, hang }) {
    let delivered = 0;
    let finished = false;
    const finish = () => { if (!finished) { finished = true; onDone?.(); } };
    const reader = {
      read() {
        if (finished || delivered >= size) { finish(); return Promise.resolve({ done: true, value: undefined }); }
        if (hang) return new Promise(() => { });       // Safari：abort 后 read 仍永不返回
        return new Promise((resolve, reject) => {
          const chunk = Math.min(64 * KB, size - delivered);
          const ms = chunk / KB / Math.max(1, speedOf(host, offset + delivered, kind)) * 1000;
          const id = clock.setTimeout(() => {
            delivered += chunk;
            resolve({ done: false, value: new Uint8Array(chunk) });
          }, ms);
          signal?.addEventListener('abort', () => { clock.clear(id); finish(); reject(abortError()); }, { once: true });
        });
      },
      cancel() { finish(); return Promise.resolve(); },
    };
    const headers = new Headers({ 'content-length': String(status === 200 ? FILE_BYTES : size) });
    const body = { getReader: () => reader, cancel: () => reader.cancel() };
    return { ok: status >= 200 && status < 300, status, headers, body, clone() { return this; } };
  }

  function fetch(input, init = {}) {
    const url = new URL(String(typeof input === 'string' ? input : input.url));
    const isProbe = init.cache === 'no-store';
    const range = /bytes=(\d+)-(\d+)/.exec(init.headers?.Range || init.headers?.range || '');
    const offset = range ? Number(range[1]) : 0;
    const size = range ? Number(range[2]) - offset + 1 : FILE_BYTES;
    const status = model.status ? model.status(url.hostname, !!range) : (range ? 206 : 200);
    const record = { host: url.hostname, offset, size, at: clock.now, video: video && {
      paused: video.paused, time: video.currentTime, ahead: Math.max(0, video.bufferedEnd - video.currentTime) } };
    if (isProbe) {
      net.probes.push(record);
      net.probeActive++;
      net.probePeak = Math.max(net.probePeak, net.probeActive);
    }
    let done = false;
    const onDone = () => { if (!done) { done = true; if (isProbe) net.probeActive--; } };
    return new Promise((resolve, reject) => {
      const id = clock.setTimeout(() => {
        resolve(fakeResponse({ host: url.hostname, offset, size, status, signal: init.signal, kind: isProbe ? 'probe' : 'segment',
          onDone, hang: model.hang?.(url.hostname) }));
      }, ttfbOf(url.hostname));
      init.signal?.addEventListener('abort', () => {
        if (model.hang?.(url.hostname)) return;
        clock.clear(id); onDone(); reject(abortError());
      }, { once: true });
    });
  }

  class FakeXHR extends Emitter {
    constructor() { super(); this.headers = {}; this.responseType = ''; this.readyState = 0; }
    open(method, url) { this.method = method; this.url = String(url); this.readyState = 1; }
    setRequestHeader(name, value) { this.headers[String(name).toLowerCase()] = String(value); }
    getResponseHeader(name) { return String(name).toLowerCase() === 'content-range' ? this.contentRange || null : null; }
    abort() { this.aborted = true; net.xhrAborts++; }
    send() {
      const url = new URL(this.url);
      const range = /bytes=(\d+)-(\d+)/.exec(this.headers.range || '');
      const offset = range ? Number(range[1]) : 0;
      const size = range ? Number(range[2]) - offset + 1 : SEG_BYTES;
      const entry = { host: url.hostname, path: url.pathname, offset, size, startedAt: clock.now, loaded: 0, endedAt: null };
      net.segments.push(entry);
      this.contentRange = `bytes ${offset}-${offset + size - 1}/${FILE_BYTES}`;
      const step = () => {
        if (this.aborted) { entry.endedAt = clock.now; this.emitLocal('loadend', { loaded: entry.loaded }); return; }
        if (entry.loaded >= size) {
          entry.endedAt = clock.now;
          this.emitLocal('loadend', { loaded: entry.loaded });
          return;
        }
        const chunk = Math.min(64 * KB, size - entry.loaded);
        const ms = chunk / KB / Math.max(1, speedOf(url.hostname, offset + entry.loaded, 'segment')) * 1000;
        clock.setTimeout(() => {
          entry.loaded += chunk;
          this.emitLocal('progress', { loaded: entry.loaded });
          step();
        }, ms);
      };
      clock.setTimeout(step, ttfbOf(url.hostname));
    }
  }

  const localStorage = new Storage();
  if (!hud) localStorage.setItem('bhw_hud', 'false');
  // AV1 能力已缓存为“无”，与 M2 Mac 一致；脚本不会在加载时再发能力查询。
  const env = ['QA-Safari', 'MacIntel', 8].join('|');
  localStorage.setItem('bhw_av1hw', JSON.stringify({ value: false, at: clock.now, env }));
  const navigator = { userAgent: 'QA-Safari', platform: 'MacIntel', hardwareConcurrency: 8 };
  if (mediaCapabilities === 'safari') {
    // WebKit 风格：hev1 串在 media-source 下报不支持，hvc1 才给出硬解结论。
    navigator.mediaCapabilities = {
      decodingInfo: config => Promise.resolve(/hev1/i.test(config.video.contentType) && config.type === 'media-source'
        ? { supported: false, smooth: false, powerEfficient: false }
        : { supported: true, smooth: true, powerEfficient: !/av01/i.test(config.video.contentType) }),
    };
  }
  class FakeDate extends Date { static now() { return clock.now; } }
  const windowListeners = new Emitter();
  const sandbox = {
    console: {
      log: (...args) => { logs.push(args.join(' ')); if (VERBOSE) console.log('   [page]', ...args); },
      warn: (...args) => { logs.push(args.join(' ')); if (VERBOSE) console.warn('   [page]', ...args); },
      error: (...args) => { logs.push(args.join(' ')); console.error('   [page]', ...args); },
    },
    document,
    location: { href: 'https://www.bilibili.com/video/BV1PF4m177EQ/?p=9', pathname: '/video/BV1PF4m177EQ/', search: '?p=9', hash: '' },
    localStorage,
    sessionStorage: new Storage(),
    navigator,
    performance: { now: () => clock.perf() },
    Date: FakeDate,
    setTimeout: (fn, ms, ...args) => clock.setTimeout(fn, ms, ...args),
    clearTimeout: id => clock.clear(id),
    setInterval: (fn, ms, ...args) => clock.setInterval(fn, ms, ...args),
    clearInterval: id => clock.clear(id),
    queueMicrotask,
    fetch,
    XMLHttpRequest: FakeXHR,
    HTMLVideoElement: FakeVideo,
    URL, URLSearchParams, AbortController, Headers, Request, Response, Uint8Array,
    addEventListener: (...args) => windowListeners.addEventListener(...args),
    removeEventListener: (...args) => windowListeners.removeEventListener(...args),
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.top = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(source, context, { filename: 'bili-boost.user.js' });
  const api = sandbox.__biliBoost;

  function setPlayinfo(orig = H('cosov')) {
    sandbox.__playinfo__ = { code: 0, data: {
      accept_quality: [80, 64, 32, 16],
      dash: {
        video: [{ id: 80, codecid: 12, codecs: 'hev1.1.6.L120.90', bandwidth: VIDEO_BANDWIDTH, width: 1920, height: 1080,
          frameRate: '30.000', baseUrl: `https://${orig}${VIDEO_PATH}?e=sig`, backupUrl: [`https://${AKAM}${VIDEO_PATH}?e=sig`] }],
        audio: [{ id: 30280, codecid: 0, codecs: 'mp4a.40.2', bandwidth: AUDIO_BANDWIDTH,
          baseUrl: `https://${orig}${AUDIO_PATH}?e=sig` }],
      },
    } };
  }

  // 极简播放器：缓冲 <30 秒就按 Range 顺序拉下一片；有缓冲就前进，没缓冲发一次 waiting。
  const player = {
    host: H('cosov'),
    next: 0,
    downloading: false,
    stalled: false,
    timer: null,
    xhrs: [],
    hostFor: null,
  };
  function attachVideo() {
    video = new FakeVideo();
    return video;
  }
  function requestSegment() {
    const index = player.next;
    const offset = index * SEG_BYTES;
    const xhr = new FakeXHR();
    const host = player.hostFor ? player.hostFor(index) : player.host;
    xhr.open('GET', `https://${host}${VIDEO_PATH}?e=sig&seg=${index}`);
    xhr.setRequestHeader('Range', `bytes=${offset}-${offset + SEG_BYTES - 1}`);
    player.downloading = true;
    xhr.addEventListener('loadend', event => {
      player.downloading = false;
      if (event.loaded >= SEG_BYTES) {
        player.next++;
        video.bufferedEnd += SEG_SECONDS;
      }
    });
    xhr.send();
    player.xhrs.push(xhr);
  }
  function startPlayback({ host = H('cosov'), startSegment = 0 } = {}) {
    player.host = host;
    player.next = startSegment;
    if (!video) attachVideo();
    video.currentTime = startSegment * SEG_SECONDS;
    video.bufferedEnd = video.currentTime;
    video.paused = false;
    video.readyState = 1;
    video.emit('loadstart');
    player.timer = clock.setInterval(() => {
      if (!player.downloading && video.bufferedEnd - video.currentTime < 30) requestSegment();
      if (video.paused) return;
      if (video.bufferedEnd - video.currentTime >= 0.25) {
        video.currentTime += 0.25;
        video.readyState = 4;
        if (player.stalled) { player.stalled = false; video.emit('playing'); }
        video.emit('timeupdate');
      } else {
        video.readyState = 2;
        if (!player.stalled) { player.stalled = true; video.emit('waiting'); }
      }
    }, 250);
  }
  function stopPlayback() { clock.clear(player.timer); }
  const bufferAhead = () => (video ? video.bufferedEnd - video.currentTime : 0);
  const hudText = () => elements.get('bili-boost-hud')?.textContent || '';

  return { clock, net, api, sandbox, logs, setPlayinfo, attachVideo, startPlayback, stopPlayback, requestSegment,
    player, bufferAhead, hudText, get video() { return video; } };
}

// 现场 cosov：头部 2MB 内命中 CDN 缓存（几十 MB/s），之后回源只有 ~120KB/s。
const STALL_MODEL = {
  speed(host, offset) {
    if (host === H('cosov')) return offset < 2 * MB ? 40_000 : 120;
    if (host === H('08c')) return 900;
    if (host === H('hw')) return 700;
    if (host === H('ali')) return 300;
    return 250;
  },
  ttfb: host => (host === H('cosov') ? 90 : 160),
};

async function scenarioRepresentative(source = SCRIPT, label = '') {
  // 1a：已知播放位置 → 测“即将请求”的区间；1b：不知道位置 → 4MB 处，仍避开头部缓存
  const out = {};
  for (const withCursor of [true, false]) {
    const page = createPage(STALL_MODEL, { hud: false, source });
    page.setPlayinfo();
    page.attachVideo();                   // 暂停中的 video：不受缓冲门控影响
    const xhr = new page.sandbox.XMLHttpRequest();
    const offset = 16 * SEG_BYTES;        // 播放器正在读 8MB 处
    xhr.open('GET', `https://${H('cosov')}${VIDEO_PATH}?e=sig`);
    if (withCursor) xhr.setRequestHeader('Range', `bytes=${offset}-${offset + SEG_BYTES - 1}`);
    xhr.send();
    await page.clock.advance(60_000);
    const result = page.api.测速结果;
    const cosov = result?.list.find(item => item.host === H('cosov'));
    out[withCursor ? 'cursor' : 'fallback'] = { win: result?.win, cosov, peak: page.net.probePeak, page };
  }
  if (label) return out;
  const { cursor, fallback } = out;
  const cosovProbes = cursor.page.net.probes.filter(probe => probe.host === H('cosov'));
  check('1a 快筛直接测播放器即将请求的区间（Range 末尾 +1）', cosovProbes.length > 0 &&
    cosovProbes[0].offset === 17 * SEG_BYTES, `cosov 探测偏移=${cosovProbes.map(probe => probe.offset).join(',')}（期望 ${17 * SEG_BYTES}）`);
  check('1a 不再选中“头部快、后续慢”的 cosov', cursor.win === H('08c') && cursor.cosov?.effectiveKbps < 200,
    `cosov 快筛有效速度=${cursor.cosov?.effectiveKbps}KB/s → 选择=${cursor.win}`);
  const aheadPoint = fallback.cosov?.points?.find(point => point.point === '中');
  check('1b 无播放位置时：前方点仍避开头部 2MB 缓存区', fallback.cosov?.aheadOffset >= 2 * MB && aheadPoint,
    `精测点=${(fallback.cosov?.points || []).map(point => point.point + '@' + point.kbps + 'KB/s').join(' / ')} 偏移=${fallback.cosov?.aheadOffset}`);
  check('1b 头/前方 >5× 判为头部缓存命中，按前方计分，不选 cosov', fallback.cosov?.headCached === true &&
    fallback.cosov.effectiveKbps < 200 && fallback.win === H('08c'),
    `有效=${fallback.cosov?.effectiveKbps}KB/s 备注=${fallback.cosov?.note} 选择=${fallback.win}`);
  check('3 测速全局并发 = 1', cursor.peak === 1 && fallback.peak === 1, `峰值=${cursor.peak}/${fallback.peak}`);
  return out;
}

async function scenarioFusion() {
  // 探测请求永远命中缓存（5000KB/s），播放器真实分片只有 150KB/s：真实数据必须压过探测。
  const model = {
    speed(host, offset, kind) {
      if (host === H('cosov')) return kind === 'probe' ? 5000 : 150;
      if (host === H('08c')) return 900;
      return 250;
    },
  };
  const page = createPage(model, { hud: false });
  page.setPlayinfo();
  page.attachVideo();
  page.video.paused = true;
  page.player.host = H('cosov');
  // 先让脚本测一轮（cosov 凭缓存赢），再让播放器在 cosov 上拉 4 片真实分片
  page.requestSegment();
  await page.clock.advance(30_000);
  const firstWin = page.api.测速结果?.win;
  for (let i = 0; i < 4; i++) {
    page.sandbox.__biliBoost.手动选源(H('cosov'));
    page.requestSegment();
    await page.clock.advance(6_000);
  }
  page.api.自动选源();                    // 恢复自动 → 重新测速，此时 cosov 已有 ≥3 片真实数据
  await page.clock.advance(60_000);
  const result = page.api.测速结果;
  const cosov = result?.list.find(item => item.host === H('cosov'));
  check('1 评分以真实分片为主（探测命中缓存 / 真实 150 → 融合后 <300）',
    cosov && cosov.effectiveKbps > 1000 && cosov.fusedKbps < 300 && result.win === H('08c'),
    `首轮(无实测)选=${firstWin}；融合 cosov=${cosov?.fusedKbps}KB/s（探测 ${cosov?.effectiveKbps}，${cosov?.realSamples} 片实测）→ 选 ${result?.win}`);
}

async function scenarioFlapping(source = SCRIPT, label = '') {
  // 08c / hw 每 20 秒交替“快 1200 / 慢 120”，其余源 150：考验滞回与 60 秒限频。
  const model = {
    speed(host, offset, kind, now) {
      const phase = Math.floor((now - 1_790_000_000_000) / 20_000) % 2;
      if (host === H('08c')) return phase ? 120 : 1200;
      if (host === H('hw')) return phase ? 1200 : 120;
      if (host === H('cosov')) return offset < 2 * MB ? 40_000 : 150;
      return 150;
    },
  };
  const page = createPage(model, { hud: true, source });
  page.setPlayinfo();
  page.startPlayback({ host: H('cosov') });
  // 播放器自己也会在主线慢时回退到 akam backup（现场 cosov/akam 横跳）
  page.player.hostFor = index => (index % 5 === 4 ? AKAM : H('cosov'));
  const lowBufferProbes = [];
  const probeCountBefore = () => page.net.probes.length;
  let seen = 0;
  for (let t = 0; t < 360; t += 1) {
    await page.clock.advance(1000);
    for (; seen < page.net.probes.length; seen++) {
      const probe = page.net.probes[seen];
      if (probe.video && !probe.video.paused && probe.video.time > 0.5 && probe.video.ahead < 15) lowBufferProbes.push(probe);
    }
  }
  page.stopPlayback();
  const log = source === SCRIPT ? page.api.切源记录 : [];
  const gaps = log.slice(1).map((item, index) => item.at - log[index].at);
  const segmentsComplete = page.net.segments.filter(item => item.endedAt != null).every(item => item.loaded === item.size);
  const out = { switches: log.length, gaps, stalls: page.api.卡顿次数, probes: probeCountBefore(), lowBufferProbes: lowBufferProbes.length,
    peak: page.net.probePeak, aborts: page.net.xhrAborts, segmentsComplete, page };
  if (label) return out;
  check('2 两源交替抖动：任意两次自动切源间隔 ≥60 秒', gaps.every(gap => gap >= 60_000),
    `切源 ${log.length} 次，间隔(s)=${gaps.map(gap => Math.round(gap / 1000)).join(',') || '—'}`);
  check('2 6 分钟内自动切源不超过 6 次（不横跳）', log.length <= 6, `切源记录=${log.map(item => item.to.replace(/^upos-sz-mirror|\.bilivideo\.com$/g, '')).join('→') || '无'}`);
  check('2 切源不中断进行中的分片（无 abort、已完成分片字节完整）', page.net.xhrAborts === 0 && segmentsComplete,
    `abort=${page.net.xhrAborts}，分片 ${page.net.segments.length} 个`);
  check('3 播放中前向缓冲 <15 秒时没有任何探测请求', lowBufferProbes.length === 0,
    `探测 ${out.probes} 次，其中缓冲不足时 ${lowBufferProbes.length} 次`);
  check('3 抖动场景测速并发仍为 1', page.net.probePeak <= 1, `峰值=${page.net.probePeak}`);
  const hudSource = page.hudText().split('\n')[0];
  const debugSource = page.api.当前源;
  check('5 HUD 与 __biliBoost.当前源 一致', hudSource.includes(debugSource.replace(/^upos-[a-z]{2}-(mirror|upcdn)?/, '').split('.')[0]),
    `debug=${debugSource} HUD=${JSON.stringify(hudSource)}`);
  return out;
}

async function scenarioLowBuffer() {
  // 所有源都只比码率略快：缓冲长期 <15 秒。卡顿、跨域族回退都不能触发探测；
  // 之后网络恢复、缓冲 ≥15 秒，再补测一次。
  let fast = false;
  const model = {
    speed(host) {
      if (fast) return host === H('08c') ? 2000 : 900;
      return host === H('cosov') ? 140 : 170;
    },
  };
  const page = createPage(model, { hud: true });
  page.setPlayinfo();
  page.startPlayback({ host: H('cosov') });
  await page.clock.advance(3_000);
  const startupProbes = page.net.probes.length;
  let violations = 0;
  let checked = 0;
  for (let t = 0; t < 120; t++) {
    const before = page.net.probes.length;
    await page.clock.advance(1000);
    if (t === 30) {                                     // 播放器回退到 akam backup
      const xhr = new page.sandbox.XMLHttpRequest();
      xhr.open('GET', `https://${AKAM}${VIDEO_PATH}?e=sig`);
      xhr.setRequestHeader('Range', `bytes=0-${SEG_BYTES - 1}`);
      xhr.send();
    }
    for (const probe of page.net.probes.slice(before)) {
      checked++;
      if (probe.video && !probe.video.paused && probe.video.time > 0.5 && probe.video.ahead < 15) violations++;
    }
  }
  const lowProbes = page.net.probes.length - startupProbes;
  const diag = page.api.诊断状态;
  check('3 缓冲 <15 秒期间（含卡顿、akam 回退）不发探测', violations === 0,
    `开播前探测 ${startupProbes} 次；之后 120 秒探测 ${lowProbes} 次（违规 ${violations}）；卡顿 ${page.api.卡顿次数} 次；被门控 ${diag.probeBlocked} 次`);
  check('5 跨域族回退后 HUD 与 debug 当前源一致', page.hudText().split('\n')[0].includes(
    page.api.当前源.replace(/^upos-[a-z]{2}-(mirror|upcdn)?/, '').split('.')[0]), `debug=${page.api.当前源}`);
  fast = true;
  const beforeRecovery = page.net.probes.length;
  await page.clock.advance(90_000);
  const recovered = page.net.probes.slice(beforeRecovery);
  check('3 缓冲恢复到 ≥15 秒后补测，且补测时缓冲充足', recovered.length > 0 &&
    recovered.every(probe => !probe.video || probe.video.paused || probe.video.ahead >= 15 - 0.5) &&
    page.api.诊断状态.pendingProbe === 0,
    `补测 ${recovered.length} 次，最小缓冲 ${Math.min(...recovered.map(probe => probe.video?.ahead ?? 99)).toFixed(1)} 秒`);
  page.stopPlayback();
}

async function scenarioHungProbe() {
  // Safari：abort 后 reader.read() 永不返回。整轮必须按超时结束，probing / controller 归零。
  const model = { speed: () => 600, hang: host => host === H('cos') };
  const page = createPage(model, { hud: false });
  page.attachVideo();
  const xhr = new page.sandbox.XMLHttpRequest();
  xhr.open('GET', `https://${H('ali')}${VIDEO_PATH}?e=sig`);
  xhr.send();
  await page.clock.advance(2_000);
  const during = page.api.诊断状态;
  await page.clock.advance(60_000);
  const after = page.api.诊断状态;
  const cos = page.api.测速结果?.list.find(item => item.host === H('cos'));
  check('3 探测挂起（abort 不生效）也会超时收尾并清理 probing/controller',
    during.probing === 1 && after.probing === 0 && after.probeControllers === 0 && cos?.note === '超时',
    `进行中 probing=${during.probing}；结束后 probing=${after.probing} controllers=${after.probeControllers}；cos=${cos?.note}`);
}

async function scenarioBitrate() {
  const model = { speed: () => 290 };   // 所有源 ~290KB/s：够 1.0× 码率（272），不够 1.2×（326）
  const page = createPage(model, { hud: true });
  page.setPlayinfo();
  const calls = [];
  page.sandbox.player = { getQuality: () => ({ nowQ: 80 }), requestQuality: qn => calls.push(qn) };
  page.startPlayback({ host: H('cosov') });
  await page.clock.advance(40_000);
  const warn = page.api.码率.告警;
  check('4 所有源 <1.2×码率时 HUD 提示（默认只提示不降档）', warn && /所有源都 < 1\.2×码率/.test(page.hudText()) && calls.length === 0,
    `需要 ${page.api.码率.需要}，最快 ${warn?.best}KB/s；HUD=${JSON.stringify(page.hudText().split('\n')[1] || '')}`);
  page.api.自动降档(true);
  const stored = page.sandbox.localStorage.getItem('bhw_autoDowngrade');
  await page.clock.advance(30_000);
  check('4 打开自动降档后降一档（80→64），开关存 localStorage，60 秒内不重复', calls.length === 1 && calls[0] === 64 && stored === 'true',
    `requestQuality 调用=${JSON.stringify(calls)} 存储=${stored}`);
  page.stopPlayback();
}

async function scenarioCodec() {
  // Safari：addSourceBuffer 钩子没拿到（注入晚），按分片路径对上 playurl 判定编码；hev1 不认就换 hvc1 再查。
  const safari = createPage({ speed: () => 800 }, { hud: true });
  safari.setPlayinfo();
  safari.startPlayback({ host: H('08c') });
  await safari.clock.advance(5_000);
  const detect = safari.api.编码检测;
  check('5 Safari 无 SourceBuffer 时据分片判定 HEVC 且给出硬解结论', detect.编码 === 'HEVC/H.265' && detect.硬解 === true &&
    detect.来源 === '分片匹配 playurl' && /🟢 硬解/.test(safari.hudText()), JSON.stringify(detect));
  safari.stopPlayback();

  const noCaps = createPage({ speed: () => 800 }, { hud: true, mediaCapabilities: 'none' });
  noCaps.setPlayinfo();
  noCaps.startPlayback({ host: H('08c') });
  await noCaps.clock.advance(5_000);
  check('5 检测不到时 HUD 写明原因而不是“未知”', /无法判定硬解/.test(noCaps.hudText()) &&
    /不支持 mediaCapabilities/.test(noCaps.hudText()) && !/⚪ 未知/.test(noCaps.hudText()), JSON.stringify(noCaps.api.编码检测));
  noCaps.stopPlayback();

  const noPlayurl = createPage({ speed: () => 800 }, { hud: true });
  noPlayurl.startPlayback({ host: H('08c') });
  await noPlayurl.clock.advance(5_000);
  check('5 拿不到 playurl 时原因写清楚', /未拿到 playurl/.test(noPlayurl.api.编码检测.原因), noPlayurl.api.编码检测.原因);
  noPlayurl.stopPlayback();
}

async function contrast() {
  let legacy;
  try {
    legacy = execFileSync('git', ['show', 'main:bili-boost.user.js'], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { console.log('对照：无法读取 main 分支旧版，跳过'); return; }
  if (/v1\.7\.0/.test(legacy)) { console.log('对照：main 已是 v1.7.0，跳过'); return; }
  const old = await scenarioRepresentative(legacy, 'legacy');
  const now = await scenarioRepresentative(SCRIPT, 'current');
  console.log(`对照 1（头部缓存场景）：旧版选 ${old.cursor.win}（测速峰值并发 ${old.cursor.peak}），v1.7.0 选 ${now.cursor.win}`);
  const oldFlap = await scenarioFlapping(legacy, 'legacy');
  const newFlap = await scenarioFlapping(SCRIPT, 'current');
  console.log(`对照 2/3（抖动 6 分钟）：旧版 探测 ${oldFlap.probes} 次 / 缓冲不足时 ${oldFlap.lowBufferProbes} 次 / 卡顿 ${oldFlap.stalls} / 并发峰值 ${oldFlap.peak}；` +
    `v1.7.0 探测 ${newFlap.probes} 次 / 缓冲不足时 ${newFlap.lowBufferProbes} 次 / 卡顿 ${newFlap.stalls} / 并发峰值 ${newFlap.peak}`);
}

const started = Date.now();
await scenarioRepresentative();
await scenarioFusion();
await scenarioFlapping();
await scenarioLowBuffer();
await scenarioHungProbe();
await scenarioBitrate();
await scenarioCodec();
if (CONTRAST) await contrast();
const failed = results.filter(item => !item.pass);
console.log(`\n=== qa-stall：PASS=${results.length - failed.length} FAIL=${failed.length}，耗时 ${((Date.now() - started) / 1000).toFixed(1)}s ===`);
process.exit(failed.length ? 1 : 0);
