# bili-boost Safari / WebKit 兼容审计（2026-09-25，基于 v1.5.0 → v1.5.1）

范围：`bili-boost.user.js` 触及的全部浏览器 API，对照当前 macOS Safari 18/19（WebKit）与 quoid Userscripts v4.8.6 的注入模型做静态审计。结论依据 WebKit 源码、MDN browser-compat-data（BCD）与 quoid/userscripts 源码/README，未在真实 Safari 上压测。

## 结论速览

| # | 风险 | 严重度 | 已有防护 | 本次处理 |
|---|---|---|---|---|
| 1 | iPhone Safari 无 `MediaSource` 全局，`MediaSource.prototype` 抛 ReferenceError | **高**（iOS 上半初始化） | 无 | **已修**，新增 QA |
| 2 | Userscripts 的 document-start 实际是异步注入，可能晚于页面内联脚本 | 中 | 部分（已有 `__playinfo__` 会被就地改写） | 记录，脚本内无法根治 |
| 3 | fetch `Response.clone()` 观测分支在 Safari 大分片下的内存/带宽 | 低（静态分析） | 30s / 32MB 上限、观测器 ≤32 | 记录分析，仍待实机压测 |
| 4 | HUD `user-select` Safari 只认 `-webkit-` 前缀 | 低（外观） | 无 | **已修** |
| 5 | HEVC `hev1` / `hvc1` 编码串在 Safari MSE 的可用性 | 低 | — | 已核对 WebKit 源码，两者都解析 |
| 6 | `@inject-into page` 受页面 CSP 约束，且 page 模式无 content 回退 | 低（目前无 CSP） | — | 记录 |
| 7 | 跨域 Range 精测请求可能触发 CORS 预检 | 低 | 失败时标记 skipped、退回头部结果 | 无需改 |
| 8 | Safari ITP 7 天清理脚本可写存储 | 低 | 所有存储读写均 try/catch，健康档案本就 7 天 | 无需改 |
| 9 | `@updateURL` 指向 `.user.js`，Userscripts 自动更新不完整 | 低（运维） | — | 记录 |

## 逐项说明

### 1. `MediaSource` / `ManagedMediaSource`（已修）

- 证据：MDN BCD `api/MediaSource.json` 中 `safari_ios` 注明 “Exposed in Mobile Safari on iPad but not on iPhone”；`api/ManagedMediaSource.json`：Safari 17 / iOS 17.1 起提供。WebKit `Source/WebCore/Modules/mediasource/ManagedMediaSource.idl` 为 `interface ManagedMediaSource : MediaSource`，未重声明 `addSourceBuffer`。
- 问题：旧代码在视频页同步执行 `MediaSource.prototype.addSourceBuffer`。在 iPhone 上 `MediaSource` 不存在 → ReferenceError。此时 fetch/XHR 钩子已装好，但卡顿监听、调试接口 `__biliBoost`、HUD、AV1 探测全部没有执行，形成“CDN 改写在跑、闭环和面板全无”的半初始化状态。quoid 的包装层只会 `console.error`，用户看不到。
- macOS：两者并存。由于继承关系，播放器即使改用 `ManagedMediaSource`，调用的仍是 `MediaSource.prototype.addSourceBuffer`，旧钩子在 macOS 上已能覆盖。
- 修复：分别取 `window.MediaSource`、`window.ManagedMediaSource`，沿原型链找到真正拥有 `addSourceBuffer` 的原型，用 Set 去重后只包一次；两个构造器都不存在就跳过。Chrome 行为不变（仍只包 `MediaSource.prototype`，防重复注入用例继续通过）。
- QA：新增「Safari：仅 ManagedMediaSource」。在 Chrome 中按 WebKit IDL 造出 `class ManagedMediaSource extends MediaSource` 并删除 `window.MediaSource`，断言脚本完整初始化（`__biliBoost` 可用）、基类原型已被包装、`ManagedMediaSource.prototype` 上没有多包一层，且经 `ManagedMediaSource` 调 `addSourceBuffer` 能记录编码。旧代码会因 ReferenceError 导致 `__biliBoost` 不存在，该用例必然 FAIL。
- 未覆盖：WebKit 已支持 Worker 内的 MSE（IDL `Exposed=(Window,DedicatedWorker)`）。若 B 站日后把 MSE 挪进 Worker，页面里的钩子拿不到编码信息，HUD 会显示“未检测编码”，但不影响播放。

