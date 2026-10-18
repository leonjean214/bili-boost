# bili-boost v1.8.0 执行交接

## 状态

WIN REGRESSION PASSED。草稿 PR #16：https://github.com/leonjean214/bili-boost/pull/16 ，base main，原实现 commit `0b3728d`。Win 恢复后已取得旧版红灯、新版绿灯并完成完整回归；存在明确记录的既有 SKIP，不冒充覆盖。按用户要求保持 Draft，不合并、不关闭 #11–#15，不做 Safari 真机。本轮将交接文件单独纳入版本控制（不改变 .gitignore）。

## 假设

- 当前干净 worktree `feat/manual-probe` 即指定工作目录；基线 `2082c4c`。已 fetch 并确认 `origin/main` 仍为该提交。
- #11–#15 是叠层净差异，按顺序仅取产品、测试与 README/CHANGELOG，不搬运云端日志。
- 连点合并为本轮结束后的一次手动测速，而不是无限排队；自动补测不能覆盖手动排队。
- 「全部候选测速」指所有兼容候选快筛、沿用既有入围源精测，不扩大到 Akamai 跨域族。即使拉黑也可测速展示，但不会据此解禁或自动选用。
- 手动轮绕过低缓冲与 60 秒限频，仍保留评分和有证据时的滞回。清手选/选中/缓存是在真正开始时执行，而不是排队点击时执行。

## 改动

- 逐 PR `gh pr view` / `gh pr diff`，净差异依次取入。#11 证据 TTL、#12 主动切慢源、#13 开播快筛先切、#14 对照兜底、#15 联合长测均仍有效；详细取舍见 `reviews/2026-10-salvage.md`。
- HUD 折叠/展开均常驻「立即测速」「复制诊断 JSON」按钮，32px 最小高度、Safari 防选择文字、带宽提示；复用 `重测()`。
- 手动运行进度、合并排队、自动补测优先级保护；换视频/看门狗清进度。手动完成按评分+滞回选源，无可用源仍保留失败明细。
- 逐源有效速度/TTFB/拉黑状态，按 `currentCdnSource()` 标记，与 debug 当前源同源；展示选择原因。
- `@grant none` / `@inject-into page` / 顶层 HUD 保护保持原样，无依赖、无新增定时器或逐按钮监听。
- 版本元数据与运行态均为 1.8.0，README/CHANGELOG 更新。

## 文件

- `bili-boost.user.js`
- `tools/qa-boost.mjs`：真实 DOM 点击、低缓冲自动不跑/手动跑、连点合并排队、全局串行、逐源结果与当前源一致；模拟有/无 AV1 硬解。`--manual-probe-only` 为定向测试入口。
- `tools/qa-stall.mjs`：抢救场景 10–13，加手动测速场景 14（含换视频清理）。
- `README.md` / `CHANGELOG.md`
- `reviews/2026-10-salvage.md`
- `.ai/HANDOFF.md`（本轮更新验证结果并随提交推送；不改忽略规则）

## 验证

已实际通过（Mac 仅静态，无浏览器）：

- `node --check bili-boost.user.js`
- `node --check tools/qa-boost.mjs`
- `node --check tools/qa-stall.mjs`
- 用 `new Function` 仅编译新增两段 `String.raw` 浏览器 fixture，输出 `manual probe browser fixtures: 2 templates compile (not executed)`。
- `git diff --check`

### Win 恢复后实测（2026-10-17）

1. **旧版 red，预期失败**：备份当前脚本并以 EXIT trap 保证恢复，`git show 2082c4c:bili-boost.user.js > bili-boost.user.js`，保留新版测试；执行 `QA_ARGS='--manual-probe-only' QA_TIMEOUT_SECONDS=240 ./tools/qa-on-win.sh`。退出码 1，**PASS=0 FAIL=2 SKIPPED=0**（4.1s）。两种 AV1 环境均为 `automaticBlocked:true, hasButton:false`，确实命中旧版缺按钮，不是网络失败。
2. **新版 green**：恢复当前脚本后执行同一命令。退出码 0，**PASS=2 FAIL=0 SKIPPED=0**（7.4s）。两种 AV1 环境下 automaticBlocked、controls、progress、queued、manualRan、serial、exactlyTwo、resultsMatch、clean 全部 true。
3. **完整首轮**：`QA_TIMEOUT_SECONDS=1200 node tools/qa-boost.mjs`（自动转交 Win）。退出码 1，**PASS=35 FAIL=1 SKIPPED=2**。唯一失败「新增 CDN 候选（不可用回退）」：旧断言要求全失败时 `测速结果.win === null`，而本版按需求保留失败明细，win 为保持中的原始源。实际 source 仍是原始源、故障候选已拉黑。
4. **修复测试后完整重跑**：同一完整命令，退出码 0，**PASS=36 FAIL=0 SKIPPED=2**（229.1s），其中 qa-stall 为 **PASS=77 FAIL=0 SKIP=4**（1.9s）。定向手动场景也在完整套件再次通过。修正为严格要求 `win === original && allFailed && !precise && source === original && blacklisted`，未放宽资源预算或产品行为。
5. **独立 Win 模拟回归**：将当前脚本和 `tools/qa-stall.mjs` scp 至唯一远端目录 `bili-manual-probe-sim-20261017`，执行 `ssh win-desktop 'node bili-manual-probe-sim-20261017\tools\qa-stall.mjs'`。退出码 0，**PASS=77 FAIL=0 SKIP=4**（1.6s）。结束后清理本任务唯一远端目录。
6. 修复后再次 `node --check` 三份脚本、`git diff --check`，均通过；Mac 未执行测试或打开浏览器。

