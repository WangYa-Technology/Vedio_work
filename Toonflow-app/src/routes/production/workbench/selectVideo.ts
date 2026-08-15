import express from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/middleware/middleware";
import { success } from "@/lib/responseFormat";

const router = express.Router();

export default router.post(
  "/",
  validateFields({ projectId: z.number(), scriptId: z.number(), videoId: z.number(), trackId: z.number() }),
  async (req, res) => {
    const { projectId, scriptId, videoId, trackId } = req.body;
    const video = await u.db("o_video").where({ id: videoId, projectId, scriptId, videoTrackId: trackId }).first();
    if (!video) throw new Error("未找到所选视频");
    await u.db("o_videoTrack").where({ id: trackId, projectId, scriptId }).update({ selectVideoId: videoId, videoId });
    res.status(200).send(success());
  },
);
