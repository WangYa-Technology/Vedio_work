# 漫橙映画 — AI漫剧全流程制作平台

## 写在前面

AI漫剧赛道很热，但我们观察到一个现象：市面上大量课程和工具集中在"API转发"和"一键生成"的包装上，却很少有人认真面对漫剧创作的核心问题——**剧情**和**分镜**。

一部好的漫剧，画面再精美，如果故事站不住、节奏不对、镜头语言混乱，观众几秒就划走了。AI可以生成画面，但它不会自己讲故事。从一段小说到一部能看的漫剧，中间需要经历改编、人物重塑、结构设计、导演定调、分镜拆解这些专业环节，这些环节至今仍然高度依赖创作者的判断力和审美。

**漫橙映画想做的事情很简单：把这些专业环节的方法论沉淀成可复用的工具，帮助创作者把更多精力放在"讲好故事"上，而不是消耗在重复的格式整理和平台适配里。**

这个项目集成了 @山音 的编剧/导演/分镜方法论体系，尝试用 AI Agent 辅助走完从原始素材到AI平台可用分镜的全流程。它不是替代创作者，而是做创作者的工具。

项目仍在早期，欢迎同样关心漫剧内容质量的创作者一起参与和改进。

---

从小说到AI视频，一站式完成：**小说改编 → 剧本创作 → 导演定调 → 分镜拆解 → AI视频生成提示词**

---

## 它能做什么

| 你有什么 | 漫橙映画帮你做什么 | 最终产出 |
|---------|-------------------|---------|
| 一篇小说 | 自动改编剧本 → 拆分镜 → 生成AI提示词 | 可直接喂给巨日禄/Seedance的分镜表 |
| 一个剧本 | 理解剧本 → 导演定调 → 拆分镜 | 三列Excel（巨日禄）或时间轴Markdown（Seedance） |
| 一个故事大纲 | 展开成完整剧本 → 走完全流程 | 剧本 + 分镜 + 资产清单 + AI提示词 |

**核心原则：台词神圣不可改，所有画面必须能被摄影机拍到，每个镜头必须有叙事目的。**

---

## 系统架构

```
┌─────────────────────────────────────────────────────────┐
│                     漫橙映画 前端                        │
│  Vue 3 + TDesign + Pinia + Socket.IO + Monaco Editor    │
│                                                         │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐  │
│  │ 小说原文  │ │ 剧本Agent│ │  制作台   │ │  模型配置  │  │
│  │ 导入/编辑 │ │ 故事骨架 │ │ 分镜列表 │ │ 多供应商  │  │
│  │ 快捷粘贴 │ │ 改编策略 │ │ AI聊天   │ │ Claude/   │  │
│  │ 事件分析 │ │ 剧本编辑 │ │ 分镜编辑 │ │ OpenAI/...│  │
│  │          │ │ 分镜脚本 │ │          │ │           │  │
│  └──────────┘ └──────────┘ └──────────┘ └───────────┘  │
└───────────────────────┬─────────────────────────────────┘
                        │ WebSocket + REST API
┌───────────────────────┴─────────────────────────────────┐
│                     漫橙映画 后端                        │
│  Express 5 + Socket.IO + Better-SQLite3 + Vercel AI SDK │
│                                                         │
│  ┌──────────────────────────────────────────────────┐   │
│  │              Multi-Agent 系统                     │   │
│  │                                                   │   │
│  │  scriptAgent          storyboardAgent             │   │
│  │  ├─ decisionAI        ├─ decisionAI               │   │
│  │  ├─ Memory            ├─ Memory                   │   │
│  │  └─ subAgents:        └─ subAgents:               │   │
│  │     ├─ 故事骨架          ├─ 故事破题               │   │
│  │     ├─ 改编策略          ├─ 导演定调               │   │
│  │     └─ 剧本生成          ├─ 分镜拆解               │   │
│  │                          ├─ 资产提示词             │   │
│  │                          └─ 质检监督               │   │
│  └──────────────────────────────────────────────────┘   │
│                                                         │
│  ┌──────────────────────────────────────────────────┐   │
│  │              供应商系统（VM沙盒）                   │   │
│  │  Claude / OpenAI / DeepSeek / MiniMax / Vidu /   │   │
│  │  可灵 / Seedance / 火山引擎 / ...                  │   │
│  │  用户可自定义 TypeScript 供应商模板                  │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
                        │
┌───────────────────────┴─────────────────────────────────┐
│              Claude Code Skill 技能层                     │
│                                                         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐ │
│  │ 编剧大师     │  │ 导演大师     │  │ 分镜师          │ │
│  │ screenwriting│  │ director-   │  │ storyboard-    │ │
│  │ -master     │  │ master      │  │ director       │ │
│  │             │  │             │  │                │ │
│  │ 8步剧本创作 │  │ 5步视听方案 │  │ 4步AI分镜      │ │
│  │ 4种格式路由 │  │ 九列分镜表  │  │ 巨日禄/Seedance│ │
│  │ 记忆检查点  │  │ 6大类型库   │  │ 防崩约束       │ │
│  └──────┬──────┘  └──────┬──────┘  └───────┬─────────┘ │
│         │                │                  │           │
│         └────────┬───────┴──────────────────┘           │
│                  ▼                                      │
│  ┌─────────────────────────────────────────────────┐    │
│  │          制作流水线 (storyboard-pipeline)        │    │
│  │    智能编排层：输入识别 → 路由技能链 → 数据传递   │    │
│  └─────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
```

