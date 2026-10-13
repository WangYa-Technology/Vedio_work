import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import {
  readProductionAgentRuntime,
  readScriptAgentRuntime,
  writeProductionAgentRuntime,
  writeScriptAgentRuntime,
} from "@/utils/agentPersistence";

const router = express.Router();
const workflowState = z.enum(["idle", "working", "retrying", "complete", "error"]);
const runState = z.enum(["idle", "running", "interrupted", "complete", "error"]);

// 服务端后台任务仍在运行时（runState=running，由服务端运行记录器维护），忽略客户端把
// 记录改写成非 running 的快照：典型场景是前端断连时把本地"连接已断开"的错误状态回写
// 上来，会覆盖仍在推进的后台进度，导致重连后无法通过运行记录恢复进度同步。
// 任务真正的结束状态由服务端自己落库，不依赖客户端回写。
function shouldKeepRunningRecord(
  stored: { runState?: { state?: string } } | null | undefined,
  incoming: { runState?: { state?: string } },
  label: string,
) {
  if (stored?.runState?.state !== "running") return false;
  if (incoming?.runState?.state === "running") return false;
  console.warn(
    `[agents/setRuntime] 已忽略覆盖运行中记录的快照：${label}，传入 runState=${
      incoming?.runState?.state ?? "unknown"
    }`,
  );
  return true;
}

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    agentType: z.enum(["scriptAgent", "productionAgent"]),
    episodesId: z.number().optional(),
    data: z.object({
      version: z.literal(1),
      messages: z.array(z.record(z.string(), z.unknown())).max(500),
      workflowStatus: z.object({ state: workflowState, label: z.string(), phase: z.string().optional() }),
      runState: z.object({
        state: runState,
        phase: z.string().optional(),
        startedAt: z.number().optional(),
        updatedAt: z.number(),
        resumable: z.boolean(),
      }),
      updatedAt: z.number(),
    }),
  }),
  async (req, res) => {
    const { projectId, agentType, episodesId, data } = req.body;
    if (agentType === "scriptAgent") {
      if (shouldKeepRunningRecord(await readScriptAgentRuntime(projectId), data, `scriptAgent projectId=${projectId}`)) {
        res.status(200).send(success(null));
        return;
      }
      await writeScriptAgentRuntime(projectId, data);
      res.status(200).send(success(null));
      return;
    }
    if (!Number.isSafeInteger(episodesId) || episodesId <= 0) {
      res.status(400).send({ message: "productionAgent 运行记录缺少有效的剧集 ID" });
      return;
    }
    if (
      shouldKeepRunningRecord(
        await readProductionAgentRuntime(projectId, episodesId),
        data,
        `productionAgent projectId=${projectId} episodesId=${episodesId}`,
      )
    ) {
      res.status(200).send(success(null));
      return;
    }
    await writeProductionAgentRuntime(projectId, episodesId, data);
    res.status(200).send(success(null));
  },
);
