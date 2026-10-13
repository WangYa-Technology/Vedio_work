/**
 * 只读回放：对指定项目已保存的故事骨架重跑容量体检（不写库）。
 *
 * 用法：
 *   npx tsx scripts/replaySkeletonChecks.ts [projectId] [--legacy]
 * - projectId 缺省时取最近保存了故事骨架的项目
 * - --legacy 额外打印"旧口径（整章权重、不做份额归一）"的对照结果，便于复盘修复前后差异
 *
 * 说明：本脚本绕过 runSkeletonChecks 的读库入口，直接用只读连接读取
 * `o_agentWorkData`（骨架）与 `o_novel`（章节原文），其余全部复用生产同款纯函数，
 * 保证回放结论与线上一致，且不会触碰任何写入路径。
 */
import { createRequire } from "node:module";
import path from "node:path";
import {
  SKELETON_CHECK_CONFIG,
  applyChapterSharePlan,
  buildChapterSharePlan,
  checkSkeletonStructure,
  collectSuspiciousFragmentLabels,
  countQuoteStats,
  estimateEpisodeCapacity,
  parseSkeletonEpisodesDetailed,
  skeletonReportToMarkdown,
  type ChapterStat,
  type SkeletonCheckReport,
} from "../src/agents/scriptAgent/skeletonChecks";
import {
  EPISODE_CAPACITY_BUDGET,
  estimateDialogueTiming,
  formatCapacityTable,
  inferDialogueLoad,
  suggestEpisodeCount,
  type DialogueLoad,
} from "../src/agents/shared/episodeCapacity";

const require = createRequire(__filename);
const Database = require("better-sqlite3") as any;

const dbPath = path.resolve(process.cwd(), "data", "db2.sqlite");
const args = process.argv.slice(2);
const withLegacy = args.includes("--legacy");
const explicitProjectId = args.find((arg) => /^\d+$/.test(arg));
/** `--file <path>`：直接复检任意骨架文本（仍需 projectId 提供章节原文统计） */
const fileArgIndex = args.indexOf("--file");
const skeletonFilePath = fileArgIndex >= 0 ? args[fileArgIndex + 1] : undefined;

const db = new Database(dbPath, { readonly: true });

interface WorkRow {
  projectId: number;
  data: string;
}

function loadSkeletonRow(projectId?: number): { projectId: number; projectName: string; skeleton: string } {
  const rows: WorkRow[] = projectId
    ? db.prepare("select projectId, data from o_agentWorkData where key = ? and projectId = ?").all("scriptAgent", projectId)
    : db.prepare("select projectId, data from o_agentWorkData where key = ? order by rowid desc").all("scriptAgent");
  for (const row of rows) {
    let workData: Record<string, unknown> = {};
    try {
      workData = JSON.parse(String(row.data ?? "{}"));
    } catch {
      continue;
    }
    const skeleton = typeof workData.storySkeleton === "string" ? workData.storySkeleton : "";
    if (!skeleton.trim()) continue;
    const project = db.prepare("select name from o_project where id = ?").get(row.projectId) as { name?: string } | undefined;
    return { projectId: Number(row.projectId), projectName: String(project?.name ?? "未知项目"), skeleton };
  }
  throw new Error(projectId ? `项目 ${projectId} 没有已保存的故事骨架` : "没有找到已保存故事骨架的项目");
}

/** 骨架来源：`--file` 优先（便于复检改前/改后的骨架文本），否则读工作区 */
function loadSkeleton(projectId?: number): { projectId: number; projectName: string; skeleton: string } {
  if (!skeletonFilePath) return loadSkeletonRow(projectId);
  const fs = require("node:fs") as typeof import("node:fs");
  const skeleton = fs.readFileSync(path.resolve(skeletonFilePath), "utf8");
  const project = projectId
    ? (db.prepare("select id, name from o_project where id = ?").get(projectId) as { id: number; name?: string } | undefined)
    : (db.prepare("select id, name from o_project order by id desc limit 1").get() as { id: number; name?: string } | undefined);
  if (!project) throw new Error("--file 模式需要一个项目（用于读取章节原文统计），请传入 projectId");
  return { projectId: Number(project.id), projectName: String(project.name ?? "未知项目"), skeleton };
}

function countChars(text: string): number {
  return String(text ?? "").replace(/\s+/g, "").length;
}

function loadStats(projectId: number): Map<number, ChapterStat> {
  const rows = db
    .prepare("select chapterIndex, chapterData from o_novel where projectId = ? order by id")
    .all(projectId) as Array<{ chapterIndex?: string | null; chapterData?: string | null }>;
  const stats = new Map<number, ChapterStat>();
  for (const row of rows) {
    const matched = String(row.chapterIndex ?? "").match(/\d+/);
    if (!matched) continue;
    const chapter = Number(matched[0]);
    const text = String(row.chapterData ?? "");
    const quote = countQuoteStats(text);
    stats.set(chapter, {
      chapter,
      chars: countChars(text),
      quoteChars: quote.chars,
      quoteLines: quote.lines,
      quoteMarks: quote.marks,
    });
  }
  return stats;
}

