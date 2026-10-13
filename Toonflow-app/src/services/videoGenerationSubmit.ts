/**
 * 视频生成的统一提交与跟踪服务。
 *
 * 首次生成（`routes/production/workbench/generateVideo.ts`）与失败修复重试
 * （`retryVideo` / `retryVideos` / `markVideoFailed`）必须走完全相同的管线：
 * 落快照 → 置 `o_videoTrack` 生成中 → 调供应商 → 探测与审计 → 收尾状态，
 * 否则会出现「重试的记录没有 outputAudit」「track 状态不同步」这类行为分叉。
 *
 * 自动重试策略（平台偶发失败自动重试 1 次）也收敛在这里：供应商脚本只负责
 * 把失败原因说清楚，是否重提由 `shouldAutoRetryVideoTask` 判定。
 */

import { createHash } from "node:crypto";
import u from "@/utils";
import {
  shouldAutoRetryVideoTask,
} from "@/utils/videoFailurePolicy";
import {
  pendingVideoTaskData,
  parseVideoTaskData,
  updateVideoTaskState,
  VIDEO_WORKER_RUN_ID,
} from "@/utils/videoTaskRecovery";
import { auditVideoOutput } from "@/utils/videoOutputAudit";
import { probeVideoFile } from "@/utils/videoOutputProbe";

export type VideoReferenceSource = "assets" | "storyboard";
export type VideoReferenceFileType = "image" | "video" | "audio";

export interface VideoSubmissionReference {
  index: number;
  id: number;
  sources: VideoReferenceSource;
  fileType: VideoReferenceFileType;
  filePath: string;
  name?: string;
}

export interface VideoSubmissionInput {
  projectId: number;
  scriptId: number;
  trackId: number;
  prompt: string;
  model: string;
  mode?: string | string[];
  resolution?: string;
  duration?: number;
  audio?: boolean;
  parameters?: Record<string, string | number | boolean>;
  promptTemplateId?: number | null;
  promptTemplateVersion?: string | null;
  ratio?: string;
  references: VideoSubmissionReference[];
  /** 模型提示词档案，沿用首次生成的快照结构，便于追溯与重试复用 */
  videoPromptProfile?: unknown;
  /** 修复重试：来源失败记录 id，写入快照便于追溯 */
  retryOfVideoId?: number;
  /** 修复重试：预检自动修复项，写入快照便于追溯 */
  repairFixed?: string[];
  /** 本次提交的提示词来源（修复前的原文），用于判断能否把编号校正回写分镜 */
  sourcePrompt?: string;
  /** 任务描述（默认「生成第 N 个视频片段」） */
  describe?: string;
}

export interface VideoGenerationContext {
  videoId: number;
  trackId: number;
  projectId: number;
  filePath: string;
  describe: string;
  relatedObjects: string;
}

const RATIO_FALLBACK = "16:9";
const RESOLUTION_FALLBACK = "864x480";

export function normalizeVideoMode(mode: string | string[] | undefined) {
  if (Array.isArray(mode)) return mode;
  const value = String(mode || "").trim();
  if (value.startsWith("[")) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
        return parsed;
      }
    } catch {
      // 保留原始模式，让供应商自行处理无法解析的自定义模式。
    }
  }
  return value;
}

export function hashPromptTemplate(value: unknown) {
  return createHash("sha256")
    .update(String(value || ""))
    .digest("hex")
    .slice(0, 16);
}

async function nextId(table: "o_video") {
  let id = Date.now();
  while (await u.db(table).where({ id }).first()) id += 1;
  return id;
}

/** 参考素材路径 → base64（与首次生成完全一致的读取方式）。 */
export async function readReferenceBase64(references: VideoSubmissionReference[]) {
  return Promise.all(
    references.map((reference) => u.oss.getImageBase64(reference.filePath)),
  );
}

/**
 * 落库一次视频生成任务（不等待供应商结果）。
 * 调用方负责在响应后调用 `launchVideoGeneration` 开始后台跟踪，保持
 * 「先告诉前端任务已提交、再开始跑」的既有体验。
 */
