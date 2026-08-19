import express from "express";
import { createHash, randomUUID } from "node:crypto";
import { stepCountIs, tool } from "ai";
import { z } from "zod";
import u from "@/utils";
import { db as knexDb } from "@/utils/db";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import { buildVideoTaskData } from "@/utils/videoTaskData";
import { resolveStylePromptReasoning } from "@/utils/stylePromptReasoning";
import {
  buildVideoModelPromptProtocol,
  resolveVideoPromptInstructions,
} from "@/utils/videoPromptTemplate";
import { collectVideoPromptContractViolations } from "@/utils/videoPromptContract";
import {
  migrateLegacyPromptForH3,
  removeNarrationLipSyncInstructions,
} from "@/utils/videoPromptMigration";
import {
  resolveVideoPromptVariation,
  trimPreviousVideoPrompt,
  type VideoPromptVariation,
} from "@/utils/videoPromptVariation";
import {
  CONTENT_SAFETY_SETTING_KEY,
  DEFAULT_CONTENT_SAFETY_CONSTRAINT,
} from "@/constants/contentSafety";

const router = express.Router();

const DEFAULT_VIDEO_PROMPT_TIMEOUT_MS = 120_000;
const MAX_VIDEO_PROMPT_TIMEOUT_MS = 600_000;

function getVideoPromptTimeoutMs() {
  const configured = Number(process.env.VIDEO_PROMPT_TIMEOUT_MS);
  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_VIDEO_PROMPT_TIMEOUT_MS;
  }
  return Math.min(Math.max(Math.round(configured), 1_000), MAX_VIDEO_PROMPT_TIMEOUT_MS);
}

function hashTemplateContent(value: unknown) {
  return createHash("sha256")
    .update(String(value || ""))
    .digest("hex")
    .slice(0, 16);
}

function buildPromptInferenceSnapshot(
  task: Record<string, any>,
  projectConfig: Record<string, any>,
  narrativeContext: Record<string, any>,
  templateId: number,
  templateVersion: string,
  systemPrompt: string,
  creativeVariation: VideoPromptVariation,
) {
  return {
    schemaVersion: 2,
    generatedAt: Date.now(),
    creativeVariation,
    templateId,
    templateVersion,
    systemPrompt: {
      hash: templateVersion,
      content: systemPrompt,
    },
    projectConfig: {
      model: projectConfig.modelName || projectConfig.videoModel || "",
      modelDisplayName: projectConfig.modelDisplayName || "",
      mode: projectConfig.mode || "",
      videoRatio: projectConfig.videoRatio || "16:9",
      artStyle: projectConfig.artStyle || "",
      directorManual: projectConfig.directorManual || "",
      visualStyleManual: projectConfig.visualStyleManual || "",
      referenceToken: projectConfig.referenceToken || "@图",
      audioSupported: Boolean(projectConfig.audio),
      videoPromptProfile: projectConfig.videoPromptProfile || null,
    },
    track: {
      trackId: Number(task.id),
      isEpisodeOpening: Boolean(task.isEpisodeOpening),
      requiresNarrativeVoiceover: Boolean(task.requiresNarrativeVoiceover),
      sceneTitle: task.sceneTitle || "",
      segmentTitle: task.segmentTitle || "",
      duration: Number(task.duration) || 0,
      references: (task.medias || []).map((media: any, index: number) => ({
        index: index + 1,
        id: media.id,
        name: media.name || "",
        type: media.type || "",
        sources: media.sources || "",
      })),
      shotFacts: (task.segmentRows || []).map((row: any) => ({
        serial: row.serial || "",
        description: row.description || "",
        duration: Number(row.duration) || 0,
        scale: row.scale || "",
        cameraMovement: row.cameraMovement || "",
        dialogue: row.dialogue || "",
        sound: row.sound || "",
      })),
    },
    narrativeSources: {
      episodeScriptIncluded: Boolean(narrativeContext?.episodeScript),
      sourceChapters: (narrativeContext?.sourceChapters || []).map(
        (chapter: Record<string, any>) => ({
          id: Number(chapter.id),
          chapterIndex: Number(chapter.chapterIndex) || null,
          title: String(chapter.title || ""),
        }),
      ),
    },
  };
}

const GeneratedPromptSchema = z.object({
  trackId: z.number(),
  prompt: z.string().min(1),
});

function stripFieldLabel(value: unknown, label: string) {
  return String(value || "")
    .trim()
    .replace(new RegExp(`^${label}[：:]\\s*`), "")
    .trim();
}

