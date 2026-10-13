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

## 2026-10-09：工作台视频地址必须走签名 URL

- `/oss` 静态目录经 `authenticate` 鉴权：`<video>`/`<img>` 标签不会携带 `Authorization` 头，浏览器直连只认 `?expires=&signature=` 签名，因此后端任何返回媒体地址的接口都必须用 `u.oss.getFileUrl()` 生成签名链接。
- `getVideoList` 原先自定义 `fileUrl()` 直接拼接 `/oss/...`（未签名），导致工作台视频预览提示“视频加载失败，请重新生成或检查视频文件”，同时下载、导入剪辑的素材地址也会 401；现改为与图片等其它接口一致的签名地址，文件存在性判断也由 `getFileUrl` 统一完成。
- 同步补丁运行包 `Toonflow-app/data/serve/app.js`（`fileUrl2` 改为调用 `utils_default.oss.getFileUrl`），未改 `data/temp` 基线；重新构建后需确认该处仍为签名实现。

## 2026-10-09：视频工作台「一键修复」缺失说话角色参考

- 工作台「AI生成本场提示词」在 MiniMax H3 多参考模式下会因“说话角色缺少独立角色参考”返回 400 拦截推理；该 400 现在附带结构化载荷 `data.code=MISSING_SPEAKER_REFERENCES` 与 `data.missingSpeakers[]`（trackId/storyboardIds/sceneTitle/segmentTitle/speakerName），错误文案保持逐字不变。
- 新增 `POST /api/production/workbench/checkSpeakerReferences`（入参 projectId/scriptId/trackIds）：复用与推理拦截相同的检测逻辑，返回 `{applicable, missingSpeakers}`；无 AI 调用，供前端轮询修复进度。
- 检测逻辑抽取到 `src/utils/speakerReferences.ts`（镜头解析与 `missingSpeakerReferences` 等），`generateVideoPrompt.ts` 改为引用共享实现，避免校验语义漂移；附 node:test 单测。
- 前端视频生成面板（`views/production/components/workbench/generate.vue`）错误条内新增「一键修复」按钮（仅结构化错误类型显示；发送中/修复中为 loading 禁用防重复；生产 Agent 忙碌时提示等待）：点击后经 productionAgent socket 发送 `【一键修复·视频参考角色补齐】` 结构化指令（含场次、片段、trackId、分镜真实 ID、缺失角色清单），每 5s 轮询 checkSpeakerReferences（上限约 10 分钟，超时后按钮变「继续修复」仅恢复跟踪、不重复派发）。
- 修复由生产 Agent 执行，技能文档同步更新：`production_agent_decision.md` 新增「视频工作台一键修复」派发场景（先 base_assets 补建/复用并提交图片生成，再 storyboard_panel 追加绑定）；`production_execution_base_assets.md` 要求新建前先检索近似角色复用（如“销售”≈“销售员/店员”）并回报匹配依据，且 desc/prompt 必须引用剧本原文描写、确无描写时才按项目画风手册生成并注明；`production_execution_storyboard_panel.md` 允许对“图片生成中”的新资产追加绑定（不等待图片就绪），并按 trackId/分镜真实 ID 定位分镜。
- 修复完成后检查接口归零，错误条清空并提示“角色参考已补齐，可重新推理”（不自动重试，由用户手动重新推理）；重新推理成功时清理该场景修复状态与定时器，组件卸载时清理全部轮询定时器。
- 端到端走查（摆摊项目·片段三“销售”）：400 结构化拦截 → 按钮显示 → Agent 检索资产库无近似角色后新建 role 资产（描述引用剧本原文、注明按都市写实画风生成）、提交图片生成并绑定 storyboard 3；图片生成完成后 checkSpeakerReferences 归零，工作台显示完成提示。
- 运行包重建：后端 `data/serve/app.js` 由 `npm run build` 全量重建（含签名 URL 实现与本次新接口）；前端 `data/web` 由 Toonflow-web 构建产物同步（`data/temp` 基线不存在，未涉及）。

## 2026-10-09：H3 模板字幕例外修订（规则 24）

- 现象：手机屏内播放视频的片段（场2·片段三）生成结果中屏内画面出现字幕。排查确认提交给视频模型的提示词里“字幕”零出现：自定义模板第 24 条要求“英文正文一律不写否定句、排除性需求由调用端承载”，而 H3 六字段无负向字段、调用端只做校验不注入，`non_diegetic_music` 之后的内容还会在提交前被 `enforceVideoPromptOutputConstraints` 整段替换为 `N/A`。
- 按用户选择放宽模板规则 24：字幕作为唯一例外，正文允许保留明确的英文无字幕声明（标准写法 `No subtitles appear anywhere in the frame.`），末镜结尾必须写，画面含屏幕/播放设备/招牌/画内文字源的镜头优先写；示例与兼容标记统一升级为 `(no srt, no subtitles, no music)`。其余排除性需求（水印、分镜标签、无观众配乐等）仍由调用端承载，不写进正文。
- 变更文件：`Toonflow-app/src/constants/h3VideoPromptTemplate.ts`（规则 24、输出格式内联说明、头部修订说明、文件头移植说明）；运行中模板同步更新 `o_prompt` id=1790420000000 的 `data`/`useData`（改前备份 `data/backups/o_prompt_1790420000000_backup_1791536985976.json`）；运行包 `data/serve/app.js` 内嵌常量同步补丁。
- 校验：源码常量 == DB useData == 运行包解码内容；把新声明加进真实提示词后契约校验无字幕相关 violation，且声明能通过提交前的约束处理保留下来；要求生成字幕的反向用例仍被拦截；`node --check data/serve/app.js` 通过。
- 注意：已生成的提示词不会自动更新，需对相关片段重新执行「AI生成本场提示词」后再重新生成视频；上游原始模板 `MinimaxH3提示词的推理和提取模板/H3-3D仿真人短剧推理模板.md` 未改动（该文档的字幕排除仍指向外部「字字动画负面提示词字段」）。

## 2026-10-09：《H3分镜生成通用规范》落地（分镜层真源 + 模板措辞层 + 多模型接缝）

- 需求与口径：把根目录《H3分镜生成通用规范.md》落地到生产链路。经三轮确认，最终采用"**H3 专用适配 + 预留多模型接缝**"：模型无关条款进分镜/剧本层，带数字的能力参数（12 秒档/46 字/无台词镜 ≤6s）保持 H3 参考档，六字段等 H3 专属语法只留在模板；**不实现**非 H3 模型的参数化。
- 分镜层·真源：规范末尾新增第八节《多模型适配（待接入）》（既有条款一字未改），并逐字复制为运行时可读真源 `data/skills/production_skills/h3_storyboard_general_spec.md`（两份 43391 字节、SHA256 一致）。`h3-short-drama-storyboard/SKILL.md` 的真源路径由不存在的 `script-forging/H3分镜生成通用规范.md` 修正为实际路径，并把悬空的《H3-真人实拍短剧推理模板 v1.0》17.9 引用改指本模板规则 36/38。
- 分镜层·技能：`data/skills/production_execution_storyboard_table.md` 红线新增 12–14 条（台词容量与人数、说话者必须入画、画面描述只写看得见的）并新增《规范落地清单（引用真源）》12 条；`production_execution_storyboard_gen.md` 补四条精简引用（说话者入画、特写比例锚定、群体禁画人影、外观与参考图逐项一致）。技能只写可执行动作并引用真源，不复制规范正文。
- 分镜层·机器校验：`src/agents/productionAgent/storyboardChecks.ts` 新增五项**提示级**维度——台词容量（≤46 字）、模糊指代、元语言/审核口径、后期操作词、每集片段数（≤8）；配置集中在 `STORYBOARD_CHECK_CONFIG`，报告判定口径行同步标注"均为提示级，不参与阻塞判定"。`runStoryboardChecks(projectId, scriptId, options?)` 新增 `options.config` **接缝**（未来在此按项目模型推导档位），缺省行为不变；`storyboardChecks.test.ts` 新增 4 个用例（超容量不阻塞、三类扫描只出提示、片段预算、自定义 config 覆盖档位）。
- 模板层：`src/constants/h3VideoPromptTemplate.ts` 在规则 39 后新增《项目分镜规范措辞层约束》小节（规则 40–49 + 【输入侧对齐声明】），文件头补第 7 条修订说明；正文由 55030 → **56291 字符**。
- 接缝（只留口子、不改行为）：`enforceVideoPromptOutputConstraints(value, task?, options?)` 新增 `profile` 参数位与注释；`videoPromptMigration.test.ts` 新增用例锁定"H3/generic/不传参三种调用输出逐字一致"。
- 新增脚本：`scripts/syncH3TemplateRuntime.ts`（`npm run check:h3-template`）——按 esbuild 转义规则（0x80~0xFF → `\xHH`、更高 → `\uXXXX`、反引号/`${` 转义）**只替换运行包内嵌的模板字面量**（不做全量重建，保留历史手工补丁），并做"源码常量 == DB `data`/`useData` == 运行包解码内容"的 sha256 三方校验。
- 备份：`data/backups/o_prompt_1790420000000_backup_1791540746378.json`（改前 DB 行 55030 字符）、`data/backups/serve_app.js.backup-1791541099792`（改前运行包，11752810 字节）。
- 校验：`npm run check:h3-template` 四方 sha256 一致（`1dd656c84509`）、`node --check data/serve/app.js` 通过、DB `data` == `useData`（56291 字符）且含新增小节与规则 40/49、运行包解码内容与 DB 逐字相同；`storyboardChecks.test.ts` 15/15、`videoPromptMigration.test.ts` 8/8 通过；`npm run lint`（tsc --noEmit）通过。契约模块（`videoPromptContract.ts`）未改动，既有 H3 校验路径与门控不变。
- 多模型接缝清单（未来接入 Seedance/Vidu 等时逐项落地，已写入规范第八节）：`resolveVideoModelPromptProfile`（family 分支）→ `buildVideoModelPromptProtocol`（协议段）→ `videoPromptContract`（校验门控）→ `runStoryboardChecks(options.config)`（档位/台词容量推导）→ `enforceVideoPromptOutputConstraints(options.profile)`（提交前门控）→ 模板内措辞小节整节抽为公共片段。
- 生效：模板改动不自动作用于已生成的提示词，需重新执行「AI生成本场提示词」；运行包已就地更新，**需重启后端进程**（`stop.bat` → `start.bat`）后生效。
- 回滚：① 模板行：用备份 JSON 的 `data`/`useData` 覆盖 `o_prompt` id=1790420000000，并同步改回源码常量后重跑 `npm run check:h3-template`；② 运行包：用 `data/backups/serve_app.js.backup-1791541099792` 覆盖 `data/serve/app.js`（改后可用 `node --check` 复验）；③ 规范与技能：`data/skills/production_skills/h3_storyboard_general_spec.md` 为本轮新增文件，可直接删除；根目录《H3分镜生成通用规范.md》删除第八节、`h3-short-drama-storyboard/SKILL.md` 与 `data/skills/production_execution_storyboard_{table,gen}.md` 删除本轮新增段落即可还原。**注意：`src/constants/h3VideoPromptTemplate.ts`、`src/agents/productionAgent/storyboardChecks.ts(.test.ts)` 等文件当前未被 git 跟踪（`git status` 显示为 `??`），无法用 `git checkout` 回退，需按改动说明手工还原或从备份恢复。**

