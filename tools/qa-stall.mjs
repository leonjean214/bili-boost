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
function createPage(model, { hud = true, mediaCapabilities = 'safari', source = SCRIPT, seed = null } = {}) {
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
    const status = !isProbe && model.segmentStatus && !(model.segmentStatus(url.hostname, clock.now) >= 200 &&
      model.segmentStatus(url.hostname, clock.now) < 300) ? model.segmentStatus(url.hostname, clock.now)
      : model.status ? model.status(url.hostname, !!range) : (range ? 206 : 200);
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
      // 真实分片的 HTTP 状态（如 akam/镜像 403）：XHR 照常 load/loadend，只是 status 非 2xx、没有数据。
      const status = model.segmentStatus ? model.segmentStatus(url.hostname, clock.now) : 206;
      this.status = status;
      entry.status = status;
      if (status < 200 || status >= 300) {
        clock.setTimeout(() => { entry.endedAt = clock.now; this.emitLocal('loadend', { loaded: 0 }); }, ttfbOf(url.hostname));
        return;
      }
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
  // seed：上一个“会话”留下的 localStorage（跨会话测试用），在脚本加载前写入。
  for (const [key, value] of Object.entries(seed || {})) localStorage.setItem(key, value);
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
    xhr.open('GET', `https://${host}${player.path || VIDEO_PATH}?e=sig&seg=${index}`);
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
    player, bufferAhead, hudText, get hud() { return elements.get('bili-boost-hud') || null; }, get video() { return video; } };
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

// 探测时 08c 最快（测速请求正常），可播放器的真实分片在 08c 上一律 403（现场 akam/签名不认 host 的情形）。
const FORBIDDEN_MODEL = {
  speed: host => (host === H('08c') ? 900 : 400),
  segmentStatus: host => (host === H('08c') ? 403 : 206),
};

async function scenarioSegmentForbidden(source = SCRIPT, label = '') {
  const page = createPage(FORBIDDEN_MODEL, { hud: true, source });
  page.setPlayinfo();
  page.startPlayback({ host: H('cosov') });
  await page.clock.advance(90_000);
  const segs = page.net.segments;
  const forbidden = segs.filter(seg => seg.status === 403);
  const firstFail = forbidden[0];
  const recovered = firstFail && segs.find(seg => seg.startedAt > firstFail.startedAt && seg.status === 206 && seg.loaded >= seg.size);
  const out = { forbidden: forbidden.length, stalls: page.api.卡顿次数, played: page.video.currentTime,
    recoverMs: recovered ? recovered.endedAt - firstFail.endedAt : null };
  if (label) { page.stopPlayback(); return out; }
  const api = page.api;
  const ban = api.黑名单详情?.find(item => item.host === H('08c'));
  check('6 真实分片 403 → 立即拉黑该源（不等卡顿确认）', forbidden.length >= 1 && forbidden.length <= 2 &&
    api.黑名单.includes(H('08c')) && /分片 HTTP 403/.test(ban?.原因 || ''),
    `403 次数=${forbidden.length}；黑名单=${JSON.stringify(api.黑名单详情)}`);
  check('6 拉黑后播放器重试直接回到原始源，播放不断', recovered && recovered.host === H('cosov') &&
    out.recoverMs < 2_000 && page.player.xhrs.every(xhr => !xhr.aborted) && out.played > 80,
    `回退到 ${recovered?.host}，失败→成功 ${out.recoverMs}ms，播放到 ${out.played}s，卡顿 ${out.stalls}，abort=${page.net.xhrAborts}`);
  check('6 HUD/debug 当前源不再是 403 源，切源记录写明原因', !page.hudText().split('\n')[0].includes('08c') &&
    api.当前源 !== H('08c') && api.切源记录.some(item => /HTTP 403/.test(item.why)),
    `debug=${api.当前源} HUD=${JSON.stringify(page.hudText().split('\n')[0])} 记录=${JSON.stringify(api.切源记录.map(item => item.why))}`);
  const health = api.主机健康[shortHost(H('08c'))] || '';
  check('6 403 计入主机健康（失败样本）', /\d+\/\d+ 成功/.test(health) &&
    Number(/^(\d+)\/(\d+)/.exec(health)?.[1]) < Number(/^(\d+)\/(\d+)/.exec(health)?.[2]), health);
  page.stopPlayback();
}

const shortHost = host => host.replace(/^upos-[a-z]{2}-(mirror|upcdn)?/, '').split('.')[0];

async function scenarioBanRecovery() {
  // 不播放，直接用 fetch 分片驱动：手选 08c → 分片被改写到 08c → 403 → 拉黑。看禁期、到期恢复与翻倍。
  const page = createPage(FORBIDDEN_MODEL, { hud: false });
  page.setPlayinfo();
  page.attachVideo();
  const api = page.api;
  const segUrl = `https://${H('cosov')}${VIDEO_PATH}?e=sig`;
  const fetchSeg = async () => {
    const pending = page.sandbox.fetch(segUrl, { headers: { Range: 'bytes=0-524287' } });
    await page.clock.advance(1_000);
    return pending;
  };
  await fetchSeg();                                   // 先让脚本认识这个媒体
  await page.clock.advance(60_000);                   // 开播测速收尾
  const durations = [];
  const fail = async () => {
    api.手动选源(H('08c'));
    const res = await fetchSeg();
    const ban = api.黑名单详情.find(item => item.host === H('08c'));
    durations.push({ status: res.status, left: ban?.剩余秒, strikes: ban?.次数 });
  };
  await fail();
  const firstBan = api.黑名单.includes(H('08c'));
  await page.clock.advance(2 * 60_000 + 1_000);
  const recovered = !api.黑名单.includes(H('08c'));
  for (let i = 0; i < 5; i++) { await fail(); await page.clock.advance(1_000); }
  const lefts = durations.map(item => item.left);
  check('6 黑名单到期自动恢复（首次 2 分钟）', firstBan && recovered && lefts[0] > 110 && lefts[0] <= 120,
    `首次禁 ${lefts[0]}s，2 分钟后仍在黑名单=${!recovered}`);
  check('6 连续再犯禁期翻倍且封顶 30 分钟（手选可立即解禁、不清次数）',
    lefts.slice(1).every((left, i) => left > Math.min(1800, 120 * 2 ** (i + 1)) - 15 && left <= Math.min(1800, 120 * 2 ** (i + 1))) &&
    durations.every(item => item.status === 403) && durations.at(-1).strikes === 6,
    `禁期(s)=${lefts.join('/')} 次数=${durations.map(item => item.strikes).join('/')}`);
  // 最后一次禁期结束后 1 小时内没再出错 → 次数清零，下次又从 2 分钟起。
  await page.clock.advance(30 * 60_000 + 61 * 60_000);
  await fail();
  check('6 长时间无故障后失败次数清零', durations.at(-1).strikes === 1 && durations.at(-1).left <= 120,
    JSON.stringify(durations.at(-1)));
  const state = api.诊断状态;
  check('6 黑名单有界（≤64）', state.blacklist <= 64, `blacklist=${state.blacklist}`);
}