function extractOnScreenText(value: string) {
  const match = value.match(
    /^(?:日历|画面|屏幕|招牌|纸张|海报|字幕|标题)文字[：:]\s*(.+)$/,
  );
  return match?.[1]?.trim() || "";
}

function assetTypeLabel(value: unknown) {
  const normalized = String(value || "").toLowerCase();
  if (normalized === "role" || normalized === "character") return "角色";
  if (normalized === "scene") return "场景";
  if (normalized === "props" || normalized === "prop" || normalized === "tool")
    return "道具";
  return String(value || "资产");
}

function normalizeShot(row: Record<string, any>) {
  const rawDialogue = stripFieldLabel(row.dialogue, "台词");
  const onScreenText = extractOnScreenText(rawDialogue);
  const dialogue = onScreenText ? "无台词" : rawDialogue || "无台词";
  return {
    sequence: String(row.serial || ""),
    visualAndAction: String(row.description || "").trim(),
    durationSeconds: Number(row.duration) || 0,
    shotScale: String(row.scale || "").trim() || "未标注",
    cameraMovement: String(row.cameraMovement || "").trim() || "未标注",
    dialogue,
    onScreenText,
    speechAllowed: dialogue !== "无台词",
    sound: stripFieldLabel(row.sound, "音效") || "无音效",
  };
}

function buildVideoDescription(task: Record<string, any>) {
  const shots = (task.segmentRows || []).map(normalizeShot);
  if (!shots.length) return String(task.videoDesc || "").trim();

  return shots
    .map(
      (shot: ReturnType<typeof normalizeShot>) =>
        `${shot.sequence}. ${shot.visualAndAction}；${shot.durationSeconds}s；${shot.shotScale}；${shot.cameraMovement}；对白：${shot.dialogue}；画内文字：${shot.onScreenText || "无"}；音效：${shot.sound}`,
    )
    .join("\n");
}

export function buildSceneInput(
  tasks: any[],
  projectConfig: Record<string, any>,
  narrativeContext: Record<string, any> = {},
  creativeVariation?: VideoPromptVariation,
) {
  const referenceToken = String(projectConfig.referenceToken || "@图");
  return JSON.stringify(
    {
      contract: {
        model: projectConfig.modelName || projectConfig.videoModel || "未标注",
        mode: projectConfig.mode || "未标注",
        videoRatio: projectConfig.videoRatio || "16:9",
        artStyle: projectConfig.artStyle || "未标注",
        directorManual: projectConfig.directorManual || "未标注",
        visualStyleManual: projectConfig.visualStyleManual || "未加载",
        referenceToken,
        audioSupported: Boolean(projectConfig.audio),
        videoPromptProfile: projectConfig.videoPromptProfile || null,
      },
      creativeVariation: creativeVariation
        ? {
            round: creativeVariation.round,
            key: creativeVariation.key,
            direction: creativeVariation.direction,
            requestNonce: creativeVariation.requestNonce,
            rule:
              "本轮必须据此改变开场冲突的呈现、镜头切分、旁白措辞或压力升级方式；不得改写分镜事实、角色、资产、动作方向、时长和结局。",
          }
        : undefined,
      narrativeContext: {
        purpose:
          "仅用于提炼身份、时空变化、处境落差和因果旁白；不可覆盖 shotFacts 的可见动作",
        episodeScript: String(narrativeContext.episodeScript || ""),
        sourceChapters: (narrativeContext.sourceChapters || []).map(
          (chapter: Record<string, any>) => ({
            id: Number(chapter.id),
            chapterIndex: Number(chapter.chapterIndex) || null,
            title: String(chapter.title || ""),
            content: String(chapter.content || ""),
          }),
        ),
      },
      scene: tasks[0]?.sceneTitle || "未标注场次",
      segments: tasks.map((task) => ({
        trackId: task.id,
        isEpisodeOpening: Boolean(task.isEpisodeOpening),
        requiresNarrativeVoiceover: Boolean(task.requiresNarrativeVoiceover),
        segmentTitle: task.segmentTitle,
        duration: task.duration,
        previousPrompt: trimPreviousVideoPrompt(task.prompt),
        referenceMap: (task.medias || []).map(
          (media: any, index: number) =>
            `${referenceToken}${index + 1}：${media.name || "未命名资产"}（${assetTypeLabel(media.type)}）`,
        ),
        references: (task.medias || []).map((media: any, index: number) => ({
          token: `${referenceToken}${index + 1}`,
          id: media.id,
          name: media.name || "未命名资产",
          type: assetTypeLabel(media.type),
          usage:
            media.sources === "storyboard"
              ? "storyboard"
              : "asset identity/reference",
          stableDescription:
            media.describe ||
            media.prompt ||
            "未提供稳定外观描述，不得自行补写",
        })),
        shotFacts: (task.segmentRows || []).map(normalizeShot),
        speechAllowed: (task.segmentRows || []).some(
          (row: Record<string, any>) => normalizeShot(row).speechAllowed,
        ),
        videoDescription: buildVideoDescription(task),
      })),
    },
  );
}

