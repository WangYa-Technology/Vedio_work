import express from "express";
import { success } from "@/lib/responseFormat";
import u from "@/utils";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    id: z.number(),
    projectId: z.number(),
    content: z.string().optional(),
    cameraMovement: z.string().optional(),
    scale: z.string().optional(),
    narrativePurpose: z.string().optional(),
    duration: z.number().optional(),
    dialogue: z.string().optional(),
    sound: z.string().optional(),
    platformMode: z.string().optional(),
  }),
  async (req, res) => {
    const { id, projectId, ...updates } = req.body;
    await u.db("o_storyboard_shot").where({ id, projectId }).update({ ...updates, updateTime: Date.now() });
    const data = await u.db("o_storyboard_shot").where({ id }).first();
    res.status(200).send(success(data));
  },
);
