import express from "express";
import { stepCountIs, tool } from "ai";
import { z } from "zod";
import u from "@/utils";
import { db as knexDb } from "@/utils/db";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import { buildVideoTaskData } from "@/utils/videoTaskData";
import { resolveVideoPromptInstructions } from "@/utils/videoPromptTemplate";
import {
  CONTENT_SAFETY_SETTING_KEY,
  DEFAULT_CONTENT_SAFETY_CONSTRAINT,
} from "@/constants/contentSafety";

const router = express.Router();

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

function assetTypeLabel(value: unknown) {
  const normalized = String(value || "").toLowerCase();
  if (normalized === "role" || normalized === "character") return "角色";
  if (normalized === "scene") return "场景";
  if (normalized === "props" || normalized === "prop" || normalized === "tool")
    return "道具";
  return String(value || "资产");
}

function normalizeShot(row: Record<string, any>) {
  return {
    sequence: String(row.serial || ""),
    visualAndAction: String(row.description || "").trim(),
    durationSeconds: Number(row.duration) || 0,
    shotScale: String(row.scale || "").trim() || "未标注",
    cameraMovement: String(row.cameraMovement || "").trim() || "未标注",
    dialogue: stripFieldLabel(row.dialogue, "台词") || "无台词",
    sound: stripFieldLabel(row.sound, "音效") || "无音效",
  };
}

function buildVideoDescription(task: Record<string, any>) {
  const shots = (task.segmentRows || []).map(normalizeShot);
  if (!shots.length) return String(task.videoDesc || "").trim();

  return shots
    .map(
      (shot: ReturnType<typeof normalizeShot>) =>
        `${shot.sequence}. ${shot.visualAndAction}；${shot.durationSeconds}s；${shot.shotScale}；${shot.cameraMovement}；台词：${shot.dialogue}；音效：${shot.sound}`,
    )
    .join("\n");
}

export function buildSceneInput(
  tasks: any[],
  _projectConfig: Record<string, any>,
) {
  return JSON.stringify(
    {
      scene: tasks[0]?.sceneTitle || "未标注场次",
      segments: tasks.map((task) => ({
        trackId: task.id,
        segmentTitle: task.segmentTitle,
        duration: task.duration,
        referenceMap: (task.medias || []).map(
          (media: any, index: number) =>
            `@图${index + 1}：${media.name || "未命名资产"}（${assetTypeLabel(media.type)}）`,
        ),
        videoDescription: buildVideoDescription(task),
      })),
    },
  );
}

function validatePromptReferences(task: Record<string, any>, prompt: string) {
  const medias = task.medias || [];
  if (!medias.length) return;

  const referencedNumbers = Array.from(
    prompt.matchAll(/@图\s*(\d+)/g),
    (match) => Number(match[1]),
  );
  const invalidNumbers = Array.from(
    new Set(referencedNumbers.filter((number) => number < 1 || number > medias.length)),
  );
  if (invalidNumbers.length) {
    throw new Error(
      `${task.segmentTitle || task.id} 引用了不存在的资产编号：${invalidNumbers.map((number) => `@图${number}`).join("、")}`,
    );
  }

  const lines = prompt.split(/\r?\n/);
  const missingMappings: string[] = [];
  medias.forEach((media: any, index: number) => {
    const token = `@图${index + 1}`;
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
  }),
  async (req, res) => {
    const { projectId, sceneTitle, templateId } = req.body;
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
    const data = await buildVideoTaskData(projectId, scriptIds[0]);
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
    const overLimit = tasks.find((task) => Number(task.duration) > 15);
    if (overLimit)
      return res
        .status(400)
        .send(
          error(
            `${overLimit.segmentTitle || overLimit.id} 时长超过 MiniMax H3 的 15 秒限制`,
          ),
        );

    const templateContent = resolveVideoPromptInstructions(template, {
      modelName: data.projectConfig.modelName || data.projectConfig.videoModel,
      mode: data.projectConfig.mode,
    });
    if (!templateContent)
      return res.status(400).send(error("所选视频推理模版内容为空"));

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
2. 每条提示词对应的视频时长不得超过 15 秒，不得把整个场次合并成一个长视频提示词。
3. 当前为图片多参考生视频模式。输入仅包含文字，不包含图片；只允许使用 referenceMap 中给出的资产映射，禁止引用故事板图、分镜图或虚构图片编号。
4. referenceMap 在每个片段内独立从 @图1 开始。每条输出必须完整保留该片段的全部映射行，编号和资产名称必须逐一匹配。
5. 不直接输出正文，必须调用 resultTool 一次性返回全部 trackId 的结果。
`;
    const sceneInput = buildSceneInput(tasks, data.projectConfig);
    try {
      await u.Ai.Text("universalAi").invoke({
        system: `${templateContent}\n\n${contentSafety ? `## 内容安全约束\n${contentSafety}\n` : ""}${batchConstraint}`,
        messages: [{ role: "user", content: sceneInput }],
        tools: { resultTool },
        toolChoice: "required",
        stopWhen: stepCountIs(1),
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(60_000),
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
        validatePromptReferences(task, returnedMap.get(Number(task.id)) || "");
      }
    } catch (caught) {
      return res.status(422).send(error(u.error(caught).message));
    }

    try {
      await knexDb.transaction(async (trx) => {
        for (const trackId of requestedTrackIds) {
          await trx("o_videoTrack")
            .where({ id: trackId, projectId })
            .update({ prompt: returnedMap.get(trackId) });
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