SKIP 明细：
- 完整浏览器套件 2 项：多 P 视频切 P、切清晰度。未登录仅两档，流已内联在 `__playinfo__`，真实播放器没有重新请求 playurl，按既有策略记 SKIPPED。
- 模拟套件 4 项：场景 10、11、12（两项）的历史对照。Win 暂存目录无 `origin/main / main` 可读取，明确 SKIP；当前版 77 项断言均实际执行通过。新按钮的旧版 red 已单独实际验证，不受这些旧功能对照 SKIP 影响。
- Safari 真机未做，按本轮明确要求留待 Claude。

原始本机会话日志：`/tmp/bili-red-restored.log`、`/tmp/bili-green.log`、`/tmp/bili-full.log`、`/tmp/bili-full-green.log`、`/tmp/bili-stall.log`。持久摘要见 `reviews/2026-10-salvage.md`。

## 首轮阻塞记录（已解除）

- `tailscale status`：win-host 离线，last seen 16h。
- `ssh -o ConnectTimeout=10 win-desktop 'echo ready'`：超时，后续 5 秒重试仍超时。
- `ssh -o ConnectTimeout=10 win-lan 'echo ready'`：192.0.2.10 Host is down。
- `WIN_HOST=win-desktop QA_ARGS=--manual-probe-only QA_TIMEOUT_SECONDS=120 ./tools/qa-on-win.sh`：远端传输阶段等待，工具 45 秒超时，未启动测试；核查没有本任务遗留 qa-on-win/scp 进程。
- 没有改用 Mac、Linux 或云端绕过指定 Win 门禁；没有 GUI/权限弹窗/登录操作。

用户恢复 Win 后已验证 `ssh win-desktop 'echo ready'` 返回 ready；阻塞解除，已按下列计划完成 Win red/green 与完整回归。

## 原续跑计划（1–4 已执行，结果见上）

1. 定向 red：保留当前 `bili-boost.user.js` 备份，用 `git show 2082c4c:bili-boost.user.js` 临时替换脚本，但保留新版 qa-boost。运行 `QA_ARGS='--manual-probe-only' QA_TIMEOUT_SECONDS=240 ./tools/qa-on-win.sh`，应两种 AV1 环境均 FAIL，原因 `hasButton:false`；务必恢复当前实现（用 shell trap 保证恢复），不能提交临时替换。
2. 定向 green：同一命令对当前实现应两个 PASS；每个场景检查 automaticBlocked、controls、progress、queued、manualRan、serial、exactlyTwo、resultsMatch、clean 均 true。
3. 完整：`QA_TIMEOUT_SECONDS=1200 node tools/qa-boost.mjs`（Mac 自动转交 Win；不要设 BILI_BOOST_QA_ALLOW_MAC）。完整包含 qa-stall 场景 1–14 与原有浏览器/资源回归；任何 FAIL 需修复。旧版对照在 Win 无 git 时可能 SKIP，必须记录，不冒充旧版验证成功。
4. 如 B站目标发现先失败，可单独将当前脚本和 `tools/qa-stall.mjs` 按目录结构 scp 到本任务唯一 Win 暂存目录，直接用 Win Node 执行模拟回归；再重试完整 QA。
5. 本任务未要求两小时实播，不伪造此长测。保持既有资源预算。

## Safari 真机验收（Claude 在用户空闲时操作）

1. 安装分支 v1.8.0，禁用旧版冲突脚本。打开 B站视频，确认仅顶层右下一个 HUD，折叠也有测速/复制按钮与带宽提示；点击不会选中文字。
2. 找到播放缓冲不足 15 秒的卡顿时刻（可用网络限速辅助），先观察自动探测被门控；点击「立即测速」，应立即显示阶段和第 k/N 个源，不能因低缓冲停住。
3. 测速中连续点两次：显示已排队，当前轮结束后只多执行一轮，无并发请求；测速最终按钮恢复「立即测速」。
4. 完成后逐源核对有效速度、TTFB、拉黑/拒绝状态；选中标记与 `__biliBoost.当前源` 一致，选择原因可见。手动测不受刚自动切源后的 60 秒限制，但有真实证据的滞回仍可保留旧源。
5. 先手选再测速，确认退出手选；测速中重新手选应保留用户选择。排队过程中换视频/分 P，不能把旧视频结果或排队带到新视频。
6. 点击旁边「复制诊断 JSON」，解析后核对当前源/测速/黑名单与 HUD 一致，不含 URL 签名参数；剪贴板不可用时应有现有兜底提示。
7. 查看页面 iframe（含 /correspond/）不生成第二个 HUD；关闭 HUD、自动恢复缓冲后策略、AV1/HEVC 行为不退化。

## 风险

- Win 运行回归已通过，仍有上述既有 SKIP 和未做的 Safari 真机；按用户要求草稿不转 Ready、不合并。
- #12 在旧测速仍处 3 分钟新鲜期而全局降速时可能每 60 秒试另一个源，直到证据过期；保留 cloud 原防横跳/限频约束。
- 手动低缓冲测速有意抢占部分带宽，已明确提示；黑名单不会因成功测速直接解除。
- README/CHANGELOG 里的旧模拟性能数来自原 cloud PR，不能作为本轮复验结果。
