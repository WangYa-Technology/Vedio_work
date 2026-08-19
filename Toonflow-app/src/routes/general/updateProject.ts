import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

// 修改项目
export default router.post(
  "/",
  validateFields({
    id: z.number(),
    intro: z.string().optional().nullable(),
    type: z.string().optional().nullable(),
    artStyle: z.string().optional().nullable(),
    negativePrompt: z.string().optional().nullable(),
    videoRatio: z.string().optional().nullable(),
    projectType: z.string().optional().nullable(),
  }),
  async (req, res) => {
    const { id, intro, type, artStyle, negativePrompt, videoRatio, projectType } = req.body;

    const updateData: Record<string, unknown> = {
      intro,
      type,
      artStyle,
      videoRatio,
      projectType,
    };
    if (negativePrompt !== undefined) updateData.negativePrompt = negativePrompt?.trim() || null;
    await u.db("o_project").where("id", id).update(updateData);

    res.status(200).send(success({ message: "修改成功" }));
  },
);
