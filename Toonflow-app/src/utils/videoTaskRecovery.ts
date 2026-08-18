import axios from "axios";
import { randomUUID } from "node:crypto";
import db, { db as knex } from "@/utils/db";
import oss from "@/utils/oss";
import getPath from "@/utils/getPath";
import type { o_video } from "@/types/database";
import { auditVideoOutput } from "@/utils/videoOutputAudit";
import { probeVideoFile } from "@/utils/videoOutputProbe";

export const VIDEO_WORKER_RUN_ID = randomUUID();

export interface PersistedVideoTask {
  provider?: string;
  taskId?: string;
  baseUrl?: string;
  runId: string;
  startedAt: number;
  submittedAt?: number;
}

interface ComfyFileOutput {
  filename: string;
  subfolder?: string;
  type?: string;
}

const recoveryLocks = new Map<number, Promise<void>>();
const VIDEO_EXTENSIONS = /\.(mp4|webm|mov|mkv)$/i;
const TASK_HISTORY_TTL = 2 * 60 * 60 * 1000;

export function pendingVideoTaskData(
  startedAt = Date.now(),
): PersistedVideoTask {
  return { runId: VIDEO_WORKER_RUN_ID, startedAt };
}

export function parseVideoTaskData(
  value?: string | null,
): PersistedVideoTask | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function findVideoOutput(
  value: unknown,
  seen = new Set<unknown>(),
): ComfyFileOutput | null {
  if (!value || typeof value !== "object" || seen.has(value)) return null;
  seen.add(value);
  if (!Array.isArray(value)) {
    const candidate = value as Record<string, unknown>;
    if (
      typeof candidate.filename === "string" &&
      VIDEO_EXTENSIONS.test(candidate.filename)
    ) {
      return {
        filename: candidate.filename,
        subfolder:
          typeof candidate.subfolder === "string" ? candidate.subfolder : "",
        type: typeof candidate.type === "string" ? candidate.type : "output",
      };
    }
  }
  for (const item of Array.isArray(value) ? value : Object.values(value)) {
    const found = findVideoOutput(item, seen);
    if (found) return found;
  }
  return null;
}

function comfyFailureReason(history: any): string {
  const messages = Array.isArray(history?.status?.messages)
    ? history.status.messages
    : [];
  for (const message of messages) {
    if (message?.[0] !== "execution_error") continue;
    return String(
      message?.[1]?.exception_message ||
        message?.[1]?.exception_type ||
        "ComfyUI 生成失败",
    );
  }
  return history?.status?.status_str === "error" ? "ComfyUI 生成失败" : "";
}

export async function updateVideoTaskState(
  video: Pick<o_video, "id" | "videoTrackId">,
  state: "已完成" | "生成失败",
  reason = "",
) {
  if (video.id == null) return;
  await knex.transaction(async (trx) => {
    await trx("o_video")
      .where({ id: video.id })
      .update({ state, errorReason: reason });
    if (video.videoTrackId == null) return;
    const latestVideo = await trx("o_video")
      .where({ videoTrackId: video.videoTrackId })
      .orderByRaw("COALESCE(createTime, id) DESC")
      .first("id");
    if (latestVideo?.id !== video.id) return;
    await trx("o_videoTrack")
      .where({ id: video.videoTrackId })
      .update({ state, reason });
  });
}

async function recoverComfyTask(
  video: o_video,
  task: PersistedVideoTask,
): Promise<void> {
  if (!video.filePath || !task.taskId || !task.baseUrl) return;
  const baseUrl = task.baseUrl.replace(/\/$/, "");
  const response = await axios.get(
    `${baseUrl}/history/${encodeURIComponent(task.taskId)}`,
    {
      timeout: 30_000,
    },
  );
  const history = response.data?.[task.taskId];
  if (!history) {
    if (task.submittedAt && Date.now() - task.submittedAt > TASK_HISTORY_TTL) {
      await updateVideoTaskState(
        video,
        "生成失败",
        "云端任务记录已失效，请重新生成",
      );
    }
    return;
  }

  const failure = comfyFailureReason(history);
  if (failure) {
    await updateVideoTaskState(video, "生成失败", failure);
    return;
  }
  const output = findVideoOutput(history.outputs);
  if (!output) return;

  const query = new URLSearchParams({
    filename: output.filename,
    subfolder: output.subfolder || "",
    type: output.type || "output",
  });
  const fileResponse = await axios.get(`${baseUrl}/view?${query}`, {
    responseType: "arraybuffer",
    timeout: 120_000,
  });
  const buffer = Buffer.from(fileResponse.data);
  if (!buffer.length) throw new Error("ComfyUI 返回了空视频文件");
  await oss.writeFile(video.filePath, buffer);
  const metadata = await probeVideoFile(getPath(["oss", video.filePath]));
  if (metadata) {
    const project = video.projectId != null
      ? await db("o_project").where({ id: video.projectId }).first("videoRatio")
      : null;
    const outputAudit = auditVideoOutput({
      expectedRatio: project?.videoRatio || "16:9",
      expectedDuration: Number(video.time) || undefined,
      ...metadata,
    });
    await db("o_video").where({ id: video.id }).update({
      outputAudit: JSON.stringify({
        schemaVersion: 1,
        auditedAt: Date.now(),
        ...metadata,
        ...outputAudit,
      }),
    });
  }
  await updateVideoTaskState(video, "已完成");
}

async function recoverOne(video: o_video): Promise<void> {
  if (video.id == null || video.state !== "生成中") return;
  const task = parseVideoTaskData(video.providerTaskData);
  if (!task || task.runId === VIDEO_WORKER_RUN_ID) return;

  if (!task.taskId) {
    await updateVideoTaskState(
      video,
      "生成失败",
      "服务重启时云端任务尚未提交，请重新生成",
    );
    return;
  }
  if (!task.provider?.toLowerCase().includes("comfyui")) return;
  await recoverComfyTask(video, task);
}

export async function recoverPendingVideoTasks(
  videos: o_video[],
): Promise<void> {
  await Promise.all(
    videos.map(async (video) => {
      if (video.id == null || video.state !== "生成中") return;
      const existing = recoveryLocks.get(video.id);
      if (existing) return existing;
      const pending = recoverOne(video)
        .catch((error) => {
          console.warn(
            `[视频任务恢复] ${video.id} 暂未恢复:`,
            error instanceof Error ? error.message : error,
          );
        })
        .finally(() => recoveryLocks.delete(video.id!));
      recoveryLocks.set(video.id, pending);
      return pending;
    }),
  );
}

export const videoTaskRecoveryInternals = {
  findVideoOutput,
  comfyFailureReason,
};
