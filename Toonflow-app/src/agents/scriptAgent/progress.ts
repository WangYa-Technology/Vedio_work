import { parseSkeletonEpisodes } from "@/agents/scriptAgent/skeletonChecks";

/**
 * 剧本 Agent 进度聚合（确定性、可单测）。
 *
 * 目的：把"生成到哪一步了"从模型叙事变成可计算的事实——
 * 三阶段状态（故事骨架 / 改编策略 / 剧本）、每集保存与审核状态、目标集数与下一批区间，
 * 以及一句可直接展示的结论（状态条 / 中断文案 / 批次回执共用）。
 *
 * 数据来源（唯一）：workData（storySkeleton / adaptationStrategy / supervisionHistory / targetEpisodes）
 * 与 o_script 剧本记录；本模块不写库、不做展示判断，只输出事实。
 */

/** 单批剧本生成上限，与决策层技能"单次最多生成 5 集"保持一致 */
export const SCRIPT_BATCH_SIZE = 5;
/** 目标集数解析上限（防止异常文本把分母拉爆） */
export const MAX_TARGET_EPISODES = 500;

export type EpisodeReviewStatus = "passed" | "blocked" | "issues" | "unreviewed";

export interface ReviewBrief {
  rating: string;
  at: number;
  blocking: number;
  medium: number;
  light: number;
  closed: number;
}

export interface EpisodeProgress {
  episodeNo: number;
  /** 剧本名（含集标题） */
  name: string;
  /** 正文字数（去首尾空白后） */
  chars: number;
  savedAt?: number;
  review: {
    status: EpisodeReviewStatus;
    rating?: string;
    blocking: number;
    medium: number;
    light: number;
    at?: number;
  };
}

export interface StageProgress {
  ready: boolean;
  chars: number;
  latestReview?: ReviewBrief;
}

export interface ScriptAgentProgress {
  stages: {
    storySkeleton: StageProgress;
    adaptationStrategy: StageProgress;
  };
  scripts: {
    targetEpisodes?: number;
    savedCount: number;
    remaining?: number;
    /** 下一批建议区间（不超过单批 5 集） */
    nextRange?: { from: number; to: number };
    episodes: EpisodeProgress[];
    /** 最近一次覆盖剧本集号的审核轮次 */
    latestReview?: ReviewBrief;
  };
  /** 可直接展示的一句结论（状态条 / 中断文案 / 回执共用） */
  conclusive: string;
}

export interface SupervisionRoundLike {
  at?: unknown;
  scope?: unknown;
  rating?: unknown;
  blockingCount?: unknown;
  mediumCount?: unknown;
  lightCount?: unknown;
  closedCount?: unknown;
}

export interface ScriptRowLike {
  name?: string | null;
  content?: string | null;
  createTime?: number | null;
}

export type ScopeClass =
  | { kind: "stage"; stage: "storySkeleton" | "adaptationStrategy" }
  | { kind: "episodes"; from: number; to: number }
  | { kind: "unknown" };