function buildReport(projectId: number, skeleton: string, stats: Map<number, ChapterStat>): SkeletonCheckReport {
  const parsed = parseSkeletonEpisodesDetailed(skeleton);
  const episodes = parsed.episodes;
  const plan = buildChapterSharePlan(episodes);
  applyChapterSharePlan(episodes, plan);
  const warnings = [...plan.warnings];
  const suspicious = collectSuspiciousFragmentLabels(skeleton);
  if (suspicious.length) {
    warnings.push(
      `疑似未识别的片段写法：${suspicious.slice(0, 5).join("、")}${suspicious.length > 5 ? " 等" : ""}；请改用 前半/后半/中段/后段/收束前段/收束，或“第N章(a/b)”“第N章 p%”写法`,
    );
  }
  return {
    generatedAt: Date.now(),
    projectId,
    target: { ...SKELETON_CHECK_CONFIG.episodeTarget },
    estimates: episodes.map((episode) => estimateEpisodeCapacity(episode, stats, SKELETON_CHECK_CONFIG, plan)),
    structureWarnings: checkSkeletonStructure(episodes, Array.from(stats.keys()).sort((a, b) => a - b)),
    warnings,
    parseSource: parsed.source,
    shareSummaries: plan.byChapter,
  };
}

function countByLevel(report: SkeletonCheckReport) {
  const count = (level: string) => report.estimates.filter((estimate) => estimate.level === level).length;
  return {
    severe: count("severeOver"),
    light: count("lightOver"),
    under: count("under"),
    ok: count("ok"),
  };
}

function episodeNumbersOfLevel(report: SkeletonCheckReport, level: string): string {
  return (
    report.estimates
      .filter((estimate) => estimate.level === level)
      .map((estimate) => `EP${String(estimate.episodeNo).padStart(2, "0")}`)
      .join("、") || "无"
  );
}

const { budget, episodeTarget } = SKELETON_CHECK_CONFIG;
const { projectId, projectName, skeleton } = loadSkeleton(explicitProjectId ? Number(explicitProjectId) : undefined);
const stats = loadStats(projectId);
const report = buildReport(projectId, skeleton, stats);
const totals = countByLevel(report);

const totalQuote = Array.from(stats.values()).reduce((sum, item) => sum + item.quoteChars, 0);
const totalChars = Array.from(stats.values()).reduce((sum, item) => sum + item.chars, 0);
// 与线上同源：逐字保留口径（共享容量模型），不再自行折算采用率/语速
const totalLoad = inferDialogueLoad(
  Array.from(stats.values()).reduce<DialogueLoad>(
    (sum, item) => ({
      chars: sum.chars + item.quoteChars,
      lines: sum.lines + (item.quoteLines ?? 0),
      marks: sum.marks + (item.quoteMarks ?? 0),
      inferred: sum.inferred || item.quoteLines === undefined || item.quoteMarks === undefined,
    }),
    { chars: 0, lines: 0, marks: 0, inferred: false },
  ),
);
const totalTiming = estimateDialogueTiming(totalLoad);
const episodeCount = suggestEpisodeCount(totalLoad, EPISODE_CAPACITY_BUDGET);

console.log("=== 骨架容量体检回放（只读） ===");
console.log(`项目：${projectName}（${projectId}）`);
console.log(
  `骨架：${skeleton.length} 字；章节：${stats.size} 章（原文 ${totalChars} 字，台词素材 ${totalLoad.lines} 条 / ${totalQuote} 字 / ${totalLoad.marks} 标点 → 逐字下限 ${totalTiming.floorSeconds}s、安全 ${totalTiming.safeSeconds}s${totalLoad.inferred ? "，含推断条数/标点" : ""}）`,
);
console.log("");
console.log(skeletonReportToMarkdown(report));
console.log("=== 统计 ===");
console.log(`严重超载 ${totals.severe} 集（${episodeNumbersOfLevel(report, "severeOver")}）`);
console.log(`轻度超载 ${totals.light} 集；素材不足 ${totals.under} 集；通过 ${totals.ok} 集`);
if (withLegacy) {
  const parsed = parseSkeletonEpisodesDetailed(skeleton);
  const legacyEstimates = parsed.episodes.map((episode) => estimateEpisodeCapacity(episode, stats));
  const legacySevere = legacyEstimates.filter((estimate) => estimate.level === "severeOver").length;
  const legacyLight = legacyEstimates.filter((estimate) => estimate.level === "lightOver").length;
  const legacyUnder = legacyEstimates.filter((estimate) => estimate.level === "under").length;
  const legacyOk = legacyEstimates.filter((estimate) => estimate.level === "ok").length;
  console.log(`[--legacy 旧口径对照] 严重超载 ${legacySevere} 集；轻度 ${legacyLight}；素材不足 ${legacyUnder}；通过 ${legacyOk}（旧口径 = 整章权重、同章多集各按整章计）`);
}
console.log("");
console.log("=== 收敛建议（共享容量模型口径，逐字保留） ===");
console.log(
  `- 单集目标 ${episodeTarget.minSeconds}-${episodeTarget.maxSeconds}s；上限按 ${episodeTarget.maxSeconds * budget.severeOverRatio + budget.severeToleranceSeconds}s 判阻塞、下限 ${episodeTarget.minSeconds * budget.underRatio}s 判素材不足`,
);
console.log(`- 全剧集数建议：物理下限 ${episodeCount.min} 集；舒适 ${episodeCount.comfort} 集；上限 ${episodeCount.max} 集`);
episodeCount.notes.forEach((note) => console.log(`  - ${note}`));
console.log(`- 单集容量查表：${formatCapacityTable(EPISODE_CAPACITY_BUDGET).join("；")}`);
const verdict =
  totals.severe > 0
    ? `结论：仍有 ${totals.severe} 集严重超载（阻塞），需回骨架拆集（台词逐字保留）或由用户授权删减后复检。`
    : totals.under > report.estimates.length / 2
      ? `结论：零阻塞，可放行；但素材不足 ${totals.under}/${report.estimates.length} 集，建议把集数收敛到 ${episodeCount.comfort} 集左右（或合并头/尾段）后再进入后续阶段。`
      : "结论：零阻塞，可直接放行。";
console.log(`- ${verdict}`);