---

## 技术栈

### 后端 (Toonflow-app)

| 层 | 技术 | 用途 |
|----|------|------|
| 运行时 | Node.js + TypeScript + tsx | 开发/运行 |
| Web框架 | Express 5 + express-ws | REST API + WebSocket |
| 数据库 | Better-SQLite3 + Knex | 嵌入式数据库，零配置 |
| AI SDK | Vercel AI SDK (`ai` 6.x) | 统一多供应商文本/图片/视频生成 |
| AI供应商 | @ai-sdk/anthropic, openai, deepseek, google, xai, minimax... | 可插拔供应商系统 |
| 沙盒 | VM2 | 安全执行用户自定义供应商代码 |
| 桌面端 | Electron 40 | 可选桌面打包 |

### 前端 (Toonflow-web)

| 层 | 技术 | 用途 |
|----|------|------|
| 框架 | Vue 3 + TypeScript + Vite | SPA |
| UI库 | TDesign Vue Next + @tdesign-vue-next/chat | 组件 + AI聊天组件 |
| 状态 | Pinia + pinia-plugin-persistedstate | 响应式状态管理 |
| 通信 | Socket.IO Client + Axios | 实时通信 + HTTP |
| 编辑器 | Monaco Editor + md-editor-v3 | 代码编辑 + Markdown编辑 |
| 视频 | @webav/av-canvas + av-cliper + vue-clip-track | 视频预览/轨道编辑 |
| 图标 | @icon-park/vue-next | 图标系统 |
| 布局 | Splitpanes + @vue-flow/core | 面板分割 + 流程图 |

### Skill 技能层 (Claude Code)

| Skill | 功能 | 方法论来源 |
|-------|------|-----------|
| `screenwriting-master` | 全格式剧本创作（超短片/短片/长片/剧集） | Save the Cat, Story Circle, McKee, 双轨节奏 |
| `director-master` | 导演定调 + 九列分镜表 | 世界顶级导演视听理论，6维定调，类型交叉组合 |
| `storyboard-director` | AI平台分镜（巨日禄/Seedance） | △格式，15秒弧线，70/30法则，防崩约束 |
| `seedance-storyboard-generator` | Seedance 2.0 专用生成器 | 首尾帧时间轴，@图片引用，集间连续性 |
| `storyboard-pipeline` | 智能编排层，串联以上技能 | 输入识别 → 路由 → 数据传递 |

---

## 制作流水线

### 路线 A：小说 → AI视频

```
小说原文
  │
  ▼
[编剧大师] screenwriting-master
  │ 破题 → 人物设计 → 结构大纲 → 场景写作
  │ 输出：完整剧本（所有台词+动作+场景标记）
  ▼
[分镜师] storyboard-director
  │ 故事破题 → 导演定调 → 分镜拆解 → 资产提示词
  │
  ├── 巨日禄模式 → 三列Excel（分镜编号/分镜描述/台词）
  └── Seedance模式 → 时间轴Markdown + @图片引用
```

### 路线 B：剧本 → AI视频

```
完整剧本
  │
  ▼
[分镜师] storyboard-director
  │ 快速提取核心梗+角色 → 导演定调 → 分镜拆解 → 资产提示词
  │
  ├── 巨日禄模式 → 三列Excel
  └── Seedance模式 → 时间轴Markdown
```

