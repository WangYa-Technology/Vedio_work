# 唯一生产流程基线

本文定义当前项目唯一保留的视频生产流程。后续改动必须以 `http://localhost:10588/#/production` 的现有页面和数据契约为基线，不再恢复旧 Storyboard Agent 或节点画布流程。

## 用户流程

1. 在剧本工作区完成项目和剧集剧本。
2. 进入 `#/production`，选择剧集，由 Production Agent 依次完成资产衍生、资产图片、导演计划、正式分镜表和正式分镜面板。
3. 在左侧检查按片段组织的分镜内容和引用资产；右侧对话仅用于驱动或修订同一套正式数据。
4. 打开工作台，在“快速预览”检查素材和镜头顺序。
5. 在“分镜台”生成或选择视频提示词，生成分镜视频并保留历史版本。
6. 将选中的分镜视频导入“剪辑台”，完成轨道编排和本地画布导出。

## 唯一数据源

| 内容 | 当前存储 |
| --- | --- |
| 项目与剧集 | `o_project`、`o_script` |
| Production Agent 工作区 | `o_agentWorkData` 中的 `productionFlowData` |
| 正式资产与图片 | `o_assets`、`o_image` |
| 正式分镜 | `o_storyboard` |
| 分镜和资产关系 | `o_assets2Storyboard` |
| 视频、轨道和生成任务 | `o_video`、`o_videoTrack`、`o_tasks` |

Production Agent 必须直接读写这些正式表。不得再增加平行的“临时分镜表”“旧分镜 Shot 表”或另一份 Storyboard Agent 工作区。

## 必须保留

- 前端唯一入口：`Toonflow-web/src/views/production/index.vue`
- 前端唯一状态：`Toonflow-web/src/stores/productionAgent.ts`
- 工作台三阶段：`preview.vue`、`generate.vue`、`editVideo/`
- 统一类型：`Toonflow-web/src/views/production/types.ts`
- 后端唯一 Agent：`Toonflow-app/src/agents/productionAgent/`
- 后端唯一 Socket：`/api/socket/productionAgent`
- 正式 Production 路由：`Toonflow-app/src/routes/production/`
- 共享图片生成服务：`Toonflow-app/src/services/imageGeneration.ts`

## 不得恢复

- `storyboardAgent` Store、Agent、Socket 和记忆类型
- `/api/storyboard/*` 旧路由
- `o_storyboard_shot`、`o_character_bible`、`o_director_alignment`、`o_asset_prompt`
- Vue Flow/Dagre 节点画布和旧 Production 节点组件
- 旧图片编辑器、右侧重复聊天框和 `storyboardImageCheck`
- Script Agent 中重复的“分镜脚本”标签页
- 名称包含 `copy`、`backup` 或 `old` 的平行实现

## 维护约束

- `projectId + scriptId` 是剧集级上下文；允许没有已选剧集的项目显示空态，接口不得因此返回 500。
- 分镜台展示、生成和剪辑必须引用同一批 `o_storyboard` 记录。
- 数据结构变更后必须重新生成 `src/types/database.d.ts`，并保证前后端类型检查、正式构建和 SQLite `integrity_check` 全部通过。
- 删除旧流程前先备份数据库；迁移后必须确认分镜数量、关系数量和孤儿关系。
