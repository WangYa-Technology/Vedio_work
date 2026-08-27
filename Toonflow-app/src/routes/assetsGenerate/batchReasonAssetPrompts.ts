import express from "express";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { startBatchAssetPromptReasoning } from "@/services/batchAssetPromptReasoning";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    assetsIds: z.array(z.number()).min(1).max(500),
    templateId: z.number(),
    concurrentCount: z.number().int().min(1).optional(),
  }),
  async (req, res) => {
    try {
      const data = await startBatchAssetPromptReasoning(req.body);
      return res.status(202).send(success(data));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "批量推理启动失败";
      return res.status(400).send(error(message));
    }
  },
);