## 2026-10-10：骨架容量门禁口径修复（份额计费 + 解析择优 + 集数推算公式）

- 需求与问题：《摆摊》（12 章 / 7338 字引号台词）生成故事骨架时容量门禁连续 4 轮未通过——最终报告「19 集严重超载 + 集号断裂（EP03 缺失）」，且扩容集数（12→14→18→23→28）反而让超载数从 5 递增到 19。用户追问根因，并确认「按 12 章直接推 12 集起步」这一步有问题。
- 根因（已按判定器源码在本地逐项复算复现）：
  - ① **同一章按引用集数重复计费**：判定器只从「章节范围」/标题括注取章节号，片段白名单仅 前半/后半/中段/后段/收束前段/收束；骨架把切分写成「第X章 第N场」或「章节处理」列 `1场5保留`（技能规范恰恰要求片段写在「章节处理」列），全部落到权重 1.0 → 28 集里每集都背上整章台词（第1/2/6/10/12 章单章即超线：786/860/769/698/669 字）。集数越多，引用重章的集越多 → 超载数 5→6→8→9→19。
  - ② **模式A 优先造成幽灵「集号断裂」**：骨架同时含总览表（28 行，集号 1..28 连续）与 27 个关键集展开小节（缺 EP03），`parseSkeletonEpisodes` 命中模式A 即返回，读到 27 集清单 → 报告「EP03 缺失 / 结构性倒退」。
  - ③ 展开段「章节分配」里「第4章第1场：压缩并入集末钩子」又被叠加一整章（EP08 = 第2+3章 = 253.9s）。
  - ④ 门禁不读「容量预算」「删减决策」→「授权删减」路线对 L 无效；决策层据此给出的「逐集台词素材≈780-800 字」目标本身越过阻塞线（780 字 → L=136.5s > 130s），必然再次失败。
- 修复（阈值与分级一律不变，只改计费语义与解析口径）：
  - `src/agents/scriptAgent/skeletonChecks.ts`：新增份额模型（`ChapterUsage`/`ChapterShareSource`/`buildChapterSharePlan`/`applyChapterSharePlan`）——同一章全剧分集份额合计 ≤1.0；四级推导「显式标注（片段词/`(a/b)`/`p%`/全章）→ 按场次占比 → 按引用集数等比推断 → 单集整章引用」；超配按比例归一、未分配 >10% 出提示；`estimateEpisodeCapacity` 新增可选 `sharePlan` 参数（不传时保持旧权重口径，兼容既有单测）；`parseSkeletonEpisodesDetailed` 在两份结果并存时取更完整的一份（并列取总览表）并输出缺号差异；模式B 新增读取「章节处理」列，模式A 跳过「顺延/移至」行；报告新增《解析来源与份额推断》小节与每集份额摘要；新增 `collectSuspiciousFragmentLabels`（`第1章上半` 等疑似写法提示）。
  - 技能：`data/skills/script_execution_skeleton.md` 新增《章节片段/份额标注》协议（三种写法 + 预算换算 246-503/≤657/>743 字）、模式B 硬性规则#5 对齐判定器读列、自查清单加「同章份额合计 100%」「展开段集号与总览表一致」；`script_agent_decision.md` 集数改按台词素材量推算（÷400 舒适、÷503 全达标、÷657 零阻塞、≥246 防不足）+ 门禁优先级（先补标注，再拆并删；不得用扩容代替核算）+ 自动重派上限 2 轮 + 禁止 780-800 类目标；`script_agent_supervision.md` 要求原样引用解析来源/份额推断，「展开段缺号」不得判为集号断裂，「推断份额」不得作为改判依据。
  - 新增只读回放脚本 `scripts/replaySkeletonChecks.ts`（`npx tsx scripts/replaySkeletonChecks.ts [projectId] [--legacy]`）。
- 校验：`npx tsx --test`（scriptAgent 四个测试文件）**43/43 通过**（骨架 16 例，含新增 7 例：场次四集共章、显式比例/百分号/整章/处理列、单集整章不洗白回归、双模式择优、跨章+顺延、未分配余量与超配归一、报告解析来源小节）；`npm run lint`（tsc --noEmit）通过。
- 回放验收（只读）：`npx tsx scripts/replaySkeletonChecks.ts 1791424159979 --legacy` → 《摆摊》28 集骨架由「严重超载 19 集（历史报告）/ 14 集（旧口径同清单复算）」变为**严重超载 1 集（EP28 第12章全章 669 字，L=117.1s / T=159.1s，属真实超载）**、轻度 0、素材不足 15、通过 12；另有 11 条「份额超配已归一」提示（场次标注重叠，需补标注）。收敛建议：全达标下限 ≈15 集、零阻塞下限 ≈12 集（须逐集声明份额）、舒适中心 ≈18 集、集数不宜超过 29 集。
- 生效：本项目 `start.bat` / `restart-backend.bat` 均以 `npm run dev`（tsx 直跑 `src/`）启动后端，技能为运行时读盘；**重启后端**后新口径生效。`data/serve/app.js` 是 `npm start` 的 esbuild 产物，本次**未重建**（本机启动链不经过它）；若将来改用生产模式启动，需先 `npm run build`。
- 回滚：`src/agents/scriptAgent/skeletonChecks.ts(.test.ts)` 与 `scripts/replaySkeletonChecks.ts` 为**未跟踪文件**（`git status` 显示 `??`），需手工还原/删除；`data/skills/script_execution_skeleton.md`、`data/skills/script_agent_decision.md`、`data/skills/script_agent_supervision.md`、`src/agents/scriptAgent/tools.ts` 已跟踪，可 `git checkout -- <path>` 回退。最小回退口径：在 `runSkeletonChecks` 中去掉 `buildChapterSharePlan/applyChapterSharePlan` 与 `sharePlan` 传参、`parseSkeletonEpisodes` 恢复为旧的两模式逻辑即可回到旧判定。
- 遗留议题（不在本轮范围）：骨架侧按采用率 0.7 计费、剧本侧要求原文台词逐字保留，两阶段口径不一致（骨架达标不等于剧本不超时），建议后续单独立项决定是否给骨架阶段正式的删减/改写授权与配比。
- 注意：`npm run dev` 的 tsx 已解析 `tsconfig` 的 `@/` 别名；回放脚本刻意绕开 `runSkeletonChecks` 的读库入口（避免引入 `@/utils`），直接以只读连接读取 `db2.sqlite` 后复用生产同款纯函数，结论与线上一致且无写入。

