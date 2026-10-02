# bili-boost

海外看 B 站，两个毛病经常同时犯：**转圈缓冲**，和**风扇狂转、机器发烫**。

它们的根因完全不同，但都不是你的网或你的机器不行 —— 是 B 站给你的**镜像不够快**，和 B 站给你的**编码你的芯片解不动**。这个油猴脚本一起治。

**[👉 点此安装](https://raw.githubusercontent.com/leonjean214/bili-boost/main/bili-boost.user.js)**（需先装 Tampermonkey 等脚本管理器，见下方[安装](#安装)）

> 本脚本由 `bili-cdn-fix`（CDN 测速切源）与 `bili-hwdecode`（强制硬解编码）两个单功能脚本合并而来，已替代它们。如果你装过其中任何一个，**请先在脚本管理器里禁用或删除**，否则会重复劫持请求、重复测速、出现多个 HUD。
>
> 仓库原名 `bili-cdn-switcher`，合并后改名为 `bili-boost`。GitHub 会自动重定向旧链接。

### v1.7.0（Safari 实播卡顿优化）

起因：2026-10-02 Mac Safari 实播（BV1PF4m177EQ p=9，1080P）卡顿 12 次。开播测速选了 cosov（头部 47MB/s、1MB 处 5.5MB/s），但播放器真实分片在 cosov 上只有 50～700KB/s；同一分片在 cosov/akam 之间反复横跳，每 20～30 秒又发一轮探测和播放器抢带宽，`probing=1` 一直挂着。

- **测速代表性**：快筛与精测改测播放器「即将请求」的区间（最近一次分片 Range 的末尾 +1；还不知道时取 4MB 处，按文件长度收口），精测仍保留文件头作对照。头/前方速度比 >5× 时判为「头部缓存命中」，只按前方点计分。评分改用含 TTFB 的**有效速度**，并与真实分片速度按交付时间加权融合：有 1～2 片实测时真实占 0.6，≥3 片占 0.8。
- **防横跳**：自动切源加滞回——旧源须连续 3 片低于码率（确认卡顿时 1 片即可），或新源真实分片连续 3 片比旧源快 25% 以上；同一视频 60 秒内最多自动切 1 次（手选、手动重测不受限）。切源只影响之后的请求，正在传输的分片不会被中断。播放器自己回退到 Akamai 等跨域族 backup 时原样放行，不再清掉已选源、也不再因此重测。
- **缓冲不足禁测**：播放中前向缓冲 <15 秒时暂停一切探测（快筛、精测、卡顿重测都算），只用已有数据（真实分片、上轮测速、健康档案）决策；缓冲回到 15 秒以上再补测。所有探测全局串行（并发 1），每个请求 8 秒硬超时（abort 不生效时也按时退出），整轮 90 秒看门狗，结束必清理 `probing` / controller。
- **码率感知**：从 playurl 读当前视频+音频的 `bandwidth`；所有源（融合后）速度都 <1.2×码率时 HUD 提示。可选自动降一档清晰度（默认关，只提示；开关存 `localStorage` 的 `bhw_autoDowngrade`）。
- **HUD / 编码**：修复 HUD 与 `__biliBoost.当前源` 不一致（换源后 HUD 立即重绘，500ms 同步兜底）。Safari 拿不到 SourceBuffer 时，按分片路径对上 playurl 推断编码，`decodingInfo` 依次试 media-source → hev1 换 hvc1 → file；仍判断不了时写明原因（不支持 mediaCapabilities、查询超时、没拿到 playurl……），不再只显示「未知」。
- 新增无浏览器回归 `node tools/qa-stall.mjs`（模拟 fetch/XHR/video，虚拟时钟），`qa-boost.mjs` 也会先跑它。详见 [CHANGELOG](CHANGELOG.md)。

### v1.6.0

- 关闭 HUD 会清除折叠定时器和点击监听；重复编码状态查询会合并，媒体切换立即结束旧 metadata/能力等待；精测缓冲等待改为事件唤醒并可取消。
- 新增独立资源计数与有/无 AV1 硬解的压力回归，并提供真实两小时播放检查。发布变更见 [CHANGELOG](CHANGELOG.md)，复现命令与计数口径见下方「回归测试」。

### v1.5.2

- 按海外用户反馈，将 `upos-sz-mirror08h.bilivideo.com` 加入 CDN 候选；继续走现有快筛、头部/中段精测（Range 不可用时退回头部）。本轮探测失败不会让它成为新赢家；展开 HUD 可手动试该节点，不保证不同地区都更快。

### v1.5.1

- Safari 兼容审计（见 `reviews/SAFARI-AUDIT-20260925.md`）：`addSourceBuffer` 钩子改为沿原型链同时覆盖 `MediaSource` / `ManagedMediaSource`，iPhone Safari（只有 ManagedMediaSource）不再因 `MediaSource` 未定义而中断初始化；HUD 补 `-webkit-user-select`。

### v1.5.0

- 长时播放与 SPA 切视频会主动取消旧探测/观测、清理媒体态；所有动态 Map/Set/数组和待处理观测器均有硬上限。
- 主机健康档案升级为带版本的 v2 格式，旧字典自动迁移，并同时执行 **32 台主机 + 7 天**裁剪。
- 分 P、切清晰度会按 `cid/qn/fnval` 识别新媒体代次，旧手选、测速、实测样本和编码状态不再污染新源。
- 分片热路径先按扩展名快筛，再构造 URL；移除每请求的 host/path 正则扫描。20 万次混合请求微基准由 **54.3ms 降至 14.5ms（3.73×）**。

---

## 毛病一：CDN 镜像不够快

B 站 web 播放器从 `playurl` 拿到的是一个主地址 + 若干 backup 地址，客户端无权选择 CDN。海外用户经常被分到回源很慢的镜像，而 backup 线同样不可靠。

一次真实抓取（2026-09-14，海外网络，视频 `BV1nTR5BjES3`，2MB 分片实测）：

| 镜像 | 速度 | 说明 |
| --- | --- | --- |
| `upos-sz-mirror08c` | **815 KB/s** | 中国移动 |
| `upos-sz-mirrorali` | 781 KB/s | 阿里 |
| `upos-sz-mirrorhw` | 659 KB/s | 华为 |
| `upos-sz-mirrorcos` | 511 KB/s | 腾讯 |
| `upos-sz-mirrorcosov` | **218 KB/s** | Gcore —— **播放器给的主地址** |
| `upos-hz-mirrorakam` | **HTTP 403** | Akamai —— **播放器给的唯一 backup** |
| `upos-sz-mirroraliov` | 88 KB/s | 阿里海外 |

1080P 大约需要 375 KB/s。主线 218 KB/s 不够码率，备线直接 403 —— 必卡。而同一时刻同一个视频，08c 有 815 KB/s。

分片 URL 的签名可以跨 upos 镜像复用，所以换个 host 就能取到同样的内容。

## 毛病二：B 站优先发 AV1，而你的芯片解不动

B 站对同一视频同时下发 AVC / HEVC / AV1 三条流，由播放器挑。它的挑选策略是：

```json
"default_codec_strategy": ["av1", "hevc", "avc"]
```

**AV1 排第一。** 而 Apple M1/M2 的媒体引擎没有 AV1 硬件解码器（Apple 从 M3 才加），AV1 只能由 CPU 软解 —— 于是发烫、掉帧、耗电。

同一份配置里确实有一张按 GPU 改写策略的表，但里面只有这些：

```json
"gpu": { "ZX C-960": ["hevc","avc"], "ZX C-1080": [...], "ZX C-1190": [...], "vastai": [...] }
```

兆芯、瀚博 —— 全是国产 GPU。**Apple Silicon 不在名单里**，于是直接吃默认值。

在 M2 / Chrome 152 上用 `navigator.mediaCapabilities.decodingInfo()` 实测（`powerEfficient` 为 true 才是硬解）：

| 编码 | supported | powerEfficient |
| --- | --- | --- |
| H.264 / AVC (1080p & 4K) | ✅ | ✅ **硬解** |
| HEVC / H.265 (Main & Main10) | ✅ | ✅ **硬解** |
| VP9 | ✅ | ✅ |
| **AV1 (1080p & 4K)** | ✅ | ❌ **软解** |

浏览器的硬解一切正常，唯独 AV1 落在 CPU 上 —— 而 B 站偏偏优先发 AV1。

> 顺带排除一个思路：把 `MediaSource.isTypeSupported('…av01…')` 伪造成 `false` **没有用**。实测 B 站播放器根本不查浏览器能力，它照着策略表硬选，伪造后依然给你 AV1。必须从播放数据本身下手。

---

## 工作原理

两个模块共用一套请求劫持（`fetch` / `XHR.open` / `XHR.send` 各只 hook 一次），按阶段分工：

```
请求阶段  →  CDN 模块：改写 .m4s/.mp4/.flv 分片请求的 host
响应阶段  →  编码模块：改写 playurl 响应体，剔除 AV1
```

### CDN 模块

**两阶段、多点测速，全部串行**（v1.7.0 起快筛也串行，全局同时只有 1 个探测请求）：

```
阶段1  串行快筛（各 128KB，测播放前方区间；Range 不可用时退回头部）→ 淘汰死源和慢源
       ↓ 取前 3 名
阶段2  串行精测（每源共 768KB）
       ├─ 文件头 384KB
       └─ 播放前方 Range 384KB（最近分片 Range 末尾 +1；未知时 4MB 处）
```

**测速点要测播放器接下来真要下的字节**。现场 cosov 头部 47MB/s、1MB 处也有 5.5MB/s —— 都是 CDN 已缓存的段，而播放器后续分片只有 50～700KB/s。所以前方点取「播放器即将请求」的区间；头/前方速度比 >5× 时标记「头部疑似缓存」，只按前方点计分。若某个服务端不支持单段 Range，则明确标注并退回头部结果，不会仅因诊断能力缺失把可播放源拉黑。

每次测速同时拆出 **TTFB（首字节延迟）**、**净传输吞吐**和**有效速度**（含 TTFB 的端到端）。排序用有效速度，并与该源的真实分片速度融合（按每 KB 交付时间加权，即加权调和平均；有 1～2 片实测时真实占 0.6，≥3 片占 0.8）—— 被缓存抬高几十倍的探测值拉不回一个真实只有 100KB/s 的源。

**在用源保护 + 滞回**。候选的融合交付时间至少好 25% 才考虑切走；真要切还得过滞回：旧源连续 3 片低于码率（确认卡顿时 1 片即可），或新源在真实分片上连续 3 片比旧源快 25% 以上。第一次选源时旧源样本不足 3 片，按测速结论直接选。同一视频 **60 秒内最多自动切 1 次**；手选和手动重测不受限。被挡下时 HUD 会显示「⏸ 滞回：……」。

**切源不打断正在下的分片**。改写只作用于之后发起的请求，脚本从不 abort 播放器的请求。

**跨域族 backup 原样放行**。播放器自己回退到 `akamaized.net` backup 时，签名不能跨族改写，脚本只记录它的真实速度，不清掉已选源、不触发测速（v1.6 在这里会清缓存并重测，正是现场 cosov/akam 横跳、每 20～30 秒一轮探测的来源）。

**不合成跨供应商 Akamai 地址**。`akamaized.net` 的签名可能绑定 host，把 `bilivideo.com` URL 只换成 Akamai 常见 403，所以候选池只放同族 `bilivideo.com` 镜像；如果播放器原地址本来就是 Akamai，它仍会作为原始源测速，但不会和另一域族互改。

**闭环验证**。探测值只是一瞬间的估计，真正可信的是播放器实际拉流的速度：

- XHR 分片用 `progress/loadend` 统计；fetch 分片流式读取 `Response.clone()` 的观测分支，**不重复发网络请求，也不替换播放器拿到的原 Response**
- 只显示当前源最近 6 片的净吞吐与 TTFB 中位数，切源后不混入旧源样本
- `waiting` / `stalled` 不再立即算卡顿：主动 seek、初始加载、playurl/SourceBuffer 切换有静默期，还要确认 1.2 秒内播放时间没前进、缓冲不足且 `readyState` 未恢复
- 确认真卡后（v1.7.0）：卡顿时缓冲必然不足，**不发探测**，只用已有数据（真实分片 > 上轮测速 > 健康档案）挑替代源，并受滞回和 60 秒限频约束；切走时当前源进入该视频的拒绝名单，缓冲回到 15 秒以上再补测

所以即使某次探测选错了，也能自我修正；展开 HUD 还可点击测速列表里的任一蓝色源（包括自动判失败但你想强试的源）手动切线，并随时恢复自动。

**跨会话健康档案**（v1.3.0 起）。单看速度会选中"忽快忽慢"的源 —— 一台 70% 时候飞快、30% 超时的镜像，体验差于一台始终中等的。脚本把每台主机的成败、净吞吐与 TTFB 记在 `localStorage`：

```
排序键（严格全序）：本轮是否成功 → 成功率分档(每 15% 一档) → 估算交付时间 → TTFB → host
```

- 样本少于 3 次先按最好档处理（乐观探索），每轮快筛都在累积样本，很快就会落到真实分档
- **本轮失败或超时截断的源不算成功**，也不能靠历史成功率当赢家
- 最多保留 32 台主机、7 天过期、样本到 24 后衰减 —— 防止陈年统计支配当前网络
- v1.5.0 起存储为带版本的 envelope；v1.3/v1.4 旧字典会在首次加载时自动迁移、裁剪，不丢失仍有效的样本

**缓冲不足禁测**（v1.7.0）。播放中前向缓冲 <15 秒时暂停一切探测；精测前最多等 20 秒缓冲回到 15 秒以上（或暂停），等不到就放弃本轮精测、按快筛+真实分片决策，**不再「等 8 秒照跑」**。开播前（还没开始播放）和暂停时不受限。被推迟的测速在缓冲恢复后补测，与上一轮至少间隔 45 秒；每个媒体目录只自动开播测速一次，不会逐片重测。每个探测请求 8 秒硬超时（Safari 偶发 abort 后 `read()` 永不返回，也会按时退出），整轮 90 秒看门狗，结束必清理 `probing` / controller。

**码率感知**（v1.7.0）。按分片路径对上 playurl 里那一路流，拿到当前视频+音频 `bandwidth`。所有源（融合后）速度都低于 1.2×码率时 HUD 提示「所有源都 < 1.2×码率」；展开面板可打开「跟不上码率时自动降一档」（默认关，存 `localStorage` 的 `bhw_autoDowngrade`），打开后通过播放器的 `requestQuality` 降一档，60 秒内最多一次。

### 编码模块

四层，从源头到兜底：

1. **官方编码偏好**。播放器源码里有一个没多少人注意的枚举：
   ```js
   DEF = 0, HEVC = 1, AVC = 2, AV1 = 3   // → bilibili_player_codec_prefer_type
   ```
   默认 `0` 就是上面那个 AV1 优先的坑。脚本把它设成 `1`(HEVC) 或 `2`(AVC)。

2. **改写 `default_codec_strategy`**。启动瞬间的补充保险（这个值会被服务端刷新覆盖，所以不能只靠它）。

3. **劫持 `window.__playinfo__`**。B 站把首帧播放数据内联在 HTML 里，脚本拦下 setter，把 `codecid === 13`（AV1）的流从 `dash.video` 里剔除。

4. **劫持 `playurl` 接口**。换 P、切清晰度、番剧走 XHR/fetch，同样过滤（`fetch`、`xhr.responseText`、`xhr.responseType='json'` 三条分支都覆盖）。

> **第 1 层才是真正起作用的那层。** 实测：只设 `codec_prefer_type=1`，**一条 AV1 都不剔除、数组顺序原封不动**，播放器照样选 HEVC。
>
> 那为什么还要 3、4 层？因为**这个偏好会被播放器版本升级重置**（见「已知局限」）。剔除 AV1 是偏好失效时的兜底，不是主力。

**两个安全阀**：

- 某个视频**只有** AV1 一条流时不动它 —— 砍光了会直接播不了。
- 重排编码优先级时**只在同一清晰度内部调整**，绝不改变 B 站原有的清晰度顺序。

#### 自动判断要不要干预（v1.2.0 起）

**上面这一整套只对没有 AV1 硬解的机器有意义。** 有 AV1 硬解的机器（RTX 40/50 系、Intel Arc、较新核显、M3 及以后）剔除 AV1 反而是**倒退** —— 等于放弃压缩率更高的编码去换 HEVC，同画质更费带宽，还白白掉画质。

所以编码模块是**三态**，默认 `auto`：

| 模式 | 行为 |
| --- | --- |
| **自动**（默认） | 用 `mediaCapabilities.decodingInfo()` 探测本机 AV1 是否 `powerEfficient`，有硬解就完全不干预，无硬解才剔除 |
| 强制开 | 无条件剔除 AV1 |
| 强制关 | 完全不碰编码，只保留 CDN 加速 |

HUD 上点击「编码模块」一行轮换三态。探测结果缓存在 `localStorage`，同时绑定当前浏览器环境并在 **30 天后自动过期**；浏览器环境变化也会重探。换显卡或升级驱动后不想等过期，可跑 `__biliBoost.重新探测AV1()` 立即刷新。

> **探测失败时一律按"无硬解"处理**（也就是剔除 AV1）。这是有意的不对称：误判成有硬解，会让软解机器发烫掉帧（后果重）；误判成无硬解，只是多费点带宽（后果轻）。不确定时选后果轻的那边。
>
> 探测带 3 秒超时 —— 实测 `decodingInfo()` 在某些环境下会永远不 resolve。超时按"未知"处理，下次再探，**绝不按机型名或 UA 猜**。

---

## 安装

需要一个用户脚本管理器。

### Chrome / Edge / Firefox

Tampermonkey 或 Violentmonkey，新建脚本粘贴 `bili-boost.user.js` 即可。脚本带 `@updateURL`，之后会自动检查更新。

### Safari

Safari 没有油猴。用 App Store 上免费的 [Userscripts](https://apps.apple.com/app/userscripts/id1463298887)（quoid）：

1. 装好后打开 Userscripts.app，设置一个 **save location** 目录（会弹授权框，选 Allow）
2. 把 `bili-boost.user.js` 放进该目录
3. Safari → Settings → Extensions → 勾选 Userscripts
4. 点工具栏的 Userscripts 图标 → **Always Allow on Every Website**
   （分片走 `*.bilivideo.com`，只给 bilibili.com 授权不够）

> 编辑器页面右侧显示 `No Item Selected` 是正常的占位文案，只表示你还没点左侧列表里的脚本。真正表示没找到脚本的文案是 `No valid files found in directory`。

**Safari 的两个注意点**（都已实测）：

- 脚本必须同时带 `@grant none` 和 `@inject-into page`。Userscripts 对 `@grant none` 的默认处理**和 Tampermonkey 相反** —— 它会注入到 content 隔离世界，那样劫持 `fetch` / `MediaSource` / `__playinfo__` 对页面**全部无效**。`@inject-into page` 才能把它拉回页面世界。
- CSS 里 `backdrop-filter` 在 Safari 必须写 `-webkit-backdrop-filter`，否则静默不生效。

---

## 看它有没有在工作

右下角常驻一个小面板：

```
08c · 实测 834 KB/s · TTFB 86ms · 卡顿 0
🟢 硬解 · HEVC/H.265
```

第一行的「实测」是播放器真实拉流的**净吞吐**，TTFB 是首字节延迟；两者都取当前源最近 6 个分片的中位数，比任何探测值都可信。**只要吞吐明显高于码率、TTFB 不离谱且卡顿是 0，就说明选源是对的** —— 是不是全网第一名并不重要。

第二行的硬解状态不是靠编码名猜的：

| 显示 | 含义 |
| --- | --- |
| 🟢 硬解 | `decodingInfo().powerEfficient === true` |
| 🔴 软解 | `powerEfficient === false`，正在烧 CPU |
| ⏳ 检测中 | 能力查询还没返回 |
| ⚪ 无法判定硬解 · 原因 | 不做断言，并写明原因（不支持 mediaCapabilities、查询超时、没拿到 playurl、分片没对上 playurl……） |

编码优先取 `addSourceBuffer` 的 MIME；Safari/Userscripts 注入晚、钩子拿不到时，按分片路径对上 playurl 里的流来判定（HUD 标「据分片」）。`decodingInfo` 依次试 media-source → hev1 换 hvc1（WebKit 常不认 hev1）→ file。所有源都跟不上码率时，HUD 第二行会出现「⚠️ 所有源都 < 1.2×码率」。

点击面板展开明细：

```
测速(开播) · 精测=头部+播放前方，显示有效速度（与真实分片融合）/TTFB
✅ 08c       762 KB/s ·   72ms 融合3片实测 · 精测(头+前方)
   ↳ 头 901KB/s/61ms · 前方 812KB/s/72ms
   hw        690 KB/s ·   91ms 精测(头+前方)
   ↳ 头 780KB/s/91ms · 前方 825KB/s/74ms
原 cosov     172 KB/s ·   90ms 融合3片实测 · 头部疑似缓存(80×)，按前方计
   ↳ 头 47108KB/s/88ms · 前方 590KB/s/90ms
   ali       340 KB/s ·  102ms 快筛
点击蓝色源可手动切线
码率：需 290 KB/s（1.2× = 348）
跟不上码率时自动降一档：关（点击切换）
──────────────────────────────
编码：HEVC/H.265 · powerEfficient：true
已剔除 AV1：2 条
B站提供：AVC/H.264 / HEVC/H.265 / AV1
编码偏好：H.265（点击切换）
HUD：开（点击关闭）
```

标 `快筛` 的数字只有 128KB，用来淘汰死源/慢源；精测行取头部与前方中较差的表现（判为头部缓存时只看前方）。数字是有效速度，有真实分片时显示融合值。点蓝色源会立刻手选，面板随后出现「恢复自动测速」。

---

## 控制台接口

页面控制台里敲 `__biliBoost`（`__biliCdn` 是等价别名，为兼容旧版保留）：

```js
__biliBoost.当前源        // 当前生效的镜像
__biliBoost.手动源        // 当前手选镜像；自动模式为 null
__biliBoost.实测速度      // 当前源最近 6 个分片的净吞吐中位数
__biliBoost.首字节延迟    // 当前源最近 6 个分片的 TTFB 中位数
__biliBoost.分片明细      // 每片的 host / fetch|xhr / 净吞吐 / TTFB
__biliBoost.测速结果      // 完整测速明细，含头部/中段点与快筛标记
__biliBoost.卡顿次数      // 只计通过 1.2 秒确认的卡顿
__biliBoost.黑名单        // 被 403 / 连不上淘汰的源
__biliBoost.冲突          // 旧版脚本冲突详情；无冲突时为 null
__biliBoost.主机健康      // 各镜像成功率、均速与 TTFB（跨会话累计）
__biliBoost.编码模块      // 当前三态及自动判断结果
__biliBoost.AV1硬解       // 本机 AV1 硬解探测结论
__biliBoost.真实速度      // v1.7：各源本媒体真实分片有效速度中位数、样本数、连续低于码率片数
__biliBoost.切源记录      // v1.7：自动切源时间/原因（最近 8 次）
__biliBoost.滞回状态      // v1.7：最近一次被滞回/限频挡下的切源及原因；无则 null
__biliBoost.码率          // v1.7：当前需求 KB/s、是否告警、自动降档开关
__biliBoost.自动降档(true) // v1.7：所有源跟不上码率时自动降一档（默认 false，只提示）
__biliBoost.编码检测      // v1.7：编码、来源（SourceBuffer / 分片匹配 playurl）、硬解、判定不了的原因
__biliBoost.重测()        // 退出手选并重新测速
__biliBoost.手动选源('upos-sz-mirror08c.bilivideo.com')
__biliBoost.自动选源()    // 退出手选并恢复自动测速
__biliBoost.面板(false)   // 关掉右下角 HUD
__biliBoost.编码模块开关('auto')  // 'auto' / true / false
__biliBoost.重新探测AV1() // 换显卡或升驱动后刷新硬解判断
__biliBoost.清空主机健康()
```

---

## 配置

编码偏好和 HUD 开关在面板展开态里点击切换。测速参数在脚本顶部：

| 项 | 默认 | 说明 |
| --- | --- | --- |
| `CANDIDATES` | 6 个镜像 | 只合成同族 bilivideo host；原始 host 另行加入 |
| `QUICK_BYTES` | 128KB | 阶段1 每个候选的探测量 |
| `FULL_BYTES` | 768KB | 阶段2 每源总精测量，均分给头部/中段 |
| `MID_RANGE_OFFSET` | 1MB | 文件太小、无法取前方点时的旧中段偏移 |
| `FALLBACK_AHEAD_OFFSET` | 4MB | 还不知道播放器读到哪时的前方测速点 |
| `HEAD_CACHE_RATIO` | 5 | 头/前方速度比超过即判头部缓存命中 |
| `FINALISTS` | 3 | 进入精测的候选数 |
| `MIN_GAIN` | 1.25 | 融合交付时间至少改善多少才离开在用源 |
| `HYSTERESIS_SEGMENTS` | 3 | 滞回：旧源连续 N 片低于码率 / 新源连续 N 片更快 |
| `SWITCH_MIN_INTERVAL` | 60s | 同一视频两次自动切源的最小间隔 |
| `RETEST_COOLDOWN` | 45s | 补测与上一轮测速的最小间隔 |
| `PROBE_BUFFER_MIN` | 15s | 播放中前向缓冲低于此值禁止一切探测 |
| `PROBE_ROUND_MAX` | 90s | 整轮测速看门狗 |
| `BITRATE_HEADROOM` | 1.2 | 所有源低于「码率×此值」时提示 |
| `STALL_CONFIRM_MS` | 1.2s | waiting/stalled 保持多久才确认 |
| `CACHE_TTL` | 30min | 测速结果缓存时长 |
| `HEALTH_RATIO_DELTA` | 0.15 | 成功率分档宽度 |
| `HEALTH_MIN_ATTEMPTS` | 3 | 低于此样本数按最好档乐观探索 |
| `HEALTH_MAX_HOSTS` | 32 | 健康档案保留的主机上限 |
| `HEALTH_MAX_AGE` | 7d | 健康档案样本时间上限 |
| `IDLE_MAX_WAIT` | 20s | 精测等缓冲恢复的上限；等不到就放弃精测（不再照跑） |
| `DECODING_INFO_TIMEOUT` | 3s | 硬解能力探测超时 |
| `AV1_HW_CACHE_TTL` | 30d | AV1 硬解结论最长缓存时间 |

**编码偏好**默认 H.265（同画质码率更低）；如果遇到花屏或某台设备 HEVC 硬解有问题，切 H.264 —— 它的硬解兼容性最好。

---

## 哔哩哔哩 Mac 客户端

客户端（v1.17.1）是 **Electron 22 / Chromium 108** 套壳，和 Chrome 面临完全相同的编码问题，实测它的 HEVC 同样硬解、AV1 同样软解。

但客户端**不需要装脚本，也不要改 `app.asar`** —— 它是 Developer ID 签名 + hardened runtime，改包会破坏签名封印，而且会被自动更新还原。

直接用官方 UI：**播放器齿轮 →「播放策略」→ 选 HEVC**。

这个选择存在 `localStorage` 的 `bilibili_player_codec_prefer_type`，重启客户端后保留。已实测：即使服务端把 `default_codec_strategy` 刷回 `["av1","hevc","avc"]`，播放器依然老实用 HEVC，说明用户偏好优先级更高。

---

## 回归测试

```bash
node tools/qa-stall.mjs        # v1.7.0 卡顿优化模拟回归：不开浏览器、不联网，任何平台 1 秒内跑完
node tools/qa-stall.mjs --contrast  # 另用 main 分支旧版跑同场景做对照（需要 git）
./tools/qa-on-win.sh           # 从 Mac 打包到 Win 桌面会话，运行有窗口静音 Chrome（会先跑 qa-stall）
QA_ARGS='--soak-seconds=60' ./tools/qa-on-win.sh  # 完整 QA + 一分钟实播 smoke
QA_TIMEOUT_SECONDS=9000 QA_ARGS='--soak-seconds=7200' ./tools/qa-on-win.sh  # 完整 QA + 两小时实播
```

`qa-stall.mjs` 用 `node:vm` 加载真实脚本，fetch / XHR / `<video>` / 定时器全部模拟、走虚拟时钟，覆盖：头部快中后段慢的源（快筛测的是播放器 Range 之后的区间、头/前方 >5× 判缓存、不选 cosov）；探测命中缓存但真实分片慢时以真实为主；两源每 20 秒交替快慢 6 分钟（两次自动切源间隔 ≥60 秒、播放器分片无 abort 且字节完整）；缓冲 <15 秒时卡顿与 akam 回退都不触发探测、缓冲恢复后补测；Safari 式 abort 不生效时探测按超时收尾并清理 `probing`/controller；全局并发 1；码率提示与可选降档；HUD 与 debug 当前源一致；Safari 无 SourceBuffer 时据分片判定 HEVC 硬解、判断不了时写明原因。`--contrast` 下同一抖动场景旧版 v1.6.0 发 161 次探测（155 次在缓冲不足时）、卡顿 88 次、探测并发峰值 6；v1.7.0 为 2 次 / 0 次 / 7 次 / 1。

`--soak-seconds` 仅接受 1..7200 的整数；不传时保持快速完整 QA，不自动等待两小时。长测沿用同一页面的真实视频循环播放、实际 AV1 能力分支、有窗口静音 Chrome，不刷新文档清空资源。只累计媒体时间正常前进的有效播放时长，暂停、卡住、seek 跳跃不计；B 站 MSE 播放器不认 `video.loop`，短视频/分 P 播完时由事件驱动重播（重播的 seek 不计时），有效播放连续 5 分钟不增长或 video 被替换即判 FAIL；有效播放与墙钟均达到目标才 PASS，两小时场景 8400 秒截止，外层 runner 显式给 9000 秒预算。失败/断连/停播或资源超预算返回非零退出码，不能把缺少成功退出码的运行当成完成。

QA 在 userscript 前安装资源计数器，通过合成源码的行区间和**直接资源申请调用点**归属排除 B 站页面、测试器和被脚本调用的外部助手。记录实际活动 timeout/interval、事件监听（含去重、once、AbortSignal 清理）和已 observe 未 disconnect 的 MutationObserver；WeakMap/WeakRef 避免跟踪器强持有废弃 DOM/XHR，采样前 GC 后读取，峰值也在申请时累计。原 `诊断状态` 仅作为另一份业务状态证据，不替代底层资源计数。

冻结的测试上限为 timeout **48**（fetch 32、单代探测最多 7、七项单例等待/展示定时器、两个收尾位置）、interval **1**、监听 **32**（基础 12、空闲等待 4、metadata 1、最多 7 路 XHR 各 2、DOMContentLoaded 1）、MutationObserver **0**。有限压力操作结束并关闭 HUD 后，稳态须回到 timeout 0、interval 1、监听 11、observer 0；不因失败提高预算。实播每分钟有效播放输出一个 `[soak]` JSON 摘要，含墙钟/有效时长、进度、基线/峰值/末值和预算；原始日志只保存在本机，PR 提供无凭据的数字摘要。

每次 runner 都使用独立的远端目录、计划任务、压缩包和 CDP 端口，可供并行验收；900 秒内未收到原子退出码文件会回显日志并失败，结束后只清理本次进程与文件。测试矩阵（未登录，Windows RTX 5090；本轮执行数字与长测证据见 PR）：

```
PASS     对照组（不注入）          av01... / 实测 AV1 powerEfficient
PASS     编码三态向后兼容           true / false / auto+null
PASS     健康档案旧数据迁移与双上限  v1→v2；32 条 / 7 天裁剪
PASS     AV1 硬解缓存过期           31 天旧值失效并写回新元数据
PASS     普通 UGC 视频页            按实测能力保留 AV1 或改选 HEVC/AVC
PASS     卡顿优化模拟回归（qa-stall）  测速代表性 / 滞回 / 缓冲门控 / 码率 / 编码判定（v1.7.0 新增）
PASS     CDN 模块                   头部+前方（或中段）、TTFB、手选/自动 API
PASS ×2  新增 CDN 候选              08h 可用才自动/手动选，不可用退回原始源
PASS     fetch 实测速与卡顿过滤      Response 语义不变；初始/seek/瞬时 waiting 不误判
PASS     分片热路径微基准           20 万次分类计数一致
PASS ×2  长时播放与媒体切换有界      有/无 AV1 硬解；2000 分片 + 20 次 SPA
PASS     防重复注入                 四个 hook 均未再次包装
PASS     Safari 仅 ManagedMediaSource  iPhone API 形态可完整初始化
PASS     Safari 双全局共享原型去重     两个构造器共用的 hook 只包装一次
PASS ×2  旧版冲突检测               两种注入顺序
PASS ×2  playurl 劫持层（mock）      有硬解保留 AV1；无硬解三通道清除 AV1
PASS     番剧页                     有硬解不干预；无硬解禁止 AV1
PASS     HUD 检查                   实测能力、编码和 auto 策略一致
PASS     资源计数器自测             四类资源创建/释放、故意泄漏检出、外部资源排除
PASS     实播计时反例               暂停/停播/seek/空等不能累计有效播放
PASS ×10 资源压力双能力矩阵         XHR 300 次、fetch 40 路、HUD 100 次、编码/SPA 各 50 次
SKIPPED  多 P 视频切 P              未登录流已内联，无 playurl 请求
SKIPPED  切清晰度                   同上
默认完整 QA：PASS=33 FAIL=0 SKIPPED=2
带实播场景：另增加一项真实播放资源回归（所选秒数）
```

**对照组是最有价值的一条**：不注入脚本时必须拿到 `av01`，并以 `powerEfficient` 的实际结果冻结本机能力分支。测试器在每个候选文档的 Observer 运行前清除编码偏好；只有“干净对照选择 AV1、注入后按实测能力保留 AV1 或改选 HEVC/AVC”的视频才进入场景池。后续外部 UGC/番剧场景遇到导航、网络或 CDP 瞬态错误时，会换全新页面和下一个已验证候选，最多三次，不放宽业务断言。

播放器在未登录时不会发 playurl，所以编码模块的第 3/4 层用 CDP `Fetch` mock 一个含「两档清晰度 × 三种编码」的响应来确定性验证，不依赖 B 站的真实行为。mock 与长时资源用例都分别模拟“有 AV1 硬解”和“无 AV1 硬解”：前者验证 `auto` 原样保留 AV1，后者验证 fetch、XHR text、XHR json 与 `support_formats` 均清除 AV1；资源上限和 `cid/qn/fnval` 状态隔离在两个分支都执行。番剧页没有“服务端一定选择 AV1”的候选前置：有硬解时 AV1/HEVC/AVC 都可接受，但必须处于 `auto` 不干预；无硬解时只允许 HEVC/AVC 且必须显示剔除 AV1。多 P 与切清晰度的真实 UI 用例仍会尝试执行；未登录页面不发新请求或有界发现未找到可播放多 P 时会如实 SKIPPED。

---

## 故障排查

### HUD 提示「旧版 bili-cdn-fix 仍在运行」

这表示旧版脚本仍在另一个脚本管理器中注入，可能造成重复测速、重复改写 CDN 和 HUD 重叠。请分别检查 **Userscripts**、**AdGuard → Extensions**、**Tampermonkey**，禁用或删除 `bili-cdn-fix`；只保留 `bili-boost`，然后完整刷新 B 站页面。新版会隐藏旧 HUD 以免遮挡，但不会尝试拆除旧版已安装的请求 hook。

---

## 已知局限

### CDN 模块

- **有探测流量成本**。全部候选可用时每个新视频约 3MB（快筛约 0.6～0.8MB + 三个 finalist 各 768KB）；死源或短文件会更少。前方测速点下载的正是播放器接下来要拉的字节，会顺带预热 CDN，但本地并不复用。嫌多就调小 `QUICK_BYTES` / `FULL_BYTES`，或减少 `CANDIDATES`。
- 测速结果按视频缓存 30 分钟，期间网络变化不会主动重新评估；确认卡顿只按已有数据切源，缓冲恢复后才补测。
- 快筛串行后，开播那一轮若播放已经开始且缓冲 <15 秒，会提前收工、按已测到的源和真实分片决策，等缓冲恢复再补测；首个视频开播的头几秒可能还在原始源上。
- 前方测速点依赖单段 HTTP Range，以及能从播放器请求里读到 `Range` 请求头；不支持 Range 或 Range 签名受限时会退回头部精测，因此无法识别该 host 的“头快中慢”（但真实分片融合与滞回仍会兜底）。
- 码率按分片路径对上 playurl；首屏 playurl 若早于脚本注入（Safari/Userscripts 偶发）就拿不到，此时按约 1080P 的 400KB/s 估算，且编码改由 SourceBuffer 判定。自动降档依赖播放器的 `window.player.requestQuality`，未暴露时只提示。
- fetch 实测速通过 `Response.clone()` 的流式观测分支完成，不会重复下载；观测分支限 30 秒/32MB。极端超大或超慢分片只记录截断样本。
- `waiting` / `stalled` 已过滤初始加载、seek、切清晰度和瞬时恢复，但浏览器没有“CDN 真卡”的权威事件，极端播放器状态仍可能误判或漏判。
- 只处理 `.m4s` / `.mp4` / `.flv` 分片请求，走 PCDN（`mcdn.bilivideo.cn`）的流量不在范围内。
- 各镜像的快慢与地理位置强相关，`CANDIDATES` 基于海外网络实测，国内用户结果会完全不同。
- 脚本不再主动合成 Akamai host；播放器原本下发的 Akamai 地址仍会参与，但其内容签名可能返回 403。

### 编码模块

- **播放器版本升级会重置一次偏好**。源码里的逻辑是：
  ```js
  getLocalStorage("bilibili_player_codec_prefer_reset") !== "1.5.2"  // 不等就重置
  ```
  版本号变了，你的编码选择会被清回「默认」。浏览器端因为脚本每次加载都会重设，可以自愈；**客户端需要手动再选一次 HEVC**。
- HEVC 比 AVC 同画质码率更低，但极少数老视频可能没有 HEVC 源，此时会自动落到 AVC。
- 只有 AV1 一条流的视频不做处理（见上文安全阀），这种视频仍然是软解。
- AV1 硬解缓存最多可能在硬件/驱动变化后陈旧 30 天；可用 `重新探测AV1()` 立即失效。探测失败仍保持 `null` 并在下次加载重试。
- M3 及以后的 Apple 芯片有 AV1 硬解，自动模式探测成功后会关闭编码干预。

### 共同

- **自动化回归是未登录跑的**，只能到 480P；多 P/清晰度的状态隔离已有确定性模拟，但真实 UI 流程仍可能因页面不发 playurl 而 SKIPPED。登录态 **1080P 已在 Safari 手动实测通过**（HEVC 硬解、CDN 切源、`__biliCdn` 八个接口齐全）；**4K / 高码率仍未覆盖**，尤其 4K HEVC 在 M2 上的 `powerEfficient` 还没验证过。
- 升级期间若旧的 `bili-cdn-fix` / `bili-hwdecode` 仍启用，会造成重复劫持。脚本会检测 `bili-cdn-fix`、显示告警并隐藏它的 HUD，但不会拆除旧 hook，仍需按上面的故障排查步骤手动禁用。`bili-hwdecode` 的历史版本没有查到可靠的全局名或 HUD id，因此不做猜测性检测。

## License

MIT
