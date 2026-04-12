import express from "express";
import { success } from "@/lib/responseFormat";
import u from "@/utils";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    emotion: z.string(),
    genre: z.string(),
    action: z.string(),
    subject: z.string(),
    form: z.string(),
    socialPerspective: z.string(),
    colorPlan: z.string(),
    soundDesign: z.string(),
  }),
  async (req, res) => {
    const { projectId, emotion, genre, action, subject, form, socialPerspective, colorPlan, soundDesign } = req.body;
    const now = Date.now();
    const existing = await u.db("o_director_alignment").where({ projectId }).first();
    if (existing) {
      await u.db("o_director_alignment").where({ projectId }).update({ emotion, genre, action, subject, form, socialPerspective, colorPlan, soundDesign, updateTime: now });
    } else {
      await u.db("o_director_alignment").insert({ projectId, emotion, genre, action, subject, form, socialPerspective, colorPlan, soundDesign, createTime: now, updateTime: now });
    }
    const data = await u.db("o_director_alignment").where({ projectId }).first();
    res.status(200).send(success(data));
  },
);
