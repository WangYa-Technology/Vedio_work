import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import {
  collectRepairableVideoIds,
  retryVideoFromSnapshot,
  VideoRepairError,
} from "@/services/videoRepair";

const router = express.Router();

interface BatchRepairItem {
  videoId: number;
  ok: boolean;
  newVideoId?: number;
  trackId?: number;
  fixed?: string[];
  message?: string;
  action?: string;
}

/**
 * 批量修复：默认修复当前集/场所有「最新一条且生成失败」的片段，
 * 也可由 videoIds / trackIds 指定范围。
 * 串行提交，避免把账号并发打满再次触发资源类失败；进度由前端既有轮询承担。
 */
export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number().optional(),
    videoIds: z.array(z.number()).optional(),
    trackIds: z.array(z.number()).optional(),
  }),
  async (req, res) => {
    const { projectId, scriptId, videoIds, trackIds } = req.body;
    const explicitIds = Array.isArray(videoIds)
      ? videoIds.map(Number).filter((value) => Number.isFinite(value) && value > 0)
      : [];
    const targetIds = explicitIds.length
      ? explicitIds
      : await collectRepairableVideoIds({
          projectId: Number(projectId),
          scriptId: scriptId == null ? undefined : Number(scriptId),
          trackIds: Array.isArray(trackIds)
            ? trackIds.map(Number).filter((value) => Number.isFinite(value) && value > 0)
            : undefined,
        });
    if (!targetIds.length) {
      return res.status(400).send(error("当前没有可修复的失败片段"));
    }

    const results: BatchRepairItem[] = [];
    for (const videoId of targetIds) {
      try {
        const result = await retryVideoFromSnapshot(videoId);
        results.push({
          videoId,
          ok: true,
          newVideoId: result.videoId,
          trackId: result.trackId,
          fixed: result.fixed,
        });
      } catch (caught) {
        if (caught instanceof VideoRepairError) {
          results.push({
            videoId,
            ok: false,
            message: caught.message,
            action: caught.action,
          });
          continue;
        }
        results.push({
          videoId,
          ok: false,
          message: caught instanceof Error ? caught.message : "修复失败",
        });
      }
    }

    const submitted = results.filter((item) => item.ok).length;
    const failed = results.length - submitted;
    res.status(200).send(
      success(
        {
          total: results.length,
          submitted,
          failed,
          results,
        },
        failed
          ? `已提交 ${submitted} 个修复任务，${failed} 个需要处理`
          : `已提交 ${submitted} 个修复任务`,
      ),
    );
  },
);