## 2026-10-10：分镜层容量闸门与台词事实层（消除"台词丢失"死循环）

- 需求与问题：分镜阶段审核连续 4 轮报"台词丢失"（D→C→C→C，第 4 轮自述"均为上轮漏检"），逐轮由用户手工选择修复方向；同时存在反向推力（机器校验要求"34 字台词配 5.3s"改为拆镜或延长到 ≥10.7s，两种修复都在加时长）。
- 根因（只读复算，逐项可复现）：
  - ① **三层容量口径不一且分镜层无"单集总闸"**：同一集 EP01——骨架按采用率 0.7 规划 ≈110.8s、剧本折算 128.7~158.9s（骑线被"接受现状"放行）、分镜逐镜实测 **217.3s / 61 镜 / 13 片段**。`storyboardChecks` 只有单镜/单片段级判定（片段 12/17s 档位、台词镜时长、无台词镜），片段数 ≤8 仅提示级，**没有单集合计校验**，因此 217.3s 的产物在机器侧是"阻塞 0 项"。
  - ② **唯一能拦住的硬红线是监督层 LLM 的"台词完整性"**（`production_agent_supervision.md:196`），比对靠模型自行"提取剧本台词→逐条核对"，无事实层、无上轮清单 → 清单漂移、真丢与假报混杂（逐条复核：剧本 39 句台词实际全部在位，第 4 轮点名"缺失"的 6 句都在镜 31/32/15/16/17/43）。
  - ③ **例外无登记**：剧本阶段"接受现状"只存在于会话记录，下游不可见，于是分镜仍按 100~130s 验收。
  - ④ **真实病理与报告口径相反**：新事实层实测本集"台词净时长下限 93.2s ≤ 130s（装得下）"、**非台词（动作/环境）占用 ≈124.1s** —— 超出的 87.3s 应从动作镜/片段压缩或拆集解决，**根本不该拿台词开刀**；而审核链一直在报"台词丢失"，把修复引向了错误方向。
- 修复（阈值与既有红线一律不动，只补事实层与闸门）：
  - `src/agents/productionAgent/storyboardChecks.ts`：
    - 配置新增 `episodeTarget`（100/130s、严重线 130×1.2+1=157s、不足线 85s、1s 容差）与 `coverage`（相似度 0.85、短句阈值 5 字、拆镜窗口 3、明细上限 6）；`segmentBudget` 增加 `blockingSegments: 10`。
    - 新增纯函数：`collectEpisodeFacts`（逐镜求和 + 台词字数/标点/台词镜数）、`collectStoryboardDialogueUnits`、`scriptSpokenLines`（剔除剧本场记注释【…】、补捞"角色（超长情绪）：台词"被解析器归入 other 的行）、`checkDialogueCoverage`（逐字一致 / 拆镜承载 / 疑似改写 / 缺失 / 分镜额外 五分类，哈希精确匹配 + 2~3 镜拼接 + 阈值模糊匹配）。
    - 检查新增：**单集合计时长**（>157s 阻塞、>130s 骑线、<85s 提示）、**容量缺口**（台词净时长下限超预算 = 阻塞并给出"需删减 ≥N 字台词"）、**片段预算分级**（>8 骑线、>10 阻塞）、**台词覆盖度**（缺失 = 阻塞、疑似改写 = 骑线、分镜额外 = 提示，拆分合规不报）。
    - 报告新增《单集容量事实层》《台词覆盖度事实层》两个小节 + 豁免回显；`runStoryboardChecks` 增加可选 `options.script/waivers`，并新增 `loadStoryboardCheckContext` 供构建期复用。
  - 例外登记：`src/utils/productionFlow.ts` 新增 `appendProductionFlowWaiver`（patch 合并 + 事务 + 回读校验，最多保留 20 条）并在 `buildProductionFlowData` 暴露 `waivers`；`productionAgent/tools.ts` 新增 `add_flowData_waiver` 工具（**仅用户授权时调用**）与 `get_flowData("waivers")`。
  - 注入与回喂：`productionAgent/index.ts` 构建期与 ≤3 轮自动修复循环均携带剧本与豁免（新阻塞项自动进入 `buildBlockingRepairChecklist`）；监督层预注入沿用 `storyboardReportToMarkdown`（新小节自动随报告注入）。`supervisionLog` 的 category/severity 为自由字符串，无需改解析。
  - 技能：`production_agent_supervision.md` 台词完整性改为〔机器〕并强制引用事实层（拆镜合规、禁止自行提取比对），新增"单集容量"严重行；`production_execution_storyboard_table.md` 台词铁律加《单集容量预算》附则（单集可承载台词上限 ≈（130−无台词镜占用）×4 字/秒；超容量标准顺序：压动作镜→压片段→**报请授权删台词（登记豁免）**→拆集；严禁用删台词消化时长）并同步红线 3/11；`production_agent_decision.md` 增加"超容量标准三选一（拆集 / 回剧本删减需登记豁免 / 登记例外）"与"台词缺失只看工具事实层"。
  - 新增只读回放脚本 `scripts/replayStoryboardChecks.ts`（支持工作区复检与 `--file` 指定分镜表，输出事实层报告、旧口径对照与压缩/拆集清单）。
- 校验：`npm run lint`（tsc --noEmit）通过；单测 **66/66** 通过（分镜 18 例：新增单集合计/超上限骑线/豁免生效、容量缺口、台词覆盖度五分类、片段预算分级，既有 15 例回归并更新"片段预算"用例；监督 5 例；scriptAgent 43 例）。
- 回放验收（只读，复现 217.3s 历史产物的时长与台词结构）：单集合计 **217.3s（超出上限 87.3s，+67%）**、**13 片段（>10 段阻塞）**、台词覆盖 **逐字 38 / 拆镜 1 / 疑似改写 0 / 缺失 0 / 分镜额外 1（VO「三笔转账」）**；旧口径对照阻塞 2 项（仅台词镜时长与片段档位），本轮新增判定贡献 2 项；压缩建议：非台词占用 124.1s ≥ 需压缩 87.3s → **压缩动作镜即可达标**，拆集参考 2 集。
- 生效：本项目 `start.bat`/`restart-backend.bat` 走 `npm run dev`（tsx 直跑 `src/`），技能运行时读盘，**重启后端**后生效；`data/serve/app.js` 未重建（如需生产模式先 `npm run build`）。
- 注意（数据现状）：验收时发现工作区 `productionFlowData`（projectId=1791424159979, scriptId=1）已被重新生成流程重写为空表（updateTime 2026-10-10T10:53:49Z）且 `productionAgentRuntime` 会话已重置，历史 217.3s 产物仅存于本轮复现用的基线文件（系统临时目录 `%TEMP%\ep01-storyboard-baseline.md`，时长/台词取自历史提取，画面描述为占位）；如需按新闸门判定当时产物，可用该文件跑 `--file` 复检。
- 回滚：`src/agents/productionAgent/index.ts`、`tools.ts`、`src/utils/productionFlow.ts`、`data/skills/{production_agent_decision,production_agent_supervision,production_execution_storyboard_table}.md` 已跟踪，可 `git checkout -- <path>` 回退；`src/agents/productionAgent/storyboardChecks.ts(.test.ts)` 与 `scripts/replayStoryboardChecks.ts` 为未跟踪文件，需手工还原/删除。
- 遗留议题（本轮发现，未在范围内修改）：`scriptChecks.parseScriptEpisode` 会把剧本里的场记注释行（`【信息差类型：…】`）判成对白、并把"角色（超长情绪说明）：台词"归入 other（前者会虚增剧本阶段台词字数/时长折算，后者会漏计）；分镜侧已在 `scriptSpokenLines` 兜住，建议后续在剧本层一并修正。另有上轮遗留的"骨架 0.7 采用率 vs 剧本逐字保留"口径冲突，继续作为独立议题。
- 当前 EP01 的三条处置路线（待用户选择，本轮不改内容）：① 拆成两集（217.3s ≈ 2×108s，正好缓解骨架侧 15 集"素材不足"）；② 回剧本压缩到 ≤130s（需授权删减并登记豁免）；③ 维持现状并登记时长豁免后继续。

## 2026-10-10：单集容量通用规则框架（三层口径统一 + 拆集决策树 + 剧本端预演）

