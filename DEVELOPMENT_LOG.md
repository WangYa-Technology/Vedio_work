# 开发日志

## 2026-08-14：最新画布版硬性规则

- 生产页必须使用“带 Agent 对话的最新无限画布版”，运行入口固定为 `Toonflow-app/data/serve/app.js` 与 `Toonflow-app/data/web/index.html`，对应的官方基线是 `data/temp/serve/app.js` 与 `data/temp/web/index.html`。
- 严禁把旧版分镜列表的源码构建产物复制到 `data/serve` 或 `data/web`，也严禁在旧版分镜列表中实现或回迁生产页功能。
- 修改生产页、分镜面板、生产 Agent、视频工作台或相关接口前，必须先确认运行页面是带 Agent 对话的最新画布版；若构建过程覆盖了运行包，必须从 `data/temp` 恢复最新基线后再补丁式修改。
- 本条规则是后续开发的严格前置条件，优先级高于常规构建流程。

## 2026-08-14：分镜审计失败重新推理

- 仅在最新 Agent 画布版的分镜面板中处理图片生成失败；失败卡片保留原始错误原因，并提供“重新推理”入口。
- 重新推理先调用 `/api/production/storyboard/reasonPrompt`，依据内容安全约束改写图片提示词，清除旧错误后再强制提交该分镜生图；生成状态继续由现有轮询接口跟踪。
- 该功能不得回迁到旧版分镜列表，也不得用旧版构建产物覆盖 `data/web` 或 `data/serve`。

## 2026-08-14：参考图上传预处理优化

- HC 参考图上传限制为 1.2 MB、最长边 2048 像素：未超限的 JPEG/PNG 保留原始字节与 MIME 类型，只有超限或不支持的格式才转换为 JPEG。
- 预处理按图片内容、格式和限制参数计算 SHA-256；缓存 Promise 合并并发重复转换，缓存有条目上限。
- 同一批多张参考图使用 `Promise.all` 并行预处理，之后按原顺序加入 multipart，不改变参考图顺序。

## 2026-08-14：Agent 分镜 prompt 传递修复

- 最新 Agent 画布版 Socket 的 `getFlowData` 回调必须保留 `storyboard.prompt`、真实 `id/index`、参考资产绑定和错误状态；不得像旧补丁一样删除分镜 prompt。
- `productionAgent.get_flowData` 对 storyboard 增加数据库兜底：即使浏览器仍缓存旧 bundle，也会按当前项目/剧集从 `o_storyboard` 读取真实 prompt，避免 Agent 误判为“没有可用 prompt”。
- 运行包只补丁 `Toonflow-app/data/web/index.html` 与 `Toonflow-app/data/serve/app.js`；未修改 `data/temp`，未构建或回迁旧版分镜列表。
