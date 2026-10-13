/**
 * 只读回放：对指定项目某一集的分镜表重跑确定性检查（不写库）。
 *
 * 用法：
 *   npx tsx scripts/replayStoryboardChecks.ts [projectId] [scriptId] [--no-script]
 * - projectId/scriptId 缺省时取最近保存了分镜表的项目与其剧本
 * - --no-script：不注入剧本（跳过台词覆盖度比对），用于对照"只看分镜表自身"的旧结论
 *
 * 输出：单集容量事实层（合计 / 超时 / 片段数 / 台词净时长）、台词覆盖度四分类、
 *       旧口径对照（不含本轮新增判定）与压缩/拆集可派发建议。
 *
 * 说明：本脚本绕过 runStoryboardChecks 的读库入口（避免引入 @/utils），
 * 直接以只读连接读取 `o_agentWorkData` / `o_script` / `o_assets`，
 * 其余全部复用生产同款纯函数，保证回放结论与线上一致且无写入。
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import {
  STORYBOARD_CHECK_CONFIG,
  checkStoryboardTable,
  parseStoryboardWaivers,
  storyboardReportToMarkdown,
  type StoryboardAssetRef,
  type StoryboardCheckReport,
} from "../src/agents/productionAgent/storyboardChecks";
import { EPISODE_CAPACITY_BUDGET } from "../src/agents/shared/episodeCapacity";

function round1Safe(value: number): number {
  return Math.round(value * 10) / 10;
}

const require = createRequire(__filename);
const Database = require("better-sqlite3") as any;

const dbPath = path.resolve(process.cwd(), "data", "db2.sqlite");
const args = process.argv.slice(2);
const withoutScript = args.includes("--no-script");
const numericArgs = args.filter((arg) => /^\d+$/.test(arg)).map(Number);
const fileArgIndex = args.indexOf("--file");
const tableFile = fileArgIndex >= 0 ? args[fileArgIndex + 1] : undefined;

const db = new Database(dbPath, { readonly: true });

interface FlowRow {
  projectId: number;
  episodesId: number;
  data: string;
}

function loadFlowRow(projectId?: number, scriptId?: number): FlowRow {
  const rows: FlowRow[] = projectId
    ? db
        .prepare("select projectId, episodesId, data from o_agentWorkData where key = ? and projectId = ? order by rowid desc")
        .all("productionFlowData", projectId)
    : db.prepare("select projectId, episodesId, data from o_agentWorkData where key = ? order by rowid desc").all("productionFlowData");
  for (const row of rows) {
    if (scriptId && Number(row.episodesId) !== scriptId) continue;
    let workData: Record<string, unknown> = {};
    try {
      workData = JSON.parse(String(row.data ?? "{}"));
    } catch {
      continue;
    }
    if (typeof workData.storyboardTable !== "string" || !workData.storyboardTable.trim()) continue;
    return { projectId: Number(row.projectId), episodesId: Number(row.episodesId), data: String(row.data) };
  }
  throw new Error(projectId ? `项目 ${projectId} 没有已保存的分镜表` : "没有找到已保存分镜表的项目");
}

function loadAssets(projectId: number): StoryboardAssetRef[] {
  const rows = db
    .prepare("select id, name, type, assetsId from o_assets where projectId = ?")
    .all(projectId) as Array<{ id: number; name: string | null; type: string | null; assetsId: number | null }>;
  return rows.map((row) => ({
    id: Number(row.id),
    name: String(row.name ?? ""),
    type: String(row.type ?? ""),
    parentId: row.assetsId == null ? null : Number(row.assetsId),
  }));
}

interface CheckInputs {
  projectId: number;
  episodesId: number;
  projectName: string;
  tableText: string;
  scriptContent: string;
  scriptName: string;
  waivers: unknown;
  origin: string;
}

function resolveInputs(): CheckInputs {
  if (tableFile) {
    const resolved = path.resolve(process.cwd(), tableFile);
    const tableText = fs.readFileSync(resolved, "utf8");
    const projectId = numericArgs[0] ?? 0;
    const episodesId = numericArgs[1] ?? 0;
    const scriptRow = projectId && episodesId
      ? (db.prepare("select name, content from o_script where projectId = ? and id = ?").get(projectId, episodesId) as
          | { name?: string; content?: string }
          | undefined)
      : undefined;
    const flowRow = projectId && episodesId
      ? (db.prepare("select data from o_agentWorkData where projectId = ? and episodesId = ? and key = ?").get(
          projectId,
          episodesId,
          "productionFlowData",
        ) as { data?: string } | undefined)
      : undefined;
    let flowData: Record<string, unknown> = {};
    try {
      flowData = flowRow?.data ? (JSON.parse(String(flowRow.data)) as Record<string, unknown>) : {};
    } catch {
      flowData = {};
    }
    const projectRow = projectId ? (db.prepare("select name from o_project where id = ?").get(projectId) as { name?: string } | undefined) : undefined;
    return {
      projectId,
      episodesId,
      projectName: String(projectRow?.name ?? "未知项目"),
      tableText,
      scriptContent: String(scriptRow?.content ?? flowData.script ?? ""),
      scriptName: String(scriptRow?.name ?? `EP${episodesId || "?"}`),
      waivers: flowData.waivers,
      origin: `文件 ${resolved}`,
    };
  }

  const flow = loadFlowRow(numericArgs[0], numericArgs[1]);
  const flowData = JSON.parse(flow.data) as Record<string, unknown>;
  const scriptRow = db.prepare("select name, content from o_script where projectId = ? and id = ?").get(flow.projectId, flow.episodesId) as
    | { name?: string; content?: string }
    | undefined;
  const projectRow = db.prepare("select name from o_project where id = ?").get(flow.projectId) as { name?: string } | undefined;
  const flowScript = typeof flowData.script === "string" ? flowData.script : "";
  return {
    projectId: flow.projectId,
    episodesId: flow.episodesId,
    projectName: String(projectRow?.name ?? "未知项目"),
    tableText: String(flowData.storyboardTable ?? ""),
    scriptContent: flowScript.trim() ? flowScript : String(scriptRow?.content ?? ""),
    scriptName: String(scriptRow?.name ?? `EP${flow.episodesId}`),
    waivers: flowData.waivers,
    origin: `工作区 productionFlowData（projectId=${flow.projectId}, scriptId=${flow.episodesId}）`,
  };
}

const inputs = resolveInputs();
const report = checkStoryboardTable(inputs.tableText, {
  assets: inputs.projectId ? loadAssets(inputs.projectId) : [],
  script:
    withoutScript || !inputs.scriptContent.trim() ? null : { name: inputs.scriptName, content: inputs.scriptContent },
  waivers: parseStoryboardWaivers(inputs.waivers),
});

const { episodeTarget, segmentBudget } = STORYBOARD_CHECK_CONFIG;
const legacyCategories = new Set(["单集合计时长", "容量缺口", "片段预算", "台词覆盖度"]);
const legacyBlocking = report.issues.filter((issue) => issue.severity === "阻塞" && !legacyCategories.has(issue.category)).length;
const newBlocking = report.issues.filter((issue) => issue.severity === "阻塞" && legacyCategories.has(issue.category)).length;

function printSuggestions(current: StoryboardCheckReport): void {
  const effectiveMax = current.effectiveMaxSeconds ?? episodeTarget.maxSeconds;
  const seconds = current.episodeSeconds ?? 0;
  const dialogueFloor = current.dialogueFloorSeconds ?? 0;
  console.log("=== 压缩 / 拆集建议（按工具口径反推） ===");
  console.log(
    `- 单集合计 ${seconds}s（预算 ${episodeTarget.minSeconds}~${effectiveMax}s）：超出 ${round1Safe(seconds - effectiveMax)}s；片段 ${current.segmentCount} 段（预算 ≤${segmentBudget.maxSegments}）`,
  );
  const nonDialogue = round1Safe(Math.max(0, seconds - dialogueFloor));
  const gap = round1Safe(Math.max(0, seconds - effectiveMax));
  if (gap > 0) {
    if (gap <= nonDialogue) {
      console.log(`- 压缩可行：非台词占用约 ${nonDialogue}s，压缩动作镜/合并场景至少可回收 ${gap}s（先删动作镜，再谈台词）`);
    } else {
      console.log(`- 仅压缩动作镜不足：非台词占用约 ${nonDialogue}s < 需压缩 ${gap}s，必须删减台词或拆集`);
    }
  }
  console.log(
    `- 骑线占比：${current.dialogueShotsTight ?? 0}/${current.dialogueShots ?? 0} 个台词镜低于安全线（${Math.round((current.rideLineRatio ?? 0) * 100)}%，阈值 ${Math.round(EPISODE_CAPACITY_BUDGET.rideLineRatioThreshold * 100)}%）——骑线不阻塞、不作为返工理由`,
  );
  if (current.splitSuggestion) {
    console.log(
      `- 拆集建议：拆成 ${current.splitSuggestion.count} 集（${current.splitSuggestion.reason}）；台词逐字保留，按场/节拍边界落刀`,
    );
  } else {
    console.log(
      `- 拆集参考（无强制建议）：按上限 ${episodeTarget.maxSeconds}s 拆 ${Math.max(1, Math.ceil(seconds / episodeTarget.maxSeconds))} 集；素材不足的集优先并集`,
    );
  }
  if (current.dialogueFloorSeconds != null && dialogueFloor > effectiveMax) {
    console.log(
      `- 台词下限 ${dialogueFloor}s 已超预算：需删减 ≥ ${Math.ceil((dialogueFloor - effectiveMax) * STORYBOARD_CHECK_CONFIG.dialogue.hardCharsPerSecond)} 字台词（需用户授权并登记豁免）或拆集`,
    );
  }
  const coverageInfo = current.dialogueCoverage;
  if (coverageInfo) {
    console.log(
      `- 台词覆盖：逐字 ${coverageInfo.verbatim} / 拆镜 ${coverageInfo.split} / 疑似改写 ${coverageInfo.rewritten.length} / 缺失 ${coverageInfo.missing.length} / 分镜额外 ${coverageInfo.extra.length}`,
    );
    coverageInfo.missing.slice(0, 10).forEach((item) => console.log(`  · 待补（剧本 L${item.lineNo}）：${item.script}`));
    coverageInfo.extra.slice(0, 10).forEach((item) => console.log(`  · 待确认（剧本无对应）：${item.location} ${item.text}`));
  } else {
    console.log("- 台词覆盖：未注入剧本（--no-script），跳过比对");
  }
}

console.log("=== 分镜表确定性检查回放（只读） ===");
console.log(`项目：${inputs.projectName}（${inputs.projectId || "-"}）；剧集：${inputs.scriptName}（scriptId=${inputs.episodesId || "-"}）`);
console.log(`来源：${inputs.origin}`);
console.log(
  `输入：分镜表 ${inputs.tableText.length} 字；剧本 ${withoutScript ? "未注入" : `${inputs.scriptContent.length} 字`}；豁免 ${report.appliedWaivers?.length ?? 0} 条`,
);
console.log("");
console.log(storyboardReportToMarkdown(report));
console.log("=== 统计 ===");
console.log(`阻塞 ${report.blockingCount} 项（其中本轮新增判定贡献 ${newBlocking} 项）；骑线 ${report.borderlineCount} 项；提示 ${report.noticeCount} 项`);
console.log(`旧口径对照（不含单集容量/容量缺口/片段预算分级/台词覆盖度）：阻塞 ${legacyBlocking} 项`);
console.log(`单集合计 ${report.episodeSeconds ?? 0}s；台词净时长下限 ${report.dialogueFloorSeconds ?? 0}s（安全 ${report.dialogueSafeSeconds ?? 0}s）`);
console.log("");
printSuggestions(report);
