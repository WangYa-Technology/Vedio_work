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
    scriptId: z.number().optional(),
    episodeNumber: z.number(),
    shotNumber: z.number(),
    content: z.string(),
    cameraMovement: z.string().optional(),
    scale: z.string().optional(),
    narrativePurpose: z.string().optional(),
    duration: z.number().optional(),
    dialogue: z.string().optional(),
    sound: z.string().optional(),
    platformMode: z.string().optional(),
  }),
  async (req, res) => {
    const { projectId, scriptId = 0, episodeNumber, shotNumber, content, cameraMovement = "", scale = "", narrativePurpose = "", duration = 5, dialogue = "", sound = "", platformMode = "generic" } = req.body;
    const now = Date.now();
    const [id] = await u.db("o_storyboard_shot").insert({ projectId, scriptId, episodeNumber, shotNumber, content, cameraMovement, scale, narrativePurpose, duration, dialogue, sound, platformMode, createTime: now, updateTime: now });
    const data = await u.db("o_storyboard_shot").where({ id }).first();
    res.status(200).send(success(data));
  },
);
