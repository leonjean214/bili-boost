# bili-cdn-switcher

海外看 B 站频繁转圈缓冲？多半不是你的网慢，而是**播放器分配给你的 CDN 镜像不够快**。

这个油猴脚本在每个视频开播时实测多个 upos 镜像的真实下载速度，把分片请求改写到最快的那个；播放过程中再用真实分片速度和卡顿事件持续验证，**卡了就自动换源并记住坏源**。

## 问题是什么

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

## 工作原理

**两阶段测速**——并发测速会互相抢带宽，导致所有源被低估且排名失真，所以排名只信独占带宽的那一轮：

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

## 安装

需要一个用户脚本管理器。

### Safari

Safari 没有油猴。用 App Store 上免费的 [Userscripts](https://apps.apple.com/app/userscripts/id1463298887)（quoid）：

1. 装好后打开 Userscripts.app，设置一个 **save location** 目录（会弹授权框，选 Allow）
2. 把 `bili-cdn-fix.user.js` 放进该目录
3. Safari → Settings → Extensions → 勾选 Userscripts
4. 点工具栏的 Userscripts 图标 → **Always Allow on Every Website**
   （分片走 `*.bilivideo.com`，只给 bilibili.com 授权不够）

> 编辑器页面右侧显示 `No Item Selected` 是正常的占位文案，只表示你还没点左侧列表里的脚本。真正表示没找到脚本的文案是 `No valid files found in directory`。

### Chrome / Edge / Firefox

Tampermonkey 或 Violentmonkey，新建脚本粘贴进去即可。脚本带 `@updateURL`，之后会自动检查更新。

## 看它有没有在工作

右下角常驻一个小条：

```
08c · 实测 834 KB/s · 卡顿 0
```

这个"实测"是播放器真实拉流的速度，比任何探测值都可信。**只要它明显高于码率且卡顿是 0，就说明选择是对的** —— 是不是全网第一名并不重要。

测速完成时会展开明细，每行末尾标着来源：

```
测速(开播) · 精测为准
✅ 08c       812 KB/s 精测
   ali       780 KB/s 精测
   cosov     215 KB/s 精测
   hw        340 KB/s 快筛
   akam        0 KB/s HTTP 403
```

标 `快筛` 的数字**不要当真**，那一轮是并发跑的，只用来判断"活着还是死了"。

## 控制台接口

页面控制台里敲 `__biliCdn`：

```js
__biliCdn.当前源        // 当前生效的镜像
__biliCdn.实测速度      // 最近 6 个分片的中位数
__biliCdn.分片明细      // 每片的 host 和速度
__biliCdn.测速结果      // 完整测速明细，含精测/快筛标记
__biliCdn.卡顿次数
__biliCdn.黑名单        // 被 403 / 连不上淘汰的源
__biliCdn.重测()        // 手动重新测速
__biliCdn.面板(false)   // 关掉右下角 HUD
```

想验证得更硬一点：开着 HUD 把进度条拖到视频中后段，那里各 CDN 大概率都没缓存，最能反映真实回源能力。

## 配置

脚本顶部：

| 项 | 默认 | 说明 |
| --- | --- | --- |
| `CANDIDATES` | 6 个镜像 | 候选池，可增删 |
| `QUICK_BYTES` | 128KB | 阶段1 每个候选的探测量 |
| `FULL_BYTES` | 768KB | 阶段2 精测量，调小会低估快源 |
| `FINALISTS` | 3 | 进入精测的候选数 |
| `MIN_GAIN` | 1.25 | 比原 host 快多少才切 |
| `RETEST_COOLDOWN` | 45s | 卡顿触发重测的冷却 |
| `CACHE_TTL` | 30min | 测速结果缓存时长 |

## 已知局限

- **有探测流量成本**。每个新视频约 1.5～2.5MB 额外下载。嫌多就调小 `QUICK_BYTES` / `FULL_BYTES`，或减少 `CANDIDATES`。
- 测速结果按视频缓存 30 分钟，期间网络变化不会重新评估（但卡顿仍会触发重测）。
- 只处理 `.m4s` / `.mp4` / `.flv` 分片请求，走 PCDN（`mcdn.bilivideo.cn`）的流量不在范围内。
- 各镜像的快慢与地理位置强相关，`CANDIDATES` 里的顺序和注释基于海外网络实测，国内用户结果会完全不同。
- 镜像对特定内容可能返回 403（Akamai 尤其常见），脚本会自动拉黑，属正常现象。

## License

MIT