### 2. document-start 注入时机（记录）

- 证据：quoid `src/ext/content-scripts/entry-userscripts.js`：先 `await browser.runtime.sendMessage({name: "REQ_USERSCRIPTS"})` 往返后台，再对 `document-start` 调 `injectJS`；`page` 模式通过在关闭的 shadow root 里插入 `<script>` 执行。这个消息往返是异步的，脚本可能晚于 B 站 `<head>` 里的内联 `window.__playinfo__ = …` 和播放器首个 `addSourceBuffer` 执行。
- 已有防护：`installPlayinfoHook` 会先就地改写已存在的 `__playinfo__`；`patchCodecStrategy` 的 localStorage 写入至少从下一次加载起生效；CDN 模块从下一个分片起改写。
- 影响：Safari 首屏偶尔仍可能拿到 AV1、首批分片走原始 host；HUD 编码行可能是“未检测编码”。脚本内无法根治（Tampermonkey 在 Chrome 中是同步注入，不受影响）。遇到时刷新一次即可。

### 3. fetch `Response.clone()` 观测分支（PI-REVIEW 遗留项，静态分析）

- WebKit `FetchResponse::clone()`：body 仍在加载时会创建 ReadableStream 并 tee（注释 “If loading, let's create a stream so that data is teed on both clones”）。脚本在 clone 之前已读取 `response.body`，走的就是 tee 路径。
- 内存：tee 两个分支共享同一 chunk 对象，不复制数据。观测分支是“读完即丢”（只累加 `value.length`），不会积压；未读数据只积压在播放器分支，与不 clone 时相同。结论：不存在 Safari 特有的整段缓冲放大。
- 取消语义：WebKit `ReadableStreamInternals.js` 的 `readableStreamTeeBranch{1,2}CancelFunction` 只有两个分支都 cancel 才会取消源流，与规范一致。因此 32MB / 30s 时取消观测分支**不会**打断播放器；分支自身会先关闭，挂起的 `read()` 立即以 done 结束，`finally` 正常清理。注意：该 cancel 返回的 promise 会一直 pending 到播放器分支也结束，脚本不 await 它（只挂 `.catch`），因此不会卡住。
- 残余风险（不限于 Safari）：若播放器用 `reader.cancel()`（而非 AbortSignal）放弃某个分片，观测分支会让网络继续下载，最多 32MB / 30 秒。这是 tee 的规范语义，已有上限兜底；若播放器用 AbortController，两个分支同时报错，不会多下。
- 仍需：在 Safari 上用 4K/高码率分片做实机观察（Web Inspector → Timelines → Memory / Network）。

### 4. HUD `user-select`（已修）

- 证据：MDN BCD `css/properties/user-select.json`：Safari 只支持 `-webkit-user-select`（无前缀版仅 Technology Preview）。
- 修复：HUD 内联样式补 `-webkit-user-select:none`。`backdrop-filter` 原本已带 `-webkit-` 前缀并有不透明背景兜底。

### 5. 编码串与能力探测

- WebKit `Source/WebCore/platform/graphics/HEVCUtilities.cpp` 同时识别 `hvc1` 与 `hev1`，B 站 HEVC 流的编码串在 Safari 的 `isTypeSupported` / `decodingInfo` 下均可解析。
- `navigator.mediaCapabilities.decodingInfo({type:'media-source'})`：Safari 13+ 支持。AV1 探测用 `av01.0.08M.08`：Safari 的 AV1 解码依赖硬件（M3+），M1/M2 上预期返回 `supported:false` 或 `powerEfficient:false`（未实机核对），两者都记为无硬解 → 剔除 AV1，符合预期。调用已包在 try + 3 秒超时里，失败保持“未知”并按保守策略剔除。
- 已知小问题：Safari 冻结 UA 中的 macOS 版本（10_15_7），AV1 缓存的环境键对系统升级不敏感；有 30 天 TTL 兜底，影响很小。