### 交付物清单

| 文件 | 说明 |
|------|------|
| `[剧名]_剧本.md` | 完整△格式剧本 |
| `[剧名]_素材清单.md` | C/S/P资产编号 + AI生成提示词 |
| `[剧名]_巨日禄_分镜表.xlsx` | 巨日禄平台三列分镜表 |
| `[剧名]_E01_分镜.md` | Seedance平台时间轴分镜 |

---

## 多Agent系统

### Agent 架构

每个 Agent 遵循 `decisionAI → createSubAgent` 模式：

```
用户消息
  │
  ▼
decisionAI（主决策Agent）
  │ 读取 skill prompt → 调用 Memory 系统 → 路由到子 Agent
  ▼
createSubAgent（子Agent池）
  ├── run_sub_agent_story_analysis    → 故事破题
  ├── run_sub_agent_director_alignment → 导演定调
  ├── run_sub_agent_storyboard_breakdown → 分镜拆解
  ├── run_sub_agent_asset_prompts     → 资产提示词
  └── run_supervision_agent           → 独立质检
```

### 工具系统

Agent 通过 11 个工具函数操作数据库：

| 工具 | 功能 |
|------|------|
| `get_script_content` | 读取剧本内容 |
| `get_storyboard_data` | 读取分镜数据 |
| `save_character_bible` | 保存角色Bible |
| `save_director_alignment` | 保存导演定调 |
| `add_storyboard_shot` | 添加单个分镜 |
| `batch_add_shots` | 批量添加分镜 |
| `update_shot` / `delete_shot` | 修改/删除分镜 |
| `set_platform_mode` | 切换平台模式 |
| `save_asset_prompt` | 保存资产提示词 |

每个工具写入数据库后通过 Socket.IO 推送事件，前端自动刷新。

### 供应商系统

可插拔的 AI 供应商架构，用户通过 TypeScript 模板自定义：

```typescript
// 供应商模板结构
const vendor: VendorConfig = {
  id: "claude",
  name: "Claude (Anthropic)",
  inputs: [{ key: "apiKey", label: "API密钥", type: "password", required: true }],
  inputValues: { apiKey: "", baseUrl: "https://api.anthropic.com/v1" },
  models: [
    { name: "Claude Sonnet 4.6", modelName: "claude-sonnet-4-6", type: "text", think: false },
  ],
};

// 适配器函数（在VM2沙盒中执行）
const textRequest = (textModel) => {
  return createAnthropic({ apiKey: vendor.inputValues.apiKey }).chat(textModel.modelName);
};
```

内置供应商：Claude / OpenAI / DeepSeek / MiniMax / 火山引擎(Seedance) / 可灵 / Vidu

---

## 数据库设计

嵌入式 SQLite，零配置，首次启动自动建表：

```
o_project          — 项目管理
o_novel            — 小说原文（章节+事件提取）
o_script           — 剧本
o_storyboard_shot  — 分镜数据（镜号/内容/运镜/景别/台词/音效/时长/叙事目的/平台模式）
o_character_bible  — 角色Bible（英文描述词+Want/Need/Arc）
o_director_alignment — 导演定调（六维定调+色彩+音响）
o_asset_prompt     — 资产提示词（C/S/P系列+防崩约束）
o_agentDeploy      — Agent模型配置
o_vendorConfig     — 供应商配置（含TypeScript代码模板）
o_agentWorkData    — Agent工作数据
```

---

## 快速开始

### 环境要求

- Node.js >= 18
- npm >= 9

### 安装

```bash
# 克隆项目
git clone https://github.com/your-org/toonflow.git
cd toonflow

# 后端
cd Toonflow-app
npm install
npm run dev          # 启动后端 http://localhost:10588

# 前端（新终端）
cd Toonflow-web
npm install
npm run dev          # 启动前端 http://localhost:5173
```

### 配置 AI 模型

1. 打开前端 → 设置 → 模型配置
2. 选择供应商（Claude / OpenAI / 自定义）
3. 填入 API Key
4. 在 Agent 部署页绑定模型

### 使用 Claude Code Skill（可选）

```bash
# 安装 Claude Code CLI
# 然后在项目目录下：
claude

# 触发制作流水线
> /storyboard-pipeline

# 或单独使用
> /screenwriting-master    # 编剧大师
> /director-master         # 导演大师
> /storyboard-director     # 分镜师
```

