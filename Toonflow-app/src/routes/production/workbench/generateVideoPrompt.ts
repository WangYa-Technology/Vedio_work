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
import {
  migrateLegacyPromptForH3,
  removeNarrationLipSyncInstructions,
} from "@/utils/videoPromptMigration";
import { collectVideoPromptContractViolations } from "@/utils/videoPromptContract";
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
        scaleDescription: row.scaleDescription || "",
        cameraAngle: row.cameraAngle || "",
        cameraMovement: row.cameraMovement || "",
        location: row.location || "",
        dayPart: row.dayPart || "",
        interiorExterior: row.interiorExterior || "",
        spatialLayers: row.spatialLayers || "",
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

function parseDialogue(value: string) {
  const raw = String(value || "").trim();
  if (!raw || /^(?:无|无台词|无对白|暂无|-)$/i.test(raw)) {
    return {
      dialogueType: "none",
      speakerName: "",
      actualDialogue: "",
    };
  }
  const dialogueType = /(?:内心独白|\bOS\b)/i.test(raw)
    ? "inner_monologue_os"
    : /(?:画外音|旁白|\bVO\b)/i.test(raw)
      ? "voiceover_vo"
      : "dialogue";
  const withoutType = raw
    .replace(/^(?:普通对白|对白|内心独白|画外音|旁白)\s*(?:OS|VO)?\s*[：:]?\s*/i, "")
    .trim();
  const speakerMatch = withoutType.match(/^([^：:\n]{1,24})[：:]\s*([\s\S]+)$/);
  return {
    dialogueType,
    speakerName: speakerMatch?.[1]?.trim() || "",
    actualDialogue: (speakerMatch?.[2] || withoutType)
      .replace(/^[“"「『]|[”"」』]$/g, "")
      .trim(),
  };
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
  const speech = parseDialogue(dialogue);
  return {
    sequence: String(row.serial || ""),
    visualAndAction: String(row.description || "").trim(),
    durationSeconds: Number(row.duration) || 0,
    shotScale: String(row.scale || "").trim() || "未标注",
    shotScaleDescription: String(row.scaleDescription || "").trim() || "未标注",
    cameraAngle: String(row.cameraAngle || "").trim() || "未标注",
    cameraMovement: String(row.cameraMovement || "").trim() || "未标注",
    location: String(row.location || "").trim() || "未标注",
    dayPart: String(row.dayPart || "").trim() || "未标注",
    interiorExterior: String(row.interiorExterior || "").trim() || "未标注",
    spatialLayers: String(row.spatialLayers || "").trim() || "未标注",
    dialogue,
    ...speech,
    onScreenText,
    speechAllowed: dialogue !== "无台词",
    sound: stripFieldLabel(row.sound, "音效") || "无音效",
  };
}

function normalizeShots(rows: Record<string, any>[]) {
  let elapsed = 0;
  return rows.map((row) => {
    const shot = normalizeShot(row);
    const startSeconds = elapsed;
    elapsed += shot.durationSeconds;
    return {
      ...shot,
      startSeconds,
      endSeconds: elapsed,
      h3CutTimestamp:
        startSeconds > 0
          ? `At ${String(Math.floor(startSeconds / 60)).padStart(2, "0")}:${(
              startSeconds % 60
            )
              .toFixed(3)
              .padStart(6, "0")}`
          : "opening shot - no timestamp",
    };
  });
}

function buildVideoDescription(task: Record<string, any>) {
  const shots = normalizeShots(task.segmentRows || []);
  if (!shots.length) return String(task.videoDesc || "").trim();

  return shots
    .map(
      (shot: ReturnType<typeof normalizeShots>[number]) =>
        `${shot.sequence}. ${shot.visualAndAction}；地点：${shot.location}；时段：${shot.dayPart}；内外：${shot.interiorExterior}；空间层级：${shot.spatialLayers}；累计时间：${shot.startSeconds}-${shot.endSeconds}s；H3切镜标记：${shot.h3CutTimestamp}；景别：${shot.shotScale}；景别说明：${shot.shotScaleDescription}；摄影角度：${shot.cameraAngle}；运镜：${shot.cameraMovement}；对白类型：${shot.dialogueType}；说话人：${shot.speakerName || "无"}；实际台词：${shot.actualDialogue || "无"}；画内文字：${shot.onScreenText || "无"}；音效：${shot.sound}`,
    )
    .join("\n");
}

