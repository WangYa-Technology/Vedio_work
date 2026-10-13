import express from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/middleware/middleware";
import { success } from "@/lib/responseFormat";
import { recoverPendingVideoTasks } from "@/utils/videoTaskRecovery";

const router = express.Router();

// /oss 静态目录受登录鉴权保护，而 <video> 标签不会带上 Authorization 头，
// 因此视频地址必须走 u.oss.getFileUrl 生成带 expires/signature 的签名链接（与图片一致）。
async function fileUrl(filePath?: string | null) {
  if (!filePath) return "";
  return u.oss.getFileUrl(filePath);
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
    // getFileUrl 内部已完成"文件存在校验 + 签名"，文件缺失时返回空串。
    const srcs = await Promise.all(videos.map((video) => fileUrl(video.filePath)));
    res.status(200).send(
      success(
        videos.map((video, index) => {
          const state = video.state === "生成成功" ? "已完成" : video.state || "未生成";
          const playable = state === "已完成" && Boolean(srcs[index]);
          return {
            ...video,
            playable,
            src: playable ? srcs[index] : "",
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
