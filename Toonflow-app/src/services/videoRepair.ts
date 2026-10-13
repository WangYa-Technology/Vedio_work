/**
 * 视频「修复重试」服务：按失败记录的快照重建一次提交。
 *
 * 数据来源是失败记录本身（`promptSnapshot` / `referenceSnapshot` / `generationConfig`），
 * 因此重试与界面当前选择解耦：用户不必回到生成页重选素材，工作台与任务页也能共用同一套能力。
 * 提交前的预检与自动修收敛在 `utils/videoRepairPreflight`，本模块只做编排：
 * 取快照 → 校验模型/素材 → 预检 → 提交（复用 `videoGenerationSubmit` 的同一条管线）。
 */

import u from "@/utils";
import { parseModelReference } from "@/utils/modelRef";
import { buildVideoTaskData } from "@/utils/videoTaskData";
import {
  preflightVideoSubmission,
  type VideoRepairProjectConfig,
} from "@/utils/videoRepairPreflight";
import { updateVideoTaskState } from "@/utils/videoTaskRecovery";
import { abandonVideoTask } from "@/utils/videoTaskWatchdog";
import {
  launchVideoGeneration,
  readReferenceBase64,
  submitVideoGeneration,
  type VideoSubmissionReference,
} from "@/services/videoGenerationSubmit";

export interface VideoRepairBlockerInfo {
  code: string;
  message: string;
  action?: string;
}

export interface VideoRepairSuccess {
  /** 失败记录 id（原记录保留为历史） */
  sourceVideoId: number;
  /** 新提交的记录 id */
  videoId: number;
  trackId: number;
  /** 预检自动修复项，供界面展示 */
  fixed: string[];
}

export class VideoRepairError extends Error {
  readonly status: number;
  readonly blockers: VideoRepairBlockerInfo[];
  readonly fixed: string[];
  readonly action?: string;

  constructor(
    status: number,
    message: string,
    options: {
      blockers?: VideoRepairBlockerInfo[];
      fixed?: string[];
      action?: string;
    } = {},
  ) {
    super(message);
    this.name = "VideoRepairError";
    this.status = status;
    this.blockers = options.blockers?.length
      ? options.blockers
      : [{ code: "REPAIR_BLOCKED", message, action: options.action as any }];
    this.fixed = options.fixed || [];
    this.action = options.action || options.blockers?.[0]?.action;
  }
}

interface ParsedSnapshot {
  prompt: string;
  references: VideoSubmissionReference[];
  generationConfig: {
    model?: string;
    mode?: string | string[];
    ratio?: string;
    resolution?: string;
    duration?: number;
    audio?: boolean;
    parameters?: Record<string, string | number | boolean>;
    videoPromptProfile?: unknown;
  };
}

