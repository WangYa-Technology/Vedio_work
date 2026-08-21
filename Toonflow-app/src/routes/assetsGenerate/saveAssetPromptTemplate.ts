import express from "express";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { parseAssetInferenceTemplate } from "@/utils/assetInferenceTemplate";
import { saveAssetInferenceTemplate } from "./assetPromptTemplateStore";

const router = express.Router();

export default router.post(
  "/",
  validateFields({ data: z.union([z.string(), z.record(z.string(), z.any())]) }),
  async (req, res) => {
    const template = parseAssetInferenceTemplate(req.body.data);
    if (!template) return res.status(400).send(error("模板结构无效"));
    const saved = await saveAssetInferenceTemplate(template);
    res.status(200).send(success(saved));
  },
);