- 需求与问题：用户要求把"某一集装不下、连改四轮不收敛"升级为**通用规则框架**——任何剧本在写分镜前就能确定性地回答"能不能装下、装不下怎么改、改完是多少集"；并明确"**剧本端与分镜端必须是同一套标准**，避免剧本产出被分镜审核反复打回、越改越碎"。
- 根因（只读复算，逐项可复现）：三层各用一套台词时长口径——骨架层"台词字 × 采用率 0.7 ÷ 4 字/秒 + 42s 余量"（EP01 判 T≈103s 通过）、剧本层"连续朗读 4.5~5.5 字/秒"（EP01 判 105~130s 骑线）、分镜层"逐镜实测：字数÷4 + 0.4×标点 + 每镜 1s 缓冲"（EP01 台词安全 **155.6s**、预计 **195.6s** 必爆）。同一份素材三层差 ≈50%，"前面判通过、到制作才爆炸"必然发生；分镜端唯一能装下的办法只剩删台词或压字时比，于是出现 4 轮不收敛 + 内容被改碎。
- 修复（阈值一律未动，只统一口径并补齐决策路径）：
  - 新增共享容量模型 `src/agents/shared/episodeCapacity.ts`（三层唯一真源，纯函数）：台词下限 = 净字÷4.5 + 0.3×条数；台词安全 = 净字÷4 + 0.4×标点 + 1×条数；预计 = 台词安全 + 动作预算（常规 40s / 极限 24s）；容量反算 `C_max = 4×(130−动作−0.4×标点−条数)`；集数推算（物理下限 ⌈下限÷106⌉ / 舒适 ⌈安全÷90⌉ / 上限 ⌊下限÷44⌋）；三态（通过 / 可骑线执行 / 建议拆集（骑线占比 >40%）/ 必拆（下限+24s >130s）/ 素材不足）；语义边界拆集算法 `planEpisodeSplit`（场→节拍→对话轮次，DP 最小代价，硬约束每集 ≤130s 且 ≥85s）；兼容旧数据（缺条数/标点按字数推断并标注「推断」）。
  - 骨架层 `skeletonChecks.ts`：去掉自建的"采用率 0.7 / 计划语速 4 / 余量 42"，改为调用共享模型；`ChapterStat` 增加 `quoteLines/quoteMarks`（新增 `countQuoteStats`/`countMarks`）；逐集输出条数/净字/标点、L/T、制作侧三态、建议拆集数、授权删减反算字数、全剧集数建议与拆集投影；报告新增《容量查表》与处理口径。
  - 剧本层 `scriptChecks.ts`：新增《下游口径预演（与分镜端同一把尺子）》小节——逐集三态 + 建议拆集数 + 《拆集方案表》；「必拆/建议拆集」计入阻塞（`summary.capacitySplit`），「可骑线」只提示；同时修掉两处解析缺陷（场记注释行 `【…】` 被当成对白虚增字数、`角色（情绪括注）：台词` 被漏计）。
  - 制作层 `storyboardChecks.ts`：新增事实指标「字时比（骑线占比 = 低于安全线的台词镜 / 台词镜）」与《拆集建议》（提示级、不阻塞，仅在"拆了确实能解决"时给出）；判定口径行写明"骑线不阻塞、不得用删台词/压语速消化"。
  - 监督与工具：`productionAgent/supervisionLog.ts` 注入新增"骑线不得作为返工理由 + 容量不够的正确顺序（拆集→压动作镜→授权删减→豁免）"；`scriptAgent/tools.ts` 骨架体检回执增加"建议/必须拆集 N 集"与统一口径描述；两个只读回放脚本改用共享模型（消除第二套公式）；新增 `scripts/replayEpisodeCapacity.ts`（任意剧本容量预演 + 自动拆集方案 + `--cut=` 人工切点对比 + 全剧集数建议）。
  - 技能 7 份同步：`script_execution_skeleton.md`（预算按「条数+净字数+标点」三项、容量查表、超载决策树、禁止假修复）、`script_agent_decision.md`（集数公式换共享模型、骨架门禁改"拆集优先"）、`script_execution_script.md`（时长控制与确定性检查配合改为下游口径三态）、`script_agent_supervision.md`（模板加下游口径预演、骑线不返工）、`production_execution_storyboard_table.md`（附则改为统一公式 + 压动作→拆集→授权删减→豁免顺序）、`production_agent_decision.md`（超容量四步顺序）、`production_agent_supervision.md`（骑线占比/拆集建议为提示级）。
- 校验：`npm run lint`（tsc --noEmit）通过；单测 **90/90** 通过（新增共享模型 12 例、骨架层 2 例更新、剧本层新增 3 例、制作层新增 2 例；含"三层口径一致（同一素材差异 ≤5%）"一致性用例）。
- 试点验收（只读，`npx tsx scripts/replayEpisodeCapacity.ts 1791424159979`）：
  - 《照野炸串》EP01（39 条 / 351 净字 / 72 标点）：台词下限 89.7s、台词安全 155.6s、预计 **195.6s** → 三态 =**建议拆集**（骑线占比 ≈100%，等于全片压语速）；工具给出拆 2 集方案：新EP01 = 第28~50行（18 条/190 字 → 118.7s 通过）、新EP02 = 第52~87行（21 条/161 字 → 116.9s 通过），各约 7 段、18~21 个台词镜 + ≈8 个动作镜；人工备选切点（第59行电话挂断后）= 146.3s（骑线 37%，可执行不阻塞）+ 89.3s（贴 85s 线）——两案对照可直接给用户选。
  - 全剧复算：原著 749 条 / 6233 净字 / 1105 标点 → 逐字保留下**物理下限 16 集、舒适 31 集、上限 36 集**；逐章"至少需"合计 36 集（第1章 4 集、第2章 4 集、第3章 3 集…）；即 19 集方案在逐字保留口径下不成立，须授权删减约 2400 净字（≈38%）或把集数提到 31 集左右。
- 生效：`src/` 与 `data/skills/` 均为 dev 直跑（`npm run dev`），**重启后端**后生效；`data/serve/app.js` 未重建（生产模式启动前需 `npm run build`）。
- 回滚：`src/agents/shared/`、`src/agents/productionAgent/storyboardChecks.ts(.test.ts)`、`src/agents/scriptAgent/{scriptChecks,skeletonChecks}.ts(.test.ts)`、`scripts/replay*.ts` 为**未跟踪文件**，需手工删除/还原；`src/agents/scriptAgent/tools.ts`、`src/agents/productionAgent/supervisionLog.ts`、`data/skills/*`（7 份）已跟踪，可 `git checkout -- <path>`；最小回退口径：把三层 `estimate*Capacity` 改回各自旧公式、移除共享模块引用即可恢复旧判定（阈值与报告字段均为增量，无破坏性改动）。
- 待用户决策（本轮不落内容）：① 骨架按新口径修订（推荐：第1章前半 50% 拆为 25%+25%、原集2 顺延 → 19→20 集；坚持 19 集需先授权删减）；② EP01 切点选"工具最优（电话中段，零骑线）"还是"电话挂断后（情节完整，上集骑线 37%）"；③ 是否按全剧舒适 31 集重排骨架。

## 2026-10-10（补）：剧本端 ↔ 分镜端 ↔ 审核端口径冲突排查

- 需求：用户要求复检"剧本生成 / 分镜改编 / 审核"三端是否还会互相打架（避免剧本产出被分镜审核反复打回、越改越碎）。
- 查出的 6 处真实冲突与修复：
  1. **集数口径冲突（最严重）**：骨架 19 集，而 `scriptAgent.targetEpisodes` 仍是陈旧 12 集；保存骨架时 `resolveTargetEpisodes(mergedData)` 走"已存字段优先"，导致**新骨架集数永远刷不进配置**——进度分母、批次调度（生成到 EP12 就判定"全部完成"）、骨架监督"分集数恰好等于项目配置集数"三项全线错位。修复：新增 `progress.resolveTargetEpisodesOnSave`（保存骨架时以新骨架内容为准，解析失败才回退已存字段；其他产物维持已存优先），`scriptAgent/index.ts` 接入，新增单测。
  2. **长台词拆镜导致剧本预估必然偏小**：剧本层按"1 条 = 1 镜"折算（乐观），分镜端对 >20 字台词**强制拆镜**，每多一镜多占 1 秒安全缓冲（EP01 实测 +3 镜 ≈ +4s）→ 剧本"通过"仍可能被分镜实测判骑线/超时。修复：`DialogueTiming` 增加 `shots/splitShots/splitSafeSeconds` 与 `describeSplitOverhead`，三层报告输出《预排余量》；技能写入"**预排目标 ≤125 秒**（不贴 130）"。
  3. **分级词汇两套并存**：骨架层 `level` 只看 L/T，而三态含"骑线占比 > 40% = 建议拆集"，会出现同一集既"轻度超载"又"必须拆集"。修复：`splitPressure` 并入 `severeOver`；报告判定口径行补齐 4 个阻塞条件（L>130 / T>157 / 骑线占比>40% / L+24s>130）。
  4. **场数无约束 vs 片段预算**：骨架预算字段要求"场数 ≤4"，剧本技能却没写；下游每集 ≤8 段（>10 段阻塞），场次过密会直接顶穿片段预算。修复：剧本技能写入"单集场数 ≤4 场（每场 1~2 段）"。
  5. **已授权例外被反复拦**：用户已授权删减/登记豁免后，工具仍照常报"必拆/超限"，监督可能反复要求拆集或二次删减。修复：剧本监督写入"已授权例外不得反复拦、按授权来源放行并标注"与"集数一致性以骨架为准"。
  6. **制作层《拆集建议》可能被埋没**：修复：监督注入要求拆集建议必须进「需要您决定」（A 拆集 / B 维持骑线继续 / C 授权删减）。
