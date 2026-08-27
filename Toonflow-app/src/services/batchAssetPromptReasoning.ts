import pLimit from "p-limit";
import { v4 as uuidv4 } from "uuid";
import u from "@/utils";
import {
  AssetPromptReasoningError,
  getReasoningTemplate,
  reasonAssetPrompt,
} from "@/services/assetPromptReasoning";

type BatchTaskStatus = "running" | "cancelling" | "completed" | "cancelled";
type BatchItemStatus = "pending" | "running" | "success" | "failed" | "skipped" | "cancelled";

interface BatchTaskItem {
  assetsId: number;
  name: string;
  status: BatchItemStatus;
  error?: string;
}

interface BatchTask {
  taskId: string;
  projectId: number;
  templateId: number;
  status: BatchTaskStatus;
  cancelRequested: boolean;
  createdAt: number;
  completedAt?: number;
  items: BatchTaskItem[];
}

const tasks = new Map<string, BatchTask>();
const TASK_TTL_MS = 60 * 60 * 1000;

function pruneTasks() {
  const now = Date.now();
  for (const [taskId, task] of tasks) {
    if (task.completedAt && now - task.completedAt > TASK_TTL_MS) tasks.delete(taskId);
  }
}

function finishTask(task: BatchTask) {
  task.completedAt = Date.now();
  task.status = task.cancelRequested ? "cancelled" : "completed";
}

function snapshot(task: BatchTask) {
  const count = (status: BatchItemStatus) => task.items.filter((item) => item.status === status).length;
  const success = count("success");
  const failed = count("failed");
  const skipped = count("skipped");
  const cancelled = count("cancelled");
  const running = count("running");
  const processed = success + failed + skipped + cancelled;
  return {
    taskId: task.taskId,
    projectId: task.projectId,
    templateId: task.templateId,
    status: task.status,
    total: task.items.length,
    processed,
    running,
    success,
    failed,
    skipped,
    cancelled,
    createdAt: task.createdAt,
    completedAt: task.completedAt,
    items: task.items.map((item) => ({ ...item })),
  };
}

async function markPendingItemsCancelled(task: BatchTask) {
  const pendingIds = task.items.filter((item) => item.status === "pending").map((item) => item.assetsId);
  task.items.forEach((item) => {
    if (item.status === "pending") item.status = "cancelled";
  });
  if (pendingIds.length) {
    await u.db("o_assets").where({ projectId: task.projectId }).whereIn("id", pendingIds).update({
      promptState: "已取消",
      promptErrorReason: "批量推理已取消",
    });
  }
}

async function runTask(task: BatchTask, concurrentCount: number) {
  const limit = pLimit(concurrentCount);
  await Promise.allSettled(
    task.items.map((item) => limit(async () => {
      if (task.cancelRequested || item.status === "cancelled") return;
      item.status = "running";
      try {
        await reasonAssetPrompt({
          projectId: task.projectId,
          assetsId: item.assetsId,
          templateId: task.templateId,
        });
        item.status = "success";
      } catch (caught) {
        item.error = caught instanceof Error ? caught.message : "图片提示词推理失败";
        item.status = caught instanceof AssetPromptReasoningError && caught.disposition === "skipped" ? "skipped" : "failed";
      }
    })),
  );
  finishTask(task);
}

export async function startBatchAssetPromptReasoning(input: {
  projectId: number;
  assetsIds: number[];
  templateId: number;
  concurrentCount?: number;
}) {
  pruneTasks();
  await getReasoningTemplate(input.templateId);
  const assetsIds = [...new Set(input.assetsIds.map(Number).filter(Number.isFinite))];
  const assets = await u.db("o_assets").where({ projectId: input.projectId }).whereIn("id", assetsIds).select("id", "name");
  const names = new Map<number, string>(assets.map((asset) => [Number(asset.id), String(asset.name || "未命名")]));
  const task: BatchTask = {
    taskId: uuidv4(),
    projectId: input.projectId,
    templateId: input.templateId,
    status: "running",
    cancelRequested: false,
    createdAt: Date.now(),
    items: assetsIds.map((assetsId) => ({
      assetsId,
      name: names.get(assetsId) || `资产 #${assetsId}`,
      status: "pending",
    })),
  };
  tasks.set(task.taskId, task);
  if (task.items.length === 0) {
    finishTask(task);
    return snapshot(task);
  }

  const existingIds = assets.map((asset) => Number(asset.id));
  if (existingIds.length) {
    await u.db("o_assets").where({ projectId: input.projectId }).whereIn("id", existingIds).update({
      promptState: "生成中",
      promptErrorReason: null,
    });
  }
  void runTask(task, Math.min(Math.max(input.concurrentCount || 2, 1), 10));
  return snapshot(task);
}

export function getBatchAssetPromptReasoningTask(taskId: string, projectId: number) {
  pruneTasks();
  const task = tasks.get(taskId);
  if (!task || task.projectId !== projectId) return null;
  return snapshot(task);
}

export async function cancelBatchAssetPromptReasoningTask(taskId: string, projectId: number) {
  const task = tasks.get(taskId);
  if (!task || task.projectId !== projectId) return null;
  if (task.status === "completed" || task.status === "cancelled") return snapshot(task);
  task.cancelRequested = true;
  task.status = "cancelling";
  await markPendingItemsCancelled(task);
  if (!task.items.some((item) => item.status === "running")) finishTask(task);
  return snapshot(task);
}