// 诊断 JSON：内容与 HUD/debug 一致、剥掉签名查询串、有界、复制走剪贴板且失败有兜底、不留定时器。
async function scenarioDiagnostics() {
  const page = createPage(FORBIDDEN_MODEL, { hud: true });
  page.sandbox.location.search = '?p=9&vd_source=SECRET_VD';
  page.sandbox.navigator.userAgent = 'QA-Safari https://upos-sz-mirror08c.bilivideo.com/x.m4s?upsig=SECRET_SIG&mid=SECRET_MID';
  page.setPlayinfo();
  page.startPlayback({ host: H('cosov') });
  await page.clock.advance(90_000);
  page.stopPlayback();
  await page.clock.advance(15_000);
  const api = page.api;
  const report = api.诊断报告;
  const text = JSON.stringify(report);
  check('7 诊断报告字段齐全且与 debug 一致', report.格式 === 'bili-boost-diag/1' && /^v\d/.test(report.版本) &&
    report.当前源 === api.当前源 && report.卡顿次数 === api.卡顿次数 && report.页面.分P === '9' &&
    report.页面.路径 === '/video/BV1PF4m177EQ/' && report.切源记录.length === api.切源记录.length &&
    report.切源记录.every(item => /^\d{4}-\d\d-\d\dT/.test(item.at)) &&
    report.黑名单详情.some(item => item.host === H('08c')) && report.测速结果?.列表?.length > 0 &&
    Object.keys(report.主机健康).length > 0,
    `当前源=${report.当前源} 切源=${report.切源记录.length} 测速=${report.测速结果?.列表?.length} 黑名单=${report.黑名单详情.length}`);
  check('7 不泄露签名/查询参数（upsig、mid、vd_source 等）', !/SECRET_|upsig|[?&]mid=|e=sig/.test(text) &&
    report.环境.UA.includes('upos-sz-mirror08c.bilivideo.com/x.m4s'), report.环境.UA);
  check('7 报告有界（≤64KB）', text.length <= 64 * 1024, `${text.length} 字符`);

  // HUD 展开后有「复制诊断 JSON」，点击走 navigator.clipboard，成功后 HUD 给出反馈。
  let copied = null;
  page.sandbox.navigator.clipboard = { writeText: value => { copied = value; return Promise.resolve(); } };
  page.hud.click();                                       // 展开
  const expanded = /复制诊断 JSON/.test(page.hudText());
  const timersBefore = page.clock.timers.size;
  const action = { dataset: { action: 'copy-diag' } };
  let stopped = false;
  page.hud.emitLocal('click', { target: { closest: () => action }, stopPropagation() { stopped = true; } });
  await page.clock.advance(0);
  let parsed = null;
  try { parsed = JSON.parse(copied); } catch { }
  check('7 HUD 一键复制：剪贴板拿到完整 JSON，HUD 显示已复制', expanded && stopped && parsed?.格式 === 'bili-boost-diag/1' &&
    parsed.当前源 === api.当前源 && /已复制诊断 JSON/.test(page.hudText()),
    `展开=${expanded} 复制=${copied ? copied.length + ' 字符' : '无'} HUD=${JSON.stringify(page.hudText().split('\n').find(line => /诊断/.test(line)))}`);
  check('7 复制不新增定时器', page.clock.timers.size === timersBefore, `定时器 ${timersBefore} → ${page.clock.timers.size}`);
  page.hud.click();                                       // 收起后反馈清掉，再展开不残留旧提示
  page.hud.click();
  const cleared = !/已复制/.test(page.hudText()) && /复制诊断 JSON/.test(page.hudText());

  // 剪贴板被拒（Safari 非手势/权限）且没有 execCommand：打印到控制台，返回明确提示。
  page.sandbox.navigator.clipboard = { writeText: () => Promise.reject(new Error('NotAllowedError')) };
  const before = page.logs.length;
  const message = await api.复制诊断();
  const printed = page.logs.slice(before).some(line => line.includes('bili-boost-diag/1'));
  delete page.sandbox.navigator.clipboard;
  const message2 = await api.复制诊断();
  // 超长兜底：塞一个 200KB 的 UA，导出的仍须是合法 JSON 且 ≤64KB、带「已截断」标记。
  const realUa = page.sandbox.navigator.userAgent;
  page.sandbox.navigator.userAgent = 'x'.repeat(200 * 1024);
  let huge = null;
  page.sandbox.navigator.clipboard = { writeText: value => { huge = value; return Promise.resolve(); } };
  await api.复制诊断();
  page.sandbox.navigator.userAgent = realUa;
  let hugeParsed = null;
  try { hugeParsed = JSON.parse(huge); } catch { }
  check('7 超长时仍输出合法 JSON（≤64KB，标记已截断）', hugeParsed?.已截断 === true && huge.length <= 64 * 1024 &&
    hugeParsed.当前源 === api.当前源, `${huge?.length} 字符，合法=${!!hugeParsed}`);
  check('7 剪贴板不可用时打印到控制台并提示（收起/再展开后反馈不残留）', cleared && /已打印到控制台/.test(message) && printed &&
    /已打印到控制台/.test(message2), `收起清空=${cleared} 控制台=${printed}；${message} / ${message2}`);
}