- 核对确认**无冲突**的项：归一化阈值（100/130/157/85、40s/24s 动作预算、12/17 档、8/10 段、46 字、无台词镜 6/7s）三层同源；台词镜时长 hard/safe 公式与分镜实测同系数；OS/VO 两层都计入台词；台词逐字保留与覆盖度（缺失=阻塞、拆镜承载合规）一致；机器阻塞不可被审核降级（`buildSupervisionVerdict` 取 `max(LLM, 机器)`，定点修复范围会并入机器阻塞场）；长台词拆镜窗口与覆盖度 `splitWindow=3` 兼容（≤60 字原文最多拆 2~3 镜）。
- 端到端验证：骨架层 EP01 预估 **188.3s** ↔ 剧本层实测 **195.6s**（差 **3.9% ≤ 5%**），"前面判通过、到制作才爆炸"的口径断裂已消除；骨架 19 集复检全部按新口径判"严重超载 / 建议拆集 2 集"，与全剧舒适 31 集结论自洽。
- 校验：`npm run lint` 通过；单测 **91/91** 通过（新增 `resolveTargetEpisodesOnSave` 用例）。
- 回滚：同上一节；本轮增量集中在 `progress.ts`(+test)、`scriptAgent/index.ts`、`episodeCapacity.ts`、三层 check 的报告行与 3 份技能，均可按文件回退。

## 2026-10-11（补二）：份额解析漏读「片段词（p%）」导致骨架门禁无限阻塞

- 现象（用户反馈）：生成集数规划（骨架）时多轮修改仍持续报阻塞，决策层连续两轮"定向修复份额标注"均未闭环，并把它当成根因。
- 根因（只读取证 + 逐项复算）：骨架总览表把份额写成 **`第1章 前段（28%）`** 这种"片段词 + 括号百分比"形式，每章三集百分比合计**正好 100%**（声明规范）；但 `CHAPTER_USAGE_PATTERN` 只认同紧随章号的裸 `p%` / `(a/b)` / 裸片段词，**中文括号里的百分比读不到**，于是退回按片段词权重计费（前段 0.5 / 中段 0.34 / 后段 0.33 / 收束 0.2）→ 同章三集相加 117%（第7章 137%）→ 工具报"份额超配"并归一 →
  - **虚报超载**：EP01 被按 43% 计（真值 28%）→ 报 166.6s 严重超载（**真值 183 字/22 条 → 123.0s 通过**）；EP15、EP28 同理；
  - **漏报超载**：EP04/EP05 被按 29% 计（真值各 40%）→ 报"轻度超载 134/131s"（**真值各 290 字/35 条 → 169.1s 严重超载**）；EP03 真值 211.0s 却被报成 261.5s；
  - **决策层误判**：把工具的"份额 117%"当成根因 → 每轮改的都是"工具读不到的那串数字" → 复检输出恒定 → 无限阻塞。
- 修复：
  1. `skeletonChecks.ts`：章节使用声明改为「章号 + 尾部整段」解析（尾部到下一个「第X章」为止，允许 `第N场` 在内），`(a/b)`/`p%`（半角全角、可带括号）/片段词/整章/场次全部在尾部提取；**显式百分比优先于片段词权重**（片段词退化为语义标注）；解析前归一 Markdown 强调符（`**前半**` 不再干扰）；超配告警文案改为"声明值 + 常见原因（裸片段词 0.5+0.34+0.33=117%）+ 正确改法（改写显式百分比）+ 不要反复修改已被正确识别的标注"。
  2. 技能：`script_execution_skeleton.md` 份额协议改为"**首选 片段词 + 显式百分比**（`第1章 前段（28%）`）"，裸片段词降级为兜底并注明是容量权重、同章相加会自然超 100%；`script_agent_decision.md` 门禁处理优先级补"先读《解析来源与份额推断》核对**实际计费份额**，解析值与声明不一致先修写法、不要把归一当根因"。
  3. 工具：`scripts/replaySkeletonChecks.ts` 新增 `--file <path>`（复检任意骨架文本）；新增样例 `scripts/fixtures/skeleton-shares-sample.md`（复现"片段词+百分比"写法，含期望判定）。
- 校验：`npm run lint` 通过；单测 **93/93** 通过（新增 2 例：`片段词+括号百分比时以百分比计费`、`同章三集 28/36/36 不误报超配`；既有 18 例骨架用例含"跨章引用/超配合计归一"全部回归）。
- 复检验收（`npx tsx scripts/replaySkeletonChecks.ts 1791424159979 --file scripts/fixtures/skeleton-shares-sample.md`，样例复现该写法）：声明列已正确显示 `EP01(28% 前段)/EP02(36% 中段)/EP03(36% 后段)`，**归一后合计 100%、无超配告警**；判定 = EP01 **通过 123s**、EP02 可骑线 37%、EP03 **严重超载 211s**、EP04/EP05 **严重超载 169.1s**（与人工复算逐项一致）。即：**假阻塞消失，真阻塞如实暴露**。
- 注意（数据现状）：本轮复检时发现项目 `1791424159979` 的工作区已于 04:03 被重置（`scriptAgent.storySkeleton` 清空、`scriptAgentRuntime` 会话重置、`o_script` 0 条、`productionFlowData` 已删），因此无法对那份 36 集骨架直接复检；改用等价样例固定证据，**下一次生成即真实验收**。
- 回滚：`src/agents/scriptAgent/skeletonChecks.ts(.test.ts)`（未跟踪文件，需手工还原）、`scripts/replaySkeletonChecks.ts`、`scripts/fixtures/skeleton-shares-sample.md`、`data/skills/{script_execution_skeleton,script_agent_decision}.md`（已跟踪，可 `git checkout --`）。

## 2026-10-11（补三）：DeepSeek 官方默认开启思考并取最高档 max

- 需求：用户确认让 DeepSeek 官方（生成故事骨架及全部绑定 DeepSeek 的 Agent 调用）**默认开启思考且取最高强度 max**；不改前端/UI，允许重启后端生效。
- 根因：调用侧 `src/utils/ai.ts:77` 只传模型对象（`fn(selectedModel)`），供应商模板的 `think`/`thinkLevel` 恒为 `undefined` → `enableThinking = model.think && think` 为假 → 请求体固定 `thinking: { type: "disabled" }` 且从不发送 `reasoning_effort`（模板中 0/1/2→high、3→max 的映射从未触发）。生产页「思考级别」只经 socket 写入后端 `thinkConfig` 且无消费方（死开关），剧本页无该控件。
- 改动：`data/vendor/deepseek.ts`：`textRequest = (model, think: boolean = true, thinkLevel: 0|1|2|3 = 3)`（未传参 → `thinking:{type:"enabled"}` + `reasoning_effort:"max"`，显式传参仍可覆盖）、导出类型改为可选参数、同步档位注释；`@version` 与 `vendor.version` 2.1 → 2.2，触发启动同步（`src/lib/initDB.ts`）把库内 `o_vendorConfig.deepseek.code` 升级；`inputValues`（库内优先）与 `models`（库内非空不覆盖）保持原样。
- 备份：`data/backups/o_vendorConfig_deepseek_backup_2026-10-11T07-01-57-024Z.json`（改前整行，含 code/inputValues/models）。
- 校验：
  1. 临时脚本（sucrase + vm2 复刻启动加载路径，验证后已删除）**15/15 断言通过**：默认调用与显式 `undefined` 均得到 `thinking:{type:"enabled"}` + `reasoning_effort:"max"` 且原请求体字段（model/messages）保留；`think=false` → `disabled` 且无 `reasoning_effort`；`thinkLevel=0/2 → high`、`=3 → max`；`model.think=false` → `disabled`。
  2. 重启后端（10588）后只读查库：库内代码版本 **2.2**、含新默认签名与注释；`inputValues` 中 `apiKey` 与 `baseUrl=https://api.deepseek.com/v1` 原样；models（deepseek-v4-pro / deepseek-v4-flash / deepseek-flash，均 think:true）原样。
  3. 真实请求：经 `/api/login/login` + `/api/setting/vendorConfig/modelTest`（deepseek:deepseek-flash）发起一次真实调用，返回成功（工具调用结果正常），确认 DeepSeek 官方接受 `thinking enabled + reasoning_effort max`。
  4. 端到端：以真实 socket（`/api/socket/scriptAgent`，项目《摆摊》1791424159979）发送「生成故事骨架」，成功进入 `workflowStatus.phase=storySkeleton` 并持续流式输出；任务与连接解耦，断开后仍在后台继续并把产物写入工作区（用户选择不等待，最终产物以剧本页工作区为准）。
