/**
 * 生产审核支持模块：审核流式 meta 拦截、轮次记录持久化、宿主注入构建、定点修复范围推导。
 *
 * 对齐 Script Agent 已成熟的审核闭环范式（scriptAgent/index.ts）：
 * - 审核前由宿主强制注入「确定性检查结果 + 上一轮问题清单」，不依赖模型自觉；
 * - 审核报告末尾输出 <supervisionMeta> JSON（宿主解析、不展示给用户），驱动收敛判定；
 * - 轮次记录持久化到 productionFlowData.supervisionHistory（剧集级），供复审关闭状态核对与定点修复范围推导。
 *
 * 纯函数与 IO 分离：拦截/解析/注入/推导均为纯函数（可单测）；读写库函数内部动态加载 @/utils。
 */

import { parseStoryboardTable, type ParsedStoryboardTable } from "./storyboardChecks";
import type { RepairScope } from "./storyboardDoc";

export const SUPERVISION_HISTORY_LIMIT = 10;
export const SUPERVISION_META_TAG = "supervisionMeta";
export const SUPERVISION_META_OPEN = "<supervisionMeta";
export const SUPERVISION_META_CLOSE = "</supervisionMeta>";

export interface SupervisionIssueRecord {
  id: string;
  severity: string;
  category: string;
  location: string;
  problem: string;
  suggestion: string;
  /** 来源标注：上轮漏检 / 本轮修改引入 / 真实新缺陷 / unknown */
  source: string;
}

export interface SupervisionRoundRecord {
  at: number;
  scope: string;
  rating: string;
  blockingCount: number;
  mediumCount: number;
  lightCount: number;
  newBlockingCount: number;
  closedCount: number;
  passed: boolean;
  issues: SupervisionIssueRecord[];
}

/* ==================== 流式 meta 拦截 ==================== */

export interface SupervisionStreamState {
  buffer: string;
  inMeta: boolean;
  metaText: string;
}

function longestTagPrefixSuffix(buffer: string, tag: string): number {
  const max = Math.min(buffer.length, tag.length - 1);
  for (let length = max; length > 0; length -= 1) {
    if (tag.startsWith(buffer.slice(buffer.length - length))) return length;
  }
  return 0;
}

export function createSupervisionStreamState(): SupervisionStreamState {
  return { buffer: "", inMeta: false, metaText: "" };
}

/** 流式拦截 <supervisionMeta> 块：该块只用于宿主持久化，不推送给前端 */
export function consumeSupervisionStream(chunk: string, state: SupervisionStreamState): string {
  state.buffer += chunk;
  let visible = "";

  while (state.buffer.length) {
    if (!state.inMeta) {
      const openIndex = state.buffer.indexOf(SUPERVISION_META_OPEN);
      if (openIndex === -1) {
        const keep = longestTagPrefixSuffix(state.buffer, SUPERVISION_META_OPEN);
        visible += state.buffer.slice(0, state.buffer.length - keep);
        state.buffer = state.buffer.slice(state.buffer.length - keep);
        break;
      }
      visible += state.buffer.slice(0, openIndex);
      state.buffer = state.buffer.slice(openIndex);
      state.inMeta = true;
      continue;
    }

    const closeIndex = state.buffer.indexOf(SUPERVISION_META_CLOSE);
    if (closeIndex === -1) break;
    state.metaText += state.buffer.slice(0, closeIndex + SUPERVISION_META_CLOSE.length);
    state.buffer = state.buffer.slice(closeIndex + SUPERVISION_META_CLOSE.length);
    state.inMeta = false;
  }

  return visible;
}

export function flushSupervisionStream(state: SupervisionStreamState): string {
  const tail = state.buffer;
  state.buffer = "";
  return tail;
}

/* ==================== meta 解析 ==================== */

function asString(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return fallback;
}

