import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { SCRIPT_AGENT_RUNTIME_KEY } from "@/utils/agentPersistence";

const router = express.Router();

export default router.post(
  "/",
  validateFields({ projectId: z.number(), agentType: z.literal("scriptAgent") }),
  async (req, res) => {
    await u.db("o_agentWorkData").where({ projectId: req.body.projectId, key: SCRIPT_AGENT_RUNTIME_KEY }).del();
    res.status(200).send(success(null));
  },
);
