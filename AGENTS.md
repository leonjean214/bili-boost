# bili-boost 项目规则（给 Codex / pi / 任何自动执行者）

## 🔴 测试只能在 Win 台式机跑（用户 2026-09-27 明确要求）
- `tools/qa-boost.mjs` 会开真实 Chrome 播放 B 站视频。**在 Mac 上运行会不停弹 Chrome 窗口、很吵，禁止。**
- 一律用 `tools/qa-on-win.sh`（或在 Mac 上直接 `node tools/qa-boost.mjs`——它会自动转交 qa-on-win.sh）。
- **禁止设置 `BILI_BOOST_QA_ALLOW_MAC=1`**，禁止删除/绕过 qa-boost.mjs 开头的 macOS 转交逻辑与 tools/qa-on-win.sh——这不是越界改动，是用户要求的测试环境约束。
- Mac 上允许的检查：`node --check`、`git diff --check` 等不启动浏览器的静态检查。
- Win 是 RTX 5090，有 AV1 硬解；测试断言要按探测到的环境分支，两种环境（有/无 AV1 硬解）都要覆盖。