function asPositiveInt(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

/** 从剧本名解析集号：支持 "EP01" / "ep 1" / "第3集" 等写法 */
export function parseEpisodeNoFromName(nameValue: unknown): number | undefined {
  const name = String(nameValue ?? "");
  const ep = name.match(/\bEP\s*0*(\d{1,4})\b/i);
  if (ep) {
    const value = Number(ep[1]);
    if (Number.isSafeInteger(value) && value > 0) return value;
  }
  const cn = name.match(/第\s*0*(\d{1,4})\s*集/);
  if (cn) {
    const value = Number(cn[1]);
    if (Number.isSafeInteger(value) && value > 0) return value;
  }
  return undefined;
}

/** 解析审核范围里的集号区间：如 "EP01-EP03"、"第1-3集"、"01-03" */
export function parseScopeEpisodes(scopeValue: unknown): { from: number; to: number } | undefined {
  const scope = String(scopeValue ?? "").trim();
  if (!scope) return undefined;

  const prefixed = scope.match(
    /(?:EP|ep|第)\s*0*(\d{1,4})\s*集?\s*(?:[-–—~～至到]\s*(?:EP|ep|第)?\s*0*(\d{1,4})\s*集?)?/,
  );
  const plainRange = prefixed ? null : scope.match(/(\d{1,4})\s*[-–—~～至到]\s*(\d{1,4})/);
  const fromText = prefixed?.[1] ?? plainRange?.[1];
  const toText = prefixed?.[2] ?? plainRange?.[2];
  const from = Number(fromText);
  if (!Number.isSafeInteger(from) || from <= 0 || from > MAX_TARGET_EPISODES) return undefined;
  const to = Number(toText);
  if (!Number.isSafeInteger(to) || to < from || to > MAX_TARGET_EPISODES) return { from, to: from };
  return { from, to };
}

/** 归类审核范围：阶段级（骨架/策略）或集号区间 */
export function classifySupervisionScope(scopeValue: unknown): ScopeClass {
  const scope = String(scopeValue ?? "").trim();
  const range = parseScopeEpisodes(scope);
  if (range) return { kind: "episodes", ...range };
  if (/骨架/.test(scope)) return { kind: "stage", stage: "storySkeleton" };
  if (/策略/.test(scope)) return { kind: "stage", stage: "adaptationStrategy" };
  return { kind: "unknown" };
}

/** 集号区间展示：EP01-EP03 / EP04 / 全部 */
export function formatEpisodeRange(from: number, to: number): string {
  const label = (value: number) => `EP${String(value).padStart(2, "0")}`;
  return from === to ? label(from) : `${label(from)}-${label(to)}`;
}

/** 目标集数：已持久化字段 → 骨架分集解析 → 文本正则回退 */
export function resolveTargetEpisodes(workData: Record<string, unknown> | null | undefined): number | undefined {
  const stored = Number(workData?.targetEpisodes);
  if (Number.isSafeInteger(stored) && stored > 0 && stored <= MAX_TARGET_EPISODES) return stored;

  const skeleton = typeof workData?.storySkeleton === "string" ? workData.storySkeleton : "";
  if (skeleton.trim()) {
    const episodes = parseSkeletonEpisodes(skeleton);
    const max = episodes.length ? episodes[episodes.length - 1].episodeNo : undefined;
    if (max !== undefined && Number.isSafeInteger(max) && max > 0 && max <= MAX_TARGET_EPISODES) return max;
  }

  const strategy = typeof workData?.adaptationStrategy === "string" ? workData.adaptationStrategy : "";
  const text = [skeleton, strategy].join("\n");
  const tagged = text.match(/<集数>\s*(\d+)\s*集?\s*<\/集数>/)?.[1];
  const described = text.match(/(?:总共|共|目标|拆分为|规划为)\s*(\d+)\s*集/)?.[1];
  const count = Number(tagged ?? described);
  if (Number.isSafeInteger(count) && count > 0 && count <= MAX_TARGET_EPISODES) return count;
  return undefined;
}

/**
 * 保存时的目标集数解析（避免"骨架已拆集、项目配置还是旧集数"的跨阶段冲突）：
 * - 保存 **故事骨架** 时以**新骨架内容**为准（旧 targetEpisodes 不再优先），解析失败才回退到已存字段；
 * - 其他产物（改编策略/剧本）保持"已存字段优先"，避免措辞变化导致分母抖动。
 */
export function resolveTargetEpisodesOnSave(input: {
  artifactType: string;
  artifactContent: string;
  workData: Record<string, unknown> | null | undefined;
}): number | undefined {
  if (input.artifactType === "storySkeleton") {
    const fromSkeleton = resolveTargetEpisodes({ storySkeleton: input.artifactContent });
    if (fromSkeleton !== undefined) return fromSkeleton;
  }
  return resolveTargetEpisodes(input.workData);
}

function normalizeRounds(history: unknown): Array<ReviewBrief & { scope: string }> {
  if (!Array.isArray(history)) return [];
  return history
    .filter((item): item is SupervisionRoundLike => Boolean(item) && typeof item === "object")
    .map((item) => ({
      scope: String(item.scope ?? ""),
      rating: String(item.rating ?? "-"),
      at: Number(item.at) || 0,
      blocking: asPositiveInt(item.blockingCount),
      medium: asPositiveInt(item.mediumCount),
      light: asPositiveInt(item.lightCount),
      closed: asPositiveInt(item.closedCount),
    }))
    .sort((a, b) => a.at - b.at);
}

function reviewStatusOf(round: ReviewBrief): EpisodeReviewStatus {
  if (round.blocking > 0) return "blocked";
  return round.medium + round.light > 0 ? "issues" : "passed";
}

/** 取"最新覆盖该集"的审核轮次 */
function resolveEpisodeReview(rounds: Array<ReviewBrief & { scope: string }>, episodeNo: number) {
  for (let index = rounds.length - 1; index >= 0; index -= 1) {
    const round = rounds[index];
    const scope = classifySupervisionScope(round.scope);
    if (scope.kind !== "episodes") continue;
    if (episodeNo >= scope.from && episodeNo <= scope.to) {
      return {
        status: reviewStatusOf(round),
        rating: round.rating,
        blocking: round.blocking,
        medium: round.medium,
        light: round.light,
        at: round.at,
      };
    }
  }
  return { status: "unreviewed" as const, blocking: 0, medium: 0, light: 0 };
}

function latestStageReview(rounds: Array<ReviewBrief & { scope: string }>, stage: "storySkeleton" | "adaptationStrategy") {
  for (let index = rounds.length - 1; index >= 0; index -= 1) {
    const scope = classifySupervisionScope(rounds[index].scope);
    if (scope.kind === "stage" && scope.stage === stage) return rounds[index];
  }
  return undefined;
}

function latestEpisodeReview(rounds: Array<ReviewBrief & { scope: string }>) {
  for (let index = rounds.length - 1; index >= 0; index -= 1) {
    if (classifySupervisionScope(rounds[index].scope).kind === "episodes") return rounds[index];
  }
  return undefined;
}

function toBrief(round: ReviewBrief): ReviewBrief {
  return { rating: round.rating, at: round.at, blocking: round.blocking, medium: round.medium, light: round.light, closed: round.closed };
}

function describeReview(round: ReviewBrief): string {
  if (round.blocking > 0) return `最近审核存在 ${round.blocking} 个阻塞问题待修复（${round.rating}）`;
  const notices = round.medium + round.light;
  if (notices > 0) return `最近审核通过（${round.rating}·阻塞 0，遗留 ${notices} 项非阻塞建议）`;
  return `最近审核通过（${round.rating}）`;
}

function buildConclusive(params: {
  skeleton: StageProgress;
  strategy: StageProgress;
  targetEpisodes?: number;
  savedCount: number;
  remaining?: number;
  firstMissing?: number;
  nextRange?: { from: number; to: number };
  latestReview?: ReviewBrief;
}): string {
  const { skeleton, strategy, targetEpisodes, savedCount, remaining, nextRange, latestReview } = params;
  const totalText = targetEpisodes === undefined ? "" : `/${targetEpisodes}`;

  if (!skeleton.ready) return "故事骨架还未生成；下一步：先生成故事骨架";
  if (!strategy.ready) return `故事骨架已生成（${skeleton.chars} 字）；下一步：制定改编策略`;

  const nextText = nextRange ? `；下一步：继续生成 ${formatEpisodeRange(nextRange.from, nextRange.to)}` : "；下一步：继续编写剧本";
  if (savedCount === 0) {
    return `骨架（${skeleton.chars} 字）与改编策略（${strategy.chars} 字）已就绪${targetEpisodes ? `（共 ${targetEpisodes} 集）` : ""}${nextText}`;
  }
  const reviewText = latestReview ? `${describeReview(latestReview)}；` : "剧本尚未审核；";
  if (remaining === 0) {
    return `已生成全部 ${targetEpisodes ?? savedCount} 集剧本；${reviewText}可进入制作流程`;
  }
  return `已保存 ${savedCount}${totalText} 集剧本，${reviewText}${nextText.replace(/^；/, "")}`;
}

/** 构建进度快照（纯函数，不读库） */
export function buildScriptAgentProgress(input: {
  workData: Record<string, unknown> | null | undefined;
  scripts: ScriptRowLike[];
  batchSize?: number;
}): ScriptAgentProgress {
  const workData = input.workData ?? {};
  const batchSize = Math.max(1, Math.floor(input.batchSize ?? SCRIPT_BATCH_SIZE));
  const skeletonText = typeof workData.storySkeleton === "string" ? workData.storySkeleton : "";
  const strategyText = typeof workData.adaptationStrategy === "string" ? workData.adaptationStrategy : "";
  const rounds = normalizeRounds(workData.supervisionHistory);
  const targetEpisodes = resolveTargetEpisodes(workData);

  const skeletonReview = latestStageReview(rounds, "storySkeleton");
  const strategyReview = latestStageReview(rounds, "adaptationStrategy");
  const skeleton: StageProgress = {
    ready: skeletonText.trim().length > 0,
    chars: skeletonText.trim().length,
    ...(skeletonReview ? { latestReview: toBrief(skeletonReview) } : {}),
  };
  const strategy: StageProgress = {
    ready: strategyText.trim().length > 0,
    chars: strategyText.trim().length,
    ...(strategyReview ? { latestReview: toBrief(strategyReview) } : {}),
  };

  const episodes: EpisodeProgress[] = input.scripts
    .filter((row) => String(row?.name ?? "").trim())
    .map((row, index) => {
      const name = String(row.name ?? "");
      const episodeNo = parseEpisodeNoFromName(name) ?? index + 1;
      const content = String(row.content ?? "");
      const savedAt = Number(row.createTime);
      return {
        episodeNo,
        name,
        chars: content.trim().length,
        ...(Number.isFinite(savedAt) && savedAt > 0 ? { savedAt } : {}),
        review: resolveEpisodeReview(rounds, episodeNo),
      };
    })
    .sort((a, b) => a.episodeNo - b.episodeNo);

  const savedCount = episodes.filter((episode) => episode.chars > 0).length;
  const remaining = targetEpisodes === undefined ? undefined : Math.max(targetEpisodes - savedCount, 0);

  let nextRange: { from: number; to: number } | undefined;
  if (targetEpisodes !== undefined && remaining !== 0) {
    const savedNumbers = new Set(episodes.filter((episode) => episode.chars > 0).map((episode) => episode.episodeNo));
    let from = 1;
    while (from <= targetEpisodes && savedNumbers.has(from)) from += 1;
    if (from <= targetEpisodes) nextRange = { from, to: Math.min(from + batchSize - 1, targetEpisodes) };
  }

  const latestReview = latestEpisodeReview(rounds);
  return {
    stages: { storySkeleton: skeleton, adaptationStrategy: strategy },
    scripts: {
      ...(targetEpisodes === undefined ? {} : { targetEpisodes }),
      savedCount,
      ...(remaining === undefined ? {} : { remaining }),
      ...(nextRange ? { nextRange } : {}),
      episodes,
      ...(latestReview ? { latestReview: toBrief(latestReview) } : {}),
    },
    conclusive: buildConclusive({
      skeleton,
      strategy,
      targetEpisodes,
      savedCount,
      remaining,
      nextRange,
      latestReview,
    }),
  };
}

/** 读库入口：聚合某项目的进度快照（失败时返回空进度，不阻断主流程） */
export async function loadScriptAgentProgress(projectIdValue: unknown): Promise<ScriptAgentProgress> {
  const projectId = Number(projectIdValue);
  if (!Number.isSafeInteger(projectId) || projectId <= 0) {
    return buildScriptAgentProgress({ workData: {}, scripts: [] });
  }
  // 动态导入：避免模块被单测/工具引用时连带初始化数据库
  const { default: u } = await import("@/utils");
  try {
    const row = await u.db("o_agentWorkData").where({ projectId, key: "scriptAgent" }).first();
    let workData: Record<string, unknown> = {};
    try {
      workData = JSON.parse(String(row?.data ?? "{}"));
    } catch {
      workData = {};
    }
    const scripts = (await u.db("o_script").where({ projectId }).select("name", "content", "createTime")) as ScriptRowLike[];
    return buildScriptAgentProgress({ workData, scripts });
  } catch (err) {
    console.warn("[progress] 进度聚合失败，返回空进度:", u.error(err).message);
    return buildScriptAgentProgress({ workData: {}, scripts: [] });
  }
}
