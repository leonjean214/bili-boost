# CHANGELOG

## 1.6.0

- 修复 HUD 关闭后折叠定时器仍存活的问题，同时注销已移除面板的点击监听。
- 合并同一媒体/编码的重复状态查询；媒体切换会立即清除 metadata 监听和能力查询的截止定时器，忽略迟到结果。
- 精测的缓冲等待改由媒体事件唤醒，媒体切换或确认卡顿时立即取消等待；保留 8 秒截止，不再每 500ms 轮询。
- 新增 QA 专用定时器、监听器、MutationObserver 计数器及自测；覆盖 XHR 复用的成功/abort/失败、40 路 fetch 观测、100 次 HUD 开关、50 次编码更新和 50 次 SPA 切换，分别模拟有/无 AV1 硬解。
- 新增可选真实长时播放回归：`QA_TIMEOUT_SECONDS=9000 QA_ARGS='--soak-seconds=7200' ./tools/qa-on-win.sh`。只在 Windows 桌面静音 Chrome 执行，以实际播放进度累计有效时长，不把暂停、卡住、seek 或单纯等待计入两小时；短视频播完事件驱动重播，有效播放 5 分钟不增长即提前失败。
- 保留既有 AV1 自动能力决策、CDN 候选及 Safari Userscripts / Chrome Tampermonkey 注入和响应语义；未新增持久化格式、依赖或浏览器专属业务 API。

历史版本说明仍保留在 README，不迁移已有记录。