function missingSpeakerReferences(task: Record<string, any>) {
  const roleNames = new Set(
    (task.medias || [])
      .filter((media: any) => /role|character|人物|角色/i.test(String(media.type || "")))
      .map((media: any) => String(media.name || "").trim())
      .filter(Boolean),
  );
  return [
    ...new Set(
      normalizeShots(task.segmentRows || [])
        .map((shot) => shot.speakerName)
        .filter((speakerName) => speakerName && !roleNames.has(speakerName)),
    ),
  ];
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
      sceneSpace: {
        location: tasks[0]?.location || "未标注",
        dayPart: tasks[0]?.dayPart || "未标注",
        interiorExterior: tasks[0]?.interiorExterior || "未标注",
        spatialLayers: tasks[0]?.spatialLayers || "未标注",
      },
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
        shotFacts: normalizeShots(task.segmentRows || []),
        speechAllowed: (task.segmentRows || []).some(
          (row: Record<string, any>) => normalizeShot(row).speechAllowed,
        ),
        videoDescription: buildVideoDescription(task),
      })),
    },
  );
}

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number().optional(),
    trackId: z.number().optional(),
    trackIds: z.array(z.number()).min(1).optional(),
    sceneTitle: z.string().optional(),
    templateId: z.number(),
    info: z.array(z.any()).optional(),
    model: z.string().optional(),
    mode: z.union([z.string(), z.array(z.string())]).optional(),
  }),
  async (req, res) => {
    const { projectId, scriptId, sceneTitle, templateId, model, mode } = req.body;
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

    const formalTrackIds = requestedTrackIds;
    const tracks = formalTrackIds.length
      ? await u
          .db("o_videoTrack")
          .where({ projectId })
          .whereIn("id", formalTrackIds)
      : [];
    if (tracks.length !== formalTrackIds.length)
      return res.status(400).send(error("部分视频片段不存在或不属于当前项目"));
    const formalScriptIds = Array.from(
      new Set(tracks.map((track) => Number(track.scriptId)).filter(Boolean)),
    );
    const resolvedScriptId = formalScriptIds[0] || Number(scriptId);
    if (!resolvedScriptId)
      return res.status(400).send(error("缺少当前剧集，无法处理正式分镜"));
    if (formalScriptIds.length > 1)
      return res.status(400).send(error("同一次场次推理只能处理同一集中的视频片段"));
    const data = await buildVideoTaskData(projectId, resolvedScriptId, {
      model,
      mode,
    });
    const taskMap = new Map<number, any>(data.trackList.map((item: any) => [Number(item.id), item]));
    const tasks = requestedTrackIds
      .map((id) => taskMap.get(id))
      .filter(Boolean) as any[];
    if (tasks.length !== requestedTrackIds.length)
      return res.status(400).send(error("无法读取所选场次的完整分镜数据"));

    if (
      data.projectConfig.videoPromptProfile?.modelFamily === "minimax-h3" &&
      ["multiReference", "multimodal"].includes(
        String(data.projectConfig.videoPromptProfile?.modeKind || ""),
      )
    ) {
      const missingSpeakers = tasks.flatMap((task) =>
        missingSpeakerReferences(task).map(
          (name) => `${task.segmentTitle || task.id}：${name}`,
        ),
      );
      if (missingSpeakers.length) {
        return res.status(400).send(
          error(
            `说话角色缺少独立角色参考，已停止推理以避免复制脸或串台：${missingSpeakers.join("、")}。请先在分镜资产中绑定对应角色。`,
          ),
        );
      }
    }

    const template = await u.db("o_prompt").where({ id: templateId }).first();
    if (!template || template.type !== "videoPromptGeneration")
      return res.status(400).send(error("请选择有效的视频推理模版"));
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
7. 画内文字不是对白；speechAllowed 为 false 时不得添加角色对白、独白、拟声台词或“啊/来啊”等模型自造语音。H3 对白必须使用 <Subject N> (Sx) 与 <d>[Chinese] actualDialogue</d> 绑定，<d> 内只放 actualDialogue，不得带 speakerName、冒号或“说”等前缀；每条输入台词逐字且只出现一次，不得遗漏、改写、翻译、重复或串给其他角色。旁白使用 off-screen narrator，不归属画面角色。requiresNarrativeVoiceover 为 true 时，开场只写一句短促冲突钩子，必须同时出现原有优势/预期、明确转折和当前阻碍/代价。旁白不超过 min(片段秒数×2, 24) 个汉字；输入对白另行保留。其余片段只在叙事推进需要时加入，audioSupported 为 false 时不得添加旁白。
8. 只扩写 shotFacts 中明确存在的动作、镜头、时长、对白和音效；H3 的 Shot 1 不写时间戳，后续严格使用输入提供的 h3CutTimestamp，格式为 [Shot N] At MM:SS.mmm，且必须是累计切镜时间。禁止每镜从 00 秒重新计时。信息过载时简化动作，不凭空补剧情。
9. 每个片段先识别输入中已有的钩子：危险、目标、阻碍、对峙、失控、关键物件变化、人物反应或未完成结果。首个时间段必须优先呈现最早可感知的已有信号；若事实形成压力变化，可按“压力升级 → 反应/状态改变 → 当前结果”组织。若事实属于任务推进、发现/揭露或情绪转折，也按“变化前状态 → 可见变化 → 当前结果”组织，不得强行套用冲突或悬念。不得用画风、资产清单或静态环境介绍占据开场，也不得虚构冲突。
10. 所有带方向的动作必须写出主体、起点、终点和环境尺度反馈。坠落/降落必须锁定为“人物从画面上方向下持续接近地面或水面，地面或水面不断放大”，镜头只可跟随下降；禁止人物上升、升空、倒飞回高处、从水面飞向天空、反向播放或用镜头运动偷换人物运动方向。
11. 每个 segment 必须锁定角色、场景、光影、媒介四层一致性：换景别和机位不能改变五官发型、体型服装、道具外观、空间布局、地标位置、光源方向和项目画风。每个出镜角色映射到唯一的角色 <Subject N>；同一角色在同一镜头只允许一个可见实例。除非 shotFacts 明确要求，禁止复制人物、相同脸替身、镜像分身、水面倒影分身和背景重复人物；不得用一个角色参考代替另一个角色。
12. referenceMap 中每个参考项只能承担其声明类型的职责：角色图锁身份与服装，场景图锁空间与光影，道具图锁外观材质。不得互换用途，不得把普通参考图擅自定义为首帧、尾帧、动作或运镜参考。
13. 画面可信度来自动作的物理反馈和环境响应，而非画质标签。只为已有动作补充自然产生的惯性、重心、衣发滞后、接触反力、水花、烟尘或碎屑反馈；每镜最多一种轻微镜头真实反馈。禁止默认添加真人实拍、设备品牌、8K、胶片颗粒、无依据手持抖动、失焦、光晕或漂移。
14. 景别必须承担输入指定的叙事功能，人物位移和摄影机运动必须分开描述；不得为了“电影感”替换景别、叠加冲突运镜或用摄影机移动掩盖动作方向。
15. 无论 shotFacts 是否有对白或画内文字，最终视频都必须全程无字幕、无标题、无对话气泡；对白、旁白只作为声音，绝不渲染为字幕。shotFacts 没有画内文字时还必须禁止随机文字、logo、水印和 UI；有画内文字时只能保留场景中输入明确指定的实体文字，不能把它转成字幕。
16. creativeVariation 是本次重生成的受控创作方向，必须执行。它只决定同一事实如何制造钩子、如何安排镜头压力和如何措辞，绝不能新增事件或改写分镜。previousPrompt 非空时它是上一稿基线：新稿不得与其完全相同，且首个时间段的冲突呈现、镜头切分或旁白措辞中至少两项必须实质不同；禁止仅替换同义词。没有 previousPrompt 时，仍必须执行本轮 direction。
17. 声音与表情采用最小可执行集：每镜最多一个主要微表情变化和一至两项声音变化，必须由当前动作或冲突触发，并与镜头推进/切换同步。只有 shotFacts、对白或动作明确提供情绪信号时，才使用 1-2 个可执行的情绪/表演锚点；中性画面不得强加情绪。声音只允许“音效设计”（环境底床、动作拟音、呼吸/喊声、声场、触发点、强弱），可以保留或强化与可见动作同步的音效。固定约束：non_diegetic_music: N/A；只保留同步环境音效和动作音效，不生成背景音乐，不生成字幕。全程禁止背景音乐、配乐、BGM 和非画内音乐；MiniMax H3 的 non_diegetic_music 必须且只能写 N/A。夸张张口、瞪眼、大声喊叫只在输入已有台词/喊声或动作确实达到临界点时使用。
18. 先在内部按【参考素材说明】【核心创意】【画面过程描述】【不想要】四模块组织，再按当前模型协议序列化。H3 仍严格使用官方字段，不输出模块标题；非 H3 才直接输出四模块。参考素材按输入顺序编号为 @图片N/@视频N/@音频N，每项说明用途、锁定维度和不参考维度；无素材写“无参考素材（纯文字生成视频）”。
19. 通用四模块中的画面过程必须逐镜写 Shot N（起始秒-结束秒）—小标题，并具备景别、场景、主体/参考项、运镜、动作、台词/旁白、音效、文字、转场字段。中文台词字数÷3 约为最低台词镜头时长，纯画面镜头 2-5 秒，总时长匹配输入，未指定默认 10 秒。人物镜头最宽使用全景，远景/大全景只用于无人空镜；避免连续相同景别。凡输入景别为中景或中远景且主要人物可见，必须逐镜明确“主要人物面部锐利对焦，眼睛、鼻子、嘴部与轮廓清晰可辨，不被景深或运动模糊覆盖”；优先减少背景细节、遮挡和快速运动，不能擅自改成近景。首尾帧模式明确首尾参考且禁止切镜；一镜到底不拆 Shot。
20. 禁止使用“环绕运镜”，环绕效果统一写 truck left + pan right 或 truck right + pan left。通用【不想要】固定包含“人物远景镜头、背景音乐、字幕”；非画内音乐固定写“非叙事性音乐：N/A”。
21. H3 严格采用官方语言规则：字段名和六段正文使用英文，只有 <d> 内的对白/旁白、资产原名和场景原有文字保留原语言。<Subject N>/<Picture N>、(Sx)、At MM:SS.mmm、<d>[Chinese] ...</d> 和协议枚举值按 H3 要求保留；禁止产出“详细_description”等混合字段名。
22. 视频复盘硬约束：若片段存在关键道具失效、突然失控、身份能力与现实反差或危险逼近，0-1.5 秒必须出现可见故障/威胁及后果；1.5-3 秒写运动突变；3-5 秒写一次主动应对和一次可读表情/视线变化；5 秒后让目标/威胁明显逼近并停在未解决结果。禁止连续稳定跟拍、连续缓推或重复脸部特写填满时长；近景/特写最多占片段三分之一。单镜头不得伪造切镜，但要在同镜内完成状态变化。
23. 最终 prompt 只呈现应生成的画面、动作、音效与实际对白，并固定以两行“non_diegetic_music: N/A”及“只保留同步环境音效和动作音效，不生成背景音乐，不生成字幕。”结尾；除此之外不要追加资产校验语、嘴型控制或制作说明。
24. 不直接输出正文，必须调用 resultTool 一次性返回全部 trackId 的结果。
25. summary 只概括当前 segment 的镜头事实和当前 referenceMap，不得泄漏前后片段、后续枪声、后续反转或整集结局。只有输入真实包含待续写视频时才可使用 [video continuation]；只有图片参考时使用 [reference generation]。
26. subject_definitions 中人物、场景、道具都可按官方规则定义为独立 <Subject N>，但每个有名字的角色必须独立成行、保留自己的参考编号和资产原名。多人镜头逐一写明可见角色、准确数量与站位；未在该镜出现的角色不得进入背景或倒影。
27. 每镜至少写出一个有事实依据的可观察动词和一个视觉锚点（主体、道具、空间位置、光线或参考标签）；不得用抽象词替代画面事实。钩子只表示最早可感知的已有信号，不得写入“本不该出现”等未被输入确认的判断。
`;
    const systemPrompt = `${templateContent}\n\n${modelPromptProtocol ? `${modelPromptProtocol}\n\n` : ""}${styleReasoning}\n\n${contentSafety ? `## 内容安全约束\n${contentSafety}\n` : ""}${batchConstraint}`;
    const templateVersion = hashTemplateContent(systemPrompt);
    const sceneInput = buildSceneInput(
      tasks,
      data.projectConfig,
      data.narrativeContext,
      creativeVariation,
    );
    const invokeGeneration = async (messages: Array<{ role: "user"; content: string }>) => {
      generatedPrompts = [];
      await u.Ai.Text("universalAi").invoke({
        system: systemPrompt,
        messages,
        tools: { resultTool },
        toolChoice: "required",
        stopWhen: stepCountIs(1),
        maxRetries: 0,
        // Batch generation can legitimately need more than a single model round-trip.
        // Keep the limit bounded, but allow deployments to tune it for their provider.
        maxOutputTokens: modelPromptProtocol ? 8192 : 4096,
        abortSignal: AbortSignal.timeout(getVideoPromptTimeoutMs()),
      });
    };
    const respondAiFailure = (caught: unknown) => {
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
    };
    const normalizeReturnedPrompts = () =>
      new Map(
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
    const validateReturnedPrompts = () => {
      const returnedMap = normalizeReturnedPrompts();
      const missingIds = requestedTrackIds.filter((id) => !returnedMap.get(id));
      const unexpectedIds = generatedPrompts
        .map((item) => Number(item.trackId))
        .filter((id) => !requestedTrackIds.includes(id));
      if (missingIds.length || unexpectedIds.length) {
        throw new Error(
          `AI 返回的片段对应关系不完整${missingIds.length ? `，缺少 ${missingIds.join("、")}` : ""}`,
        );
      }

      const contractViolations = tasks.flatMap((task) => {
        const prompt = returnedMap.get(Number(task.id)) || "";
        return collectVideoPromptContractViolations(task, prompt, {
          artStyle: data.projectConfig.artStyle,
          videoRatio: data.projectConfig.videoRatio,
          referenceToken: data.projectConfig.referenceToken,
          visualStyleManual: data.projectConfig.visualStyleManual,
          audio: data.projectConfig.audio,
          audioSupported: data.projectConfig.audio,
          videoPromptProfile: data.projectConfig.videoPromptProfile,
        }).map((violation) => `${task.segmentTitle || task.id}：${violation}`);
      });
      if (contractViolations.length) {
        throw new Error(
          `视频提示词未通过 H3 契约校验：${contractViolations.slice(0, 8).join("；")}`,
        );
      }

      return returnedMap;
    };

    let returnedMap: Map<number, string>;
    try {
      await invokeGeneration([{ role: "user", content: sceneInput }]);
    } catch (caught) {
      return respondAiFailure(caught);
    }

    try {
      returnedMap = validateReturnedPrompts();
    } catch (firstValidationError) {
      const repairRequest = JSON.stringify({
        purpose: "repair_invalid_h3_prompts",
        instruction:
          "上一轮输出未通过硬契约校验。必须重新生成全部 trackId；严格按原始 sceneInput，不增加或改写剧情。修复下列问题后再次调用 resultTool。",
        violations:
          firstValidationError instanceof Error
            ? firstValidationError.message
            : String(firstValidationError),
        previousOutputs: generatedPrompts,
      });
      try {
        await invokeGeneration([
          { role: "user", content: sceneInput },
          { role: "user", content: repairRequest },
        ]);
        returnedMap = validateReturnedPrompts();
      } catch (repairError) {
        return respondAiFailure(repairError);
      }
    }

    try {
      await knexDb.transaction(async (trx) => {
        for (const trackId of requestedTrackIds) {
          if (trackId < 0) continue;
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
