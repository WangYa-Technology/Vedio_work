import express from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import { classifySupervisionScope } from "@/agents/scriptAgent/progress";

const router = express.Router();

const stageSchema = z.enum(["storySkeleton", "adaptationStrategy"]);
type StageKey = z.infer<typeof stageSchema>;

/** 移除 supervisionHistory 中属于所选阶段的审核轮次，保留集号区间与其它阶段记录 */
function filterStageRounds(history: unknown, stage: StageKey) {
  if (!Array.isArray(history)) return [];
  return history.filter((round: any) => {
    const scope = classifySupervisionScope(round?.scope);
    return !(scope.kind === "stage" && scope.stage === stage);
  });
}

/** 判断审核历史中是否仍残留该阶段的轮次 */
function hasStageRounds(history: unknown, stage: StageKey) {
  if (!Array.isArray(history)) return false;
  return history.some((round: any) => {
    const scope = classifySupervisionScope(round?.scope);
    return scope.kind === "stage" && scope.stage === stage;
  });
}

// 删除指定阶段（故事骨架 / 改编策略）：仅清空该阶段内容与对应审核记录，不级联下游剧本
export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    stage: stageSchema,
  }),
  async (req, res) => {
    const { projectId, stage } = req.body as { projectId: number; stage: StageKey };

    const row = await u.db("o_agentWorkData").where({ projectId, key: "scriptAgent" }).first();
    if (!row) return res.status(400).send(error("剧本工作区尚未初始化，无需删除"));

    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(row.data ?? "{}");
    } catch {
      // 与 setPlanData 保持一致：数据格式异常时阻止覆盖，避免破坏存量工作区。
      return res.status(400).send(error("现有剧本工作区数据格式无效，已阻止覆盖"));
    }

    const next = {
      ...data,
      [stage]: "",
      supervisionHistory: filterStageRounds(data.supervisionHistory, stage),
    };
    await u.db("o_agentWorkData").where({ id: row.id, projectId, key: "scriptAgent" }).update({
      data: JSON.stringify(next),
      updateTime: Date.now(),
    });

    // 回读校验：阶段内容已清空，且审核历史中不再残留该阶段轮次。
    const saved = await u.db("o_agentWorkData").where({ id: row.id }).select("data").first();
    let savedData: Record<string, unknown> = {};
    try {
      savedData = JSON.parse(saved?.data ?? "{}");
    } catch {
      savedData = {};
    }
    if (String(savedData[stage] ?? "").trim() || hasStageRounds(savedData.supervisionHistory, stage)) {
      throw new Error("阶段删除后回读校验失败");
    }

    res.status(200).send(success({ stage, cleared: true }));
  },
);
