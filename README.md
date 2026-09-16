# bili-boost

海外看 B 站，两个毛病经常同时犯：**转圈缓冲**，和**风扇狂转、机器发烫**。

它们的根因完全不同，但都不是你的网或你的机器不行 —— 是 B 站给你的**镜像不够快**，和 B 站给你的**编码你的芯片解不动**。这个油猴脚本一起治。

> 本脚本由 `bili-cdn-switcher` 与 `bili-hwdecode` 合并而来，已替代这两个单功能脚本。如果你装过它们，**请先在脚本管理器里禁用或删除**，否则会重复劫持请求。

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

**两阶段测速** —— 并发测速会互相抢带宽，导致所有源被低估且排名失真，所以排名只信独占带宽的那一轮：

```
阶段1  并发快筛（各 128KB）→ 只用来淘汰死源和极慢源，不作为排名依据
       ↓ 取前 3 名
阶段2  串行精测（各 768KB）→ 一个一个测，独占带宽，768KB 足够跨过 TCP 慢启动
```

**原始 host 参与竞速**。候选要比播放器原本给的地址快 25% 以上才会切走，否则保持不动 —— 因为 Gcore 这类镜像在缓存命中时能跑到几十 MB/s，盲目改写反而会丢掉缓存。

**闭环验证**。探测值只是一瞬间的估计，真正可信的是播放器实际拉流的速度：

- 每个分片下载完都记一次真实速度，取最近 6 片的中位数显示
- 在 `document` 上捕获 `waiting` / `stalled`（媒体事件不冒泡，但捕获阶段仍会经过 document）
- 一旦真卡：当前源加入该视频的拒绝名单 → 清缓存 → 排除它重新测速（45 秒冷却防抖）

所以即使某次探测选错了，也能自我修正。

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

---

## 看它有没有在工作

右下角常驻一个小面板：

```
08c · 实测 834 KB/s · 卡顿 0
🟢 硬解 · HEVC/H.265
```

第一行的「实测」是播放器真实拉流的速度，比任何探测值都可信。**只要它明显高于码率且卡顿是 0，就说明选源是对的** —— 是不是全网第一名并不重要。

第二行的硬解状态是**三态**，不是靠编码名猜的：

| 显示 | 含义 |
| --- | --- |
| 🟢 硬解 | `decodingInfo().powerEfficient === true` |
| 🔴 软解 | `powerEfficient === false`，正在烧 CPU |
| ⚪ 未知 | 能力查询失败，不做断言 |

点击面板展开明细：

```
测速(开播) · 精测为准
✅ 08c       812 KB/s 精测
   ali       780 KB/s 精测
   cosov     215 KB/s 精测
   hw        340 KB/s 快筛
   akam        0 KB/s HTTP 403
──────────────────────────────
编码：HEVC/H.265 · powerEfficient：true
已剔除 AV1：2 条
B站提供：AVC/H.264 / HEVC/H.265 / AV1
编码偏好：H.265（点击切换）
HUD：开（点击关闭）
```

标 `快筛` 的数字**不要当真**，那一轮是并发跑的，只用来判断"活着还是死了"。

想验证得更硬一点：开着面板把进度条拖到视频中后段，那里各 CDN 大概率都没缓存，最能反映真实回源能力。

---

## 控制台接口

页面控制台里敲 `__biliBoost`（`__biliCdn` 是等价别名，为兼容旧版保留）：

```js
__biliBoost.当前源        // 当前生效的镜像
__biliBoost.实测速度      // 最近 6 个分片的中位数
__biliBoost.分片明细      // 每片的 host 和速度
__biliBoost.测速结果      // 完整测速明细，含精测/快筛标记
__biliBoost.卡顿次数
__biliBoost.黑名单        // 被 403 / 连不上淘汰的源
__biliBoost.重测()        // 手动重新测速
__biliBoost.面板(false)   // 关掉右下角 HUD
```

---

## 配置

编码偏好和 HUD 开关在面板展开态里点击切换。测速参数在脚本顶部：

