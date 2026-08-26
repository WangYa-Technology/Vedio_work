import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { readScriptAgentRuntime } from "@/utils/agentPersistence";

const router = express.Router();

export default router.post(
  "/",
  validateFields({ projectId: z.number(), agentType: z.literal("scriptAgent") }),
  async (req, res) => {
    res.status(200).send(success(await readScriptAgentRuntime(req.body.projectId)));
  },
);