---

## 项目结构

```
Toonflow-app/                    # 后端
├── src/
│   ├── agents/
│   │   ├── scriptAgent/         # 剧本Agent（决策+子Agent+工具）
│   │   └── storyboardAgent/     # 分镜Agent（决策+子Agent+工具）
│   ├── routes/
│   │   ├── storyboard/          # 14个分镜API路由
│   │   ├── scriptAgent/         # 剧本Agent API
│   │   ├── novel/               # 小说管理API
│   │   └── setting/             # 配置API（供应商/Agent部署）
│   ├── socket/routes/           # WebSocket路由
│   ├── utils/
│   │   ├── ai.ts                # AI统一调用层（Text/Image/Video/Audio）
│   │   └── vm.ts                # VM2沙盒（执行供应商代码）
│   └── lib/initDB.ts            # 数据库初始化+种子数据
├── data/
│   ├── skills/                  # Agent Skill Prompt文件
│   │   ├── storyboard_agent_decision.md
│   │   ├── storyboard_execution_*.md  # 4个子Agent prompt
│   │   └── storyboard_skills/         # 参考知识库
│   └── db2.sqlite               # SQLite数据库

Toonflow-web/                    # 前端
├── src/
│   ├── views/
│   │   ├── novel/               # 小说原文模块（导入/编辑/快捷粘贴）
│   │   ├── scriptAgent/         # 剧本Agent（4 Tab：骨架/策略/剧本/分镜脚本）
│   │   └── production/          # 制作台（分镜列表+AI聊天）
│   ├── stores/
│   │   ├── scriptAgent.ts       # 剧本Agent状态
│   │   └── storyboardAgent.ts   # 分镜Agent状态+Socket事件
│   └── locales/                 # 多语言（中/英/日/俄/泰/越）

.claude/skills/                  # Claude Code Skill 技能文件
├── screenwriting-master/        # 编剧大师
├── director-master/             # 导演大师
├── storyboard-director/         # 分镜师
├── seedance-storyboard-generator/ # Seedance生成器
└── storyboard-pipeline/         # 制作流水线（编排层）
```

---

## 设计理念

### 山音方法论

本项目的 Skill 技能层基于 **@山音** 的创作方法论体系，核心理念：

- **台词神圣原则** — 剧本台词一字不省略、不改写、不合并
- **摄影机法则** — 所有画面描述必须是摄影机能拍到的，禁止心理活动
- **叙事目的** — 每个镜头必须能回答"这个镜头为什么存在"
- **70/30法则** — 70%标准支撑镜头 + 30%视觉亮点镜头
- **15秒弧线** — 每集15秒遵循 建立→上升→高潮→释放 的情绪结构
- **防崩约束** — 所有AI提示词末尾附加结构稳定性约束语
- **Character Bible** — 角色英文固定描述词保证跨集AI生成一致性

### 多Agent协作

采用 **decisionAI + subAgent + supervision** 三层架构：
- **决策层**：理解用户意图，路由到合适的子Agent
- **执行层**：每个子Agent专注一个步骤，读取对应的 Skill prompt
- **监督层**：独立质检Agent，验证输出质量

### 供应商无关

通过 VM2 沙盒 + TypeScript 模板系统实现供应商可插拔：
- 用户可自定义任何 AI 供应商的接入代码
- 文本/图片/视频/TTS 四种模型类型统一抽象
- 运行时动态加载，无需重启服务

---

## 支持的 AI 平台

| 平台 | 用途 | 输出格式 |
|------|------|---------|
| 巨日禄 | 融生视频 | 三列Excel（分镜编号/描述/台词） |
| Seedance 2.0 | 首尾帧视频 | 时间轴Markdown + @图片引用 |
| 可灵 Fusion | 融生视频 | 同巨日禄格式 |
| Midjourney / Nana | 参考图生成 | 英文提示词 + 风格前缀 |
| Runway | 首尾帧视频 | 同Seedance格式 |

---

## License

MIT

---

## 致谢

- **@山音** — 编剧/导演/分镜方法论体系设计
- [Vercel AI SDK](https://sdk.vercel.ai/) — 多供应商AI统一接口
- [TDesign](https://tdesign.tencent.com/) — UI组件库
- [Claude Code](https://claude.ai/code) — Skill技能系统
