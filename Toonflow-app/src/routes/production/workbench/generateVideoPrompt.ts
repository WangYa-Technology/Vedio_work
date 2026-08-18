import express from "express";
import { createHash } from "node:crypto";
import { stepCountIs, tool } from "ai";
import { z } from "zod";
import u from "@/utils";
import { db as knexDb } from "@/utils/db";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import { buildVideoTaskData } from "@/utils/videoTaskData";
import { resolveStylePromptReasoning } from "@/utils/stylePromptReasoning";
import { resolveVideoPromptInstructions } from "@/utils/videoPromptTemplate";
import { collectVideoPromptContractViolations } from "@/utils/videoPromptContract";
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
  templateId: number,
  templateVersion: string,
  systemPrompt: string,
) {
  return {
    schemaVersion: 2,
    generatedAt: Date.now(),
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
      scene: tasks[0]?.sceneTitle || "未标注场次",
      segments: tasks.map((task) => ({
        trackId: task.id,
        segmentTitle: task.segmentTitle,
        duration: task.duration,
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
) {
  const medias = task.medias || [];
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
6. 画内文字不是对白；speechAllowed 为 false 时不得添加对白、拟声台词或“啊/来啊”等模型自造语音。
7. 只扩写 shotFacts 中明确存在的动作、镜头、时长、对白和音效；多镜头必须用逐镜时间段（例如 0-3s、3-7s）锁定动作先后；信息过载时简化动作，不凭空补剧情。
8. 不直接输出正文，必须调用 resultTool 一次性返回全部 trackId 的结果。
`;
    const systemPrompt = `${templateContent}\n\n${styleReasoning}\n\n${contentSafety ? `## 内容安全约束\n${contentSafety}\n` : ""}${batchConstraint}`;
    const templateVersion = hashTemplateContent(systemPrompt);
    const sceneInput = buildSceneInput(tasks, data.projectConfig);
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
        maxOutputTokens: 4096,
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

    const returnedMap = new Map(
      generatedPrompts.map((item) => [
        Number(item.trackId),
        item.prompt.trim(),
      ]),
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
        );
        const violations = collectVideoPromptContractViolations(
          task,
          prompt,
          data.projectConfig,
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
                  Number(template.id),
                  templateVersion,
                  systemPrompt,
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
