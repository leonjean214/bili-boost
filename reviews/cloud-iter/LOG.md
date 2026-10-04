# cloud 迭代日志（bili-boost-iter routine）

每轮一节：时间、选题理由、改动、测试命令与输出摘要、遗留与下一轮建议。

## 2026-10-04 00:19 UTC · cloud/iter-20261004-0019（base=main）

**基线**：远端没有未合并的 `cloud/iter-*` PR，从 main（198d548，v1.7.0 + 015a614）起。最近 PR #4/#5/#6 都已经以 merge commit 进入 main，没有 inline 审查意见。#6 的 owner 验收评论（Win QA 35/0/2、Safari 实机卡顿 0）没有遗留待办。

**选题**：候选池第 3 项「403/失效源自动拉黑与半衰期恢复」。
- 现状缺陷 1：真实分片在改写后的源上返回 403/5xx 时，脚本完全没有感知，只能等卡顿确认（1.2 秒）后切走。而卡顿切源还受滞回和 60 秒限频约束，期间播放器的每次重试又被改写回同一个坏源。模拟中旧版 90 秒内 403 共 348 次，播放卡在第 4 秒。
- 现状缺陷 2：黑名单是会话级永久 Set，一次测速失败就整页拉黑。akam 这类「时好时坏」的源再没有机会；B站是 SPA，一个标签页连看几小时很常见。
- 改动范围小，可以完全用模拟测试覆盖，所以选它。

**改动**（`bili-boost.user.js`）：
- `cdnState.blacklist` 改为 `Map(host → {until, strikes, reason, at})`，新增 `isBanned` / `banHost`。禁期首次 2 分钟，到期后 1 小时内再犯就翻倍，封顶 30 分钟，上限 64 个 host（LRU）。手选会立即解禁，但保留失败次数。
- XHR `loadend` 和 fetch 响应上，如果状态为 403/404/410/5xx，且请求是脚本改写过的，就拉黑该源、加入本媒体 rejected、撤掉 picked/manual/会话缓存/全局赢家，并计入主机健康失败样本，同时记一条切源记录。这一步不占 60 秒限频额度，也不 abort 播放器请求。缓冲恢复后按常规门控补测一次。
- 新增 `__biliBoost.黑名单详情`，`黑名单` 仍返回 host 数组（只列禁期内的），qa-boost 用法兼容。
- `.gitignore` 白名单补上 `CHANGELOG.md` 和 `reviews/cloud-iter/*.md`。

**测试**：
- `node --check bili-boost.user.js` / `node --check tools/qa-stall.mjs`：OK；`git diff --check`：OK。
- 改前 `node tools/qa-stall.mjs`：PASS=21 FAIL=0。改后：**PASS=29 FAIL=0**，新增场景 6 共 8 项：403 即时拉黑；回退原始源，失败到成功 1530ms，播放到 88.5s，卡顿 0，abort 0；HUD/debug 一致且切源记录写明原因；计入健康；首次禁 120s 后恢复；禁期 120/240/480/960/1800/1800；长时间无故障后清零；有界。
- 旧版对照（用 main 版脚本跑同一场景）：旧版 403 共 348 次 / 播放到 4s；新版 403 共 1 次 / 播放到 88.5s。
- `node tools/qa-boost.mjs` 没跑：云端访问 bilibili.com 被网络策略拦截（curl 返回 000），而且按 AGENTS.md 浏览器 QA 应在 Win 台式机上跑 `./tools/qa-on-win.sh`。

**遗留 / 下一轮建议**：
- 需要 Win QA 确认 qa-boost 里「08h 返回 503 → 黑名单」用例仍然 PASS（逻辑兼容，但需要实测）。
- 播放器自己回退到 akam backup 时出现的 403 不归脚本处理（我们没改写它）。如需「akam 403 后让播放器少走 akam」，要另行设计。
- 下一轮候选：实播指标闭环（真实分片速度/卡顿写入健康档案作先验），或者诊断 JSON 一键复制。

