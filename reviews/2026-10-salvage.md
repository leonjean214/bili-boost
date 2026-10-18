# 2026-10：cloud PR #11–#15 抢救（v1.8.0）

## 方法与基线

基线 `origin/main = 2082c4c`（v1.7.0），工作分支 `feat/manual-probe`。
逐个执行 `gh pr view <n>`、`gh pr diff <n>`，确认五个 PR 均 OPEN，且为叠层净差异；按 #11 → #15 顺序应用产品脚本、测试与 README/CHANGELOG 部分，不搬运 `reviews/cloud-iter/LOG.md` 的历史运行日志。不合并、不关闭原 PR。

## 逐 PR 取舍

| PR | 对照 v1.7.0 的判断 | 取入内容 | 未取/调整及原因 |
|---|---|---|---|
| [#11](https://github.com/leonjean214/bili-boost/pull/11) | 有效、未覆盖。基线已有实播融合/码率告警，但没有证据 TTL，开播旧测速可长期掩盖全局降速。 | 3 分钟证据时效、真实样本时间戳、告警 stale 字段、常规门控补测、场景 10。 | 不取云端运行日志；历史性能数字仅作来源记录，不当本轮验证。 |
| [#12](https://github.com/leonjean214/bili-boost/pull/12) | 有效、未覆盖，直接对应卡顿。基线有 below 计数和滞回，但真实分片完成后没有主动切源入口。依赖 #11 的时效字段。 | 连续 3 片跟不上码率时，用新鲜且够快的已有数据主动切源；防选回慢源、60 秒限频、手选保护；场景 11。 | 不扩展到盲切，不放宽自动门控。 |
| [#13](https://github.com/leonjean214/bili-boost/pull/13) | 有效、未覆盖，直接对应开播慢源。基线快筛后还要等空闲/精测，慢源可能先卡一次。 | 首轮快筛暂定切换；至少 1.2×码率和 25% 提升、滞回/手选保护；暂定切换不占 60 秒额度，方便精测纠错；场景 12。 | 明确这是按任务授权抢救的自动策略变化，不是手动按钮顺带重写自动策略。 |
| [#14](https://github.com/leonjean214/bili-boost/pull/14) | 有效的测试加固。叠层合并后旧版对照可能已包含功能，不能再要求它表现出旧 bug。 | 对照标识检测、读取失败/旧接口缺失时带原因 SKIP、当前标识缺失则 FAIL、QA_LEGACY_REF。 | 仅旧版对照可 SKIP；当前版断言仍必须通过。Win 无 git 时对照可能 SKIP，不能描述为完整旧版对照成功。 |
| [#15](https://github.com/leonjean214/bili-boost/pull/15) | 有效的联合回归，基线无此覆盖；依赖 #11–#14。 | 场景 13 的 30 分钟虚拟播放、阶段功能联动、资源/并发/限频预算；测试桩只统计脚本自己的定时器。 | 未放宽任何资源预算；这是虚拟长测，不等同两小时真实播放。 |

未发现需要整项舍弃的有害产品改动。共同依赖已按顺序解决；未使用整分支 cherry-pick，以免将叠层历史和 cloud 日志重复带入。既有 403 拉黑、诊断、实播健康先验与清晰度回升已在基线中，不重复实现。

## 手动入口的最小适配

- 复用 `runCdnProbe(..., { manual: true })` 和全局串行槽；HUD 与控制台调用同一 `重测()`。
- 运行中连点合并为一次待执行手动请求，自动补测不能覆盖它；清理本视频手选/选中/缓存延迟到排队轮真正开始。
- 手动快筛包含全部兼容候选，仍只精测入围源；拉黑/本视频拒绝状态不因测速而解除，最终选源仍过滤它们。
- 手动仅绕过缓冲与 60 秒限频，评分与滞回保留；没有足够真实样本时不虚构滞回证据。
- 各源结果标记按 `currentCdnSource()`（与 `__biliBoost.当前源` 相同）而不是历史赢家；无可用候选也保留本轮失败明细。
- `@grant none`、`@inject-into page` 与 `IS_TOP` HUD 保护不变；不加依赖、不加定时器或每按钮监听。

## 本轮验证状态：Win 回归通过（保留既有 SKIP）

首轮因 Win 离线未能运行测试；2026-10-17 用户恢复 Win，SSH 返回 ready，随后完成以下实际运行。所有测试在 Win 执行，Mac 只编排、git 与静态检查。

| 验证 | 命令 / 条件 | 结果 |
|---|---|---|
| 旧版 red | 临时使用 `2082c4c:bili-boost.user.js`、保留新版测试；`QA_ARGS='--manual-probe-only' QA_TIMEOUT_SECONDS=240 ./tools/qa-on-win.sh`，trap 恢复实现 | rc=1；PASS=0 FAIL=2 SKIPPED=0，4.1s；有/无 AV1 均 `automaticBlocked:true, hasButton:false` |
| 新版 green | 恢复实现后同一命令 | rc=0；PASS=2 FAIL=0 SKIPPED=0，7.4s；9 项检查在两种 AV1 环境均 true |
| 完整首轮 | `QA_TIMEOUT_SECONDS=1200 node tools/qa-boost.mjs`（自动转交 Win） | rc=1；PASS=35 FAIL=1 SKIPPED=2；定位到旧测试对“无可用候选”的结果存储假设已不适用 |
| 完整重跑 | 修正断言后同一命令 | rc=0；PASS=36 FAIL=0 SKIPPED=2，229.1s；内含 qa-stall PASS=77 FAIL=0 SKIP=4 |
| 独立模拟回归 | scp 当前脚本及 qa-stall 至唯一 Win 暂存目录，`ssh win-desktop 'node bili-manual-probe-sim-20261017\tools\qa-stall.mjs'` | rc=0；PASS=77 FAIL=0 SKIP=4，1.6s |
| 静态 | `node --check` 三份脚本及 `git diff --check` | 全通过 |

唯一修复：`新增 CDN 候选（不可用回退）` 原先要求全失败时没有测速结果。本版按任务要求保留失败明细并标明保持原始源，因此改为严格断言 `win === original && allFailed && !precise && source === original && blacklisted`。不是把失败候选当成功，也未改产品逻辑或放宽资源预算。首轮完整失败日志先证明了断言问题，修复后整套重跑通过。

SKIP 不冒充通过：
- 浏览器 2 项：多 P 切 P、切清晰度，未登录流已内联 `__playinfo__`，播放器不重新请求 playurl。
- 模拟 4 项：场景 10、11、12（两项）的历史对照，Win 暂存目录无可读 `origin/main / main`。当前版 77 项断言均执行；手动按钮另有上表独立的真实旧版 red 证据。

Safari 真机未执行，按用户要求由 Claude 后续操作。PR #16 继续 Draft，不合并、不关闭 #11–#15。详细命令、原始日志位置与 Safari 步骤见 `.ai/HANDOFF.md`。