### 6. `@inject-into page` 与 CSP

- quoid README FAQ：Safari 中扩展无法绕过页面 CSP；只有 `@inject-into auto` 会在 `securitypolicyviolation` 后回退到 content 世界。本脚本必须在 page 世界才能 hook 页面的 fetch/XHR，所以 `page` 是正确选择。
- 2026-09-25 实测 `www.bilibili.com/video/…` 的响应头没有 `Content-Security-Policy`。若 B 站日后加上禁止 inline 的 CSP，Safari 下脚本会静默不运行（控制台会有 “Refused to execute a script”）。
- `@grant none`：quoid 在 page 模式下会移除所有 grant，且 GM API 只在 content 模式可用；脚本只用 `localStorage` / `sessionStorage`，不依赖 GM 存储，兼容。

### 7. 其他 API 逐项核对（均无问题）

- `AbortController` / fetch `signal`（Safari 12.1+），中断时抛 `DOMException` 且 `name === 'AbortError'`，与判断逻辑一致。
- `ReadableStream.getReader()` / `reader.cancel()`：Safari 支持；探测路径的 `cancel()` 不 await，不受 tee 挂起影响。
- `XMLHttpRequest.prototype` 上 `response` / `responseText` 为访问器属性（WebIDL），实例级 `defineProperty` 覆盖可行；`addEventListener(..., {once:true})` Safari 10+。
- `queueMicrotask`（Safari 12.1+）、`Promise.prototype.finally`（11.1+）、可选链与 `??`（13.1+）、`Symbol`、`URL` / `URLSearchParams`、`performance.now()`、`Element.closest` / `dataset`、`padStart` / `padEnd`：均受支持。脚本没有用 `structuredClone`、`Array.prototype.at`、`AbortSignal.timeout` / `any`、`requestIdleCallback`（Safari 无此 API）等较新或 Safari 缺失的 API。
- 媒体事件：`waiting` / `stalled` / `timeupdate` 在 document 上用捕获阶段监听，Safari 行为一致；Safari 对 `stalled` 的触发节奏不同，但已有“1.2 秒无前进 + 缓冲不足 + readyState<3”的确认逻辑兜底。
- 跨域 Range：Fetch 规范虽已把单段 `Range` 列入 CORS 安全头，旧实现仍可能发预检；失败会走 `skipped` 退回头部结果，不拉黑。
- 存储：Safari 无痕模式下 `localStorage` 可用；ITP 对 7 天未交互的站点会清理脚本可写存储，但 bilibili.com 是用户直接访问的一方站点，每次访问都会重新计时。所有读写均在 try/catch 内。
- iframe：quoid 默认注入所有 frame（除非 `@noframes`），与脚本“iframe 只保留被动 CDN 钩子、不画 HUD”的设计一致。

### 8. 更新渠道（运维提示）

- quoid README：`@updateURL` 应指向 `.meta.js`，且更新流程未完整实现（issue #248）。本仓库本身就是 Userscripts 的保存目录，Safari 直接运行工作区里的 `bili-boost.user.js`，**切换 git 分支就等于切换 Safari 里运行的版本**。

## 回归

- `node --check bili-boost.user.js`、`node --check tools/qa-boost.mjs`：通过。
- `node tools/qa-boost.mjs`：**PASS=16、FAIL=0、SKIPPED=2**（新增「Safari：仅 ManagedMediaSource」；两个 SKIPPED 仍是未登录内联 playinfo，与 v1.5.0 相同）。
- `git diff --check`：通过。
- 版本：`@version` 与 `SCRIPT_VERSION` 均为 1.5.1；无新依赖、无新增功能性网络请求、无 `eval` / `new Function`。

## 仍待实机验证

1. Safari 上 4K/高码率分片的 clone 观测分支（内存曲线与 32MB 截断后的播放器表现）。
2. Safari 下 document-start 晚注入的实际发生频率（控制台看 `Injecting: … (js/page)` 与 `[bili-boost] v1.5.1 已注入` 相对播放器日志的先后）。
3. iPhone Safari + Userscripts 的真实 B 站移动页播放（本次只在 Chrome 里模拟了 API 形态）。