## 2026-10-04 02:16 UTC · cloud/iter-20261004-0216（叠在 #7 上，base=cloud/iter-20261004-0019）

**基线**：#7（cloud/iter-20261004-0019）未合并，也没有评论或审查意见，本轮从它的分支接着做，叠层深度 2。

**选题**：候选池中的「诊断面板：导出诊断 JSON 一键复制」，也是 #7 建议的下一轮候选之一。
- 现状：用户反馈卡顿时，要在控制台逐个敲 `__biliBoost.测速结果 / 切源记录 / 主机健康 …` 再截图。字段分散，Safari 控制台也不好复制，我们拿到的现场证据常常不完整。
- 直接把 `测速结果` 之类的对象复制出来有隐患：一旦里面带了 upos 分片 URL，就会把签名查询串（upsig/deadline/mid）一起贴出去。
- 另一候选「实播指标闭环」改动面更大，而且要修改健康档案的持久化格式。目前已经叠了一层未合并的改动，本轮先选小而稳、可以完全模拟测试的这项。

**改动**（`bili-boost.user.js`）：
- `buildDiagnostics()`：把版本、页面（只留路径和分 P）、环境（UA/平台/AV1 硬解/编码模块/偏好）、当前源/手动源、实测速度/TTFB、卡顿、诊断状态、真实速度、最近分片、切源记录（ISO 时间）、滞回、测速结果（逐源逐点）、码率、编码检测、B站提供编码、黑名单详情、主机健康、冲突汇总成一个对象。
- 序列化时用 replacer 统一处理：剥掉所有 `http(s)://…?…#…` 的查询串和片段；URL/Map/Set 转成普通值；非有限数转为 null。
- 报告上限 64KB：超长时依次退成紧凑格式、省略健康档案和测速点，最后只留核心字段，任何情况下都是合法 JSON。
- 复制：在点击回调里同步调用 `navigator.clipboard.writeText`，以满足 Safari 的用户手势要求；失败时退回隐藏 textarea 加 `execCommand('copy')`，再失败就把 JSON 打印到控制台。
- HUD：展开视图新增「复制诊断 JSON」，点击后在同一行显示结果，收起时清掉。没有新增定时器或常驻监听，只在既有的 HUD 点击分发里多一个 action。
- 调试接口新增 `__biliBoost.诊断报告`（对象）和 `__biliBoost.复制诊断()`（返回 Promise<提示文本>）。
- README 控制台接口、CHANGELOG「未发布」节已同步。

**测试**：
- `node --check bili-boost.user.js` / `node --check tools/qa-stall.mjs`：OK；`git diff --check`：OK。
- 改前 `node tools/qa-stall.mjs`：PASS=29 FAIL=0。改后：**PASS=36 FAIL=0**，新增场景 7 共 7 项：
  1. 字段齐全，且与 debug 一致；
  2. 不泄露 upsig/mid/vd_source；
  3. 有界：常规 3.4KB；
  4. HUD 点击后剪贴板拿到合法 JSON，HUD 显示「已复制」；
  5. 复制不新增定时器；
  6. 200KB 超长 UA 时仍输出合法 JSON（≤64KB，带「已截断」标记）；
  7. 剪贴板被拒或不存在时打印到控制台并给出提示，收起后反馈不残留。
- 变异验证：把 URL 剥离函数改成原样返回，场景 7「不泄露签名」随即 FAIL，恢复后 PASS。
- `node tools/qa-stall.mjs --contrast`：PASS=36。
- `node tools/qa-boost.mjs` 没跑：浏览器 QA 按 AGENTS.md 只在 Win 台式机上跑，云端也访问不了 bilibili.com。

**遗留 / 下一轮建议**：
- Safari 实机确认：Userscripts `@inject-into page` 下，HUD 点击能否成功写入剪贴板（应该可以，因为调用发生在 click 回调里）。
- 可以考虑在 HUD 折叠态也放一个复制入口；目前只在展开态有，避免误触。
- 下一轮候选：实播指标闭环（真实分片速度/卡顿写入健康档案作先验）。