- 生效：重启后端已生效（`getVendorTemplateFn` 每次请求读库内代码）；未改前端与 `thinkConfig`；`data/serve/app.js` 未重建（当前启动链为 `npm run dev`）。
- 回滚：① 还原 `data/vendor/deepseek.ts`（`git checkout -- data/vendor/deepseek.ts`，或手工改回 2.1 并移除默认值）；② 同步只升不降，需用备份 JSON 把旧 `code` 回写 `o_vendorConfig.deepseek.code`；③ 重启后端。
- 备注：思考开启后响应耗时与思考 token 消耗上升属预期；Agent 侧只消费 `textStream`，思维链不展示，无 UI 变化。后续若要给 UI 接档位，需要把 think/thinkLevel 从 `AiText` 透传到 `textRequest`（当前未接线；模板已保留显式传参覆盖能力）。

## 2026-10-11（补四）：取消「思考级别」选项，文本请求统一默认最高思考档

- 需求：用户要求取消生产页设置菜单里的「思考级别」下拉（关闭思考/快速思考/深度思考），以后一律按 max 思考强度处理。已确认三项范围：① 同时重建并同步后端内置前端 `data/web`；② 所有支持的供应商都按各自最高档适配；③ 一并清理后端已死的 `thinkConfig` 通道。
- 改动：
  1. 前端移除：`Toonflow-web/src/views/production/index.vue` 删除「思考级别」行（下拉 + `settingMenuControl`）、`thinkLevelOptions`、`handleThinkLevelChange` 与 `storeToRefs` 解构中的 `thinkLevel`；`Toonflow-web/src/stores/productionAgent.ts` 删除 `thinkLevel` ref、`updateThinkConfig` 及 return 导出。全仓已无 `thinkLevel/updateThinkConfig` 引用。
  2. 后端固化默认档：`src/utils/ai.ts` 新增 `TEXT_THINK_DEFAULT = { think: true, thinkLevel: 3 }`，`textRequest` 调用改为 `fn(selectedModel, TEXT_THINK_DEFAULT.think, TEXT_THINK_DEFAULT.thinkLevel)`（唯一开关，图片/视频/语音不受影响）；删除 `src/socket/routes/productionAgent.ts` 的 `thinkConfig` 变量、ctx 字段与 `updateThinkConfig` 监听，删除 `src/agents/productionAgent/index.ts` 的 `AgentContext.thinkConfig` 字段。
  3. 供应商模板（`data/vendor/*.ts`）按模型族适配：deepseek 2.2 保持（enabled + max）；atlascloud 1.1 默认 `think=true, thinkLevel=3`（最高 high）；volcengine 2.5 由「无条件注入」收紧为白名单 `/doubao-seed-2|doubao-1-5-thinking|glm-4-[78]/` 注入 `thinking` + `reasoning_effort`（deepseek-v3 / doubao-1.5-pro 等非思考模型不注入）；openai 2.1 新增 fetch 注入 `reasoning_effort`（仅 `/^gpt-5/`，0/1/2/3 → minimal/low/medium/high，body 已有该字段不覆盖）；claude 2.1 新增 fetch 注入 `thinking:{type:"enabled",budget_tokens}`（档位 1/2/3 → 8000/12000/16000）并在缺省时补 `max_tokens:32000`（已有 max_tokens ≤ budget 时跳过注入）；minimax / toonflow 仅同步库内代码（M2 系列本身强制思考、中转仅 deepseek 模型取 max，其余模型族保持原样）。
  4. 库内代码同步：volcengine/minimax/toonflow/claude 库内为旧版且**无版本号**（启动同步不会升级）→ 停后端后手工回写 `code`（改前逐行备份）；openai/atlascloud 靠 bump 版本 + 重启走启动同步自动升级；deepseek 不变。
  5. 前端产物同步：Toonflow-web `npm run build-only`（2m20s）→ `dist`（index.html 17,670,888B + 4 个 worker）覆盖 `Toonflow-app/data/web`（改前备份 `data/backups/web_backup_20261011-154540`）。
- 验证：
  - 离线断言（sucrase + vm2 桩，验证后已删除，全部通过）：deepseek = enabled + max；atlascloud = enabled + high；volcengine = doubao-seed-2 / glm-4-7 = enabled + high，deepseek-v3 / doubao-1.5-pro 不注入；openai = gpt-5* → high（已有值不覆盖）、gpt-4.1 不注入；claude = enabled + budget + max_tokens（已有小 max_tokens 时跳过）；minimax = reasoning_split；toonflow deepseek = enabled + max、其余不注入。
  - 库内一致性（只读）：7 家供应商 `code` 与内置模板逐字一致，版本为 deepseek 2.2 / atlascloud 1.1 / volcengine 2.5 / openai 2.1 / claude 2.1 / minimax 2.1 / toonflow 3.2；`inputValues`（密钥/地址）与 `models` 未被改动。
  - 真实请求（应用自身 `/api/setting/vendorConfig/modelTest`）：`deepseek:deepseek-flash` 成功；`openai:gpt-5.6-sol`、`openai:gpt-5.5` 成功（说明注入的 `reasoning_effort` 被上游网关接受）；`openai:gpt-5.4` 报 `model_not_found`（网关返回 “Model gpt-5.4 is not available for this group”），与本次改动无关，属既有模型清单与网关可用性不匹配。
  - 页面复核（playwright-cli）：**50188 开发页与 10588 内置页**的生产 Agent 设置菜单均只剩「重新连接 / 清除消息记忆 / 清除摘要记忆 / 清除所有记忆」，「思考级别」已消失；新产物中 `思考级别/关闭思考/快速思考/thinkLevel/updateThinkConfig` 计数均为 0，`一键修复` 仍在（4 处）。注意新产物中仍有 4 处「深度思考」，来自供应商配置页的模型标记文案，与本次移除的下拉无关。
  - `npm run lint`（tsc --noEmit）通过。
  - 其它无 apiKey 的供应商（火山/MiniMax/Claude/AtlasCloud/中转）仅离线断言，未做真实请求。
- 生效：后端已重启（手工回写 + 启动同步均生效）；50188 开发页 HMR 即时生效；10588 内置页为静态文件，刷新即可。
- 回滚：前端 `git checkout -- Toonflow-web/src/views/production/index.vue Toonflow-web/src/stores/productionAgent.ts`；后端 `git checkout -- Toonflow-app/src/utils/ai.ts Toonflow-app/src/socket/routes/productionAgent.ts Toonflow-app/src/agents/productionAgent/index.ts`；供应商模板 `git checkout -- Toonflow-app/data/vendor/{deepseek,atlascloud,volcengine,openai,claude}.ts` 并用备份 JSON 回写库内 `code`（`data/backups/o_vendorConfig_*_backup_2026-10-11T07-43-34-769Z.json`；同步只升不降）；内置前端用 `data/backups/web_backup_20261011-154540` 覆盖回 `data/web`。

## 2026-10-11（补五）：OpenAI 标准接口（自定义网关）思考档位适配 v2.2

- 需求：用户追问「glm-5.3 的思考档位是什么」，并确认要针对**自定义 OpenAI 兼容网关**（该渠道挂在本项目的 `openai`「OpenAI标准接口」供应商下，`baseUrl=https://api.hctopup.com/v1`）按网关实际支持的参数适配。
- 排查结论（只读）：
  - 全仓检索：项目内**不存在 glm-5.3**；现有 GLM 仅火山的 `glm-4-7-251222` 与 AtlasCloud 的 `zai-org/glm-5.1`。
  - 实探网关 `GET /v1/models`（用库内 apiKey）返回 9 个模型：`gpt-5.5`、`gpt-5.6-luna/sol/terra`、`gpt-6-astra/luna/sol`、`gpt-6.1-sol`、`codex-auto-review` —— 无 GLM 系列。
  - 旧模板族匹配 `/^gpt-5/` **不覆盖**网关实际提供的 `gpt-6.x / gpt-6.1`；库内模型清单仍是 `gpt-5.5 / gpt-5.6-sol / gpt-5.4`（其中 `gpt-5.4` 网关不提供，上一轮实测报 `model_not_found`）。
