import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { isUserPromptId } from "@/utils/promptTemplate";
const router = express.Router();
const userPromptTypes = [
  "imagePromptGeneration",
  "videoPromptGeneration",
  "assetInferenceTemplate",
];

export default router.post(
  "/",
  validateFields({
    id: z.number(),
    name: z.string().trim().min(1).max(80).optional(),
    type: z.string().trim().min(1).max(80).optional(),
    data: z.string().trim().min(1),
  }),
  async (req, res) => {
    const { id, name, type, data } = req.body;
    const prompt = await u.db("o_prompt").where({ id }).first();
    if (!prompt) throw new Error("提示词模版不存在");
    const updateData: Record<string, string> = { useData: data };
    if (isUserPromptId(prompt.id)) {
      if (type && !userPromptTypes.includes(type))
        throw new Error("自定义模版仅支持图片或视频提示词生成阶段");
      if (name) updateData.name = name;
      if (type) updateData.type = type;
    }
    await u.db("o_prompt").where({ id }).update(updateData);
    res.status(200).send(success({ id }));
  },
);