export async function submitVideoGeneration(
  input: VideoSubmissionInput,
): Promise<VideoGenerationContext> {
  const startedAt = Date.now();
  const id = await nextId("o_video");
  const filePath = `${input.projectId}/video/${input.scriptId}/${u.uuid()}.mp4`;
  const effectiveDuration = Math.max(1, Math.round(Number(input.duration) || 5));
  const ratio = input.ratio || RATIO_FALLBACK;
  const resolution = input.resolution || RESOLUTION_FALLBACK;
  const generationConfig = {
    schemaVersion: 1,
    model: input.model,
    mode: normalizeVideoMode(input.mode),
    ratio,
    resolution,
    duration: effectiveDuration,
    audio: Boolean(input.audio),
    parameters: input.parameters || {},
    ...(input.videoPromptProfile ? { videoPromptProfile: input.videoPromptProfile } : {}),
    ...(input.retryOfVideoId ? { retryOfVideoId: input.retryOfVideoId } : {}),
    ...(input.repairFixed?.length ? { repairFixed: input.repairFixed } : {}),
  };
  const referenceSnapshot = input.references.map((reference, index) => ({
    index,
    id: reference.id,
    sources: reference.sources,
    fileType: reference.fileType,
    filePath: reference.filePath,
  }));

  await u.db("o_video").insert({
    id,
    projectId: input.projectId,
    scriptId: input.scriptId,
    videoTrackId: input.trackId,
    filePath,
    state: "生成中",
    time: effectiveDuration,
    errorReason: "",
    model: input.model,
    providerTaskData: JSON.stringify(pendingVideoTaskData(startedAt)),
    promptSnapshot: input.prompt,
    promptTemplateId: input.promptTemplateId || null,
    promptTemplateVersion: input.promptTemplateVersion || null,
    referenceSnapshot: JSON.stringify(referenceSnapshot),
    generationConfig: JSON.stringify(generationConfig),
    createTime: startedAt,
  });

  const trackUpdate: Record<string, unknown> = {
    duration: effectiveDuration,
    state: "生成中",
    reason: "",
  };
  // 修复重试只在「分镜里的提示词与本次提交来源一致」时回写编号校正结果，
  // 避免覆盖用户在失败后重新推理出来的新提示词。
  const track = await u.db("o_videoTrack").where({ id: input.trackId }).first();
  const promptSource = String(input.sourcePrompt ?? input.prompt);
  if (!input.retryOfVideoId || String(track?.prompt || "") === promptSource) {
    trackUpdate.prompt = input.prompt;
  }
  await u.db("o_videoTrack").where({ id: input.trackId }).update(trackUpdate);

  return {
    videoId: id,
    trackId: input.trackId,
    projectId: input.projectId,
    filePath,
    describe: input.describe || `生成第 ${input.trackId} 个视频片段`,
    relatedObjects: JSON.stringify({
      trackId: input.trackId,
      videoId: id,
      scriptId: input.scriptId,
      ...(input.retryOfVideoId ? { retryOfVideoId: input.retryOfVideoId } : {}),
      references: input.references,
    }),
  };
}

export interface VideoLaunchInput {
  projectId: number;
  trackId: number;
  describe: string;
  relatedObjects: string;
  model: string;
  prompt: string;
  imageBase64: string[];
  references: VideoSubmissionReference[];
  mode?: string | string[];
  ratio: string;
  duration: number;
  resolution: string;
  audio: boolean;
  parameters?: Record<string, string | number | boolean>;
}

async function persistProviderTask(
  videoId: number,
  task: { taskId: string; baseUrl: string; submittedAt: number },
  provider: string,
) {
  const existing = await u.db("o_video").where({ id: videoId }).first("providerTaskData");
  const previous = parseVideoTaskData(existing?.providerTaskData) || {};
  await u.db("o_video")
    .where({ id: videoId })
    .update({
      providerTaskId: task.taskId,
      providerTaskData: JSON.stringify({
        ...previous,
        ...task,
        provider,
        runId: VIDEO_WORKER_RUN_ID,
      }),
    });
}

