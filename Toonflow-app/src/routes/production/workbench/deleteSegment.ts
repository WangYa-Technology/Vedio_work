import express from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import { buildProductionFlowData } from "@/utils/productionFlow";
import { parseStoryboardTable } from "@/utils/videoTaskData";
import {
  assertNotGenerating,
  collectStoryboardRows,
  removeStoryboardRows,
  saveStoryboardTableContent,
} from "@/utils/storyboardCleanup";

const router = express.Router();

function countSegments(markdown: string, script: string) {
  return parseStoryboardTable(markdown, script).length;
}

/**
 * 从分镜表 markdown 中移除指定序号的片段块。
 * 保留场头（`## 场N…`），避免场次元数据（地点 / 时段 / 空间信息）与后续片段错位。
 * 返回 null 表示未定位到目标片段；返回空字符串表示片段被删除后分镜表已无片段。
 */
function removeSegmentBlock(markdown: string, segmentIndex: number): string | null {
  const lines = String(markdown || "").split(/\r?\n/);
  let cursor = -1;
  let start = -1;
  let end = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (/^###\s*片段/.test(line)) {
      cursor += 1;
      if (cursor === segmentIndex) {
        start = index;
        continue;
      }
      if (start >= 0) {
        end = index;
        break;
      }
      continue;
    }
    if (start >= 0 && /^##(?!#)\s/.test(line)) {
      end = index;
      break;
    }
  }
  if (start < 0) return null;
  lines.splice(start, end - start);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number(),
    segmentIndex: z.number().int().nonnegative().optional(),
    trackId: z.number().optional(),
  }),
  async (req, res) => {
    const { projectId, scriptId } = req.body;
    const segmentIndex = req.body.segmentIndex === undefined ? undefined : Number(req.body.segmentIndex);
    const trackId = req.body.trackId === undefined ? undefined : Number(req.body.trackId);
    if (segmentIndex === undefined && trackId === undefined) {
      return res.status(400).send(error("缺少要删除的分镜片段标识"));
    }

    const flow = await buildProductionFlowData(projectId, scriptId);
    const rows = await collectStoryboardRows(projectId, scriptId);
    const segments = parseStoryboardTable(flow.storyboardTable || "", flow.script || "");

    // 定位目标分镜面板行：优先真实 trackId（快速预览），其次按与分镜表对齐的 index（制作页分镜列表）。
    let targetRows =
      trackId !== undefined ? rows.filter((row) => Number(row.trackId) === trackId) : [];
    let markdownIndex = segmentIndex;
    if (trackId !== undefined) {
      if (!targetRows.length) return res.status(400).send(error("未找到对应的分镜片段，请刷新后重试"));
      const rowIndex = Number(targetRows[0].index);
      if (Number.isInteger(rowIndex) && rowIndex >= 0) markdownIndex = rowIndex;
    } else if (segmentIndex !== undefined) {
      targetRows = rows.filter((row) => Number(row.index) === segmentIndex);
    }

    const canEditMarkdown =
      markdownIndex !== undefined &&
      Number.isInteger(markdownIndex) &&
      markdownIndex >= 0 &&
      markdownIndex < segments.length;
    if (!targetRows.length && !canEditMarkdown) {
      return res.status(400).send(error("要删除的分镜片段不存在，请刷新后重试"));
    }

    const trackIds = [
      ...new Set(targetRows.map((row) => Number(row.trackId)).filter(Number.isFinite)),
    ];
    const tracks = trackIds.length ? await u.db("o_videoTrack").whereIn("id", trackIds) : [];
    try {
      assertNotGenerating(targetRows, tracks);
    } catch (assertError) {
      return res.status(400).send(error((assertError as Error).message));
    }

    const targetLabel = canEditMarkdown
      ? `${segments[markdownIndex as number].sceneTitle} / ${segments[markdownIndex as number].segmentTitle}`
      : `轨道 ${trackId}`;
    const removedIndexes = [
      ...new Set(targetRows.map((row) => Number(row.index)).filter(Number.isFinite)),
    ].sort((left, right) => left - right);

    const { removedStoryboardIds, removedTrackIds, removedVideoCount } =
      await removeStoryboardRows(targetRows);

    // 剩余分镜面板行按顺序补齐 index，保持与分镜表片段顺序一一对齐。
    if (removedIndexes.length) {
      const remaining = await u.db("o_storyboard").where({ projectId, scriptId });
      await u.db.transaction(async (trx) => {
        for (const row of remaining) {
          const currentIndex = Number(row.index);
          if (!Number.isFinite(currentIndex)) continue;
          const shift = removedIndexes.filter((removed) => removed < currentIndex).length;
          if (shift > 0) {
            await trx("o_storyboard").where({ id: row.id }).update({ index: currentIndex - shift });
          }
        }
      });
    }

    // 分镜表 markdown 同步：移除对应片段块并写回生产工作区。
    if (canEditMarkdown && flow.storyboardTable) {
      const nextTable = removeSegmentBlock(flow.storyboardTable, markdownIndex as number);
      if (nextTable === null) {
        throw new Error("未能从分镜表中定位该片段，分镜面板已删除，请刷新后重试");
      }
      await saveStoryboardTableContent(projectId, scriptId, nextTable);
    }

    // 回读校验：目标分镜行已删除，且分镜表中片段数量与内容符合预期。
    if (removedStoryboardIds.length) {
      const left = await u.db("o_storyboard").whereIn("id", removedStoryboardIds).first();
      if (left) throw new Error("分镜片段删除后回读校验失败");
    }
    if (canEditMarkdown && flow.storyboardTable) {
      const saved = await u
        .db("o_agentWorkData")
        .where({ projectId, episodesId: scriptId, key: "productionFlowData" })
        .select("data")
        .first();
      let savedTable = "";
      try {
        savedTable = String(JSON.parse(saved?.data || "{}").storyboardTable || "");
      } catch {
        savedTable = "";
      }
      if (countSegments(savedTable, flow.script || "") !== segments.length - 1) {
        throw new Error("分镜表删除后回读校验失败");
      }
    }

    res.status(200).send(
      success({
        removedSegment: targetLabel,
        removedStoryboardIds,
        removedTrackIds,
        removedVideoCount,
      }),
    );
  },
);
