/**
 * 「生成中」视频任务的超时兜底看门狗。
 *
 * 云端工作流偶发卡死时（平台侧任务排队不动、审核卡住、结果链接长期不返回），
 * 请求侧的轮询可以一直挂着等 90 分钟，界面却只能显示「生成中」。
 * 这里按固定周期扫描 `o_video` 中状态为「生成中」的记录，超过阈值（默认 30 分钟）
 * 就落「生成失败」并写明可修复；若云端稍后真的返回了成功结果，仍允许覆盖为「已完成」。
 *
 * 与「手动标记失败」的区别：手动标记会写 `abandonedAt`，此后云端结果一律不再改写状态。
 */

import u from "@/utils";
import {
  isVideoTaskTimedOut,
  resolveVideoTaskTimeoutMs,
} from "@/utils/videoFailurePolicy";
import { parseVideoTaskData, updateVideoTaskState } from "@/utils/videoTaskRecovery";

export const VIDEO_TASK_WATCHDOG_INTERVAL_MS = 60_000;
const MIN_WATCHDOG_INTERVAL_MS = 10_000;

export interface VideoTaskTiming {
  /** 任务开始时间（providerTaskData.startedAt，缺失回退 createTime） */
  startedAt: number;
  /** 用户手动放弃/标记失败时间，>0 表示不再接收云端结果 */
  abandonedAt: number;
  /** 已判定超时的时间，避免重复判定 */
  timeoutAt: number;
  /** 平台偶发失败自动重试次数 */
  autoRetryCount: number;
}

export interface VideoTaskWatchRow {
  id: number;
  videoTrackId?: number | null;
  state?: string | null;
  providerTaskData?: string | null;
  createTime?: number | null;
}

export function parseVideoTaskTiming(
  providerTaskData: unknown,
  createTime?: unknown,
): VideoTaskTiming {
  const task = parseVideoTaskData(
    typeof providerTaskData === "string" ? providerTaskData : null,
  );
  return {
    startedAt: Number(task?.startedAt) || Number(createTime) || 0,
    abandonedAt: Number(task?.abandonedAt) || 0,
    timeoutAt: Number(task?.timeoutAt) || 0,
    autoRetryCount: Number(task?.autoRetryCount) || 0,
  };
}

/** 判断一条记录是否被判超时（纯函数，便于单测）。 */
export function shouldMarkVideoTaskTimedOut(
  row: VideoTaskWatchRow,
  now: number,
  timeoutMs = resolveVideoTaskTimeoutMs(),
): boolean {
  if (row.state !== "生成中") return false;
  const timing = parseVideoTaskTiming(row.providerTaskData, row.createTime);
  if (timing.abandonedAt || timing.timeoutAt) return false;
  return isVideoTaskTimedOut(timing.startedAt, now, timeoutMs);
}

/** 用户手动放弃：写 `abandonedAt`，此后云端结果不再改写状态。 */
export async function abandonVideoTask(videoId: number, at = Date.now()) {
  const record = await u
    .db("o_video")
    .where({ id: videoId })
    .first("providerTaskData");
  if (!record) return;
  const previous = (parseVideoTaskData(record.providerTaskData) || {}) as Record<
    string,
    unknown
  >;
  await u
    .db("o_video")
    .where({ id: videoId })
    .update({
      providerTaskData: JSON.stringify({ ...previous, abandonedAt: at }),
    });
}

async function writeTimeoutMark(videoId: number, at: number) {
  const record = await u
    .db("o_video")
    .where({ id: videoId })
    .first("providerTaskData");
  if (!record) return;
  const previous = (parseVideoTaskData(record.providerTaskData) || {}) as Record<
    string,
    unknown
  >;
  await u
    .db("o_video")
    .where({ id: videoId })
    .update({
      providerTaskData: JSON.stringify({ ...previous, timeoutAt: at }),
    });
}

/** 扫描一次超时任务，返回被标记的数量。 */
export async function sweepVideoTaskTimeouts(
  now = Date.now(),
  timeoutMs = resolveVideoTaskTimeoutMs(),
): Promise<number> {
  const rows = (await u
    .db("o_video")
    .where({ state: "生成中" })
    .select(
      "id",
      "videoTrackId",
      "state",
      "providerTaskData",
      "createTime",
    )) as VideoTaskWatchRow[];
  const timedOut = rows.filter((row) =>
    shouldMarkVideoTaskTimedOut(row, now, timeoutMs),
  );
  const minutes = Math.max(1, Math.round(timeoutMs / 60_000));
  for (const row of timedOut) {
    const reason = `云端任务超过 ${minutes} 分钟没有返回结果，已按超时处理，可修复重试`;
    await writeTimeoutMark(Number(row.id), now);
    await updateVideoTaskState(
      { id: Number(row.id), videoTrackId: Number(row.videoTrackId) },
      "生成失败",
      reason,
    );
    console.warn(
      `[视频超时兜底] ${row.id}（track ${row.videoTrackId}）已超过 ${minutes} 分钟未返回，标记为生成失败`,
    );
  }
  return timedOut.length;
}

let watchdogTimer: NodeJS.Timeout | null = null;

/** 启动看门狗（重复调用幂等）。 */
export function startVideoTaskWatchdog(
  intervalMs = VIDEO_TASK_WATCHDOG_INTERVAL_MS,
): void {
  if (watchdogTimer) return;
  const tick = async () => {
    try {
      await sweepVideoTaskTimeouts();
    } catch (error) {
      console.warn(`[视频超时兜底] 扫描失败：${u.error(error).message}`);
    }
  };
  watchdogTimer = setInterval(
    () => void tick(),
    Math.max(MIN_WATCHDOG_INTERVAL_MS, intervalMs),
  );
  watchdogTimer.unref?.();
  void tick();
}

export function stopVideoTaskWatchdog(): void {
  if (!watchdogTimer) return;
  clearInterval(watchdogTimer);
  watchdogTimer = null;
}
