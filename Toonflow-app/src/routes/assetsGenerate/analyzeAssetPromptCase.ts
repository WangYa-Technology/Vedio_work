import express from "express";
import { z } from "zod";
import u from "@/utils";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import {
  createTemplateAnalysisPrompt,
  parseAssetInferenceTemplate,
} from "@/utils/assetInferenceTemplate";
import { saveAssetInferenceTemplate } from "./assetPromptTemplateStore";

const router = express.Router();

function extractJson(value: string) {
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const source = (fenced || value).trim();
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(source.slice(start, end + 1));
  } catch {
    return null;
  }
}

export default router.post(
  "/",
  validateFields({
    caseText: z.string().trim().min(20).max(30000),
    name: z.string().trim().max(80).optional(),
    save: z.boolean().optional(),
  }),
  async (req, res) => {
    try {
      const result = (await u.Ai.Text("universalAi").invoke({
        system: createTemplateAnalysisPrompt(req.body.caseText, req.body.name),
        messages: [{ role: "user", content: req.body.caseText }],
        maxRetries: 0,
        maxOutputTokens: 4096,
      })) as any;
      const parsed = extractJson(String(result.text || result._output || ""));
      const template = parseAssetInferenceTemplate(parsed);
      if (!template) return res.status(502).send(error("案例分析未返回有效的图片推理模板"));
      if (req.body.name?.trim()) template.name = req.body.name.trim();
      const data = req.body.save === false ? { id: null, name: template.name, type: "assetInferenceTemplate", data: JSON.stringify(template), template } : await saveAssetInferenceTemplate(template);
      res.status(200).send(success(data));
    } catch (caught) {
      res.status(502).send(error(`案例分析失败：${u.error(caught).message}`));
    }
  },
);

