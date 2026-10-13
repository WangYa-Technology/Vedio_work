import express from "express";
import { success } from "@/lib/responseFormat";
import u from "@/utils";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { EMPTY_PROJECT_GLOBAL_CONTEXT } from "@/schemas/projectGlobalContext";
import { loadScriptAgentProgress } from "@/agents/scriptAgent/progress";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    agentType: z.enum(["scriptAgent"]),
  }),
  async (req, res) => {
    const { projectId, agentType } = req.body;
    const row = await u.db("o_agentWorkData").where({ projectId: projectId, key: agentType }).first();
    // 进度快照（三阶段状态 / 每集审核状态 / 结论句）：派生数据、只读展示，前端不得回写工作表
    const progress = await loadScriptAgentProgress(projectId);

    if (!row) {
      const now = Date.now();
      const [id] = await u.db("o_agentWorkData").insert({
        projectId: projectId,
        key: agentType,
        data: JSON.stringify({
          storySkeleton: "",
          adaptationStrategy: "",
          projectGlobalContext: EMPTY_PROJECT_GLOBAL_CONTEXT,
        }),
        createTime: now,
        updateTime: now,
      });
      return res.status(200).send(
        success({
          data: {
            storySkeleton: "",
            adaptationStrategy: "",
            script: [],
            projectGlobalContext: EMPTY_PROJECT_GLOBAL_CONTEXT,
            progress,
          },
          id,
        }),
      );
    }
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(row.data ?? "{}");
    } catch {
      data = {};
    }
    if (!data.projectGlobalContext || typeof data.projectGlobalContext !== "object") {
      data.projectGlobalContext = EMPTY_PROJECT_GLOBAL_CONTEXT;
    }
    data.script = await u.db("o_script").where({ projectId }).select("id", "name", "content");
    data.progress = progress;

    res.status(200).send(success({ data, id: row.id }));
  },
);
