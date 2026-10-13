import express from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/middleware/middleware";
import { success } from "@/lib/responseFormat";
import { resolveVideoModelPromptProfile } from "@/utils/videoModelPromptProfile";
import { buildVideoTaskData, resolveTierDuration } from "@/utils/videoTaskData";
import {
  enforceVideoPromptOutputConstraints,
  migrateLegacyPromptForH3,
} from "@/utils/videoPromptMigration";
import {
  hashPromptTemplate,
  launchVideoGeneration,
  normalizeVideoMode,
  readReferenceBase64,
  submitVideoGeneration,
  type VideoSubmissionReference,
} from "@/services/videoGenerationSubmit";

const router = express.Router();

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
    const references: VideoSubmissionReference[] = uploadData.map(
      (item: any, index: number) => ({
        index,
        id: Number(item.id),
        sources: item.sources,
        fileType: resolveReferenceType(item),
        filePath: referencePaths[index],
      }),
    );
    const imageBase64 = await readReferenceBase64(references);
    const requestedDuration = Math.max(
      1,
      Math.round(Number(duration || track.duration || 5)),
    );
    // 分镜档位映射：计划 11~13s 按 10s 生成、16~18s 按 15s 生成。
    // 批量生成不带 duration 时会落到 track.duration（分镜计划值），这里补齐映射，
    // 保证提交时长与提示词时间轴一致；已映射过的值不会二次生效。
    const supportedDurations = (
      (taskData.projectConfig.durationResolutionMap || []) as Array<{
        duration?: number | number[];
      }>
    )
      .flatMap((item) =>
        Array.isArray(item?.duration) ? item.duration : [item?.duration],
      )
      .map(Number)
      .filter((value) => Number.isFinite(value));
    const tierDuration = resolveTierDuration(
      requestedDuration,
      supportedDurations,
      Number(videoPromptProfile?.maxDuration) || 15,
    );
    const targetDuration = tierDuration ?? requestedDuration;
    const effectiveDuration = /minimax.*h3|h3.*minimax/i.test(model)
      ? Math.min(15, targetDuration)
      : targetDuration;
    const effectiveRatio = project?.videoRatio || "16:9";
    const effectiveResolution = String(resolution || "864x480");

    const context = await submitVideoGeneration({
      projectId,
      scriptId,
      trackId,
      prompt: effectivePrompt,
      model,
      mode,
      resolution: effectiveResolution,
      duration: effectiveDuration,
      audio: Boolean(audio),
      parameters: parameters || {},
      promptTemplateId: promptTemplateId || null,
      promptTemplateVersion: promptTemplate
        ? hashPromptTemplate(promptTemplate.useData || promptTemplate.data)
        : null,
      ratio: effectiveRatio,
      references,
      videoPromptProfile,
    });
    res
      .status(200)
      .send(
        success(
          { id: context.videoId, state: "生成中" },
          "视频生成任务已提交",
        ),
      );

    launchVideoGeneration(context, {
      projectId,
      trackId,
      describe: context.describe,
      relatedObjects: context.relatedObjects,
      model,
      prompt: effectivePrompt,
      imageBase64,
      references,
      mode: normalizeVideoMode(mode),
      ratio: effectiveRatio,
      duration: effectiveDuration,
      resolution: effectiveResolution,
      audio: Boolean(audio),
      parameters: parameters || {},
    });
  },
);
