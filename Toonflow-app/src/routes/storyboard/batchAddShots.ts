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
    shots: z.array(z.object({
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
    })),
  }),
  async (req, res) => {
    const { projectId, shots } = req.body;
    const now = Date.now();
    for (const shot of shots) {
      await u.db("o_storyboard_shot").insert({
        projectId,
        scriptId: shot.scriptId ?? 0,
        episodeNumber: shot.episodeNumber,
        shotNumber: shot.shotNumber,
        content: shot.content,
        cameraMovement: shot.cameraMovement ?? "",
        scale: shot.scale ?? "",
        narrativePurpose: shot.narrativePurpose ?? "",
        duration: shot.duration ?? 5,
        dialogue: shot.dialogue ?? "",
        sound: shot.sound ?? "",
        platformMode: shot.platformMode ?? "generic",
        createTime: now,
        updateTime: now,
      });
    }
    const data = await u.db("o_storyboard_shot").where({ projectId }).orderBy("episodeNumber").orderBy("shotNumber");
    res.status(200).send(success({ count: shots.length, shots: data }));
  },
);