- 改动（`data/vendor/openai.ts` v2.1 → **2.2**）：
  - 思考模型族匹配放宽为 `/^(gpt-[5-9]|o[3-9]|glm-[45]|deepseek-v[3-9]|kimi-k[2-9]|minimax-m2)/i`（`gpt-4o/gpt-4.1` 等非思考模型仍不注入；保留 `think !== false` 语义）。
  - 按族选择注入形态：OpenAI 系（gpt-5+/o/kimi/minimax）→ `reasoning_effort`（0/1/2/3 → minimal/low/medium/high）；GLM 系 → `thinking:{type:"enabled"}`（智谱语义无 effort 档位，**glm-5.3 一旦出现在任何网关即按此处理**）；DeepSeek 系 → `thinking:{type:"enabled"}` + `reasoning_effort`（0/1/2→high、3→max）。合并顺序 `{ ...注入字段, ...rawBody }`，调用方已有同名字段不覆盖。
  - 自愈回退：注入版被上游以 400/422 拒绝时，用原始请求体重试一次并 `logger()` 记录「[openai] 上游拒绝思考参数，已回退原样请求: <model>」；其它状态码（如 500）不回退。
  - 头注释与 `checkForUpdates().latestVersion` 同步为 2.2。
- 库内同步：整行备份 `data/backups/o_vendorConfig_openai_backup_2026-10-11T10-32-16-672Z.json`；模型清单 3 条 → **9 条**（改为网关实有模型、移除网关不提供的 `gpt-5.4`、think 标记置 true 便于配置页显示深度思考）；`code` 由重启触发的启动同步自动升级为 2.2；`inputValues`（apiKey/baseUrl）未改动。
- 验证：
  - 离线断言（sucrase + vm2 桩，验证后删除）**30 项全部通过**：gpt-5.5 / gpt-6.1-sol → `high`；gpt-6-astra level2 → `medium`；level0 → `minimal`；glm-5.3 / glm-4.7 → `thinking:{type:"enabled"}` 且不带 `reasoning_effort`；deepseek-v4-pro → thinking + `max`、flash level1 → `high`；gpt-4o / gpt-4.1 / codex-auto-review / `think=false` 不注入；已有 `reasoning_effort`/`thinking` 不被覆盖；400 与 422 回退（第二次请求为原始 body、返回第二次响应、写 1 条日志）；500 不回退（1 次请求、原样返回、无日志）。
  - 真实调用（应用模型测试接口）：`openai:gpt-5.5` 与 `openai:gpt-6-sol` **均成功**；应用日志中「已回退原样请求」为 0 条 → 注入的 `reasoning_effort` 被网关接受（含本次新增匹配的 gpt-6 族）。
- 生效：后端已重启（启动同步已把库内 openai 代码升级为 2.2）；不涉及前端，**无需重建 data/web**。
- glm-5.3 结论：当前网关不提供该模型；本次适配后，只要任何自定义网关（挂在「OpenAI标准接口」供应商下）提供 `glm-5.x`，即自动注入 `thinking:{type:"enabled"}`；若网关不认识该参数，会自动回退为原样请求（保证可用性，仅丢思考档位）。
- 回滚：`git checkout -- Toonflow-app/data/vendor/openai.ts` + 用备份 JSON 回写 openai 行 `code`/`models` + 重启后端。

## 2026-10-11：画内文字被当成说话角色（视频工作台「一键修复」无法闭环）

- 现象：视频工作台推理视频提示词时返回 400「说话角色缺少独立角色参考，已停止推理以避免复制脸或串台：片段一：摊车灯牌文字、片段一：刘鹏消息文字」，点击「一键修复」永不成功（轮询 10 分钟后变「继续修复」）。
- 根因（会话与库内数据双重证据）：该剧集分镜表把屏幕/招牌/短信类文字信息写在台词列，写法是 `VO（摊车灯牌文字）：『照野炸串』`、`VO（刘鹏消息文字）：『你先别激动。』`、`VO（转账截图上文字）：…`、`VO（手机来电显示）：『许曼青』`、`（VO）银行流水文字：…`。而画内文字识别只白名单 `日历|画面|屏幕|招牌|纸张|海报|字幕|标题` + `文字：` 七个前缀，`摊车灯牌文字`/`刘鹏消息文字`/`手机来电显示` 全部漏判 → 冒号前整段被当成说话人 → 命中"说话角色缺少独立角色参考"拦截。
- 「一键修复」必然失败的原因：拦截只认 `role` 类型资产，而生产 Agent 正确地把这两项判定为**道具类文字元素**（`tool`），新建资产 14/15「摊车灯牌文字」「刘鹏消息文字」并追加绑定到分镜 1（回读 `verified=true`）——`tool` 类型不参与说话人参考比对，因此 `checkSpeakerReferences` 永远不归零。这不是 Agent 执行错误，而是判定口径把"画面文字来源"当成了"说话角色"。
- 修复（判定口径，非打补丁绕过）：
  - 新增共享模块 `Toonflow-app/src/utils/onScreenText.ts`：`extractOnScreenText()` 支持 ①任意来源标签 + `文字：`（`摊车灯牌文字`/`备注栏文字`/`银行流水文字`）；②显式 `VO（…）`/`（VO）…` 类型前缀下的屏幕/设备来源标签（`手机来电显示`/`屏幕`/`弹幕`/`聊天记录` 等）；`（VO）…` 写在括号外的写法与包裹引号（`『』`）一并归一化。裸写形式只认"…文字："，避免把 `老王：…` 这类普通对白误判成画内文字。
  - `speakerReferences.ts`：删除本地白名单实现，改用共享识别；`normalizeShot` 改为**逐段**处理（`<br>` 混写时只剔除画内文字段，其余台词照常解析说话人），画内文字汇总进 `onScreenText`，`speechAllowed=false`。
  - `videoTaskData.ts`：说话人自动补全（`extractSpeakerNames`）跳过画内文字段，避免拿来源标签去找同名角色资产、甚至复制出替身脸。
  - `videoPromptContract.ts`：H3 契约的期望台词排除画内文字（不再要求为它建立独立 Subject、也不再要求逐字进 `<d>`）；纯画内文字镜头在 `hasNoDialogue` 中按"无对白"处理（禁止模型据此添加对白/独白）。
  - 同类误判一并修掉：`SPEECH_SUFFIXES` 补 `内心/心声/自语/独白`，`OS（陈照野内心，低沉）：『那锅汤，我熬了三年。』` 不再被解析出"陈照野内心"这个假说话人（片段六/片段八原本同样会被拦截）。
- 验证：
  - 单测：`src/utils/speakerReferences.test.ts` 11/11、`src/utils/videoPromptContract.test.ts` 33/33 通过（新增画内文字、混写行、`OS（…内心…）`、纯画内文字镜头无对白四类用例）。
  - 真实项目数据：用分镜表 8 个片段（45 镜）+ 项目 7 个 role 资产实跑修复后的检测逻辑，**8/8 段无缺失说话人**（修复前片段一报 2 项、片段四/六/八各报 1 项）；运行包内同一逻辑复跑结果一致。
- 运行包：因 `data/serve/app.js` 含历史手工补丁、与源码其余部分并不同步，本次**采用就地补丁**（只改画内文字/说话人相关函数），未做全量重建；`node --check` 通过，补丁前备份 `data/backups/serve_app.js.backup-pre-onscreen-fix`。**需重启后端进程后生效**；前端未改动，无需重建 `data/web`。
- 遗留资产已按用户确认清理：14/15 号 `tool` 资产（「摊车灯牌文字」「刘鹏消息文字」）、图片记录与 `data/oss` 文件、分镜 1 上的两条绑定，统一用应用自身的 `removeAssetsCascade` 级联删除；分镜 1 绑定恢复为 `[1,6,7,8,10,11,12,13]`，删除前行数据备份 `data/backups/assets_14_15_before_delete_2026-10-11T12-38-26-461Z.json`。本次是首次生成提示词，无旧提示词需要清理。
- 追加（回答"以后别的剧本能否规避"时跑探针发现的同类漏判，一并关闭）：
  - 朗读/播报/音效来源：`VO（旁白）：…`、`OS（内心独白）：…`、`VO（画外音）：…`、`VO（系统播报）：…`、`VO（广播）：…`、`VO（心跳声）：…` 原先会解析出"旁白/内心/画外音/广播/心跳声"等假角色（同样 400 拦截）。现在由 `isNarrationSourceLabel()` 判定为来源标签 → 归一化为空说话人：**不绑定角色参考，但台词仍按画外旁白发声**（`dialogueType` 保留 `voiceover_vo`/`inner_monologue_os`），H3 侧 `parseSingleExpectedDialogue` 统一走 `cleanSpeakerName`，漏写 `<d>` 仍判漏台词。`SCREEN_TEXT_SOURCE_PREFIXES` 里原有的 `系统` 移交朗读来源处理，`系统面板：…` 这类仍按画内文字。
  - 裸写屏幕来源：`短信：…`、`屏幕：…`（不带 `VO（…）` 包装）同样按画内文字处理，不再产生"短信/屏幕"假说话人；来源词表本身是设备/界面/文书类名词，且朗读词表先行排除，不会误伤 `老王：…` 这类对白。
  - 名字保护：音效来源判定收窄为"声音修饰词 + 声/响/音"（心跳声/提示音/钟摆响/广播声…），`小音`/`李美音`/`苏晚声` 等角色名保持原样参与参考校验。
  - 验证：`speakerReferences.test.ts` 12/12、`videoPromptContract.test.ts` 34/34；运行包同逻辑复跑（画内文字、朗读/音效来源、裸写屏幕词、角色名保护 + 真实 8 片段）**全部通过**；`node --check` 通过。
  - 仍属边界（需要时一行可补）：词表外的新奇来源标签（如 `VO（外卖单）：…`）与 2 字音效词（如 `VO（铃声）：…`）会退回"说话人"解析并被拦下——此时按报错里的标签名补进 `src/utils/onScreenText.ts` 的两张词表即可。
