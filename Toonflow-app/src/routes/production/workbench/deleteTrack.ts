import express from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/middleware/middleware";
import { success } from "@/lib/responseFormat";

const router = express.Router();

export default router.post("/", validateFields({ id: z.number() }), async (req, res) => {
  const linked = await u.db("o_storyboard").where({ trackId: req.body.id }).first();
  if (linked) throw new Error("分镜片段对应的主轨道不能删除");
  const videos = await u.db("o_video").where({ videoTrackId: req.body.id });
  for (const video of videos) {
    if (!video.filePath) continue;
    try {
      await u.oss.deleteFile(video.filePath);
    } catch {
      // 忽略已不存在的历史文件。
    }
  }
  await u.db("o_video").where({ videoTrackId: req.body.id }).delete();
  await u.db("o_videoTrack").where({ id: req.body.id }).delete();
  res.status(200).send(success());
});
