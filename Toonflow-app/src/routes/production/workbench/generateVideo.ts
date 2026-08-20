import express from "express";
import { createHash } from "node:crypto";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/middleware/middleware";
import { success } from "@/lib/responseFormat";
import {
  pendingVideoTaskData,
  updateVideoTaskState,
  VIDEO_WORKER_RUN_ID,
} from "@/utils/videoTaskRecovery";
import { resolveVideoModelPromptProfile } from "@/utils/videoModelPromptProfile";
import { buildVideoTaskData } from "@/utils/videoTaskData";
import { auditVideoOutput } from "@/utils/videoOutputAudit";
import { probeVideoFile } from "@/utils/videoOutputProbe";
import {
  enforceVideoPromptOutputConstraints,
  migrateLegacyPromptForH3,
} from "@/utils/videoPromptMigration";

const router = express.Router();

async function nextId(table: "o_video") {
  let id = Date.now();
  while (await u.db(table).where({ id }).first()) id += 1;
  return id;
}

async function resolveReferenceFile(item: {
  id: number;
  sources: "assets" | "storyboard";
}) {
  if (item.sources === "assets") {
    const asset = await u
      .db("o_assets")
      .leftJoin("o_image", "o_assets.imageId", "o_image.id")
      .where("o_assets.id", item.id)
      .select("o_assets.name", "o_image.filePath")
      .first();
    if (!asset?.filePath)
      throw new Error(`参考资产“${asset?.name || item.id}”没有可用图片`);
    return asset.filePath as string;
  }
  const storyboard = await u.db("o_storyboard").where({ id: item.id }).first();
  if (!storyboard?.filePath) throw new Error(`分镜图 ${item.id} 不存在`);
  return storyboard.filePath as string;
}

function resolveReferenceType(item: {
  fileType?: "image" | "video" | "audio";
  sources: "assets" | "storyboard";
}) {
  if (item.sources === "storyboard") return "image" as const;
  return item.fileType || "image";
}

function normalizeVideoMode(mode: string | string[] | undefined) {
  if (Array.isArray(mode)) return mode;
  const value = String(mode || "").trim();
  if (value.startsWith("[")) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) return parsed;
    } catch {
      // 保留原始模式，让供应商自行处理无法解析的自定义模式。
    }
  }
  return value;
}

