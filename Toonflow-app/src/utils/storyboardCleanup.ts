import u from "@/utils";
import { parseStoryboardTableAssetBindings, saveProductionFlowData } from "@/utils/productionFlow";

type AnyRow = Record<string, any>;

/**
 * 读取某一集的全部分镜面板行，按正式分镜表顺序排列
 * （与 productionFlow.loadStoryboard 的排序口径保持一致）。
 */
export async function collectStoryboardRows(projectId: number, scriptId: number): Promise<AnyRow[]> {
  return u
    .db("o_storyboard")
    .where({ projectId, scriptId })
    .orderByRaw('COALESCE("index", 2147483647), id');
}

/** 正在生成中的分镜 / 轨道禁止删除，避免破坏进行中的生成任务 */
export function assertNotGenerating(storyboards: AnyRow[], tracks: AnyRow[] = []) {
  const generating = [...storyboards, ...tracks].find((row) =>
    String(row?.state || "").includes("生成中"),
  );
  if (generating) {
    throw new Error("存在正在生成中的片段，请等待生成完成或先停止任务后再删除");
  }
}

async function removeFilesBestEffort(filePaths: Array<string | null | undefined>) {
  for (const filePath of filePaths) {
    if (!filePath) continue;
    try {
      await u.oss.deleteFile(filePath);
    } catch {
      // 文件可能已被手动删除或路径失效：数据一致性优先，不因单个文件缺失中断清理。
    }
  }
}

/**
 * 级联删除指定分镜行：分镜图文件、资产关联、视频与视频轨道、分镜面板记录。
 * 数据库写入放在事务中，OSS 文件在事务提交后 best-effort 清理。
 */
export async function removeStoryboardRows(rows: AnyRow[]) {
  const storyboardIds = [...new Set(rows.map((row) => Number(row.id)).filter(Number.isFinite))];
  const trackIds = [...new Set(rows.map((row) => Number(row.trackId)).filter(Number.isFinite))];
  if (!storyboardIds.length) {
    return { removedStoryboardIds: [], removedTrackIds: [], removedVideoCount: 0 };
  }

  const videos = trackIds.length ? await u.db("o_video").whereIn("videoTrackId", trackIds) : [];

  await u.db.transaction(async (trx) => {
    await trx("o_assets2Storyboard").whereIn("storyboardId", storyboardIds).delete();
    if (trackIds.length) {
      await trx("o_video").whereIn("videoTrackId", trackIds).delete();
      await trx("o_videoTrack").whereIn("id", trackIds).delete();
    }
    await trx("o_storyboard").whereIn("id", storyboardIds).delete();
  });

  await removeFilesBestEffort([
    ...rows.map((row) => row.filePath),
    ...videos.map((video) => video.filePath),
  ]);
  return { removedStoryboardIds: storyboardIds, removedTrackIds: trackIds, removedVideoCount: videos.length };
}

/** 清空某一集的全部分镜产物：分镜面板、资产关联、视频轨道、视频与对应文件 */
export async function purgeEpisodeStoryboardData(projectId: number, scriptId: number) {
  const rows = await collectStoryboardRows(projectId, scriptId);
  const storyboardIds = rows.map((row) => Number(row.id)).filter(Number.isFinite);
  const videos = await u.db("o_video").where({ projectId, scriptId });

  await u.db.transaction(async (trx) => {
    if (storyboardIds.length) {
      await trx("o_assets2Storyboard").whereIn("storyboardId", storyboardIds).delete();
    }
    await trx("o_video").where({ projectId, scriptId }).delete();
    await trx("o_videoTrack").where({ projectId, scriptId }).delete();
    await trx("o_storyboard").where({ projectId, scriptId }).delete();
  });

  await removeFilesBestEffort([
    ...rows.map((row) => row.filePath),
    ...videos.map((video) => video.filePath),
  ]);
  return { removedStoryboardIds: storyboardIds, removedVideoCount: videos.length };
}

/**
 * 写回分镜表 markdown：保留 productionFlowData 其它字段与回读校验，
 * 并按剩余内容同步 pendingBaseAssetIds（不再被引用的待补资产移出待办清单）。
 */
export async function saveStoryboardTableContent(projectId: number, scriptId: number, content: string) {
  const existing = await u
    .db("o_agentWorkData")
    .where({ projectId, episodesId: scriptId, key: "productionFlowData" })
    .first();
  let current: AnyRow = {};
  if (existing?.data) {
    try {
      current = JSON.parse(existing.data) as AnyRow;
    } catch {
      throw new Error("现有生产工作区数据格式无效，已阻止覆盖");
    }
  }
  const next: AnyRow = { ...current, storyboardTable: content };
  const pendingBaseAssetIds = Array.isArray(current.pendingBaseAssetIds)
    ? current.pendingBaseAssetIds.map(Number).filter(Number.isSafeInteger)
    : [];
  if (pendingBaseAssetIds.length) {
    const referenced = new Set(parseStoryboardTableAssetBindings(content).flat());
    const remaining = pendingBaseAssetIds.filter((id: number) => !referenced.has(id));
    if (remaining.length) next.pendingBaseAssetIds = remaining;
    else delete next.pendingBaseAssetIds;
  }
  await saveProductionFlowData(projectId, scriptId, next);
}