function asCount(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

const META_BLOCK_PATTERN = /<supervisionMeta(?:\s[^>]*)?>([\s\S]*?)<\/supervisionMeta>/;

export function stripSupervisionMeta(text: string): string {
  return String(text ?? "").replace(/<supervisionMeta(?:\s[^>]*)?>[\s\S]*?<\/supervisionMeta>/g, "").trim();
}

/** 解析监制报告末尾的 <supervisionMeta> JSON（容错：格式错误返回 undefined） */
export function parseStoryboardSupervisionMeta(text: string): SupervisionRoundRecord | undefined {
  const match = String(text ?? "").match(META_BLOCK_PATTERN);
  if (!match) return undefined;

  const payloadText = match[1]
    .replace(/^```[a-zA-Z]*\s*/, "")
    .replace(/\s*```$/, "")
    .trim();
  let payload: unknown;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    return undefined;
  }
  if (!payload || typeof payload !== "object") return undefined;

  const raw = payload as Record<string, unknown>;
  const issueEntries = Array.isArray(raw.issues) ? raw.issues : [];
  const issues: SupervisionIssueRecord[] = issueEntries.slice(0, 50).map((item, index) => {
    const entry = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    return {
      id: asString(entry.id, String(index + 1)),
      severity: asString(entry.severity, "一般"),
      category: asString(entry.category, asString(entry.item)),
      location: asString(entry.location),
      problem: asString(entry.problem),
      suggestion: asString(entry.suggestion),
      source: asString(entry.source, "unknown"),
    };
  });

  const closedEntries = Array.isArray(raw.closedFromPrevious) ? raw.closedFromPrevious : [];
  const closedCount =
    closedEntries.length > 0
      ? closedEntries.filter((item) => {
          const entry = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
          return asString(entry.status).toLowerCase() === "fixed";
        }).length
      : asCount(raw.closedCount);

  const blockingCount = asCount(raw.blockingCount);
  return {
    at: Date.now(),
    scope: asString(raw.scope, "分镜表"),
    rating: asString(raw.rating, "-"),
    blockingCount,
    mediumCount: asCount(raw.mediumCount),
    lightCount: asCount(raw.lightCount),
    newBlockingCount: asCount(raw.newBlockingCount),
    closedCount,
    passed: typeof raw.passed === "boolean" ? raw.passed : blockingCount === 0,
    issues,
  };
}

/* ==================== 历史读写 ==================== */

