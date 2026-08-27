import express from "express";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { getBatchAssetPromptReasoningTask } from "@/services/batchAssetPromptReasoning";

const router = express.Router();

export default router.post(
  "/",
  validateFields({ projectId: z.number(), taskId: z.string().uuid() }),
  async (req, res) => {
    const data = getBatchAssetPromptReasoningTask(req.body.taskId, req.body.projectId);
    if (!data) return res.status(404).send(error("批量推理任务不存在或已过期"));
    return res.status(200).send(success(data));
  },
);