function validatePromptReferences(
  task: Record<string, any>,
  prompt: string,
  referenceToken = "@图",
  profile?: Record<string, any> | null,
) {
  const allMedias = task.medias || [];
  const isH3 = profile?.modelFamily === "minimax-h3";
  const medias = isH3 && profile?.modeKind === "text"
    ? []
    : isH3 && profile?.modeKind === "firstLastFrame"
      ? allMedias.slice(0, 2)
      : isH3 && Number(profile?.referenceLimit) > 0
        ? allMedias.slice(0, Number(profile.referenceLimit))
        : allMedias;
  if (!medias.length) return;

  const escapedToken = referenceToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const referencedNumbers = Array.from(
    prompt.matchAll(new RegExp(`${escapedToken}\\s*(\\d+)`, "g")),
    (match) => Number(match[1]),
  );
  const invalidNumbers = Array.from(
    new Set(referencedNumbers.filter((number) => number < 1 || number > medias.length)),
  );
  if (invalidNumbers.length) {
    throw new Error(
      `${task.segmentTitle || task.id} 引用了不存在的资产编号：${invalidNumbers.map((number) => `${referenceToken}${number}`).join("、")}`,
    );
  }

  const lines = prompt.split(/\r?\n/);
  const missingMappings: string[] = [];
  medias.forEach((media: any, index: number) => {
    const token = `${referenceToken}${index + 1}`;
    const assetName = String(media.name || "").trim();
    const mappingLine = lines.find((line) => line.includes(token));
    if (!mappingLine || (assetName && !mappingLine.includes(assetName))) {
      missingMappings.push(`${token}=${assetName || "未命名资产"}`);
    }
  });
  if (missingMappings.length) {
    throw new Error(
      `${task.segmentTitle || task.id} 的提示词资产映射不完整：${missingMappings.join("、")}`,
    );
  }
}

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    trackId: z.number().optional(),
    trackIds: z.array(z.number()).min(1).optional(),
    sceneTitle: z.string().optional(),
    templateId: z.number(),
    info: z.array(z.any()).optional(),
    model: z.string().optional(),
    mode: z.union([z.string(), z.array(z.string())]).optional(),
  }),
  async (req, res) => {
    const { projectId, sceneTitle, templateId, model, mode } = req.body;
    const requestedTrackIds = Array.from(
      new Set<number>(
        [
          ...(req.body.trackIds || []),
          ...(req.body.trackId ? [req.body.trackId] : []),
        ].map(Number),
      ),
    );
    if (!requestedTrackIds.length)
      return res.status(400).send(error("未选择需要推理的视频片段"));

    const tracks = await u
      .db("o_videoTrack")
      .where({ projectId })
      .whereIn("id", requestedTrackIds);
    if (tracks.length !== requestedTrackIds.length)
      return res
        .status(400)
        .send(error("部分视频片段不存在或不属于当前项目"));
    const scriptIds = Array.from(
      new Set(tracks.map((track) => Number(track.scriptId)).filter(Boolean)),
    );
    if (scriptIds.length !== 1)
      return res
        .status(400)
        .send(error("同一次场次推理只能处理同一集中的视频片段"));

    const template = await u.db("o_prompt").where({ id: templateId }).first();
    if (!template || template.type !== "videoPromptGeneration")
      return res.status(400).send(error("请选择有效的视频推理模版"));
    const data = await buildVideoTaskData(projectId, scriptIds[0], {
      model,
      mode,
    });
    const taskMap = new Map(
      data.trackList.map((item) => [Number(item.id), item]),
    );
    const tasks = requestedTrackIds
      .map((id) => taskMap.get(id))
      .filter(Boolean) as any[];
    if (tasks.length !== requestedTrackIds.length)
      return res
        .status(400)
        .send(error("无法读取所选场次的完整分镜数据"));
    const hasNarrativeContext = Boolean(
      data.narrativeContext?.episodeScript ||
        data.narrativeContext?.sourceChapters?.some(
          (chapter: Record<string, any>) => chapter.content,
        ),
    );
    for (const task of tasks) {
      task.requiresNarrativeVoiceover = Boolean(
        task.isEpisodeOpening && data.projectConfig.audio && hasNarrativeContext,
      );
    }
    const actualSceneTitle = String(tasks[0]?.sceneTitle || "");
    if (
      tasks.some((task) => String(task.sceneTitle || "") !== actualSceneTitle)
    )
      return res.status(400).send(error("所选片段不属于同一场次"));
    if (sceneTitle && sceneTitle !== actualSceneTitle)
      return res.status(409).send(error("场次数据已变化，请刷新后重试"));
    const configuredDurations = (data.projectConfig.durationResolutionMap || [])
      .flatMap((item: any) =>
        Array.isArray(item?.duration) ? item.duration : [item?.duration],
      )
      .map(Number)
      .filter((value: number) => Number.isFinite(value));
    const maxDuration = Math.max(
      Number(data.projectConfig.videoPromptProfile?.maxDuration) || 15,
      ...configuredDurations,
    );
    const overLimit = tasks.find(
      (task) => Number(task.duration) > maxDuration,
    );
    if (overLimit)
      return res
        .status(400)
        .send(
          error(
            `${overLimit.segmentTitle || overLimit.id} 时长超过当前模型允许的 ${maxDuration} 秒限制`,
          ),
        );

    const templateContent = resolveVideoPromptInstructions(template, {
      modelName: data.projectConfig.modelName || data.projectConfig.videoModel,
      mode: data.projectConfig.mode,
      referenceToken: data.projectConfig.referenceToken,
      videoRatio: data.projectConfig.videoRatio,
    });
    if (!templateContent)
      return res.status(400).send(error("所选视频推理模版内容为空"));

    const styleReasoning = resolveStylePromptReasoning(
      data.projectConfig.artStyle,
      data.projectConfig.visualStyleManual,
    );
    const modelPromptProtocol = buildVideoModelPromptProtocol({
      ...data.projectConfig.videoPromptProfile,
      referenceToken: data.projectConfig.referenceToken,
    });
    const creativeVariation = resolveVideoPromptVariation(tasks, randomUUID());

    const safetySetting = await u
      .db("o_setting")
      .where("key", CONTENT_SAFETY_SETTING_KEY)
      .first();
    const contentSafety = String(
      safetySetting?.value ?? DEFAULT_CONTENT_SAFETY_CONSTRAINT,
    ).trim();
    let generatedPrompts: Array<z.infer<typeof GeneratedPromptSchema>> = [];
    const resultTool = tool({
      description: "返回本场每个视频片段对应的最终视频提示词",
      inputSchema: z.object({
        prompts: z
          .array(GeneratedPromptSchema)
          .length(tasks.length)
          .describe("必须为输入中的每个 trackId 返回且只返回一条提示词"),
      }),
      execute: async ({ prompts }) => {
        generatedPrompts = prompts;
        return "视频提示词已接收，无需继续回复";
      },
    });

    const batchConstraint = `
## 本次场次批量推理的最高优先级规则
1. 输入中同一场次包含多个独立视频片段；一次读取全部片段，但每个 trackId 必须分别生成一条独立提示词。
2. 每条提示词对应的视频时长不得超过当前模型允许的 ${maxDuration} 秒，不得把整个场次合并成一个长视频提示词。
3. contract 是当前模型、模式、画幅、画风和参考图标记的唯一事实来源；不得用模板示例覆盖它。
4. 只允许使用当前片段 references/referenceMap 中的资产映射；${data.projectConfig.referenceToken} 编号在每个片段内独立从 1 开始，名称必须逐一匹配。
5. artStyle、videoRatio 和 visualStyleManual 高于模板示例；不得默认改成真人、2.39:1、8K、摄影机品牌或胶片风格。
6. narrativeContext 中的章节原文与本集剧本只用于提炼画面看不见的冲突事实：优先选择“主角原身份/能力 vs 当前失能”“上一刻的时间地点 vs 此刻的异常”“目标 vs 突发阻碍”“行动 vs 即时代价”。旁白不能复述 shotFacts 已经展示的动作，也不能改写画面中的人物、道具、结果或镜头顺序。原文只说明发生穿越、未说明机制时，必须保留未知，禁止编造传送门、法术、爆炸、系统召唤等原因。
7. 画内文字不是对白；speechAllowed 为 false 时不得添加角色对白、独白、拟声台词或“啊/来啊”等模型自造语音。旁白只标注“旁白 VO：实际语句”，作为非画内叙述，不归属任何画面角色；不得输出任何嘴型、嘴部开合或 lip-sync 控制说明。requiresNarrativeVoiceover 为 true 时，开场只写一句短促冲突钩子，必须同时出现原有优势/预期、明确转折和当前阻碍/代价，优先使用“却、偏偏、竟、反而、谁知、没想到、上一秒……下一秒……”连接。禁止履历罗列。旁白不超过 min(片段秒数×2, 24) 个汉字：8 秒优先 10-16 字，12-15 秒最多 24 字；输入对白另行保留。其余片段只在叙事推进需要时加入，audioSupported 为 false 时不得添加旁白。
8. 只扩写 shotFacts 中明确存在的动作、镜头、时长、对白和音效；多镜头必须用逐镜时间段（例如 0-3s、3-7s）锁定动作先后；信息过载时简化动作，不凭空补剧情。
9. 每个片段先识别输入中已有的钩子：危险、目标、阻碍、对峙、失控、关键物件变化、人物反应或未完成结果。首个时间段必须强势突出至少一组“强烈落差 + 正面冲突”：身份能力 vs 狼狈处境、前一刻 vs 此刻、目标 vs 阻碍、人物 vs 威胁、行动 vs 代价。随后形成“压力升级 → 反应/状态改变 → 悬念收尾”。不得用画风、资产清单或静态环境介绍占据开场，也不得虚构冲突。
10. 所有带方向的动作必须写出主体、起点、终点和环境尺度反馈。坠落/降落必须锁定为“人物从画面上方向下持续接近地面或水面，地面或水面不断放大”，镜头只可跟随下降；禁止人物上升、升空、倒飞回高处、从水面飞向天空、反向播放或用镜头运动偷换人物运动方向。
11. 每个 segment 必须锁定角色、场景、光影、媒介四层一致性：换景别和机位不能改变五官发型、体型服装、道具外观、空间布局、地标位置、光源方向和项目画风；不得新增人物分身、背景结构或随机特效。
12. referenceMap 中每个参考项只能承担其声明类型的职责：角色图锁身份与服装，场景图锁空间与光影，道具图锁外观材质。不得互换用途，不得把普通参考图擅自定义为首帧、尾帧、动作或运镜参考。
13. 画面可信度来自动作的物理反馈和环境响应，而非画质标签。只为已有动作补充自然产生的惯性、重心、衣发滞后、接触反力、水花、烟尘或碎屑反馈；每镜最多一种轻微镜头真实反馈。禁止默认添加真人实拍、设备品牌、8K、胶片颗粒、无依据手持抖动、失焦、光晕或漂移。
14. 景别必须承担输入指定的叙事功能，人物位移和摄影机运动必须分开描述；不得为了“电影感”替换景别、叠加冲突运镜或用摄影机移动掩盖动作方向。
15. shotFacts 没有画内文字时，提示词必须禁止随机文字、字幕、对话气泡、logo、水印和 UI；有画内文字时只能保留输入指定内容。
16. creativeVariation 是本次重生成的受控创作方向，必须执行。它只决定同一事实如何制造钩子、如何安排镜头压力和如何措辞，绝不能新增事件或改写分镜。previousPrompt 非空时它是上一稿基线：新稿不得与其完全相同，且首个时间段的冲突呈现、镜头切分或旁白措辞中至少两项必须实质不同；禁止仅替换同义词。没有 previousPrompt 时，仍必须执行本轮 direction。
17. 声音与表情采用最小可执行集：每镜最多一个主要微表情变化和一至两项声音变化，必须由当前动作或冲突触发，并与镜头推进/切换同步。逐镜把声音拆为“音效设计”（环境底床、动作拟音、声场、触发点、强弱）和“配乐设计”（进入/退出、音色或乐器、慢/中/快节奏或节拍密度、动态、静音/留白、与动作或剪辑的同步点）；无叙事依据时配乐写 N/A，不能用泛化音乐词代替设计。夸张张口、瞪眼、大声喊叫只在输入已有台词/喊声或动作确实达到临界点时使用。
18. 最终 prompt 只呈现应生成的正向画面、动作、声音、配乐与实际对白；不要复述本约束、资产校验语、禁止项、嘴型控制或其他制作说明。
19. 不直接输出正文，必须调用 resultTool 一次性返回全部 trackId 的结果。
`;
    const systemPrompt = `${templateContent}\n\n${modelPromptProtocol ? `${modelPromptProtocol}\n\n` : ""}${styleReasoning}\n\n${contentSafety ? `## 内容安全约束\n${contentSafety}\n` : ""}${batchConstraint}`;
    const templateVersion = hashTemplateContent(systemPrompt);
    const sceneInput = buildSceneInput(
      tasks,
      data.projectConfig,
      data.narrativeContext,
      creativeVariation,
    );
    try {
      await u.Ai.Text("universalAi").invoke({
        system: systemPrompt,
        messages: [{ role: "user", content: sceneInput }],
        tools: { resultTool },
        toolChoice: "required",
        stopWhen: stepCountIs(1),
        maxRetries: 0,
        // Batch generation can legitimately need more than a single model round-trip.
        // Keep the limit bounded, but allow deployments to tune it for their provider.
        maxOutputTokens: modelPromptProtocol ? 8192 : 4096,
        abortSignal: AbortSignal.timeout(getVideoPromptTimeoutMs()),
      });
    } catch (caught) {
      const normalized = u.error(caught);
      const details = `${normalized.message} ${JSON.stringify(normalized.cause || {})}`;
      const isTimeout =
        /timeout|timed out|524|headers timeout|abort(?:ed|error)?/i.test(
          details,
        );
      const message = isTimeout
        ? "视频提示词推理超时：上游模型未在时限内返回，请稍后重试或改用更快的文本模型"
        : `视频提示词推理失败：${normalized.message || "上游模型请求失败"}`;
      return res.status(isTimeout ? 504 : 502).send(error(message));
    }

    // Some older templates still return the pre-H3 reference notation. Normalize it
    // before validation and persistence so the workbench and provider use one prompt.
    const returnedMap = new Map(
      generatedPrompts.map((item) => {
        const trackId = Number(item.trackId);
        const task = tasks.find((candidate) => Number(candidate.id) === trackId);
        return [
          trackId,
          removeNarrationLipSyncInstructions(migrateLegacyPromptForH3(item.prompt.trim(), {
            profile: data.projectConfig.videoPromptProfile,
            referenceToken: data.projectConfig.referenceToken,
            references: task?.medias,
            task,
          })),
        ];
      }),
    );
    const missingIds = requestedTrackIds.filter((id) => !returnedMap.get(id));
    const unexpectedIds = generatedPrompts
      .map((item) => Number(item.trackId))
      .filter((id) => !requestedTrackIds.includes(id));
    try {
      if (missingIds.length || unexpectedIds.length) {
        throw new Error(
          `AI 返回的片段对应关系不完整${missingIds.length ? `，缺少 ${missingIds.join("、")}` : ""}`,
        );
      }

      for (const task of tasks) {
        const prompt = returnedMap.get(Number(task.id)) || "";
        validatePromptReferences(
          task,
          prompt,
          data.projectConfig.referenceToken,
          data.projectConfig.videoPromptProfile,
        );
        const violations = collectVideoPromptContractViolations(
          task,
          prompt,
          {
            ...data.projectConfig,
            audioSupported: Boolean(data.projectConfig.audio),
          },
        );
        if (violations.length) {
          throw new Error(
            `${task.segmentTitle || task.id} 提示词契约校验失败：${violations.join("；")}`,
          );
        }
      }
    } catch (caught) {
      return res.status(422).send(error(u.error(caught).message));
    }

    try {
      await knexDb.transaction(async (trx) => {
        for (const trackId of requestedTrackIds) {
          const task = tasks.find((item) => Number(item.id) === trackId);
          await trx("o_videoTrack")
            .where({ id: trackId, projectId })
            .update({
              prompt: returnedMap.get(trackId),
              promptTemplateId: Number(template.id),
              promptTemplateVersion: templateVersion,
              promptInferenceSnapshot: JSON.stringify(
                buildPromptInferenceSnapshot(
                  task || { id: trackId },
                  data.projectConfig,
                  data.narrativeContext,
                  Number(template.id),
                  templateVersion,
                  systemPrompt,
                  creativeVariation,
                ),
              ),
            });
        }
      });
    } catch (caught) {
      return res
        .status(500)
        .send(error(`视频提示词写入失败：${u.error(caught).message}`));
    }

    res.status(200).send(
      success({
        sceneTitle: actualSceneTitle,
        template: { id: template.id, name: template.name },
        prompts: requestedTrackIds.map((trackId) => ({
          trackId,
          prompt: returnedMap.get(trackId),
        })),
      }),
    );
  },
);