// 实播指标闭环：上次会话的真实分片速度/卡顿写进健康档案，下次开播（本会话还没有真实分片）作为先验。
// 现场：cosov 探测永远命中缓存（5000KB/s），真实分片只有 150KB/s。无先验时开播首轮必选 cosov（场景 1 的 firstWin）。
const CACHE_LIE_MODEL = {
  speed(host, offset, kind) {
    if (host === H('cosov')) return kind === 'probe' ? 5000 : 150;
    if (host === H('08c')) return 900;
    return 250;
  },
};
function readHealth(page) {
  try { return JSON.parse(page.sandbox.localStorage.getItem('bhw_health') || 'null'); } catch { return null; }
}
async function openRound(seed, source = SCRIPT) {
  const page = createPage(CACHE_LIE_MODEL, { hud: false, seed, source });
  page.setPlayinfo();
  page.attachVideo();
  page.video.paused = true;
  // 开播触发用一个 8MB 的大分片（150KB/s 下 30 秒内传不完）：首轮决策只能依据探测 + 先验，不混入本会话真实分片。
  const xhr = new page.sandbox.XMLHttpRequest();
  xhr.open('GET', `https://${H('cosov')}${VIDEO_PATH}?e=sig`);
  xhr.setRequestHeader('Range', `bytes=0-${8 * MB - 1}`);
  xhr.send();
  await page.clock.advance(30_000);
  return { page, result: page.api.测速结果 };
}
function legacySource() {
  for (const ref of ['origin/main', 'main']) {
    try {
      return execFileSync('git', ['show', `${ref}:bili-boost.user.js`], {
        cwd: new URL('..', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { }
  }
  return null;
}
async function scenarioRealPrior() {
  // 会话 1：手选 cosov，在暂停态拉 6 片真实分片（间隔 8 秒，跨过 30 秒落盘节流）。
  const s1 = createPage(CACHE_LIE_MODEL, { hud: false });
  s1.setPlayinfo();
  s1.attachVideo();
  s1.video.paused = true;
  s1.player.host = H('cosov');
  const timersBefore = s1.clock.timers.size;
  for (let i = 0; i < 6; i++) {
    s1.api.手动选源(H('cosov'));
    s1.requestSegment();
    await s1.clock.advance(8_000);
  }
  await s1.clock.advance(60_000);
  const stored = readHealth(s1);
  const cosov = stored?.hosts?.[H('cosov')];
  check('8 真实分片速度写进健康档案（有界、节流落盘、不新增定时器）', stored?.version === 2 && cosov?.realN >= 3 &&
    cosov.real > 100 && cosov.real < 200 && Object.keys(stored.hosts).length <= 32 && s1.clock.timers.size <= timersBefore + 1,
    `cosov 实播=${cosov?.real}KB/s×${cosov?.realN} 片，卡顿=${cosov?.stalls}；定时器 ${timersBefore} → ${s1.clock.timers.size}`);

  // 会话 2：只继承健康档案（不继承全局赢家），开播首轮：探测仍说 cosov 5000，先验把它压下去。
  const seed = { bhw_health: s1.sandbox.localStorage.getItem('bhw_health') };
  const fresh = await openRound(null);
  const primed = await openRound(seed);
  const primedCosov = primed.result?.list.find(item => item.host === H('cosov'));
  check('8 下次开播：先验压过被缓存抬高的探测，不再选 cosov（对照：无先验选 cosov）',
    fresh.result?.win === H('cosov') && primed.result?.win === H('08c') && primedCosov?.priorKbps > 100 &&
    primedCosov.priorKbps < 200 && primedCosov.fusedKbps < 500 && primedCosov.effectiveKbps > 1000,
    `无先验选=${fresh.result?.win}；有先验 cosov 探测=${primedCosov?.effectiveKbps} 先验=${primedCosov?.priorKbps} → 融合=${primedCosov?.fusedKbps}，选=${primed.result?.win}`);
  const healthLine = primed.page.api.主机健康[primed.page.api.诊断报告 ? 'cosov' : 'cosov'] ||
    Object.entries(primed.page.api.主机健康).find(([name]) => /cosov/.test(name))?.[1];
  check('8 主机健康/诊断报告展示实播与先验', /实播 \d+KB\/s×\d+ 片 卡顿 \d+（先验 \d+KB\/s）/.test(healthLine || '') &&
    primed.page.api.诊断报告.测速结果?.列表?.some(item => item.host === H('cosov') && item.priorKbps === primedCosov?.priorKbps),
    healthLine);

  // 先验 24 小时过期：同一份档案把实播时间改到 25 小时前 → 不再使用先验（档案本身 7 天内仍保留）。
  const aged = JSON.parse(seed.bhw_health);
  for (const record of Object.values(aged.hosts)) if (record.realAt) record.realAt -= 25 * 3600e3;
  const stale = await openRound({ bhw_health: JSON.stringify(aged) });
  const staleCosov = stale.result?.list.find(item => item.host === H('cosov'));
  check('8 先验 24 小时后失效（换网/VPN 不长期粘住）', stale.result?.win === H('cosov') && staleCosov?.priorKbps == null,
    `选=${stale.result?.win} 先验=${staleCosov?.priorKbps}`);

  // 卡顿惩罚：每次卡顿折 4 片；08c 实播 900 但 8 片里卡 4 次 → 先验 300 < hw 先验 600（无卡顿）。
  const now = 1_790_000_000_000;
  const penal = { version: 2, updatedAt: now, hosts: {
    [H('08c')]: { attempts: 6, successes: 6, kbps: 900, ttfb: 100, at: now, real: 900, realN: 8, stalls: 4, realAt: now },
    [H('hw')]: { attempts: 6, successes: 6, kbps: 700, ttfb: 100, at: now, real: 600, realN: 8, stalls: 0, realAt: now },
  } };
  const p = createPage(CACHE_LIE_MODEL, { hud: false, seed: { bhw_health: JSON.stringify(penal) } });
  const lines = p.api.主机健康;
  check('8 卡顿按次折扣先验（900×8/(8+4×4)=300）', /先验 300KB\/s/.test(lines['08c'] || Object.values(lines).find(v => /卡顿 4/.test(v)) || '') &&
    /先验 600KB\/s/.test(Object.values(lines).find(v => /卡顿 0/.test(v)) || ''), JSON.stringify(lines));

  // 实播卡顿计入当时在用的源：所有源真实只有 150（低于码率 272），连续播放必卡。
  const slow = createPage({ speed: () => 150 }, { hud: false });
  slow.setPlayinfo();
  slow.startPlayback({ host: H('cosov') });
  await slow.clock.advance(120_000);
  slow.stopPlayback();
  const slowHealth = Object.values(readHealth(slow)?.hosts || {});
  const stallTotal = slowHealth.reduce((sum, r) => sum + (r.stalls || 0), 0);
  check('8 实播卡顿写进健康档案（≤片数，随落盘持久化）', slow.api.卡顿次数 > 0 && stallTotal > 0 &&
    slowHealth.every(r => !r.stalls || r.stalls <= r.realN), `会话卡顿=${slow.api.卡顿次数} 档案卡顿合计=${stallTotal}`);

  // 格式兼容：坏的实播字段整组丢弃、探测统计保留；无探测也无实播的空记录丢弃；40 个 host 裁到 32。
  const messy = { version: 2, updatedAt: now, hosts: {
    [H('08c')]: { attempts: 5, successes: 5, kbps: 900, at: now, real: 'abc', realN: -1, stalls: 9, realAt: now },
    [H('zzz')]: { attempts: 0, successes: 0, kbps: 0, at: now },
    [H('ali')]: { attempts: 0, successes: 0, kbps: 0, at: now, real: 300, realN: 5, stalls: 99, realAt: now },
  } };
  for (let i = 0; i < 40; i++) messy.hosts[`upos-sz-mirrorx${i}.bilivideo.com`] = { attempts: 3, successes: 3, kbps: 100, at: now - 1000 - i };
  const m = createPage(CACHE_LIE_MODEL, { hud: false, seed: { bhw_health: JSON.stringify(messy) } });
  m.setPlayinfo();
  m.attachVideo();
  m.video.paused = true;
  m.requestSegment();                       // 一片真实分片 → 实播样本落盘（首个样本不受 30 秒节流）
  await m.clock.advance(10_000);
  const mh = JSON.parse(m.sandbox.localStorage.getItem('bhw_health') || '{}').hosts || {};
  const legacy = legacySource();
  let legacyOk = null;
  if (legacy && !/realPrior/.test(legacy)) {
    // 旧版脚本读到带实播字段的新档案：不报错、照常读取探测统计（只是忽略新字段）。
    const old = await openRound(seed, legacy);
    legacyOk = !!old.result?.win && Object.keys(old.page.api.主机健康).length > 0;
  }
  check('8 档案格式兼容与有界（坏字段丢弃、空记录丢弃、≤32 条、卡顿≤片数；旧版可读新档案）',
    mh[H('08c')]?.attempts >= 5 && mh[H('08c')].real === undefined && !mh[H('zzz')] &&
    mh[H('ali')]?.realN === 5 && mh[H('ali')].stalls === 5 && Object.keys(mh).length === 32 && legacyOk !== false,
    `08c=${JSON.stringify(mh[H('08c')])} ali=${JSON.stringify(mh[H('ali')])} 条数=${Object.keys(mh).length} 旧版=${legacyOk ?? '跳过'}`);
}

// 场景 9：自动降档后的回升与滞回。多档 playurl（112/80/64/32），模拟播放器 requestQuality 会换分片路径。
const QUALITY_PATHS = { 112: '/upgcxcode/09/61/1234567/1234567-1-30112.m4s', 80: VIDEO_PATH,
  64: '/upgcxcode/09/61/1234567/1234567-1-30064.m4s', 32: '/upgcxcode/09/61/1234567/1234567-1-30032.m4s' };
const QUALITY_BW = { 112: 4_194_304, 80: VIDEO_BANDWIDTH, 64: 1_048_576, 32: 524_288 };
// 播放器只拉视频分片（脚本没见到音频路径），需求按视频算：80 档 256KB/s（降档门槛 1.2× = 307，回升门槛 1.5× = 384），
// 64 档 128KB/s（1.2× = 154）。
function setQualityPlayinfo(page) {
  const video = Object.entries(QUALITY_PATHS).map(([qn, path]) => ({ id: Number(qn), codecid: 12, codecs: 'hev1.1.6.L120.90',
    bandwidth: QUALITY_BW[qn], width: 1920, height: 1080, frameRate: '30.000', baseUrl: `https://${H('cosov')}${path}?e=sig` }));
  page.sandbox.__playinfo__ = { code: 0, data: { accept_quality: [112, 80, 64, 32], dash: { video,
    audio: [{ id: 30280, codecid: 0, codecs: 'mp4a.40.2', bandwidth: AUDIO_BANDWIDTH, baseUrl: `https://${H('cosov')}${AUDIO_PATH}?e=sig` }] } } };
}
function qualityPage() {
  const net = { bw: 290 };
  const page = createPage({ speed: () => net.bw }, { hud: true });
  setQualityPlayinfo(page);
  const calls = [];
  const state = { nowQ: 80 };
  const setQuality = qn => { state.nowQ = qn; page.player.path = QUALITY_PATHS[qn]; };
  page.sandbox.player = {
    getQuality: () => ({ nowQ: state.nowQ }),
    requestQuality: qn => { calls.push({ qn, at: page.clock.now, ahead: page.bufferAhead() }); setQuality(qn); },
  };
  page.player.path = QUALITY_PATHS[80];
  page.api.自动降档(true);
  return { page, net, calls, setQuality };
}
async function advanceUntil(page, ms, done, step = 5_000) {
  for (let t = 0; t < ms && !done(); t += step) await page.clock.advance(step);
}
async function scenarioQualityRestore() {
  const { page, net, calls } = qualityPage();
  const qns = () => calls.map(call => call.qn).join('→');
  page.startPlayback({ host: H('cosov') });
  await page.clock.advance(60_000);    // 290KB/s：80 档跟不上（<307）→ 降到 64
  net.bw = 340;                        // 落在滞回带内：够 80 档的 1.2×（307），不够回升门槛 1.5×（384）
  await page.clock.advance(300_000);
  check('9 降档后网速落在滞回带内（≥1.2× 但 <1.5× 原档码率）不回升', qns() === '64',
    `requestQuality=${qns()}；${page.api.码率.说明}`);

  net.bw = 700;
  await advanceUntil(page, 300_000, () => calls.length >= 2);
  const down = calls[0];
  const up = calls[1];
  check('9 网速恢复后自动升回降档前的清晰度（距降档 ≥2 分钟、前向缓冲 ≥15 秒）',
    up?.qn === 80 && up.at - down.at >= 120_000 && up.ahead >= 15 && /升回 80/.test(page.hudText() + page.api.码率.说明),
    `${qns()}，距降档 ${up ? Math.round((up.at - down.at) / 1000) : '-'}s，缓冲 ${up?.ahead?.toFixed(1)}s；${page.api.码率.说明}`);

  net.bw = 200;                        // 回升后当前源连续 3 片 <80 档码率（256）→ 试用期内退回 64，失败计 1 次
                                       // （其他源还挂着 340 的旧探测值，全局告警不会触发，不能只靠它）
  await advanceUntil(page, 120_000, () => calls.length >= 3);
  const revert = calls[2];
  const plan = page.api.码率.回升;
  check('9 回升后试用期内跟不上 → 退回原档，失败次数 +1、下次等待翻倍',
    revert?.qn === 64 && revert.at - up.at < 180_000 && plan?.失败次数 === 1 && plan.等待 === '240 秒' && /退回/.test(page.api.码率.说明),
    `${qns()}，回升后 ${revert ? Math.round((revert.at - up.at) / 1000) : '-'}s 退回；回升=${JSON.stringify(plan)}`);

  net.bw = 700;
  const resumeAt = page.clock.now;
  await advanceUntil(page, 600_000, () => calls.length >= 4);
  const again = calls[3];
  check('9 再次回升遵守翻倍后的等待（≥240 秒），不来回横跳',
    again?.qn === 80 && again.at - revert.at >= 240_000 && again.at - resumeAt < 600_000,
    `${qns()}，距退回 ${again ? Math.round((again.at - revert.at) / 1000) : '-'}s`);

  await page.clock.advance(240_000);   // 试用期（3 分钟）平安度过 → 回升计划结束
  check('9 回到降档前清晰度且试用期平安后结束回升；从不超过降档前的档位（不请求 112）',
    page.api.码率.回升 === null && calls.length === 4 && !calls.some(call => call.qn > 80) && /自动回升结束/.test(page.api.码率.说明),
    `${qns()}；回升=${JSON.stringify(page.api.码率.回升)}；${page.api.码率.说明}`);
  page.stopPlayback();

  // 手动改清晰度、关掉开关：都不再自动回升。
  const manual = qualityPage();
  manual.page.startPlayback({ host: H('cosov') });
  await manual.page.clock.advance(120_000);
  manual.setQuality(32);               // 用户自己切到 32
  manual.net.bw = 700;
  await manual.page.clock.advance(400_000);
  const manualQns = manual.calls.map(call => call.qn).join('→');
  const off = qualityPage();
  off.page.startPlayback({ host: H('cosov') });
  await off.page.clock.advance(120_000);
  const hadPlan = !!off.page.api.码率.回升;
  off.page.api.自动降档(false);
  off.net.bw = 700;
  await off.page.clock.advance(400_000);
  check('9 用户手动改清晰度 / 关掉自动降档后，不再自动回升',
    manualQns === '64' && manual.page.api.码率.回升 === null && /停止自动回升/.test(manual.page.api.码率.说明) &&
    hadPlan && off.calls.length === 1 && off.page.api.码率.回升 === null,
    `手动：${manualQns}，${manual.page.api.码率.说明}；关开关：调用 ${off.calls.length} 次，之前有计划=${hadPlan}`);
  manual.page.stopPlayback();
  off.page.stopPlayback();

  // 回升后试用期内确认卡顿（不经过码率告警）也退回。
  const stall = qualityPage();
  stall.page.startPlayback({ host: H('cosov') });
  await stall.page.clock.advance(120_000);
  stall.net.bw = 700;
  await advanceUntil(stall.page, 300_000, () => stall.calls.length >= 2);
  const timersBefore = stall.page.clock.timers.size;
  stall.net.bw = 1;                      // 网络骤停：没有新分片完成（不会触发码率告警），缓冲耗尽 → 确认卡顿
  await stall.page.clock.advance(45_000);
  stall.net.bw = 700;
  await stall.page.clock.advance(5_000);
  const stallQns = stall.calls.map(call => call.qn).join('→');
  check('9 回升试用期内确认卡顿 → 立即退回并计失败（不新增定时器）',
    stallQns === '64→80→64' && stall.page.api.码率.回升?.失败次数 === 1 && stall.page.clock.timers.size <= timersBefore,
    `${stallQns}，卡顿 ${stall.page.api.卡顿次数} 次，定时器 ${timersBefore} → ${stall.page.clock.timers.size}`);
  stall.page.stopPlayback();
}

// 场景 10：码率告警里的旧数据时效。开播测速时各源都 600KB/s，之后整体网速掉到 200（< 码率 272）。
// 缓冲一直不足 15 秒 → 禁测，其他源的 600 旧探测值没人刷新。旧版靠它判“还有源够快”，永远不告警、不降档。
const DEGRADE_AT = 60_000;
async function degradeRun(source = SCRIPT, { autoDowngrade = false, onlyCurrent = false, slowKbps = 200, minutes = 8,
  degradeAt = DEGRADE_AT, manual = false, otherKbps = 600 } = {}) {
  let t0 = null;
  const slow = (host, now) => t0 != null && now - t0 >= degradeAt && (!onlyCurrent || host === H('cosov'));
  const page = createPage({ speed: (host, offset, kind, now) => (slow(host, now) ? slowKbps : host === H('cosov') ? 600 : otherKbps) }, { hud: true, source });
  t0 = page.clock.now;
  setQualityPlayinfo(page);
  const calls = [];
  const state = { nowQ: 80 };
  page.player.path = QUALITY_PATHS[80];
  page.sandbox.player = { getQuality: () => ({ nowQ: state.nowQ }), requestQuality: qn => {
    calls.push({ qn, at: page.clock.now - t0 }); state.nowQ = qn; page.player.path = QUALITY_PATHS[qn]; } };
  if (autoDowngrade) page.api.自动降档(true);
  page.startPlayback({ host: H('cosov') });
  if (manual) { await page.clock.advance(5_000); page.api.手动选源(H('cosov')); }
  let warnAt = null;
  let warnHud = '';
  let earlyWarn = false;
  const timersBefore = page.clock.timers.size;
  let minAhead = Infinity;
  for (let t = 0; t < minutes * 60_000; t += 5_000) {
    await page.clock.advance(5_000);
    if (t >= degradeAt) minAhead = Math.min(minAhead, page.bufferAhead());
    const warn = page.api.码率.告警;
    if (!warn) continue;
    if (warnAt == null) { warnAt = page.clock.now - t0; warnHud = page.hudText(); }
    // 最近一轮测速还新鲜（<3 分钟）时，旧逻辑照常：其他源的新数据够快就不该告警。
    const roundTs = page.api.测速结果?.ts;
    if (roundTs && page.clock.now - roundTs < 180_000 && warn.stale === 0 && warn.best >= 600 * 0.9) earlyWarn = true;
  }
  const out = { page, t0, stalls: page.api.卡顿次数, calls, warnAt, probes: page.net.probes.length, minAhead, warnHud, earlyWarn, warn: page.api.码率.告警, source: page.api.当前源,
    timersGrew: page.clock.timers.size > timersBefore };
  page.stopPlayback();
  return out;
}
async function scenarioStaleEvidence() {
  const run = await degradeRun();
  check('10 整体降速且禁测时，其他源的旧探测值 3 分钟后不再撑住码率告警',
    run.warnAt != null && run.warnAt > DEGRADE_AT && run.warnAt <= DEGRADE_AT + 180_000 + 60_000 && !run.earlyWarn &&
    run.warn?.stale >= 1 && /未计入/.test(run.warnHud) && run.calls.length === 0,
    `降速后 ${run.warnAt == null ? '从不' : Math.round((run.warnAt - DEGRADE_AT) / 1000) + 's'} 告警；告警=${JSON.stringify(run.warn)}；` +
    `HUD=${JSON.stringify(run.warnHud.split('\n').find(line => /码率/.test(line)) || '')}`);
  const legacy = legacySource();
  if (legacy && legacy !== SCRIPT) {
    const old = await degradeRun(legacy);
    check('10 对照：旧版（origin/main）同场景 8 分钟内从不告警', old.warnAt == null,
      `旧版告警时间=${old.warnAt}；新版=${run.warnAt}`);
  }
  const auto = await degradeRun(SCRIPT, { autoDowngrade: true });
  check('10 打开自动降档时，旧数据过期后真正降一档（80→64），只降一次',
    auto.calls.length === 1 && auto.calls[0].qn === 64 && auto.calls[0].at > DEGRADE_AT && !auto.timersGrew,
    `requestQuality=${JSON.stringify(auto.calls)}；${auto.page.api.码率.说明}`);
  // 当前源 290：够 1.0× 码率（缓冲不掉），不够 1.2×；其他源其实仍有 600。旧数据过期后不该直接告警/降档，
  // 而是在缓冲充足时补测一轮拿新数据——新数据证明还有快源，就不告警。
  const only = await degradeRun(SCRIPT, { autoDowngrade: true, onlyCurrent: true, slowKbps: 290 });
  const firstProbes = (await degradeRun(SCRIPT, { onlyCurrent: true, slowKbps: 290, minutes: 1 })).probes;
  check('10 当前源略低于 1.2×、缓冲充足、其他源旧数据过期：先补测拿新数据，不误告警、不降档',
    only.warnAt == null && only.calls.length === 0 && only.probes > firstProbes && only.minAhead >= 15 && !only.timersGrew,
    `告警=${only.warnAt}；降档=${JSON.stringify(only.calls)}；探测 ${firstProbes} → ${only.probes} 次；降速后最低缓冲 ${only.minAhead.toFixed(1)}s；` +
    `测速原因=${only.page.api.测速结果?.why}；当前源=${shortHost(only.source)}`);

  // 其他源自己的真实分片还新鲜（<3 分钟）时照常计入：刚从 08c（600）手动切到 cosov（290），不告警也不需要补测。
  const page = createPage({ speed: host => (host === H('cosov') ? 290 : 600) }, { hud: true });
  page.setPlayinfo();
  page.sandbox.player = { getQuality: () => ({ nowQ: 80 }), requestQuality: () => { } };
  page.startPlayback({ host: H('cosov') });
  await page.clock.advance(5_000);
  page.api.手动选源(H('08c'));
  await page.clock.advance(225_000);           // 08c 播 3 分多钟，开播那轮测速已过期
  page.api.手动选源(H('cosov'));
  const probesAt = page.net.probes.length;
  let warned = false;
  for (let t = 0; t < 120_000; t += 5_000) { await page.clock.advance(5_000); warned ||= !!page.api.码率.告警; }
  const real = page.api.真实速度;
  check('10 其他源的真实分片还新鲜时照常计入（刚切走的快源撑住告警），不额外补测',
    !warned && page.net.probes.length === probesAt && /08c/.test(Object.keys(real).join()) && page.api.当前源 === H('cosov'),
    `告警=${warned}；补测 ${page.net.probes.length - probesAt} 次；真实速度=${JSON.stringify(real)}`);
  page.stopPlayback();
}

// 场景 11：当前源连续 3 片真实分片低于码率、还没卡：用已有的新鲜数据主动切到够快的源，不等卡顿。
const short = host => String(host || '').replace(/^upos-sz-mirror|\.bilivideo\.com$/g, '');
const slowSwitches = run => run.page.api.切源记录.filter(item => /跟不上码率/.test(item.why));
function describeRun(run) {
  return `切源=${run.page.api.切源记录.map(item => `${short(item.from)}→${short(item.to)}@${Math.round((item.at - run.t0) / 1000)}s(${item.why})`).join('，') || '无'}；` +
    `卡顿 ${run.stalls} 次；降速后最低缓冲 ${run.minAhead.toFixed(1)}s；当前源=${short(run.source)}；探测 ${run.probes} 次`;
}
async function scenarioSlowSegments() {
  // 码率 272，cosov 在 60 秒后掉到 150（< 码率），其他源仍 600（开播测速新鲜）。
  const run = await degradeRun(SCRIPT, { onlyCurrent: true, slowKbps: 150, minutes: 4 });
  const first = slowSwitches(run)[0];
  check('11 当前源连续 3 片低于码率 → 不等卡顿，按新鲜测速主动切到够快的源',
    first && first.from === H('cosov') && first.at - run.t0 <= DEGRADE_AT + 30_000 && run.source !== H('cosov') &&
    run.stalls === 0 && run.minAhead >= 10 && !run.timersGrew, describeRun(run));
  const legacy = legacySource();
  if (legacy && legacy !== SCRIPT) {
    const old = await degradeRun(legacy, { onlyCurrent: true, slowKbps: 150, minutes: 4 });
    check('11 对照：旧版（origin/main）同场景要等缓冲见底、确认卡顿后才切',
      old.stalls >= 1 && old.minAhead < 1, `旧版：卡顿 ${old.stalls} 次，降速后最低缓冲 ${old.minAhead.toFixed(1)}s；新版：卡顿 ${run.stalls} 次`);
  }
  // 整体网速掉到 240（略低于码率，缓冲慢慢掉、不卡）：开播测速还新鲜时可能照着它试切，
  // 但刚连续跟不上的源不再选回（不 A↔B 横跳），测速过期后就停手；每次间隔 ≥60 秒。
  const all = await degradeRun(SCRIPT, { slowKbps: 240, minutes: 8 });
  const allSlow = slowSwitches(all);
  const left = new Set();
  let back = false;
  let lastAt = -Infinity;
  let gapOk = true;
  for (const item of allSlow) {
    back ||= left.has(item.to);
    left.add(item.from);
    gapOk &&= item.at - lastAt >= 60_000;
    lastAt = item.at;
  }
  const lastSlowAt = allSlow.length ? allSlow.at(-1).at - all.t0 : 0;
  check('11 所有源都跟不上时不在慢源之间来回切：不切回刚跟不上的源、间隔 ≥60 秒、测速过期后停手',
    allSlow.length >= 1 && !back && gapOk && lastSlowAt <= 180_000 + 60_000 && !all.timersGrew, describeRun(all));
  // 其他源测速只有 250（< 码率 272）：切过去也跟不上，不主动切（交给码率告警/降档）。
  const weak = await degradeRun(SCRIPT, { onlyCurrent: true, slowKbps: 150, otherKbps: 250, minutes: 3 });
  check('11 候选源也跟不上码率时不主动切源', slowSwitches(weak).length === 0, describeRun(weak));
  // 用户手选的源不动（卡顿后的原有逻辑不变）。
  const man = await degradeRun(SCRIPT, { onlyCurrent: true, slowKbps: 150, minutes: 4, manual: true });
  check('11 手选源连续低于码率时不主动切源', slowSwitches(man).length === 0, describeRun(man));
  // 开播测速已过期（4 分钟后才降速）：其他源只有旧数字，不凭它主动切；交给码率告警的补测。
  const late = await degradeRun(SCRIPT, { onlyCurrent: true, slowKbps: 150, minutes: 8, degradeAt: 240_000 });
  check('11 其他源只有过期（>3 分钟）测速时不凭旧数字主动切源', slowSwitches(late).length === 0, describeRun(late));
}
// 场景 12：开播快筛结论即时生效。原始源 cosov 只有 120KB/s（< 码率 272），08c 900。
// 旧版快筛在首帧前就跑完了，但要等精测（缓冲 ≥15 秒，最多等 20 秒）才切，缓冲涨不上去，只能卡一次后才切。
async function startupRun(source = SCRIPT, { caps = {}, liarHead = 0, manual = null, paused = false, seconds = 60 } = {}) {
  const model = {
    speed(host, offset) {
      if (liarHead && host === H('hw')) return offset < liarHead ? 40_000 : 120;
      return caps[host] ?? 300;
    },
    ttfb: () => 120,
  };
  const page = createPage(model, { hud: false, source });
  page.setPlayinfo(H('cosov'));
  page.startPlayback({ host: H('cosov') });
  if (paused) page.video.paused = true;   // 未自动播放：播放器照常预载，快筛不受缓冲门控影响、总能跑完
  const t0 = page.clock.now;
  if (manual) {
    // 首个分片发出后（脚本已认出媒体目录、开播快筛正在跑）用户手选。
    await page.clock.advance(300);
    page.api.手动选源(manual);
  }
  let firstFrame = null;
  page.video.addEventListener('timeupdate', () => { firstFrame ??= page.clock.now - t0; });
  let minAhead = Infinity;
  const timersAfterStart = page.clock.timers.size;
  for (let i = 0; i < seconds; i++) {
    await page.clock.advance(1000);
    if (page.clock.now - t0 > 6000) minAhead = Math.min(minAhead, page.bufferAhead());
  }
  const log = page.api.切源记录;
  return { page, t0, firstFrame, minAhead, stalls: page.api.卡顿次数, log, quick: log.filter(item => item.why === '开播快筛'),
    source: page.api.当前源, timersGrew: page.clock.timers.size > timersAfterStart + 1,
    text: `切源=${log.map(item => `${short(item.from)}→${short(item.to)}@${((item.at - t0) / 1000).toFixed(1)}s(${item.why})`).join('，') || '无'}；` +
      `首帧 ${firstFrame}ms；卡顿 ${page.api.卡顿次数} 次；6 秒后最低缓冲 ${minAhead.toFixed(1)}s；当前源=${short(page.api.当前源)}；探测 ${page.net.probes.length} 次` };
}
async function scenarioStartupQuick() {
  const slowOrig = { [H('cosov')]: 120, [H('08c')]: 900 };
  const run = await startupRun(SCRIPT, { caps: slowOrig });
  const first = run.quick[0];
  check('12 原始源慢：快筛一跑完就切到快源（不等精测），开播 60 秒 0 卡顿',
    run.quick.length === 1 && first.from === H('cosov') && first.to === H('08c') && first.at - run.t0 <= 6_000 &&
    run.stalls === 0 && run.source === H('08c') && !run.timersGrew, run.text);
  const legacy = legacySource();
  if (legacy && legacy !== SCRIPT) {
    const old = await startupRun(legacy, { caps: slowOrig });
    check('12 对照：旧版（origin/main）同场景要卡一次才切走', old.stalls >= 1 && run.stalls < old.stalls,
      `旧版：${old.text}`);
  }
  // 精测照跑，并且能修正暂定结论：快筛后 08c 不计入限频，精测/卡顿/跟不上码率仍可随时切。
  const result = run.page.api.测速结果;
  check('12 精测照常跑完并确认快筛结论（不再多切一次）',
    result && !result.incomplete && result.win === H('08c') && run.log.length === 1 && !result.held,
    `测速结果 win=${short(result?.win)} incomplete=${result?.incomplete} 原因=${result?.why} held=${result?.held}`);
  // 头部缓存骗过快筛（hw 前 2MB 40000KB/s、之后 120）：暂定切到 hw 后，卡顿路径不被 60 秒限频挡住，立刻纠正。
  const lie = await startupRun(SCRIPT, { caps: { [H('cosov')]: 120, [H('08c')]: 600 }, liarHead: 2 * MB, seconds: 120 });
  const fixAt = lie.log.find(item => item.from === H('hw'))?.at;
  check('12 快筛被头部缓存骗到 hw：暂定切换不占 60 秒限频，30 秒内被纠正，卡顿 ≤1 次',
    lie.quick[0]?.to === H('hw') && fixAt && fixAt - lie.quick[0].at <= 30_000 && lie.stalls <= 1 && lie.source !== H('hw'), lie.text);
  if (legacy && legacy !== SCRIPT) {
    const old = await startupRun(legacy, { caps: { [H('cosov')]: 120, [H('08c')]: 600 }, liarHead: 2 * MB, seconds: 120 });
    check('12 对照：同一骗局旧版卡顿更多', old.stalls > lie.stalls, `旧版：${old.text}`);
  }
  // 原始源够用（500 vs 08c 560，快不到 25%；快筛跑完时 cosov 真实分片不足 3 片，滞回兜不住，只能靠这道门槛）：不做暂定切换。暂停预载，确保快筛跑完、确实走到这道门槛。
  const fine = await startupRun(SCRIPT, { caps: { [H('cosov')]: 500, [H('08c')]: 560 }, paused: true });
  const fineProbed = fine.page.api.测速结果?.list.length;
  check('12 原始源已够用（候选快不到 25%）时不暂定切换', fine.quick.length === 0 && fineProbed >= 6, `测到 ${fineProbed} 个源；${fine.text}`);
  // 所有候选都 < 1.2×码率（300 < 326）：切过去也没余量，不暂定切换。
  const weak = await startupRun(SCRIPT, { caps: { [H('cosov')]: 120, [H('08c')]: 300 } });
  check('12 候选都不到 1.2×码率时不暂定切换', weak.quick.length === 0, weak.text);
  // 开播前手选了 cosov：不动。
  const man = await startupRun(SCRIPT, { caps: slowOrig, manual: H('cosov') });
  check('12 手选源时不暂定切换', man.quick.length === 0, man.text);
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
  const oldForbid = await scenarioSegmentForbidden(legacy, 'legacy');
  const newForbid = await scenarioSegmentForbidden(SCRIPT, 'current');
  console.log(`对照 6（真实分片 403，90 秒）：旧版 403 ${oldForbid.forbidden} 次 / 卡顿 ${oldForbid.stalls} / 播放到 ${oldForbid.played}s；` +
    `新版 403 ${newForbid.forbidden} 次 / 卡顿 ${newForbid.stalls} / 播放到 ${newForbid.played}s`);
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
await scenarioSegmentForbidden();
await scenarioBanRecovery();
await scenarioDiagnostics();
await scenarioRealPrior();
await scenarioQualityRestore();
await scenarioStaleEvidence();
await scenarioSlowSegments();
await scenarioStartupQuick();
if (CONTRAST) await contrast();
const failed = results.filter(item => !item.pass);
console.log(`\n=== qa-stall：PASS=${results.length - failed.length} FAIL=${failed.length}，耗时 ${((Date.now() - started) / 1000).toFixed(1)}s ===`);
process.exit(failed.length ? 1 : 0);
