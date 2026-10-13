/**
 * 只读容量预演：对指定项目的剧本按"三层统一口径"重算单集容量，并输出拆集方案（不写库）。
 *
 * 用法：
 *   npx tsx scripts/replayEpisodeCapacity.ts [projectId] [剧本名关键字]
 * - projectId 缺省时取最近保存了剧本的项目
 * - 第二个参数可选：只算名称包含该关键字的剧本（如 EP01）
 *
 * 输出：
 *   1) 逐集负载（条数 / 净字数 / 标点）、台词下限与安全时长、预计时长、三态与建议拆集数；
 *   2) 需要拆集时给出《拆集方案表》（按场/节拍/对话轮次边界落刀、台词逐字保留）；
 *   3) 全剧集数建议（物理下限 / 舒适 / 上限）与按章统计的台词负载。
 *
 * 说明：绕过 runScriptChecks 的读库入口（避免引入 @/utils），用只读连接读 `o_script` / `o_novel`，
 * 其余全部复用生产同款纯函数（parseScriptEpisode / previewEpisodeCapacity / 共享容量模型）。
 */
import { createRequire } from "node:module";
import path from "node:path";
import {
  buildCapacityUnits,
  parseScriptEpisode,
  previewEpisodeCapacity,
  renderSplitPlanTable,
} from "../src/agents/scriptAgent/scriptChecks";
import {
  EPISODE_CAPACITY_BUDGET,
  capacityLevelMark,
  estimateDialogueTiming,
  estimateEpisodeCapacity as estimateLoadCapacity,
  formatCapacityTable,
  inferDialogueLoad,
  suggestEpisodeCount,
  type DialogueLoad,
} from "../src/agents/shared/episodeCapacity";

const require = createRequire(__filename);
const Database = require("better-sqlite3") as any;

const dbPath = path.resolve(process.cwd(), "data", "db2.sqlite");
const args = process.argv.slice(2);
const explicitProjectId = args.find((arg) => /^\d+$/.test(arg));
const nameFilter = args.find((arg) => !/^\d+$/.test(arg) && !arg.startsWith("--"));
/** 人工指定切点：--cut=59 或 --cut=59,120（按剧本行号，切在该行之后） */
const manualCuts = args
  .filter((arg) => arg.startsWith("--cut="))
  .flatMap((arg) => arg.slice("--cut=".length).split(","))
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0)
  .sort((a, b) => a - b);

const db = new Database(dbPath, { readonly: true });

interface ScriptRow {
  projectId: number;
  name: string;
  content: string;
}

interface NovelRow {
  chapterIndex?: string | null;
  chapterData?: string | null;
}

function loadScripts(projectId?: number): { projectId: number; projectName: string; rows: ScriptRow[] } {
  const rows: ScriptRow[] = projectId
    ? db
        .prepare("select projectId, name, content from o_script where projectId = ? order by id")
        .all(projectId)
    : db
        .prepare("select projectId, name, content from o_script order by id desc limit 40")
        .all();
  for (const row of rows) {
    const content = String(row.content ?? "");
    if (!content.trim()) continue;
    const project = db.prepare("select name from o_project where id = ?").get(row.projectId) as
      | { name?: string }
      | undefined;
    return {
      projectId: Number(row.projectId),
      projectName: String(project?.name ?? "未知项目"),
      rows,
    };
  }
  throw new Error(projectId ? `项目 ${projectId} 没有已保存的剧本` : "没有找到已保存剧本的项目");
}

function countMarks(text: string): number {
  return (String(text ?? "").match(/[，。！？；、…—·,.!?;:]/g) ?? []).length;
}

function loadChapterLoads(projectId: number): Array<{ chapter: number; load: DialogueLoad }> {
  const rows = db
    .prepare("select chapterIndex, chapterData from o_novel where projectId = ? order by id")
    .all(projectId) as NovelRow[];
  const pattern = /[“"「『]([^”"」』\n]{1,120})[”"」』]/g;
  const result: Array<{ chapter: number; load: DialogueLoad }> = [];
  for (const row of rows) {
    const matched = String(row.chapterIndex ?? "").match(/\d+/);
    if (!matched) continue;
    const text = String(row.chapterData ?? "");
    let chars = 0;
    let lines = 0;
    let marks = 0;
    let match: RegExpExecArray | null;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(text)) !== null) {
      const plain = match[1].replace(/\s+/g, "");
      if (plain.length < 2 || plain.length > 60) continue;
      const markCount = countMarks(plain);
      chars += plain.length - markCount;
      marks += markCount;
      lines += 1;
    }
    result.push({ chapter: Number(matched[0]), load: { chars, lines, marks } });
  }
  return result;
}

