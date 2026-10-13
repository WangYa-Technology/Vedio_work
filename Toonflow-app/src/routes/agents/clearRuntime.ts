import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { PRODUCTION_AGENT_RUNTIME_KEY, SCRIPT_AGENT_RUNTIME_KEY } from "@/utils/agentPersistence";

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
      await u.db("o_agentWorkData").where({ projectId, key: SCRIPT_AGENT_RUNTIME_KEY }).del();
      res.status(200).send(success(null));
      return;
    }
    if (!Number.isSafeInteger(episodesId) || episodesId <= 0) {
      res.status(400).send({ message: "productionAgent 运行记录缺少有效的剧集 ID" });
      return;
    }
    await u.db("o_agentWorkData").where({ projectId, episodesId, key: PRODUCTION_AGENT_RUNTIME_KEY }).del();
    res.status(200).send(success(null));
  },
);
