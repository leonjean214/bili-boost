# bili-boost v1.5.0 优化报告

## 1. 长时播放资源审计与修复

审计了用户脚本中所有动态容器、定时器、监听器和异步观测：

- `rejected` / `picked` / `manual`：只属于当前媒体，SPA、分片目录、分 P 或清晰度变化时清空。
- `probing`：媒体切换时清空；旧任务在 `finally` 中安全删除自己的 key。
- `perf`：始终只保留最近 6 片，媒体切换清空。
- `blacklist`：原先跨会话页生命周期内可能随任意原始 host 增长；现改为 LRU 风格最多 64 项。
- `codecState.offered`：现最多检查 64 条流、保存 16 种编码标签。
- 主机健康档案：最多 32 项、7 天，见下一节。
- CDN 探测 `AbortController`：新增活动集合；媒体切换立即 abort 并清空。
- fetch clone 观测器：新增活动集合，最多 32 个；超限取消最旧观测，媒体切换全部取消，完成时自行删除。
- 媒体告警 timer：由每次新增改成单例 timer，重置时清除。
- HUD 折叠 timer：原本已在每次展开前清旧 timer，保持不变。
- `setInterval(syncMediaIdentity, 500)`、document 播放事件监听和 SPA 监听：每个页面只安装一次，防重复注入用例确认不会叠加。
- `MutationObserver`：脚本没有创建。
- XHR `progress/loadend`：`loadend` 为 once，结束时显式移除 `progress`，保持不变。

新增 CDP 确定性回归：模拟 2000 个分片、20 次 SPA 换视频、一次切清晰度和一次切分 P，断言 Map/Set/数组、探测 controller、fetch observer、健康档案和告警 timer 全部有界，并确认媒体态重置。

## 2. 健康档案双上限与迁移

- 存储从旧版裸 host 字典升级为 `{ version: 2, updatedAt, hosts }`。
- 首次读取 v1.3/v1.4 字典时自动迁移，无需用户清存储。
- 每次读取和写入都同时执行：
  - 时间上限：7 天；
  - 条数上限：按最近更新时间保留 32 台主机；
  - 单主机样本上限：24 次，旧样本按成功率等比例衰减。
- 新增回归写入 40 条有效 + 5 条过期旧格式记录，确认迁移后为 v2、恰好 32 条、过期项清除、attempts 不超过 24。

## 3. 多 P / 切清晰度

- 除 URL 路径和 `p/ep_id` 外，现在还跟踪 playurl 的 `bvid/avid/cid/ep_id/qn/fnval`。
- `cid` 变化（分 P）或 `qn/fnval` 变化（清晰度）会建立新媒体代次，清空旧手选源、自动选择、拒绝源、实测样本、测速结果和编码展示状态，并取消旧媒体仍在进行的探测/观测。
- QA 仍优先尝试未登录 Chrome 的真实 UI。本次发现真实 2P 视频，但未登录流已内联，因此真实切 P 和切清晰度均 SKIPPED。
- 另用确定性浏览器内模拟覆盖 `cid/qn/fnval` 变化，确认 generation 增长且旧 `picked/manual` 不污染新媒体。

## 4. 分片热路径

改动前，每个 fetch/XHR 请求都会构造 `URL`，分片判断再对完整 host 和 path 做正则扫描。改动后：

1. 先从原始字符串的末尾（去 query/hash）检查 `.m4s/.mp4/.flv`；
2. 非分片立即返回，不构造 `URL`；
3. 分片才构造 `URL`，host/path 使用 `startsWith/endsWith` 和字符检查，不再跑正则；
4. XHR/fetch 遥测分支复用同一快筛。

Node 微基准：20 万次混合请求分类（90% 非分片），结果计数一致：

- 改动前：54.3ms
- 改动后：14.5ms
- 提升：3.73×

数字会随机器负载波动；QA 不以速度比为易抖动的通过条件，只要求新旧分类结果完全一致，并打印当次耗时。

## 约束检查

- `@version`：1.5.0；`SCRIPT_VERSION`：v1.5.0。
- 未新增依赖。
- 未新增功能性网络请求。
- 用户脚本无 `eval` / `new Function`。
- 保留 Safari Userscripts 所需 `@grant none`、`@inject-into page` 和现有兼容写法。

## 最终回归

- `node --check bili-boost.user.js`：通过。
- `node --check tools/qa-boost.mjs`：通过。
- `node tools/qa-boost.mjs`：PASS=15、FAIL=0、SKIPPED=2。
- `git diff --check`：通过。

两个 SKIPPED 均为未登录播放器复用内联 playinfo、没有发新 playurl；对应状态隔离已由确定性模拟覆盖。