const { projectId, projectName, rows } = loadScripts(explicitProjectId ? Number(explicitProjectId) : undefined);
const targets = rows.filter(
  (row) => String(row.content ?? "").trim() && (!nameFilter || String(row.name ?? "").includes(nameFilter)),
);

console.log("=== 剧本容量预演（只读，三层统一口径） ===");
console.log(`项目：${projectName}（${projectId}）`);
console.log(
  `口径：台词下限 = 净字÷${4.5} + 0.3×条数；台词安全 = 净字÷4 + 0.4×标点 + 1×条数；预计时长 = 台词安全 + 动作预算 ${EPISODE_CAPACITY_BUDGET.actionReferenceSeconds}s（合并到极限 ${EPISODE_CAPACITY_BUDGET.actionMinimumSeconds}s）`,
);
console.log(
  `单集：${EPISODE_CAPACITY_BUDGET.minSeconds}~${EPISODE_CAPACITY_BUDGET.maxSeconds}s（>${EPISODE_CAPACITY_BUDGET.severeSeconds}s 阻塞、<${EPISODE_CAPACITY_BUDGET.underSeconds}s 素材不足）；容量查表：${formatCapacityTable(EPISODE_CAPACITY_BUDGET).join("；")}`,
);
console.log("");

for (const row of targets) {
  const parsed = parseScriptEpisode(String(row.name ?? ""), String(row.content ?? ""));
  const preview = previewEpisodeCapacity(parsed);
  const estimate = preview.estimate;
  console.log(`--- ${parsed.name} ---`);
  console.log(
    `负载：${preview.load.lines} 条 / ${preview.load.chars} 净字 / ${preview.load.marks} 标点；场数 ${parsed.scenes.length}`,
  );
  console.log(
    `折算：台词下限 ${preview.timing.floorSeconds}s、台词安全 ${preview.timing.safeSeconds}s → 预计 ${estimate.totalSeconds}s（刚性下限时长 ${estimate.floorTotalSeconds}s）`,
  );
  console.log(`三态：${capacityLevelMark(estimate.result.level)}；${estimate.result.verdict}`);
  console.log(`建议：${estimate.result.advice}`);
  if (preview.splitPlan) {
    console.log("");
    console.log("《拆集方案表》");
    renderSplitPlanTable(preview.splitPlan).forEach((line) => console.log(line));
    const suggestion = preview.splitPlan.suggestion;
    console.log(
      `收敛建议：物理下限 ${suggestion.min} 集 / 舒适 ${suggestion.comfort} 集 / 上限 ${suggestion.max} 集（${suggestion.notes.join("；")}）`,
    );
    for (const part of preview.splitPlan.parts) {
      const seconds = part.estimate.totalSeconds;
      const segments = Math.min(
        EPISODE_CAPACITY_BUDGET.maxSegments,
        Math.max(4, Math.round(seconds / 16)),
      );
      const actionShots = Math.max(4, Math.round(EPISODE_CAPACITY_BUDGET.actionReferenceSeconds / 5));
      console.log(
        `  · 新EP${String(part.index).padStart(2, "0")}：约 ${segments} 段、${part.load.lines} 个台词镜 + ≈${actionShots} 个动作镜（4~6s 双拍合并），预计 ${seconds}s`,
      );
    }
  }

  // 人工指定切点评估（用于"工具推荐切点不合语义"时的替代方案对比）
  if (manualCuts.length) {
    const units = buildCapacityUnits(parsed);
    console.log("");
    console.log("《人工切点评估》");
    let start = 0;
    manualCuts.forEach((cut, index) => {
      const end = units.findIndex((unit) => Number(unit.id.replace(/^L/, "")) > cut);
      const slice = units.slice(start, end >= 0 ? end : units.length);
      const load = slice.reduce<DialogueLoad>(
        (sum, unit) => ({
          chars: sum.chars + unit.chars,
          marks: sum.marks + unit.marks,
          lines: sum.lines + unit.lines,
        }),
        { chars: 0, marks: 0, lines: 0 },
      );
      const estimate = estimateLoadCapacity(load, EPISODE_CAPACITY_BUDGET);
      console.log(
        `  · 第 ${index + 1} 集（至第${cut}行）：${load.lines} 条 / ${load.chars} 净字 / ${load.marks} 标点 → 下限 ${estimate.timing.floorSeconds}s、安全 ${estimate.timing.safeSeconds}s、预计 ${estimate.totalSeconds}s（骑线占比 ${Math.round(estimate.rideLineRatio * 100)}%）→ ${capacityLevelMark(estimate.result.level)}`,
      );
      start = end >= 0 ? end : units.length;
    });
    const rest = units.slice(start);
    if (rest.length) {
      const load = rest.reduce<DialogueLoad>(
        (sum, unit) => ({
          chars: sum.chars + unit.chars,
          marks: sum.marks + unit.marks,
          lines: sum.lines + unit.lines,
        }),
        { chars: 0, marks: 0, lines: 0 },
      );
      const estimate = estimateLoadCapacity(load, EPISODE_CAPACITY_BUDGET);
      console.log(
        `  · 最后 1 集（第${manualCuts[manualCuts.length - 1] + 1}行起）：${load.lines} 条 / ${load.chars} 净字 / ${load.marks} 标点 → 下限 ${estimate.timing.floorSeconds}s、安全 ${estimate.timing.safeSeconds}s、预计 ${estimate.totalSeconds}s（骑线占比 ${Math.round(estimate.rideLineRatio * 100)}%）→ ${capacityLevelMark(estimate.result.level)}`,
      );
    }
  }
  console.log("");
}

