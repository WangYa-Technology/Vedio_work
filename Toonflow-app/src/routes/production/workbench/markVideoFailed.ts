import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import {
  markVideoRecordFailed,
  retryVideoFromSnapshot,
  VideoRepairError,
} from "@/services/videoRepair";

const router = express.Router();

/**
 * 把卡住的「生成中」记录手动标记为失败（写入 abandonedAt，云端后到的结果不再覆盖状态）。
 * `retry=true` 时紧接着按快照发起修复重试。
 */
export default router.post(
  "/",
  validateFields({
    videoId: z.number(),
    retry: z.boolean().optional(),
  }),
  async (req, res) => {
    const videoId = Number(req.body.videoId);
    const shouldRetry = Boolean(req.body.retry);
    try {
      await markVideoRecordFailed(videoId);
      if (!shouldRetry) {
        return res
          .status(200)
          .send(success({ videoId, state: "生成失败" }, "已标记为生成失败，可修复重试"));
      }
      const result = await retryVideoFromSnapshot(videoId);
      return res.status(200).send(
        success(
          {
            videoId: result.videoId,
            sourceVideoId: result.sourceVideoId,
            trackId: result.trackId,
            state: "生成中",
            fixed: result.fixed,
          },
          result.fixed.length
            ? `已标记失败并自动修复 ${result.fixed.length} 项后重新提交`
            : "已标记失败并重新提交",
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