function hashPromptTemplate(value: unknown) {
  return createHash("sha256")
    .update(String(value || ""))
    .digest("hex")
    .slice(0, 16);
}

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number(),
    trackId: z.number(),
    uploadData: z.array(
      z.object({
        id: z.number(),
        sources: z.enum(["assets", "storyboard"]),
        fileType: z.enum(["image", "video", "audio"]).optional(),
      }),
    ),
    prompt: z.string().min(1),
    model: z.string().min(1),
    mode: z.union([z.string(), z.array(z.string())]).optional(),
    resolution: z.string().optional(),
    duration: z.number().optional(),
    audio: z.boolean().optional(),
    parameters: z.record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean()]),
    ).optional(),
    promptTemplateId: z.number().optional(),
  }),
  async (req, res) => {
    const {
      projectId,
      scriptId,
      trackId,
      uploadData,
      prompt,
      model,
      mode,
      resolution,
      duration,
      audio,
      parameters,
      promptTemplateId,
    } = req.body;
    const track = await u
      .db("o_videoTrack")
      .where({ id: trackId, projectId, scriptId })
      .first();
    if (!track) throw new Error("未找到对应的视频片段");
    const project = await u.db("o_project").where({ id: projectId }).first();
    const taskData = await buildVideoTaskData(projectId, scriptId, {
      model,
      mode,
    });
    const promptTask = taskData.trackList.find(
      (item) => Number(item.id) === Number(trackId),
    );
    const videoPromptProfile = resolveVideoModelPromptProfile({
      modelName: model,
      displayName: taskData.projectConfig.modelDisplayName,
      mode,
      durationResolutionMap: taskData.projectConfig.durationResolutionMap,
      audio: audio ?? taskData.projectConfig.audio,
    });
    const effectivePrompt = enforceVideoPromptOutputConstraints(
      migrateLegacyPromptForH3(prompt, {
        profile: videoPromptProfile,
        referenceToken: taskData.projectConfig.referenceToken,
        references: promptTask?.referenceAssets,
        task: promptTask,
      }),
      promptTask,
    );
    const promptTemplate = promptTemplateId
      ? await u.db("o_prompt").where({ id: promptTemplateId }).first()
      : null;
    const referencePaths = await Promise.all(
      uploadData.map(resolveReferenceFile),
    );
    const imageBase64 = await Promise.all(
      referencePaths.map((filePath) => u.oss.getImageBase64(filePath)),
    );
    const referenceList = imageBase64.map((base64, index) => ({
      type: resolveReferenceType(uploadData[index]),
      sourceType: "base64" as const,
      base64,
    }));
    const id = await nextId("o_video");
    const filePath = `${projectId}/video/${scriptId}/${u.uuid()}.mp4`;
    const requestedDuration = Math.max(
      1,
      Math.round(Number(duration || track.duration || 5)),
    );
    const effectiveDuration = /minimax.*h3|h3.*minimax/i.test(model)
      ? Math.min(15, requestedDuration)
      : requestedDuration;
    const startedAt = Date.now();
    const generationConfig = {
      schemaVersion: 1,
      model,
      mode: normalizeVideoMode(mode),
      ratio: project?.videoRatio || "16:9",
      resolution: resolution || "864x480",
      duration: effectiveDuration,
      audio: Boolean(audio),
      parameters: parameters || {},
      videoPromptProfile,
    };
    const referenceSnapshot = uploadData.map((item: any, index: number) => ({
      index,
      id: item.id,
      sources: item.sources,
      fileType: resolveReferenceType(item),
      filePath: referencePaths[index],
    }));

    await u.db("o_video").insert({
      id,
      projectId,
      scriptId,
      videoTrackId: trackId,
      filePath,
      state: "生成中",
      time: effectiveDuration,
      errorReason: "",
      model,
      providerTaskData: JSON.stringify(pendingVideoTaskData(startedAt)),
      promptSnapshot: effectivePrompt,
      promptTemplateId: promptTemplateId || null,
      promptTemplateVersion: promptTemplate
        ? hashPromptTemplate(promptTemplate.useData || promptTemplate.data)
        : null,
      referenceSnapshot: JSON.stringify(referenceSnapshot),
      generationConfig: JSON.stringify(generationConfig),
      createTime: startedAt,
    });
    await u
      .db("o_videoTrack")
      .where({ id: trackId })
      .update({
        prompt: effectivePrompt,
        duration: effectiveDuration,
        state: "生成中",
        reason: "",
      });
    res
      .status(200)
      .send(success({ id, state: "生成中" }, "视频生成任务已提交"));

    void (async () => {
      try {
        await (
          await u.Ai.Video(model as `${string}:${string}`).run(
            {
              prompt: effectivePrompt,
              imageBase64,
              referenceList,
              aspectRatio: (project?.videoRatio ||
                "16:9") as `${number}:${number}`,
              mode: normalizeVideoMode(mode),
              duration: effectiveDuration,
              resolution: resolution || "864x480",
              audio: Boolean(audio),
              parameters: parameters || {},
            },
            {
              taskClass: "videoGeneration",
              describe: `生成第 ${trackId} 个视频片段`,
              relatedObjects: JSON.stringify({
                trackId,
                references: uploadData,
              }),
              projectId,
              onProviderTask: async (task) => {
                const existing = await u
                  .db("o_video")
                  .where({ id })
                  .first("providerTaskData");
                let previous: Record<string, any> = {};
                try {
                  previous = JSON.parse(existing?.providerTaskData || "{}");
                } catch {
                  previous = {};
                }
                await u
                  .db("o_video")
                  .where({ id })
                  .update({
                    providerTaskId: task.taskId,
                    providerTaskData: JSON.stringify({
                      ...previous,
                      ...task,
                      runId: VIDEO_WORKER_RUN_ID,
                      startedAt,
                    }),
                  });
              },
            },
          )
        ).save(filePath);
        const probedMetadata = await probeVideoFile(u.getPath(["oss", filePath]));
        if (probedMetadata) {
          const outputAudit = auditVideoOutput({
            expectedRatio: project?.videoRatio || "16:9",
            expectedDuration: effectiveDuration,
            ...probedMetadata,
          });
          await u.db("o_video").where({ id }).update({
            outputAudit: JSON.stringify({
              schemaVersion: 1,
              auditedAt: Date.now(),
              ...probedMetadata,
              ...outputAudit,
            }),
          });
        }
        await updateVideoTaskState({ id, videoTrackId: trackId }, "已完成");
      } catch (error) {
        const reason = u.error(error).message;
        await updateVideoTaskState({ id, videoTrackId: trackId }, "生成失败", reason);
      }
    })();
  },
);
