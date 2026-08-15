import express from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/middleware/middleware";
import { success } from "@/lib/responseFormat";
import { recoverPendingVideoTasks } from "@/utils/videoTaskRecovery";

const router = express.Router();

function fileUrl(filePath?: string | null) {
  if (!filePath) return "";
  if (/^https?:\/\//i.test(filePath)) return filePath;
  return `/oss/${String(filePath).replace(/^[/\\]+/, "").replace(/\\/g, "/")}`;
}

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number(),
  }),
  async (req, res) => {
    const { projectId, scriptId } = req.body;
    const tracks = await u.db("o_videoTrack").where({ projectId, scriptId }).select("id");
    const videos = tracks.length
      ? await u.db("o_video").whereIn(
          "videoTrackId",
          tracks.map((track) => Number(track.id)),
        )
      : [];
    void recoverPendingVideoTasks(videos);
    const fileAvailability = await Promise.all(
      videos.map((video) =>
        video.filePath && !/^https?:\/\//i.test(video.filePath)
          ? u.oss.fileExists(video.filePath)
          : Promise.resolve(Boolean(video.filePath)),
      ),
    );
    res.status(200).send(
      success(
        videos.map((video, index) => {
          const state = video.state === "生成成功" ? "已完成" : video.state || "未生成";
          const playable = state === "已完成" && fileAvailability[index];
          return {
            ...video,
            playable,
            src: playable ? fileUrl(video.filePath) : "",
            state: state === "已完成" && !playable ? "生成失败" : state,
            errorReason:
              state === "已完成" && !playable
                ? video.errorReason || "视频文件不存在，请重新生成"
                : video.errorReason,
          };
        }),
      ),
    );
  },
);