| 项 | 默认 | 说明 |
| --- | --- | --- |
| `CANDIDATES` | 6 个镜像 | 候选池，可增删 |
| `QUICK_BYTES` | 128KB | 阶段1 每个候选的探测量 |
| `FULL_BYTES` | 768KB | 阶段2 精测量，调小会低估快源 |
| `FINALISTS` | 3 | 进入精测的候选数 |
| `MIN_GAIN` | 1.25 | 比原 host 快多少才切 |
| `RETEST_COOLDOWN` | 45s | 卡顿触发重测的冷却 |
| `CACHE_TTL` | 30min | 测速结果缓存时长 |

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
node tools/qa-boost.mjs        # 默认端口 9333，可用 BHW_QA_PORT 覆盖
```

会起一个独立 profile 的 Chrome，跑完自动清理。当前结果（未登录，M2 / Chrome 152）：

```
PASS     对照组（不注入）        av01...            powerEfficient=false
PASS     普通 UGC 视频页          hvc1.1.6.L120.90   powerEfficient=true
PASS     CDN 模块                 cosov · 测速条目=6 · 实测 590 KB/s
PASS     防重复注入               HUD 仍为一个，四个 hook 均未再次包装
PASS     playurl 劫持层（mock）   HEVC/80, AVC/80, HEVC/32, AVC/32
PASS     番剧页                   hvc1.1.6.L120.90   powerEfficient=true
PASS     HUD 检查                 🟢 硬解 · HEVC/H.265
SKIPPED  多 P 视频切 P            未登录只有两档，流已内联，无需重新请求 playurl
SKIPPED  切清晰度                 同上
```

**对照组是最有价值的一条**：不注入脚本时拿到的是 `av01` 且 `powerEfficient=false`，反证了测试本身有区分度。

播放器在未登录时不会发 playurl，所以编码模块的第 3/4 层用 CDP `Fetch` mock 一个含「两档清晰度 × 三种编码」的响应来确定性验证，不依赖 B 站的真实行为。

---

## 已知局限

### CDN 模块

- **有探测流量成本**。每个新视频约 1.5～2.5MB 额外下载。嫌多就调小 `QUICK_BYTES` / `FULL_BYTES`，或减少 `CANDIDATES`。
- 测速结果按视频缓存 30 分钟，期间网络变化不会重新评估（但卡顿仍会触发重测）。
- 只处理 `.m4s` / `.mp4` / `.flv` 分片请求，走 PCDN（`mcdn.bilivideo.cn`）的流量不在范围内。
- 各镜像的快慢与地理位置强相关，`CANDIDATES` 里的顺序和注释基于海外网络实测，国内用户结果会完全不同。
- 镜像对特定内容可能返回 403（Akamai 尤其常见），脚本会自动拉黑，属正常现象。

### 编码模块

- **播放器版本升级会重置一次偏好**。源码里的逻辑是：
  ```js
  getLocalStorage("bilibili_player_codec_prefer_reset") !== "1.5.2"  // 不等就重置
  ```
  版本号变了，你的编码选择会被清回「默认」。浏览器端因为脚本每次加载都会重设，可以自愈；**客户端需要手动再选一次 HEVC**。
- HEVC 比 AVC 同画质码率更低，但极少数老视频可能没有 HEVC 源，此时会自动落到 AVC。
- 只有 AV1 一条流的视频不做处理（见上文安全阀），这种视频仍然是软解。
- M3 及以后的 Apple 芯片有 AV1 硬解，那些机器上这个模块没有必要。

### 共同

- **登录态没有覆盖**。上面的回归是未登录跑的，只能到 480P；1080P / 4K / 高码率下的表现、以及 4K HEVC 在 M2 上的 `powerEfficient` 都还没验证过。
- 升级期间若旧的 `bili-cdn-fix` / `bili-hwdecode` 仍启用，会造成重复劫持。脚本自带安装标记只能防自己重复注入，**管不到旧版**，请手动禁用。

## License

MIT