async function readProductionFlowData(projectId: number, scriptId: number): Promise<Record<string, unknown>> {
  const { default: u } = await import("@/utils");
  const row = await u
    .db("o_agentWorkData")
    .where({ projectId, episodesId: scriptId, key: "productionFlowData" })
    .first();
  try {
    const parsed = JSON.parse(String(row?.data ?? "{}"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function readStoryboardSupervisionHistory(
  projectIdValue: number,
  scriptIdValue: number,
): Promise<SupervisionRoundRecord[]> {
  const projectId = Number(projectIdValue);
  const scriptId = Number(scriptIdValue);
  if (!Number.isSafeInteger(projectId) || projectId <= 0 || !Number.isSafeInteger(scriptId) || scriptId <= 0) {
    return [];
  }
  const data = await readProductionFlowData(projectId, scriptId);
  const history = Array.isArray(data.supervisionHistory) ? data.supervisionHistory : [];
  return history.filter((item): item is SupervisionRoundRecord => Boolean(item) && typeof item === "object");
}

/** 追加一轮审核记录到 productionFlowData.supervisionHistory（保留其他工作区字段） */
export async function appendStoryboardSupervisionRound(
  projectIdValue: number,
  scriptIdValue: number,
  record: SupervisionRoundRecord,
): Promise<void> {
  const projectId = Number(projectIdValue);
  const scriptId = Number(scriptIdValue);
  if (!Number.isSafeInteger(projectId) || projectId <= 0 || !Number.isSafeInteger(scriptId) || scriptId <= 0) return;
  const { default: u } = await import("@/utils");
  const now = Date.now();

  await u.db.transaction(async (trx: any) => {
    const workData = await trx("o_agentWorkData")
      .where({ projectId, episodesId: scriptId, key: "productionFlowData" })
      .first();
    let current: Record<string, unknown> = {};
    try {
      current = JSON.parse(String(workData?.data ?? "{}"));
    } catch {
      current = {};
    }
    const history = Array.isArray(current.supervisionHistory) ? current.supervisionHistory : [];
    const next = {
      ...current,
      supervisionHistory: [...history, record].slice(-SUPERVISION_HISTORY_LIMIT),
    };
    if (workData) {
      await trx("o_agentWorkData")
        .where({ id: workData.id, projectId, episodesId: scriptId })
        .update({ data: JSON.stringify(next), updateTime: now });
      return;
    }
    await trx("o_agentWorkData").insert({
      projectId,
      episodesId: scriptId,
      key: "productionFlowData",
      data: JSON.stringify(next),
      createTime: now,
      updateTime: now,
    });
  });
}

export function computeConvergence(history: SupervisionRoundRecord[]): { cleanRounds: number } {
  let cleanRounds = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const round = history[index];
    if (round.blockingCount === 0 && round.newBlockingCount === 0) {
      cleanRounds += 1;
      continue;
    }
    break;
  }
  return { cleanRounds };
}

/* ==================== 注入构建 ==================== */

/** 审核派发前宿主强制注入：确定性检查结论 + 上一轮问题清单 + 本轮判定要求 */
export function buildStoryboardSupervisionInjection(
  checkMarkdown: string,
  history: SupervisionRoundRecord[],
): string {
  const sections: string[] = [checkMarkdown.trim()];

  sections.push("### 上一轮审核清单（本轮必须逐项复验，先给出关闭状态）");
  if (history.length) {
    const lastRound = history[history.length - 1];
    const { cleanRounds } = computeConvergence(history);
    sections.push(
      `- 上轮范围：${lastRound.scope}；评级：${lastRound.rating}；严重 ${lastRound.blockingCount}、中等 ${lastRound.mediumCount}、轻微 ${lastRound.lightCount}；新增严重 ${lastRound.newBlockingCount}；已关闭 ${lastRound.closedCount}`,
    );
    if (lastRound.issues.length) {
      for (const issue of lastRound.issues.slice(0, 20)) {
        sections.push(
          `- [${issue.id}] ${issue.severity}｜${issue.category}｜${issue.location}｜${issue.problem}｜建议：${issue.suggestion}｜来源：${issue.source}`,
        );
      }
    } else {
      sections.push("- （上轮未记录问题明细）");
    }
    sections.push(`- 连续无新增严重问题轮数：${cleanRounds}`);
  } else {
    sections.push("- 本轮为该剧集首次审核，无历史清单。");
  }

  sections.push("### 本轮判定要求");
  sections.push("- 报告必须包含「确定性检查」「上轮问题关闭状态」「净变化」三节；确定性检查结论原样引用，不得改写；");
  sections.push("- 审核维度中属机器校验的项（片段时长档位、台词镜时长、无台词镜上限、禁词、资产 ID、格式）已由工具给出结论：工具判定通过项不得再列为问题；工具阻塞项原样引用，不得反向判定；");
  sections.push("- 严重问题 = 0 即通过（放行进入下一阶段）；骑线/提示项只记录、不阻塞，不得因中/轻微问题要求返工；");
  sections.push(
    "- 骑线项（含字时比、片段档位贴边）不得作为返工理由，禁止用删台词、压语速、超段数消化时长——这三条是被明确禁止的\"假修复\"；",
  );
  sections.push(
    "- 容量不够时的正确顺序：① 按报告「拆集建议」拆集（台词逐字保留，与骨架/剧本层同一口径）；② 压缩动作镜/合并片段；③ 报请用户授权删减台词或登记时长豁免；",
  );
  sections.push("- 修复版本复审时：先逐项给出上一轮问题的关闭状态（已修复/未修复/部分修复），再报告新增问题；新增严重问题必须标注来源（上轮漏检 / 本轮修改引入 / 真实新缺陷）；");
  sections.push("- 「需要您决定」区块仅用于需要创作决策的问题（台词取舍、情节取舍等）；机器可自动修复的确定性项不要作为选项抛给用户；");
  sections.push(
    "- 报告出现《拆集建议》时，必须进「需要您决定」并列选项：A 拆集（台词逐字保留，回剧本/骨架同步份额后重出分镜）/ B 维持骑线继续（记录例外，不阻塞）/ C 报请用户授权删减台词（登记豁免）；不得只写在中等/提示问题里带过；",
  );
  sections.push(`- 报告末尾必须输出 <${SUPERVISION_META_TAG}> JSON 块（宿主解析用，不会展示给用户），字段：scope/rating/blockingCount/mediumCount/lightCount/newBlockingCount/closedFromPrevious/issues[{id,severity,category,location,problem,suggestion,source}]。`);

  return `\n\n【宿主预注入：确定性检查与审核历史】\n${sections.join("\n")}`;
}

/** 审核结果对决策层的宿主判定行（附在报告正文之后） */
export function buildSupervisionVerdict(
  record: SupervisionRoundRecord | undefined,
  machineBlockingCount: number,
): string {
  if (!record) {
    return machineBlockingCount === 0
      ? "【宿主判定】本轮未返回结构化审核结论；机器校验 0 阻塞。请人工核对报告后决定是否继续。"
      : `【宿主判定】本轮未返回结构化审核结论；机器校验仍有 ${machineBlockingCount} 项阻塞，按未通过处理，需修复后复审。`;
  }
  const blocking = Math.max(record.blockingCount, machineBlockingCount);
  if (blocking === 0) {
    return "【宿主判定】本轮严重问题 0 项 → 审核通过：可进入下一阶段；中/轻微问题仅记录，不阻塞。";
  }
  return `【宿主判定】本轮仍有 ${blocking} 项严重问题 → 未通过：只需修复严重问题（其余不阻塞），修复完成后自动复审。`;
}

/* ==================== 定点修复范围推导 ==================== */

/**
 * 从上轮审核的严重问题位置推导修复授权范围（场级）。
 * 返回 null 表示"无法推导"（无历史 / 无严重问题 / 场号无法映射）——此时走无守卫全量流程。
 */
export function buildRepairScopesFromHistory(
  history: SupervisionRoundRecord[],
  parsedOld: ParsedStoryboardTable,
): RepairScope[] | null {
  const lastRound = history[history.length - 1];
  if (!lastRound) return null;
  const severeIssues = lastRound.issues.filter(
    (issue) => issue.severity.includes("严重") || issue.severity.toLowerCase().includes("blocking"),
  );
  if (!severeIssues.length) return null;

  const sceneNos = new Set<number>();
  for (const issue of severeIssues) {
    const match = issue.location.match(/场\s*(\d+)/);
    if (match) sceneNos.add(Number(match[1]));
  }
  if (!sceneNos.size) return null;

  const sceneOrders: number[] = [];
  for (const sceneNo of sceneNos) {
    const scene = parsedOld.scenes.find((item) => item.sceneNo === sceneNo);
    if (scene && !sceneOrders.includes(scene.index)) sceneOrders.push(scene.index);
  }
  if (!sceneOrders.length) return null;

  return sceneOrders.sort((a, b) => a - b).map((sceneOrder) => ({ sceneOrder }));
}

/** 把机器校验阻塞项所在场并入授权范围（保证自动修复能覆盖新暴露的阻塞场） */
export function extendRepairScopes(
  baseScopes: RepairScope[],
  parsedTable: ParsedStoryboardTable,
  sceneNos: number[],
): RepairScope[] {
  const extended = [...baseScopes];
  for (const sceneNo of sceneNos) {
    const scene = parsedTable.scenes.find((item) => item.sceneNo === sceneNo);
    if (!scene) continue;
    if (!extended.some((scope) => scope.sceneOrder === scene.index)) {
      extended.push({ sceneOrder: scene.index });
    }
  }
  return extended.sort((a, b) => a.sceneOrder - b.sceneOrder);
}
