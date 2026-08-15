import express from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/middleware/middleware";
import { success } from "@/lib/responseFormat";

const router = express.Router();

export default router.post("/", validateFields({ id: z.number() }), async (req, res) => {
  const video = await u.db("o_video").where({ id: req.body.id }).first();
  if (video?.filePath) {
    try {
      await u.oss.deleteFile(video.filePath);
    } catch {
      // 数据记录仍需清理，文件可能已由用户手动删除。
    }
  }
  if (video?.videoTrackId) {
    await u
      .db("o_videoTrack")
      .where({ id: video.videoTrackId })
      .where((builder) => builder.where("selectVideoId", req.body.id).orWhere("videoId", req.body.id))
      .update({ selectVideoId: null, videoId: null });
  }
  await u.db("o_video").where({ id: req.body.id }).delete();
  res.status(200).send(success());
});