function parseJson<T>(raw: unknown, fallback: T): T {
  try {
    const parsed = JSON.parse(String(raw ?? ""));
    return parsed && typeof parsed === "object" ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

export function parseVideoSnapshot(record: {
  promptSnapshot?: unknown;
  referenceSnapshot?: unknown;
  generationConfig?: unknown;
}): ParsedSnapshot {
  const rawReferences = parseJson<Array<Record<string, unknown>>>(
    record.referenceSnapshot,
    [],
  );
  const references: VideoSubmissionReference[] = rawReferences
    .filter((item) => String(item?.filePath || "").trim())
    .map((item, position) => ({
      index: Number.isFinite(Number(item?.index)) ? Number(item.index) : position,
      id: Number(item?.id) || 0,
      sources: item?.sources === "storyboard" ? "storyboard" : "assets",
      fileType:
        item?.fileType === "audio"
          ? "audio"
          : item?.fileType === "video"
            ? "video"
            : "image",
      filePath: String(item.filePath),
    }));
  return {
    prompt: String(record.promptSnapshot ?? ""),
    references,
    generationConfig: parseJson(record.generationConfig, {}),
  };
}

/** 参考素材名称：资产取 `o_assets.name`，分镜图按提交顺序命名，用于提示词编号对齐。 */
async function attachReferenceNames(
  references: VideoSubmissionReference[],
): Promise<VideoSubmissionReference[]> {
  const assetIds = [
    ...new Set(
      references
        .filter((reference) => reference.sources === "assets")
        .map((reference) => Number(reference.id))
        .filter((value) => Number.isFinite(value) && value > 0),
    ),
  ];
  const assetRows = assetIds.length
    ? await u.db("o_assets").whereIn("id", assetIds).select("id", "name")
    : [];
  const nameById = new Map(
    assetRows.map((row: any) => [Number(row.id), String(row.name || "")]),
  );
  return references.map((reference, position) => ({
    ...reference,
    name:
      reference.sources === "storyboard"
        ? `分镜图 ${position + 1}`
        : nameById.get(Number(reference.id)) || "",
  }));
}

/** 模型/供应商是否仍然可用（失败记录里的模型可能已被移除或停用）。 */
async function resolveModelUnavailableReason(model: string) {
  const reference = parseModelReference(model);
  if (!reference.vendorId || !reference.modelName) {
    return `当前模型标识无效（${model || "空"}），请在生成页重新选择模型`;
  }
  const vendor = await u
    .db("o_vendorConfig")
    .where({ id: reference.vendorId, enable: 1 })
    .first();
  if (!vendor) {
    return `模型供应商「${reference.vendorId}」已停用或不存在，请在设置里重新启用`;
  }
  const models = parseJson<Array<{ modelName?: string }>>(vendor.models, []);
  if (models.length && !models.some((item) => item?.modelName === reference.modelName)) {
    return `模型「${reference.modelName}」已从供应商配置中移除，请在生成页重新选择模型`;
  }
  return "";
}

async function loadVideoRecord(videoId: number) {
  const record = await u.db("o_video").where({ id: videoId }).first();
  if (!record) {
    throw new VideoRepairError(400, "未找到该视频记录，可能已被删除");
  }
  return record;
}

/**
 * 定位要修复的记录：
 * - 直传 videoId（工作台失败格子、任务页新数据）；
 * - 只有 projectId + trackId 时（任务页历史行）取该片段最新一条记录：
 *   最新是失败 → 修它；最新还在生成中 → 由后续逻辑提示先标记失败；
 *   最新已成功 → 回退到最近一条失败记录，没有则提示无需修复。
 */
export async function resolveRepairableVideoId(input: {
  videoId?: number;
  trackId?: number;
  projectId?: number;
}): Promise<number> {
  if (Number.isFinite(input.videoId) && Number(input.videoId) > 0) {
    return Number(input.videoId);
  }
  if (Number.isFinite(input.trackId) && Number(input.trackId) > 0) {
    const query = u.db("o_video").where({ videoTrackId: Number(input.trackId) });
    if (Number.isFinite(input.projectId) && Number(input.projectId) > 0) {
      query.andWhere({ projectId: Number(input.projectId) });
    }
    const records: any[] = await query
      .select("id", "state")
      .orderByRaw("COALESCE(createTime, id) DESC");
    if (!records.length) {
      throw new VideoRepairError(400, "该片段还没有生成记录，请先在生成页发起生成");
    }
    const latest = records[0];
    if (latest.state === "生成失败" || latest.state === "生成中") {
      return Number(latest.id);
    }
    const latestFailed = records.find((record) => record.state === "生成失败");
    if (!latestFailed) {
      throw new VideoRepairError(400, "该片段最近一次生成已成功，无需修复");
    }
    return Number(latestFailed.id);
  }
  throw new VideoRepairError(400, "缺少视频记录标识，无法定位要修复的片段");
}

/**
 * 按失败记录的快照重新提交一次生成（提交即返回，后台跟踪由服务内负责）。
 * 预检发现无法自动修的问题时抛 `VideoRepairError`，由路由转成结构化响应。
 */
export async function retryVideoFromSnapshot(
  videoId: number,
  options: {
    /**
     * 用分镜里「当前」的提示词替代失败快照：
     * 用户在修复面板里重新推过该镜提示词后，需要按新提示词重试，而不是继续用旧快照。
     */
    promptOverride?: string;
  } = {},
): Promise<VideoRepairSuccess> {
  const record = await loadVideoRecord(videoId);
  if (record.state === "生成中") {
    throw new VideoRepairError(
      400,
      "该视频仍在生成中，如需重新生成请先点「标记失败」（云端任务结果将不再接收）",
      { action: "markFailed" },
    );
  }
  if (record.state !== "生成失败") {
    throw new VideoRepairError(
      400,
      `该视频状态为「${record.state || "未生成"}」，只有生成失败的视频需要修复`,
    );
  }
  const projectId = Number(record.projectId);
  const scriptId = Number(record.scriptId);
  const trackId = Number(record.videoTrackId);
  const snapshot = parseVideoSnapshot(record);
  const model = String(snapshot.generationConfig.model || record.model || "");

  const unavailable = await resolveModelUnavailableReason(model);
  if (unavailable) {
    throw new VideoRepairError(400, unavailable, { action: "regeneratePrompt" });
  }

  let projectConfig: VideoRepairProjectConfig = {};
  try {
    const taskData = await buildVideoTaskData(projectId, scriptId, {
      model,
      mode: snapshot.generationConfig.mode,
    });
    projectConfig = taskData.projectConfig;
  } catch (error) {
    throw new VideoRepairError(
      400,
      `无法读取该项目的视频配置：${u.error(error).message}`,
    );
  }

  const sourcePrompt = String(options.promptOverride || snapshot.prompt || "");
  const references = await attachReferenceNames(snapshot.references);
  const report = await preflightVideoSubmission({
    prompt: sourcePrompt,
    references,
    generationConfig: snapshot.generationConfig,
    projectConfig,
    fileExists: (filePath) => u.oss.fileExists(filePath),
  });
  if (report.blockers.length) {
    throw new VideoRepairError(400, report.blockers[0].message, {
      blockers: report.blockers,
      fixed: report.fixed,
      action: report.blockers[0].action,
    });
  }

  const repairReferences = report.references.map((reference) => ({
    index: reference.index,
    id: reference.id,
    sources: reference.sources,
    fileType: reference.fileType,
    filePath: reference.filePath,
  }));
  const imageBase64 = await readReferenceBase64(repairReferences);
  const ratio = String(snapshot.generationConfig.ratio || "16:9");
  const parameters = snapshot.generationConfig.parameters || {};
  const context = await submitVideoGeneration({
    projectId,
    scriptId,
    trackId,
    prompt: report.prompt,
    model,
    mode: snapshot.generationConfig.mode,
    resolution: report.resolution,
    duration: report.duration,
    audio: report.audio,
    parameters,
    promptTemplateId: record.promptTemplateId ?? null,
    promptTemplateVersion: record.promptTemplateVersion ?? null,
    ratio,
    references: repairReferences,
    videoPromptProfile: snapshot.generationConfig.videoPromptProfile,
    retryOfVideoId: videoId,
    repairFixed: report.fixed,
    sourcePrompt,
    describe: `生成第 ${trackId} 个视频片段（修复重试）`,
  });
  launchVideoGeneration(context, {
    projectId,
    trackId,
    describe: context.describe,
    relatedObjects: context.relatedObjects,
    model,
    prompt: report.prompt,
    imageBase64,
    references: repairReferences,
    mode: snapshot.generationConfig.mode,
    ratio,
    duration: report.duration,
    resolution: report.resolution,
    audio: report.audio,
    parameters,
  });

  console.log(
    `[视频修复] ${videoId}(track ${trackId}) 已重新提交为 ${context.videoId}` +
      (report.fixed.length ? `；自动修复 ${report.fixed.length} 项` : ""),
  );
  return {
    sourceVideoId: videoId,
    videoId: context.videoId,
    trackId,
    fixed: report.fixed,
  };
}

/**
 * 收集「可修复」的视频记录：每个片段取最新一条记录，且状态为生成失败。
 * 与前端批量修复的语义一致（历史失败版本不重复重试）。
 */
export async function collectRepairableVideoIds(input: {
  projectId: number;
  scriptId?: number;
  trackIds?: number[];
}): Promise<number[]> {
  const query = u.db("o_videoTrack").where({ projectId: input.projectId });
  if (input.scriptId) query.andWhere({ scriptId: input.scriptId });
  if (input.trackIds?.length) query.whereIn("id", input.trackIds.map(Number));
  const tracks = await query.select("id");
  if (!tracks.length) return [];
  const videos = await u
    .db("o_video")
    .whereIn("videoTrackId", tracks.map((track: any) => Number(track.id)))
    .orderByRaw("COALESCE(createTime, id) DESC");
  const latestByTrack = new Map<number, any>();
  for (const video of videos) {
    const key = Number(video.videoTrackId);
    if (!latestByTrack.has(key)) latestByTrack.set(key, video);
  }
  return [...latestByTrack.values()]
    .filter((video) => video.state === "生成失败")
    .map((video) => Number(video.id));
}

/** 手动把卡住的「生成中」记录标记为失败（写 abandonedAt，后续云端结果不再覆盖）。 */
export async function markVideoRecordFailed(
  videoId: number,
  reason = "已手动标记为生成失败，可修复重试",
): Promise<void> {
  const record = await u.db("o_video").where({ id: videoId }).first();
  if (!record) throw new VideoRepairError(400, "未找到该视频记录，可能已被删除");
  if (record.state === "生成失败") {
    return;
  }
  if (record.state !== "生成中") {
    throw new VideoRepairError(
      400,
      `该视频状态为「${record.state || "未生成"}」，无需标记失败`,
    );
  }
  // 先落失败状态，再写 abandonedAt：状态写入本身会被 abandoned 规则跳过，
  // 顺序颠倒会导致这条手动标记不生效。
  await updateVideoTaskState(
    { id: videoId, videoTrackId: Number(record.videoTrackId) },
    "生成失败",
    reason,
  );
  await abandonVideoTask(videoId);
}
