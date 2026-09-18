# bili-boost

海外看 B 站，两个毛病经常同时犯：**转圈缓冲**，和**风扇狂转、机器发烫**。

它们的根因完全不同，但都不是你的网或你的机器不行 —— 是 B 站给你的**镜像不够快**，和 B 站给你的**编码你的芯片解不动**。这个油猴脚本一起治。

**[👉 点此安装](https://raw.githubusercontent.com/leonjean214/bili-boost/main/bili-boost.user.js)**（需先装 Tampermonkey 等脚本管理器，见下方[安装](#安装)）

> 本脚本由 `bili-cdn-fix`（CDN 测速切源）与 `bili-hwdecode`（强制硬解编码）两个单功能脚本合并而来，已替代它们。如果你装过其中任何一个，**请先在脚本管理器里禁用或删除**，否则会重复劫持请求、重复测速、出现多个 HUD。
>
> 仓库原名 `bili-cdn-switcher`，合并后改名为 `bili-boost`。GitHub 会自动重定向旧链接。

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

**两阶段、多点测速** —— 并发测速会互相抢带宽，导致所有源被低估且排名失真，所以最终排名只信独占带宽的精测：

```
阶段1  并发快筛（各 128KB）→ 只淘汰死源和极慢源
       ↓ 取前 3 名
阶段2  串行精测（每源共 768KB）
       ├─ 文件头 384KB
       └─ 1MB 偏移处 Range 384KB
```

头部快、中段慢是 CDN 缓存命中后回源不稳的典型表现；精测取两个位置里较差的交付表现，不再只看文件头。若某个服务端不支持单段 Range，则明确标注并退回头部结果，不会仅因诊断能力缺失把可播放源拉黑。

每次测速同时拆出两个指标：**TTFB（首字节延迟）**和**净传输吞吐**。同一健康档内按“TTFB + 传输一个标准 768KB 样本所需时间”排序，而不是把首字节等待藏在一个速度数字里。

**原始 host 参与竞速**。候选的估算交付时间至少好 25% 才会切走，否则保持不动 —— 因为 Gcore 这类镜像在缓存命中时能跑到几十 MB/s，盲目改写反而会丢掉缓存。

**不合成跨供应商 Akamai 地址**。`akamaized.net` 的签名可能绑定 host，把 `bilivideo.com` URL 只换成 Akamai 常见 403，所以候选池只放同族 `bilivideo.com` 镜像；如果播放器原地址本来就是 Akamai，它仍会作为原始源测速，但不会和另一域族互改。

**闭环验证**。探测值只是一瞬间的估计，真正可信的是播放器实际拉流的速度：

- XHR 分片用 `progress/loadend` 统计；fetch 分片流式读取 `Response.clone()` 的观测分支，**不重复发网络请求，也不替换播放器拿到的原 Response**
- 只显示当前源最近 6 片的净吞吐与 TTFB 中位数，切源后不混入旧源样本
- `waiting` / `stalled` 不再立即算卡顿：主动 seek、初始加载、playurl/SourceBuffer 切换有静默期，还要确认 1.2 秒内播放时间没前进、缓冲不足且 `readyState` 未恢复
- 确认真卡后：当前源加入该视频的拒绝名单 → 清缓存/解除手选 → 排除它重新测速（45 秒冷却防抖）

所以即使某次探测选错了，也能自我修正；展开 HUD 还可点击测速列表里的任一蓝色源（包括自动判失败但你想强试的源）手动切线，并随时恢复自动。

**跨会话健康档案**（v1.3.0 起）。单看速度会选中"忽快忽慢"的源 —— 一台 70% 时候飞快、30% 超时的镜像，体验差于一台始终中等的。脚本把每台主机的成败、净吞吐与 TTFB 记在 `localStorage`：

```
排序键（严格全序）：本轮是否成功 → 成功率分档(每 15% 一档) → 估算交付时间 → TTFB → host
```

- 样本少于 3 次先按最好档处理（乐观探索），每轮快筛都在累积样本，很快就会落到真实分档
- **本轮失败或超时截断的源不算成功**，也不能靠历史成功率当赢家
- 最多保留 32 台主机、7 天过期、样本到 24 后衰减 —— 防止陈年统计支配当前网络

**精测挂在空闲后面**。精测要下 2MB+，播放中做等于跟正片抢带宽，本身就可能造成卡顿。所以精测前先等播放器缓冲覆盖当前播放点 12 秒以上、或暂停；等不到最多等 8 秒就照跑。**快筛不等** —— 开播那一刻正是最需要选对源的时候。卡顿触发的重测也不等，那时本来就没在放。

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

第二行的硬解状态是**三态**，不是靠编码名猜的：

| 显示 | 含义 |
| --- | --- |
| 🟢 硬解 | `decodingInfo().powerEfficient === true` |
| 🔴 软解 | `powerEfficient === false`，正在烧 CPU |
| ⚪ 未知 | 能力查询失败，不做断言 |

点击面板展开明细：

```
测速(开播) · 精测=头部+1MB中段，显示净吞吐/TTFB
✅ 08c       812 KB/s ·   72ms 精测(头+中)
   ↳ 头 901KB/s/61ms · 中 812KB/s/72ms
   ali       780 KB/s ·   91ms 精测(头+中)
   ↳ 头 780KB/s/91ms · 中 825KB/s/74ms
   cosov     215 KB/s ·  184ms 精测(头+中)
   hw        340 KB/s ·  102ms 快筛
点击蓝色源可手动切线
──────────────────────────────
编码：HEVC/H.265 · powerEfficient：true
已剔除 AV1：2 条
B站提供：AVC/H.264 / HEVC/H.265 / AV1
编码偏好：H.265（点击切换）
HUD：开（点击关闭）
```

标 `快筛` 的数字**不要当真**，那一轮是并发跑的，只用来判断"活着还是死了"。精测行取头部与中段中较差的表现；点蓝色源会立刻手选，面板随后出现「恢复自动测速」。

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
| `CANDIDATES` | 5 个镜像 | 只合成同族 bilivideo host；原始 host 另行加入 |
| `QUICK_BYTES` | 128KB | 阶段1 每个候选的探测量 |
| `FULL_BYTES` | 768KB | 阶段2 每源总精测量，均分给头部/中段 |
| `MID_RANGE_OFFSET` | 1MB | 中段 Range 的起始偏移 |
| `FINALISTS` | 3 | 进入精测的候选数 |
| `MIN_GAIN` | 1.25 | 估算交付时间至少改善多少才离开原 host |
| `RETEST_COOLDOWN` | 45s | 确认卡顿后触发重测的冷却 |
| `STALL_CONFIRM_MS` | 1.2s | waiting/stalled 保持多久才确认 |
| `CACHE_TTL` | 30min | 测速结果缓存时长 |
| `HEALTH_RATIO_DELTA` | 0.15 | 成功率分档宽度 |
| `HEALTH_MIN_ATTEMPTS` | 3 | 低于此样本数按最好档乐观探索 |
| `HEALTH_MAX_HOSTS` | 32 | 健康档案保留的主机上限 |
| `IDLE_BUFFER_SEC` | 12s | 精测要求的缓冲余量 |
| `IDLE_MAX_WAIT` | 8s | 等不到空闲也照跑的上限 |
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
node tools/qa-boost.mjs        # 默认端口 9333，可用 BILI_BOOST_QA_PORT 覆盖
```

会起一个独立 profile 的 Chrome，跑完自动清理。当前结果（未登录，M2 / Chrome 152）：

```
PASS     对照组（不注入）          av01... / powerEfficient=false
PASS     编码三态向后兼容           true / false / auto+null
PASS     AV1 硬解缓存过期           31 天旧值失效并写回新元数据
PASS     普通 UGC 视频页            hvc1... / powerEfficient=true
PASS     CDN 模块                   头部+中段、TTFB、手选/自动 API
PASS     fetch 实测速与卡顿过滤      Response 语义不变；初始/seek/瞬时 waiting 不误判
PASS     防重复注入                 四个 hook 均未再次包装
PASS ×2  旧版冲突检测               两种注入顺序
PASS     playurl 劫持层（mock）      fetch / XHR text / XHR json
PASS     番剧页                     avc1... / powerEfficient=true
PASS     HUD 检查                   🟢 硬解 · HEVC/H.265
SKIPPED  多 P 视频切 P              未登录流已内联，无 playurl 请求
SKIPPED  切清晰度                   同上
总计：PASS=12 FAIL=0 SKIPPED=2
```

**对照组是最有价值的一条**：不注入脚本时拿到的是 `av01` 且 `powerEfficient=false`，反证了测试本身有区分度。

播放器在未登录时不会发 playurl，所以编码模块的第 3/4 层用 CDP `Fetch` mock 一个含「两档清晰度 × 三种编码」的响应来确定性验证，不依赖 B 站的真实行为。

---

## 故障排查

### HUD 提示「旧版 bili-cdn-fix 仍在运行」

这表示旧版脚本仍在另一个脚本管理器中注入，可能造成重复测速、重复改写 CDN 和 HUD 重叠。请分别检查 **Userscripts**、**AdGuard → Extensions**、**Tampermonkey**，禁用或删除 `bili-cdn-fix`；只保留 `bili-boost`，然后完整刷新 B 站页面。新版会隐藏旧 HUD 以免遮挡，但不会尝试拆除旧版已安装的请求 hook。

---

## 已知局限

### CDN 模块

- **有探测流量成本**。全部候选可用时每个新视频约 3MB（快筛约 0.6～0.8MB + 三个 finalist 各 768KB）；死源或短文件会更少。嫌多就调小 `QUICK_BYTES` / `FULL_BYTES`，或减少 `CANDIDATES`。
- 测速结果按视频缓存 30 分钟，期间网络变化不会主动重新评估（但确认卡顿仍会触发重测）。
- 中段探测依赖单段 HTTP Range；不支持 Range 或 Range 签名受限时会退回头部精测，因此无法识别该 host 的“头快中慢”。
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

- **自动化回归是未登录跑的**，只能到 480P。登录态 **1080P 已在 Safari 手动实测通过**（HEVC 硬解、CDN 切源、`__biliCdn` 八个接口齐全）；**4K / 高码率仍未覆盖**，尤其 4K HEVC 在 M2 上的 `powerEfficient` 还没验证过。
- 升级期间若旧的 `bili-cdn-fix` / `bili-hwdecode` 仍启用，会造成重复劫持。脚本会检测 `bili-cdn-fix`、显示告警并隐藏它的 HUD，但不会拆除旧 hook，仍需按上面的故障排查步骤手动禁用。`bili-hwdecode` 的历史版本没有查到可靠的全局名或 HUD id，因此不做猜测性检测。

## License

MIT