async function persistAutoRetry(videoId: number, autoRetryCount: number) {
  const existing = await u.db("o_video").where({ id: videoId }).first("providerTaskData");
  const previous = parseVideoTaskData(existing?.providerTaskData) || {};
  await u.db("o_video")
    .where({ id: videoId })
    .update({
      providerTaskData: JSON.stringify({
        ...previous,
        runId: VIDEO_WORKER_RUN_ID,
        autoRetryCount,
        lastAutoRetryAt: Date.now(),
      }),
    });
}

/**
 * 后台执行一次视频生成：失败且判定为平台偶发失败时自动重提 1 次，
 * 仍失败才落「生成失败」并把重试次数写进原因。
 */
async function runVideoGeneration(
  context: VideoGenerationContext,
  input: VideoLaunchInput,
): Promise<void> {
  let autoRetryCount = 0;
  for (;;) {
    try {
      const instance = await u.Ai.Video(input.model as `${string}:${string}`).run(
        {
          prompt: input.prompt,
          imageBase64: input.imageBase64,
          referenceList: input.references.map((reference, index) => ({
            type: reference.fileType,
            sourceType: "base64" as const,
            base64: input.imageBase64[index],
          })),
          aspectRatio: input.ratio as `${number}:${number}`,
          mode: normalizeVideoMode(input.mode),
          duration: input.duration,
          resolution: input.resolution,
          audio: input.audio,
          parameters: input.parameters || {},
        },
        {
          taskClass: "videoGeneration",
          describe: context.describe,
          relatedObjects: context.relatedObjects,
          projectId: input.projectId,
          onProviderTask: async (task) => {
            await persistProviderTask(context.videoId, task, input.model.split(":")[0]);
          },
        },
      );
      await instance.save(context.filePath);
      const probedMetadata = await probeVideoFile(u.getPath(["oss", context.filePath]));
      if (probedMetadata) {
        const project = await u
          .db("o_project")
          .where({ id: input.projectId })
          .first("videoRatio");
        const outputAudit = auditVideoOutput({
          expectedRatio: project?.videoRatio || RATIO_FALLBACK,
          expectedDuration: input.duration,
          ...probedMetadata,
        });
        await u.db("o_video").where({ id: context.videoId }).update({
          outputAudit: JSON.stringify({
            schemaVersion: 1,
            auditedAt: Date.now(),
            ...probedMetadata,
            ...outputAudit,
          }),
        });
      }
      await updateVideoTaskState(
        { id: context.videoId, videoTrackId: context.trackId },
        "已完成",
      );
      return;
    } catch (error) {
      const reason = u.error(error).message;
      if (shouldAutoRetryVideoTask(reason, autoRetryCount, input.model)) {
        autoRetryCount += 1;
        await persistAutoRetry(context.videoId, autoRetryCount);
        console.warn(
          `[视频生成] ${context.videoId} 判定为平台偶发失败，自动重试第 ${autoRetryCount} 次：${reason}`,
        );
        continue;
      }
      const finalReason =
        autoRetryCount > 0 ? `${reason}（已自动重试 ${autoRetryCount} 次）` : reason;
      await updateVideoTaskState(
        { id: context.videoId, videoTrackId: context.trackId },
        "生成失败",
        finalReason,
      );
      return;
    }
  }
}

/** 不阻塞请求地启动后台生成跟踪。 */
export function launchVideoGeneration(
  context: VideoGenerationContext,
  input: VideoLaunchInput,
): void {
  void runVideoGeneration(context, input).catch(async (error) => {
    const reason = u.error(error).message || "视频生成任务异常中断";
    console.error(`[视频生成] ${context.videoId} 异常：${reason}`);
    await updateVideoTaskState(
      { id: context.videoId, videoTrackId: context.trackId },
      "生成失败",
      reason,
    );
  });
}
