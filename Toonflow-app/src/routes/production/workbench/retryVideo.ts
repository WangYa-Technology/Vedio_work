import express from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import {
  resolveRepairableVideoId,
  retryVideoFromSnapshot,
  VideoRepairError,
} from "@/services/videoRepair";

const router = express.Router();

/**
 * 修复重试：按失败记录的快照重新提交一次生成。
 * 支持 videoId 直传（工作台），也支持 projectId + trackId 兜底定位最新失败记录（任务页历史行）。
 */
export default router.post(
  "/",
  validateFields({
    videoId: z.number().optional(),
    trackId: z.number().optional(),
    projectId: z.number().optional(),
    /** 重新推过该镜提示词后，按分镜里的新提示词重试（而不是继续用失败快照） */
    useTrackPrompt: z.boolean().optional(),
  }),
  async (req, res) => {
    const { videoId, trackId, projectId, useTrackPrompt } = req.body;
    try {
      const targetVideoId = await resolveRepairableVideoId({
        videoId: videoId == null ? undefined : Number(videoId),
        trackId: trackId == null ? undefined : Number(trackId),
        projectId: projectId == null ? undefined : Number(projectId),
      });
      let promptOverride: string | undefined;
      if (useTrackPrompt) {
        const record = await u.db("o_video").where({ id: targetVideoId }).first();
        const track = await u
          .db("o_videoTrack")
          .where({ id: record?.videoTrackId })
          .first("prompt");
        promptOverride = String(track?.prompt || "").trim() || undefined;
        if (!promptOverride) {
          return res
            .status(400)
            .send(error("分镜里还没有提示词，请先在提示词面板生成后再重试"));
        }
      }
      const result = await retryVideoFromSnapshot(targetVideoId, {
        promptOverride,
      });
      res
        .status(200)
        .send(
          success(
            {
              sourceVideoId: result.sourceVideoId,
              videoId: result.videoId,
              trackId: result.trackId,
              state: "生成中",
              fixed: result.fixed,
            },
            result.fixed.length
              ? `已自动修复 ${result.fixed.length} 项并重新提交`
              : "已按原参数重新提交",
          ),
        );
    } catch (caught) {
      if (caught instanceof VideoRepairError) {
        return res.status(caught.status).send(
          error(caught.message, {
            blockers: caught.blockers,
            fixed: caught.fixed,
            action: caught.action,
          }),
        );
      }
      throw caught;
    }
  },
);
