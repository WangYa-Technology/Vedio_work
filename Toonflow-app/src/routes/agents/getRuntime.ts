import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { readProductionAgentRuntime, readScriptAgentRuntime } from "@/utils/agentPersistence";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    agentType: z.enum(["scriptAgent", "productionAgent"]),
    episodesId: z.number().optional(),
  }),
  async (req, res) => {
    const { projectId, agentType, episodesId } = req.body;
    if (agentType === "scriptAgent") {
      res.status(200).send(success(await readScriptAgentRuntime(projectId)));
      return;
    }
    if (!Number.isSafeInteger(episodesId) || episodesId <= 0) {
      res.status(400).send({ message: "productionAgent 运行记录缺少有效的剧集 ID" });
      return;
    }
    res.status(200).send(success(await readProductionAgentRuntime(projectId, episodesId)));
  },
);
