#!/usr/bin/env node
// v1.8.1 HUD 展开态行宽检查：不启动浏览器、不访问网络。
// 用 node:vm 跑真实的 bili-boost.user.js（DOM/网络全部打桩），注入一组与实测截图同形状的
// lastResults（cosov/hw/ali 精测有 points，cos 快筛，08h/08c 失败且已拉黑，08a 未测且本视频拒绝），
// 渲染展开态后把 innerHTML 去掉标签，逐行打印显示宽度（CJK/全角/emoji 按 2 计）。
//   node tools/qa-hud-width.mjs              # 校验当前文件，最宽行必须 ≤50，超出判 FAIL
//   node tools/qa-hud-width.mjs origin/main  # 用同一 fixture 渲染指定 git ref，只打印不断言（改前对比）
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const REF = process.argv[2] || null;
const SCRIPT = REF
  ? execFileSync('git', ['show', `${REF}:bili-boost.user.js`], { encoding: 'utf8' })
  : await readFile(new URL('../bili-boost.user.js', import.meta.url), 'utf8');
const MAX_WIDTH = 50;

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
}

class Storage {
  constructor() { this.map = new Map(); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
}

// 显示宽度：ASCII 与半角（≤0xFF）按 1，其余（CJK、全角、emoji、↳、— 等）按 2。
const displayWidth = text => [...text].reduce((width, ch) => width + (ch.codePointAt(0) > 0xff ? 2 : 1), 0);

// innerHTML → 纯文本行：<br>/<hr> 断行，剥掉标签，解常用实体。
const htmlToLines = html => String(html)
  .replace(/<br\b[^>]*>/gi, '\n')
  .replace(/<hr\b[^>]*>/gi, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  .split('\n');

function createPage(source) {
  const document = new Emitter();
  const elements = new Map();
  class Element extends Emitter {
    constructor(tag) {
      super();
      this.tagName = tag.toUpperCase();
      this.style = { cssText: '', setProperty() { } };
      this.html = '';
      this.id = '';
      this.dataset = {};
    }
    set innerHTML(value) { this.html = String(value); }
    get innerHTML() { return this.html; }
    get textContent() { return htmlToLines(this.html).join('\n'); }
    remove() { if (elements.get(this.id) === this) elements.delete(this.id); }
    click() { }
  }
  document.body = { appendChild(element) { elements.set(element.id, element); return element; } };
  document.createElement = tag => new Element(tag);
  document.getElementById = id => elements.get(id) || null;
  document.querySelector = () => null;

  const localStorage = new Storage();
  // AV1 能力已缓存为“无”，避免脚本加载时发能力查询。
  const env = ['QA-Node', 'MacIntel', 8].join('|');
  localStorage.setItem('bhw_av1hw', JSON.stringify({ value: false, at: Date.now(), env }));
  const noop = () => 1;
  class FakeXHR extends Emitter {
    open() { } setRequestHeader() { } send() { } abort() { }
    getResponseHeader() { return null; }
  }
  const sandbox = {
    console: { log() { }, warn() { }, error: (...args) => console.error('   [page]', ...args) },
    document,
    location: { href: 'https://www.bilibili.com/', pathname: '/', search: '', hash: '' },
    localStorage,
    sessionStorage: new Storage(),
    navigator: {
      userAgent: 'QA-Node', platform: 'MacIntel', hardwareConcurrency: 8,
      mediaCapabilities: { decodingInfo: () => Promise.resolve({ supported: true, smooth: true, powerEfficient: true }) },
    },
    performance: { now: () => 0 },
    Date,
    setTimeout: noop, clearTimeout: noop, setInterval: noop, clearInterval: noop,
    queueMicrotask,
    fetch: () => new Promise(() => { }),
    XMLHttpRequest: FakeXHR,
    HTMLVideoElement: class extends Element { },
    URL, URLSearchParams, AbortController, Headers, Request, Response, Uint8Array,
    addEventListener() { }, removeEventListener() { },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.top = sandbox;
  const context = vm.createContext(sandbox);
  // 在 IIFE 内、debugApi 暴露处挂一个测试钩子，才能注入 cdnState 并驱动 renderHud。
  const marker = 'window.__biliBoost = debugApi;';
  if (!source.includes(marker)) throw new Error('找不到注入点：' + marker);
  vm.runInContext(source.replace(marker, `${marker}\n  window.__qaHud = { cdnState, renderHud };`),
    context, { filename: 'bili-boost.user.js' });
  return { sandbox, hud: () => elements.get('bili-boost-hud') || null };
}

const H = name => `upos-sz-mirror${name}.bilivideo.com`;
const { sandbox, hud } = createPage(SCRIPT);
const { cdnState, renderHud } = sandbox.__qaHud;
const now = Date.now();
cdnState.curKey = 'width-check|p=1';
cdnState.activeHost = H('cosov');                    // 当前源 → ✅ 标记
cdnState.rejected.set(cdnState.curKey, new Set([H('08a')]));
for (const host of [H('08h'), H('08c')]) {
  cdnState.blacklist.set(host, { until: now + 600e3, strikes: 1, reason: '分片 HTTP 403·拉黑', at: now });
}
cdnState.lastResults = {
  why: '开播', ts: now, origHost: H('08a'), win: H('cosov'), incomplete: false, held: null,
  reason: '健康档与融合速度/TTFB 评分最优',
  list: [
    { host: H('cosov'), ok: true, kbps: 640, effectiveKbps: 612, fusedKbps: 589, ttfb: 118,
      realSamples: 3, stage: '精测(头+前方)', note: '头部疑似缓存(5×)，按前方计',
      points: [{ point: '头', kbps: 3400, ttfb: 36 }, { point: '前方', kbps: 612, ttfb: 118 }] },
    { host: H('hw'), ok: true, kbps: 720, effectiveKbps: 701, fusedKbps: 701, ttfb: 152,
      stage: '精测(头+前方)', note: '',
      points: [{ point: '头', kbps: 735, ttfb: 141 }, { point: '前方', kbps: 701, ttfb: 152 }] },
    { host: H('ali'), ok: true, kbps: 300, effectiveKbps: 282, fusedKbps: 282, ttfb: 461,
      realSamples: 2, stage: '精测(头+前方)', note: '头部疑似缓存(5×)，按前方计',
      points: [{ point: '头', kbps: 1500, ttfb: 88 }, { point: '前方', kbps: 282, ttfb: 461 }] },
    { host: H('cos'), ok: true, kbps: 512, effectiveKbps: 498, ttfb: 172, stage: '快筛', note: '' },
    { host: H('08h'), ok: false, kbps: 0, effectiveKbps: 0, ttfb: null, stage: '快筛', note: '失败' },
    { host: H('08c'), ok: false, kbps: 0, effectiveKbps: 0, ttfb: null, stage: '快筛', note: '失败' },
  ],
};
renderHud(true);
const box = hud();
if (!box) { console.error('FAIL  HUD 没有渲染'); process.exit(1); }

const lines = htmlToLines(box.innerHTML);
console.log(`=== HUD 展开态纯文本（${REF || '工作区'}，宽度=CJK2/半角1，上限 ${MAX_WIDTH}）===`);
let widest = 0;
for (const line of lines) {
  const width = displayWidth(line);
  widest = Math.max(widest, width);
  console.log(`${String(width).padStart(3)} │ ${line}`);
}
console.log(`最宽行 = ${widest}`);
if (REF) {
  console.log('（对比渲染模式，不做宽度断言）');
} else if (widest > MAX_WIDTH) {
  console.error(`FAIL  最宽行 ${widest} > ${MAX_WIDTH}`);
  process.exit(1);
} else {
  console.log(`PASS  最宽行 ${widest} ≤ ${MAX_WIDTH}`);
}
