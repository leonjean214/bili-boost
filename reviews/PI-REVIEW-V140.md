# bili-boost v1.4.0 主动优化报告

## 做了什么、为什么

- **精测改为头部 + 中段两点**：每个 finalist 仍共下载 768KB，拆成文件头 384KB 与 1MB 偏移 Range 384KB，并按较差点排名，用来识别“头部缓存快、中段回源慢”。Range 不支持、签名拒绝或文件太短时退回头部，不误杀可播放源。
- **拆出 TTFB**：探测和真实分片都记录首字节延迟与传输吞吐；同一健康档按“TTFB + 标准 768KB 传输时间”严格排序，`compareHosts` 仍是合法全序。健康档案同步保存 TTFB。
- **补齐 fetch 分片实测速**：流式读取 `Response.clone()`，不额外发请求、不替换播放器持有的原 Response；观测分支限制为 30 秒/32MB，并按媒体代次丢弃迟到样本。XHR 同时补了 TTFB。
- **降低卡顿误判**：`waiting/stalled` 先经过 1.2 秒确认；过滤初始加载、主动 seek、playurl/SourceBuffer 切换、已有缓冲、`readyState` 恢复和播放时间继续前进，并对同一事件去重。
- **AV1 硬解缓存失效**：缓存改为 `{value, at, env}`，绑定浏览器环境、30 天过期；旧版裸 boolean 自动迁移。失效或探测失败均保持 `null`，`auto + null` 仍保守剔除 AV1；旧 `bhw_codec=true/false` 语义未变。
- **停止合成 Akamai host**：移除主动 Akamai 候选并禁止 bilivideo/Akamai 跨域族改写，避免 host 绑定签名导致的常见 403；播放器原本下发的 Akamai 地址仍可作为原始源测速。
- **增加手动逃生口**：HUD 可点击所有兼容候选（包括未测或自动判失败的源）立即切线，并可恢复自动；控制台增加 `手动源`、`首字节延迟`、`手动选源()`、`自动选源()`。
- **顺手修正有效性细节**：HUD 只汇总当前源样本；媒体切换后的迟到请求不再污染新媒体；记录实际请求 host；清理 v1.3 遗留的跨域族全局赢家；README 与 QA 同步更新。

## 判断为不值得做的项

- **不用 PerformanceResourceTiming 代替 fetch clone**：跨域分片通常没有可靠 `Timing-Allow-Origin`，拿不到稳定的传输大小/阶段数据。
- **不用 TransformStream/Proxy 替换原 fetch Response**：会改变 `url/type/redirected/clone()` 等语义；clone 观测分支兼容风险更低，且已加上限。
- **不永久删除 Akamai 支持**：只禁止“凭空合成”；服务端原本给出的 Akamai URL 可能有合法的 host 专属签名，应保留原始源能力。
- **不靠 Network Information API 自动识别 Wi‑Fi/VPN 切换**：Safari 覆盖不足，也不能可靠识别 VPN；继续用 30 分钟缓存 + 确认卡顿重测。
- **不采集 WebGL GPU 指纹来使 AV1 缓存失效**：隐私和兼容成本高于收益；环境绑定 + 30 天 TTL + 手动重探足够。
- **不重写 playurl 合成 Response 的既有实现**：当前播放器与回归均未依赖缺失的只读元数据；Proxy/流级改写的品牌检查和兼容风险更高，和本轮 fetch 分片观测不是同一问题。

## 仍存疑

- 不支持 Range 的 CDN 只能退回头部精测，仍无法识别其“头快中慢”。
- fetch clone 已做 30 秒/32MB 限制且确定性验证通过，但 Safari 上的超大高码率分片尚未单独压测。
- 卡顿判断已显著收紧，浏览器仍没有“CDN 真卡”的权威事件，极端播放器状态可能误判或漏判。
- 登录态 1080P/4K、多 P、真实切清晰度仍未覆盖；本轮自动化仍是未登录 Chrome。

## 回归结果

- `node --check bili-boost.user.js`：通过。
- `node --check tools/qa-boost.mjs`、`git diff --check`：通过。
- `node tools/qa-boost.mjs`：**PASS=12、FAIL=0、SKIPPED=2**；新增覆盖编码三态兼容、31 天 AV1 缓存失效、CDN 多点/TTFB/手选、fetch Response 语义与实测速、初始/seek/瞬时 waiting 去误报。
- `@version` 与 `SCRIPT_VERSION` 均为 **1.4.0**；用户脚本未新增依赖、额外功能网络请求或 `eval/new Function`。