## 2026-10-13：视频提示词推理 400「Thinking mode does not support this tool_choice」

- 现象：视频工作台「AI生成本场提示词」直接报 `视频提示词推理失败：Thinking mode does not support this tool_choice (request_id: a2d0a1fd-…)`。
- 复现与根因（真实请求实测，非推测）：`src/routes/production/workbench/generateVideoPrompt.ts` 用 `toolChoice: "required"` 强制模型调用 `resultTool`；而 10-11 的「取消思考级别、统一最高档」改动让**所有**文本请求都带 `thinking:{type:"enabled"}` + `reasoning_effort:max`（`src/utils/ai.ts` 的 `TEXT_THINK_DEFAULT` + `data/vendor/deepseek.ts` v2.2 注入）。DeepSeek 官方接口在思考模式下不接受强制工具选择。直连该供应商实测（`deepseek-v4-flash`，与应用配置一致）：`tool_choice:"required"` + thinking → **HTTP 400** `Thinking mode does not support this tool_choice`；`tool_choice:"auto"` + thinking → **HTTP 200 且模型确实调用 `resultTool`**（`deepseek-v4-pro` 同样结果）。
- 修复（保留思考模式，只放宽工具选择形态）：
  - 新增 `Toonflow-app/src/utils/toolChoiceCompat.ts`：识别"思考模式不支持该 tool_choice"类错误（含 responseBody/cause 嵌套），把 `required`/`any`/指定函数形态放宽为 `auto`；`auto`/`none` 与其它错误（余额、超时等）一律不动；并记录已确认不兼容的模型键，后续请求直接按 `auto` 发起，省掉一次必失败的请求。
  - `src/utils/ai.ts`：`AiText` 抽出 `buildTextOptions()`（invoke/stream 共用，语义与原来逐字等价），`invoke()` 失败时命中该错误即放宽并重试一次（`console.warn` 记录 `[ai] … 已放宽为 toolChoice: auto 重试`）；`stream()` 复用同一构建逻辑（streamText 错误在流中产生，不做重试）。
  - 运行包 `data/serve/app.js` 就地补丁同一逻辑（`AiText` 区块 + 兼容函数，未全量重建）；`node --check` 通过。
- 验证：
  - 单测 `src/utils/toolChoiceCompat.test.ts` **6/6**（强制形态识别；真实错误文案命中并放宽且不改原对象；responseBody 嵌套命中；`auto`/`none`、余额/超时错误不放宽；错误描述含嵌套 cause；模型键记忆）。
  - 运行包同逻辑复跑（提取 `AiText` 区块 + 桩 `generateText`）：首调 `required`→被拒→自动 `auto` 成功；同模型再调**只发一次** `auto`；其它模型不受影响。**全部通过**。
  - 真实供应商直连：`required` → 400 复现用户报错；`auto` → 200 且返回 `resultTool` 工具调用（说明放宽后仍能稳定拿到工具结果，契约校验与修复重试链不变）。
- 影响面：只影响"强制工具选择"的请求（当前仅视频提示词推理一处）；思考模式、模板、供应商代码与其它请求链路均未改动。前端未改动，无需重建 `data/web`。
- 回滚：`git checkout -- Toonflow-app/src/utils/ai.ts`、删除 `Toonflow-app/src/utils/toolChoiceCompat(.test).ts`，运行包用 `data/backups/serve_app.js.backup-pre-onscreen-fix` 覆盖后重启。
- 生效：需重启后端（运行包已就地更新）。
## 2026-10-13（补）：thinking 模式下强制工具选择的完整降级链（修复"缺少 trackId"）

- 现象：上一次修复（放宽为 toolChoice: auto）后，视频提示词推理改报 `AI 返回的片段对应关系不完整，缺少 1791713681844`。
- 根因（实测四种组合，`deepseek-v4-flash` 直连官方接口）：
  - thinking=enabled + `tool_choice:"required"` → 400 `Thinking mode does not support this tool_choice`；
  - thinking=enabled + `tool_choice:"auto"` → 200，**但只保证"可以"调工具**：提示词很长（视频提示词是 2 万+ 字符 system + 分场输入）时模型把结果写成正文、不调 `resultTool`，于是 `generatedPrompts` 为空 → 路由抛"缺少 trackId"。
  - thinking=disabled + `required` → 200 且**稳定返回 `resultTool` 工具调用**（这条是本次修复的落点）。
  - thinking=disabled + `auto` → 200 + 工具调用。
  - 旁证：AI SDK 的 `stopWhen: stepCountIs(1)` 不会吞掉工具调用——步骤内 `executeTools()` 先执行，之后才判定停止（`node_modules/ai/dist/index.js` 4539 / 4634），所以只要模型调用了工具，`execute` 一定跑到。
- 修复（判定 + 记忆在 `toolChoiceCompat.ts`，链路在 `ai.ts`）：
  - `toolChoiceCompat.ts` 重写为：`isForcedToolChoice`、`describeAiError`、`isToolChoiceRejected`、`relaxForcedToolChoice(options)`、`resultHasToolCall(result)`，以及两组进程内记忆 `relaxedToolChoiceModels` / `noThinkingToolChoiceModels`。
  - `getVendorTemplateFn(fnName, modelName, runtimeHooks?, textThink?)`：文本请求可**按调用**覆盖思考开关（默认仍 think=true / level 3，与"统一最高档"一致）。
  - `AiText.invoke()`：仅当调用方显式强制工具选择时走降级链 ①思考+强制 → ②（被拒）思考+auto → ③（仍无工具调用）关思考+强制；每一步命中即记入记忆，同模型后续请求直接从可用形态发起（首段最多 3 次请求，之后 1 次）。非强制请求与无关错误（余额、超时等）行为不变，`stream()` 复用同一构建逻辑（不做重试）。
  - 运行包 `data/serve/app.js` 就地补丁同一实现（含 `getVendorTemplateFn` 的思考开关透传；注意运行包内原本不传该参数、依赖供应商模板默认值，本次补上 `textThink?.think ?? true`，行为不变但可覆盖）；`node --check` 通过。
- 验证：
  - 单测 `src/utils/toolChoiceCompat.test.ts` **6/6**（强制形态；真实错误文案与嵌套 responseBody/cause 判定；无关错误不误判；`resultHasToolCall` 含 `steps[].toolCalls` 兜底；策略记忆）。
  - 运行包同逻辑桩跑（提取 `AiText` 区块 + 桩 `generateText`/`getVendorTemplateFn`）**9/9**：首段 `required(true) → auto(true) → required(false)` 三次并返回工具调用；同模型再调只发一次（关思考+强制）；不支持该拒绝的模型保持"思考+强制"一次通过；无关错误不重试直接抛；非强制请求单次且保留思考。
  - 类型检查：`npx tsc --noEmit` 中 `src/utils/ai.ts` 与 `toolChoiceCompat.ts` 无报错（其余 5 条报错为改动前既有：extractStylePrompt/agentSetKey/memory/cleanNovel）。
- 副作用与边界：视频提示词首段请求数由 1 → 最多 3（含一次供应商 400），耗时上限受路由的 `AbortSignal.timeout(VIDEO_PROMPT_TIMEOUT_MS，默认 120s)` 约束；如遇超时可用环境变量 `VIDEO_PROMPT_TIMEOUT_MS=300000` 放宽。稳定态为"关思考 + 强制"（H3 契约校验与一次修复重试不变）。
- 生效：需重启后端。
