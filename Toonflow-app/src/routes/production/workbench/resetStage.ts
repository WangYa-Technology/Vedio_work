import express from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import { saveProductionFlowData } from "@/utils/productionFlow";
import {
  assertNotGenerating,
  collectStoryboardRows,
  purgeEpisodeStoryboardData,
} from "@/utils/storyboardCleanup";

const router = express.Router();

/** 读取原始生产工作区数据（保留 pendingBaseAssetIds 等内部字段，避免覆盖丢失） */
async function readFlowData(projectId: number, scriptId: number): Promise<Record<string, any>> {
  const row = await u
    .db("o_agentWorkData")
    .where({ projectId, episodesId: scriptId, key: "productionFlowData" })
    .first();
  if (!row?.data) return {};
  try {
    return JSON.parse(row.data) as Record<string, any>;
  } catch {
    throw new Error("现有生产工作区数据格式无效，已阻止覆盖");
  }
}

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number(),
    stage: z.enum(["directorPlan", "storyboard"]),
  }),
  async (req, res) => {
    const { projectId, scriptId, stage } = req.body;

    const rows = await collectStoryboardRows(projectId, scriptId);
    const tracks = await u.db("o_videoTrack").where({ projectId, scriptId });
    try {
      assertNotGenerating(rows, tracks);
    } catch (assertError) {
      return res.status(400).send(error((assertError as Error).message));
    }

    const current = await readFlowData(projectId, scriptId);
    const next: Record<string, any> = { ...current, storyboardTable: "" };
    if (stage === "directorPlan") next.scriptPlan = "";
    delete next.pendingBaseAssetIds;

    const { removedStoryboardIds, removedVideoCount } =
      await purgeEpisodeStoryboardData(projectId, scriptId);
    await saveProductionFlowData(projectId, scriptId, next);

    // 回读校验：阶段产出与分镜面板必须为空。
    const saved = await readFlowData(projectId, scriptId);
    if (
      saved.storyboardTable ||
      (stage === "directorPlan" && saved.scriptPlan) ||
      saved.pendingBaseAssetIds
    ) {
      throw new Error("阶段重置后回读校验失败");
    }
    const leftRows = await collectStoryboardRows(projectId, scriptId);
    if (leftRows.length) throw new Error("分镜面板清空后回读校验失败");

    res.status(200).send(
      success({
        stage,
        removedStoryboardCount: removedStoryboardIds.length,
        removedVideoCount,
      }),
    );
  },
);
