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
