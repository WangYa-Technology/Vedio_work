import express from "express";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import {
  AssetPromptReasoningError,
  reasonAssetPrompt,
} from "@/services/assetPromptReasoning";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    assetsId: z.number(),
    templateId: z.number(),
    referenceImageId: z.number().optional().nullable(),
  }),
  async (req, res) => {
    try {
      const data = await reasonAssetPrompt(req.body);
      return res.status(200).send(success(data));
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : "图片提示词推理失败";
      const statusCode =
        caught instanceof AssetPromptReasoningError
          ? caught.statusCode
          : 502;
      return res
        .status(statusCode)
        .send(error(`图片提示词推理失败：${message}`));
    }
  },
);