/* ==================== 全剧集数建议 ==================== */
const chapterLoads = loadChapterLoads(projectId);
if (chapterLoads.length) {
  const total = chapterLoads.reduce<DialogueLoad>(
    (sum, item) => ({
      chars: sum.chars + item.load.chars,
      lines: sum.lines + item.load.lines,
      marks: sum.marks + item.load.marks,
    }),
    { chars: 0, lines: 0, marks: 0 },
  );
  const totalTiming = estimateDialogueTiming(inferDialogueLoad(total));
  const suggestion = suggestEpisodeCount(inferDialogueLoad(total));
  console.log("=== 全剧集数建议（按原著台词逐字保留口径） ===");
  console.log(
    `原著台词合计：${total.lines} 条 / ${total.chars} 净字 / ${total.marks} 标点 → 台词下限 ${totalTiming.floorSeconds}s、台词安全 ${totalTiming.safeSeconds}s`,
  );
  console.log(`集数建议：物理下限 ${suggestion.min} 集；舒适 ${suggestion.comfort} 集；上限 ${suggestion.max} 集`);
  suggestion.notes.forEach((note) => console.log(`  - ${note}`));
  console.log("");
  console.log("| 章 | 条数 | 净字数 | 标点 | 台词下限 | 台词安全 | 至少需 | ");
  console.log("| --- | --- | --- | --- | --- | --- | --- |");
  for (const item of chapterLoads) {
    const timing = estimateDialogueTiming(item.load);
    const need = Math.max(
      1,
      Math.ceil(timing.safeSeconds / (EPISODE_CAPACITY_BUDGET.maxSeconds - EPISODE_CAPACITY_BUDGET.actionReferenceSeconds)),
      Math.ceil(timing.floorSeconds / (EPISODE_CAPACITY_BUDGET.maxSeconds - EPISODE_CAPACITY_BUDGET.actionMinimumSeconds)),
    );
    console.log(
      `| 第${item.chapter}章 | ${item.load.lines} | ${item.load.chars} | ${item.load.marks} | ${timing.floorSeconds}s | ${timing.safeSeconds}s | ${need} 集 |`,
    );
  }
}
