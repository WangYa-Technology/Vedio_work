import { Socket } from "socket.io";
import { tool } from "ai";
import type { ModelMessage } from "ai";
import { z } from "zod";
import u from "@/utils";
import Memory from "@/utils/agent/memory";
import useTools from "@/agents/scriptAgent/tools";
import ResTool from "@/socket/resTool";
import * as fs from "fs";
import path from "path";
import { CONTENT_SAFETY_SETTING_KEY, DEFAULT_CONTENT_SAFETY_CONSTRAINT } from "@/constants/contentSafety";
import { reportToMarkdown, runScriptChecks } from "@/agents/scriptAgent/scriptChecks";
import { runSkeletonChecks, skeletonReportToMarkdown } from "@/agents/scriptAgent/skeletonChecks";
import {
  buildContinuationMessages,
  getLastXmlElement,
  isArtifactTruncated,
  pickContinuationContext,
  spliceContinuation,
} from "@/agents/scriptAgent/artifactContinuation";
import {
  formatEpisodeRange,
  loadScriptAgentProgress,
  resolveTargetEpisodes,
  resolveTargetEpisodesOnSave,
  type ScriptAgentProgress,
} from "@/agents/scriptAgent/progress";

export interface AgentContext {
  socket: Socket;
  isolationKey: string;
  text: string;
  userMessageTime?: number;
  abortSignal?: AbortSignal;
  resTool: ResTool;
  msg: ReturnType<ResTool["newMessage"]>;
}

const SUB_AGENT_MAX_ATTEMPTS = 3;
// 超长产出（故事骨架/剧本）撞上单次输出上限时的续写段数上限与产出体积上限：
// 续写把一次超长输出拆成多段连续输出后拼接，避免整段重生成反复被同一个上限截断。
const SUB_AGENT_MAX_CONTINUATIONS = 6;
const SUB_AGENT_MAX_ARTIFACT_CHARS = 60000;
const TRANSIENT_AI_ERROR =
  /(?:upstream_error|temporarily unavailable|service unavailable|overloaded|rate.?limit|too many requests|timeout|timed out|econnreset|etimedout|econnaborted|eai_again|socket hang up|fetch failed|other side closed|network error|connection (?:closed|reset|error)|\b(?:429|502|503|504)\b)/i;

function collectErrorText(error: unknown, depth = 0): string {
  if (depth > 3 || error == null) return "";
  if (typeof error === "string") return error;
  if (typeof error !== "object") return String(error);

  const value = error as Record<string, unknown>;
  const directValues = ["name", "message", "type", "code", "status", "statusCode", "responseBody"]
    .map((key) => value[key])
    .filter((item): item is string | number => typeof item === "string" || typeof item === "number")
    .map(String);
  const nestedValues = [value.cause, value.lastError, ...(Array.isArray(value.errors) ? value.errors : [])]
    .map((item) => collectErrorText(item, depth + 1))
    .filter(Boolean);
  return [...directValues, ...nestedValues].join(" ");
}

export function isTransientAiError(error: unknown): boolean {
  return TRANSIENT_AI_ERROR.test(collectErrorText(error));
}

function createAbortError() {
  const error = new Error("生成已停止");
  error.name = "AbortError";
  return error;
}

async function waitBeforeRetry(delayMs: number, signal?: AbortSignal) {
  if (signal?.aborted) throw createAbortError();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(createAbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function getWorkflowLabel(stage?: string) {
  switch (stage) {
    case "storySkeleton":
      return "正在生成故事骨架";
    case "adaptationStrategy":
      return "正在制定改编策略";
    case "script":
      return "正在编写剧本";
    case "supervision":
      return "正在审核当前产出";
    default:
      return "正在分析项目并规划下一步";
  }
}

function hasToolResults(messages: ModelMessage[]) {
  return messages.some((message) => message.role === "tool");
}

function buildMemPrompt(mem: Awaited<ReturnType<Memory["get"]>>): string {
  let memoryContext = "";
  if (mem.rag.length) {
    memoryContext += `[相关记忆]\n${mem.rag.map((r) => r.content).join("\n")}`;
  }
  if (mem.summaries.length) {
    if (memoryContext) memoryContext += "\n\n";
    memoryContext += `[历史摘要]\n${mem.summaries.map((s, i) => `${i + 1}. ${s.content}`).join("\n")}`;
  }
  if (mem.shortTerm.length) {
    if (memoryContext) memoryContext += "\n\n";
    memoryContext += `[近期对话]\n${mem.shortTerm.map((m) => `${m.role}: ${m.content}`).join("\n")}`;
  }
  return `## Memory\n以下是你对用户的记忆，可作为参考但不要主动提及：\n${memoryContext}`;
}

async function getContentSafetyConstraint(): Promise<string> {
  const setting = await u.db("o_setting").where("key", CONTENT_SAFETY_SETTING_KEY).first();
  return String(setting?.value ?? DEFAULT_CONTENT_SAFETY_CONSTRAINT).trim();
}

function withContentSafetyConstraint(systemPrompt: string, constraint: string): string {
  if (!constraint) return systemPrompt;
  return `${systemPrompt}\n\n## 内容安全约束（用户设置）\n${constraint}`;
}

async function getWorkflowContext(projectIdValue: unknown) {
  const projectId = Number(projectIdValue);
  if (!Number.isSafeInteger(projectId) || projectId <= 0) return "当前工作流状态未知。";

  const workData = await u.db("o_agentWorkData").where({ projectId, key: "scriptAgent" }).first();
  const scripts = await u.db("o_script").where({ projectId }).select("id", "name");
  let planData: Record<string, unknown> = {};
  try {
    planData = JSON.parse(workData?.data ?? "{}");
  } catch {
    planData = {};
  }

  const hasSkeleton = typeof planData.storySkeleton === "string" && planData.storySkeleton.trim().length > 0;
  const hasStrategy = typeof planData.adaptationStrategy === "string" && planData.adaptationStrategy.trim().length > 0;
  const globalContext = planData.projectGlobalContext as Record<string, { content?: unknown }> | undefined;
  const configuredGlobalMaterials = ["plot", "character", "world"].filter(
    (key) => typeof globalContext?.[key]?.content === "string" && String(globalContext[key].content).trim().length > 0,
  );
  // 目标集数走确定性解析（已存字段 → 骨架分集解析 → 文本正则回退），避免模型措辞变化导致分母丢失
  const targetEpisodeCount = resolveTargetEpisodes(planData);
  const remainingEpisodes = targetEpisodeCount === undefined ? undefined : Math.max(targetEpisodeCount - scripts.length, 0);
  const suggestedNext = !hasSkeleton
    ? "先生成故事骨架"
    : !hasStrategy
      ? "直接制定改编策略，不重复询问已确认项目参数"
        : scripts.length === 0
          ? targetEpisodeCount === undefined
          ? "进入剧本编写；根据原著事件密度和目标时长智能推算目标集数与本次生成批次，单次最多5集，不逐项询问用户配置"
          : `进入剧本编写；已确认目标${targetEpisodeCount}集，本次直接生成${Math.min(targetEpisodeCount, 5)}集，不再询问集数`
        : remainingEpisodes === undefined
          ? "剧本已存在，汇报已生成集数并引导用户继续生成后续剧本或进入制作流程"
          : remainingEpisodes > 0
            ? `已生成${scripts.length}集，继续生成剩余${remainingEpisodes}集；不再询问已确认集数`
            : "全部目标剧本已生成，直接引导进入制作流程";

  return [
    "## 宿主工作流快照（可信）",
    `故事骨架：${hasSkeleton ? "已保存" : "未生成"}`,
    `改编策略：${hasStrategy ? "已保存" : "未生成"}`,
    `目标集数：${targetEpisodeCount === undefined ? "未从已保存配置中识别" : `${targetEpisodeCount}集`}`,
    `项目全局资料：${configuredGlobalMaterials.length ? `已配置${configuredGlobalMaterials.length}/3类` : "未配置"}`,
    `已生成剧本：${scripts.length}集${scripts.length ? `（${scripts.map((item) => item.name).join("、")}）` : ""}`,
    `建议下一步：${suggestedNext}`,
    "当用户说“继续”“已经有了”“确认”或表达同意时，必须基于此快照推进，不得重新询问已保存阶段或已确认参数。",
  ].join("\n");
}

type RequiredArtifact = "storySkeleton" | "adaptationStrategy" | "scriptItem";

type ArtifactPayload =
  | { type: "storySkeleton"; content: string }
  | { type: "adaptationStrategy"; content: string }
  | { type: "scriptItem"; name: string; content: string };

function getArtifactLabel(requiredArtifact: RequiredArtifact) {
  if (requiredArtifact === "storySkeleton") return "故事骨架";
  if (requiredArtifact === "adaptationStrategy") return "改编策略";
  return "剧本";
}

/** 产出校验失败时的报错：区分"被输出上限截断"与"格式不合规"，前者要提示换模型/降集数 */
function buildArtifactError(text: string, requiredArtifact: RequiredArtifact) {
  const label = getArtifactLabel(requiredArtifact);
  if (isArtifactTruncated(text, requiredArtifact)) {
    return new Error(
      `${label}输出超长且未闭合（已生成 ${text.length} 字，缺少 </${requiredArtifact}>，自动续写仍未完成）：` +
        `通常是被模型单次输出上限截断，请改用输出上限更大的模型，或降低目标集数后重试`,
    );
  }
  if (requiredArtifact === "scriptItem") return new Error("剧本任务必须输出一个带名称的完整 <scriptItem> 产出物");
  return new Error(`${label}任务未输出完整的 <${requiredArtifact}> 产出物`);
}

function getRequiredArtifact(text: string, requiredArtifact: RequiredArtifact): ArtifactPayload {
  if (requiredArtifact === "storySkeleton" || requiredArtifact === "adaptationStrategy") {
    const element = getLastXmlElement(text, requiredArtifact);
    if (!element?.content) throw buildArtifactError(text, requiredArtifact);
    return { type: requiredArtifact, content: element.content };
  }

  const element = getLastXmlElement(text, "scriptItem");
  const nameMatch = element?.attrs.match(/\bname\s*=\s*(?:"([^"]*)"|'([^']*)')/);
  const name = (nameMatch?.[1] ?? nameMatch?.[2] ?? "").trim();
  if (!element?.content || !name) throw buildArtifactError(text, requiredArtifact);
  return { type: "scriptItem", name, content: element.content };
}

function getArtifactSuccessMessage(artifact: ArtifactPayload) {
  if (artifact.type === "storySkeleton") return `故事骨架已保存到工作区（${artifact.content.length}字）`;
  if (artifact.type === "adaptationStrategy") return `改编策略已保存到工作区（${artifact.content.length}字）`;
  return `剧本《${artifact.name}》已保存到工作区（${artifact.content.length}字）`;
}

async function persistPlanXml(projectIdValue: unknown, artifact: ArtifactPayload) {
  const projectId = Number(projectIdValue);
  if (!Number.isSafeInteger(projectId) || projectId <= 0) throw new Error("无效的项目 ID，无法保存产出物");

  const now = Date.now();
  await u.db.transaction(async (trx) => {
    if (artifact.type === "scriptItem") {
      const existing = await trx("o_script").where({ projectId, name: artifact.name }).first();
      if (existing) {
        await trx("o_script").where({ id: existing.id, projectId }).update({ content: artifact.content });
      } else {
        await trx("o_script").insert({ projectId, name: artifact.name, content: artifact.content, createTime: now });
      }
      return;
    }

    const workData = await trx("o_agentWorkData").where({ projectId, key: "scriptAgent" }).first();
    let currentData: Record<string, unknown> = {};
    try {
      currentData = JSON.parse(workData?.data ?? "{}");
    } catch {
      throw new Error("现有剧本工作区数据格式无效，已阻止覆盖");
    }
    const mergedData = {
      ...currentData,
      storySkeleton: typeof currentData.storySkeleton === "string" ? currentData.storySkeleton : "",
      adaptationStrategy: typeof currentData.adaptationStrategy === "string" ? currentData.adaptationStrategy : "",
      [artifact.type]: artifact.content,
    };
    // 目标集数：保存骨架/策略时确定性解析并落库（供进度展示与工作流快照复用）；
    // 骨架被重写（含量拆集）时以新骨架为准，避免旧 targetEpisodes 卡住新集数——
    // 否则会出现"骨架 20 集 / 项目配置 12 集"，进度、批次调度与监督的集数校验全部对不上。
    const targetEpisodes = resolveTargetEpisodesOnSave({
      artifactType: artifact.type,
      artifactContent: artifact.content,
      workData: mergedData,
    });
    const persistedData = {
      ...mergedData,
      ...(targetEpisodes === undefined ? {} : { targetEpisodes }),
    };

    if (workData) {
      await trx("o_agentWorkData").where({ id: workData.id, projectId, key: "scriptAgent" }).update({
        data: JSON.stringify(persistedData),
        updateTime: now,
      });
    } else {
      await trx("o_agentWorkData").insert({
        projectId,
        key: "scriptAgent",
        data: JSON.stringify(persistedData),
        createTime: now,
        updateTime: now,
      });
    }
  });

  if (artifact.type === "scriptItem") {
    const saved = await u.db("o_script").where({ projectId, name: artifact.name }).select("content").first();
    if (saved?.content !== artifact.content) throw new Error("剧本写入后回读校验失败");
    return;
  }

  const saved = await u.db("o_agentWorkData").where({ projectId, key: "scriptAgent" }).select("data").first();
  let savedData: Record<string, unknown> = {};
  try {
    savedData = JSON.parse(saved?.data ?? "{}");
  } catch {
    throw new Error("工作区写入后回读数据格式无效");
  }
  if (savedData[artifact.type] !== artifact.content) throw new Error("工作区写入后回读校验失败");
}

/* ==================== 审核闭环：轮次记录与确定性检查预注入 ==================== */

const SUPERVISION_HISTORY_LIMIT = 10;
const SUPERVISION_META_TAG = "supervisionMeta";
const SUPERVISION_META_OPEN = "<supervisionMeta";
const SUPERVISION_META_CLOSE = "</supervisionMeta>";

interface SupervisionIssueRecord {
  id: string;
  severity: string;
  item: string;
  location: string;
  problem: string;
  suggestion: string;
  source: string;
}

interface SupervisionRoundRecord {
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

interface SupervisionStreamState {
  buffer: string;
  inMeta: boolean;
  metaText: string;
}

function asString(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return fallback;
}

function asCount(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

async function readScriptAgentWorkData(projectId: number): Promise<Record<string, unknown>> {
  const row = await u.db("o_agentWorkData").where({ projectId, key: "scriptAgent" }).first();
  try {
    const parsed = JSON.parse(String(row?.data ?? "{}"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function readSupervisionHistory(projectIdValue: unknown): Promise<SupervisionRoundRecord[]> {
  const projectId = Number(projectIdValue);
  if (!Number.isSafeInteger(projectId) || projectId <= 0) return [];
  const data = await readScriptAgentWorkData(projectId);
  const history = Array.isArray(data.supervisionHistory) ? data.supervisionHistory : [];
  return history.filter(
    (item): item is SupervisionRoundRecord => Boolean(item) && typeof item === "object",
  );
}

function parseSupervisionMeta(text: string): SupervisionRoundRecord | undefined {
  const element = getLastXmlElement(text, SUPERVISION_META_TAG);
  if (!element?.content) return undefined;

  const payloadText = element.content
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
      item: asString(entry.item),
      location: asString(entry.location),
      problem: asString(entry.problem),
      suggestion: asString(entry.suggestion),
      source: asString(entry.source, "unknown"),
    };
  });

  const closedEntries = Array.isArray(raw.closedFromPrevious) ? raw.closedFromPrevious : [];
  const closedCount = closedEntries.filter((item) => {
    const entry = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    return asString(entry.status).toLowerCase() === "fixed";
  }).length;

  const blockingCount = asCount(raw.blockingCount);
  return {
    at: Date.now(),
    scope: asString(raw.scope, "未标注范围"),
    rating: asString(raw.rating, "-"),
    blockingCount,
    mediumCount: asCount(raw.mediumCount),
    lightCount: asCount(raw.lightCount),
    newBlockingCount: asCount(raw.newBlockingCount),
    closedCount,
    passed: blockingCount === 0,
    issues,
  };
}

function stripSupervisionMeta(text: string): string {
  return text.replace(/<supervisionMeta(?:\s[^>]*)?>[\s\S]*?<\/supervisionMeta>/g, "").trim();
}

async function appendSupervisionRound(projectIdValue: unknown, record: SupervisionRoundRecord): Promise<void> {
  const projectId = Number(projectIdValue);
  if (!Number.isSafeInteger(projectId) || projectId <= 0) return;
  const now = Date.now();

  await u.db.transaction(async (trx) => {
    const workData = await trx("o_agentWorkData").where({ projectId, key: "scriptAgent" }).first();
    let currentData: Record<string, unknown> = {};
    try {
      currentData = JSON.parse(workData?.data ?? "{}");
    } catch {
      currentData = {};
    }
    const history = Array.isArray(currentData.supervisionHistory) ? currentData.supervisionHistory : [];
    // 只 patch supervisionHistory，保留骨架/策略/全局资料等既有字段
    const persistedData = {
      ...currentData,
      supervisionHistory: [...history, record].slice(-SUPERVISION_HISTORY_LIMIT),
    };

    if (workData) {
      await trx("o_agentWorkData").where({ id: workData.id, projectId, key: "scriptAgent" }).update({
        data: JSON.stringify(persistedData),
        updateTime: now,
      });
      return;
    }
    await trx("o_agentWorkData").insert({
      projectId,
      key: "scriptAgent",
      data: JSON.stringify(persistedData),
      createTime: now,
      updateTime: now,
    });
  });
}

function computeConvergence(history: SupervisionRoundRecord[]): { cleanRounds: number } {
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

/** 连续存在阻塞问题的审核轮数（用于"最多 2 轮自动修复复审"上限判定） */
function countConsecutiveBlockedRounds(history: SupervisionRoundRecord[]): number {
  let blocked = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index].blockingCount > 0) {
      blocked += 1;
      continue;
    }
    break;
  }
  return blocked;
}

/** 从最近一轮审核问题中提取涉及的集号（EP03 / 第3集），用于剧本定点修复范围 */
export function resolveScriptRepairEpisodeKeys(history: SupervisionRoundRecord[]): string[] {
  const last = history[history.length - 1];
  if (!last) return [];
  const keys = new Set<string>();
  for (const issue of last.issues) {
    const text = `${issue.location} ${issue.problem}`;
    let match: RegExpExecArray | null;
    const epPattern = /EP\s*(\d{1,3})/gi;
    while ((match = epPattern.exec(text)) !== null) {
      keys.add(`EP${String(Number(match[1])).padStart(2, "0")}`);
    }
    const cnPattern = /第\s*(\d{1,3})\s*集/g;
    while ((match = cnPattern.exec(text)) !== null) {
      keys.add(`EP${String(Number(match[1])).padStart(2, "0")}`);
    }
  }
  return [...keys];
}

/** 集名是否落在授权集号范围内（keys 为空 = 不限制具体集，仅要求为既有集） */
function episodeNameMatchesKeys(name: string, keys: string[]): boolean {
  if (!keys.length) return true;
  const upper = String(name ?? "").toUpperCase();
  return keys.some((key) => upper.includes(key.toUpperCase()));
}

/** 定点修复保存守卫：越界集/新增集一律拒绝写入 */
async function assertScriptRepairScope(
  projectIdValue: unknown,
  artifactName: string,
  scope: { episodeKeys: string[] },
): Promise<void> {
  const projectId = Number(projectIdValue);
  const name = String(artifactName ?? "").trim();
  if (!Number.isSafeInteger(projectId) || projectId <= 0) return;
  const existingRows = (await u.db("o_script").where({ projectId }).select("name")) as { name: string | null }[];
  const existingNames = existingRows.map((row) => String(row.name ?? ""));
  if (!existingNames.includes(name)) {
    throw new Error(`定点修复不得新增集：「${name}」不是既有集；如需新增或重做请走构建流程`);
  }
  if (!episodeNameMatchesKeys(name, scope.episodeKeys)) {
    throw new Error(
      `定点修复只允许修改：${scope.episodeKeys.join("、")}；本次产出为「${name}」，已拒绝保存以免波及范围外集数`,
    );
  }
}

function buildSupervisionInjection(checkMarkdown: string, history: SupervisionRoundRecord[]): string {
  const sections: string[] = [checkMarkdown.trim()];

  sections.push("### 上一轮审核清单（本轮必须逐项复验，先给出关闭状态）");
  if (history.length) {
    const lastRound = history[history.length - 1];
    const { cleanRounds } = computeConvergence(history);
    sections.push(
      `- 上轮范围：${lastRound.scope}；评级：${lastRound.rating}；阻塞 ${lastRound.blockingCount}、一般 ${lastRound.mediumCount}、轻微 ${lastRound.lightCount}；新增阻塞 ${lastRound.newBlockingCount}；已关闭 ${lastRound.closedCount}`,
    );
    if (lastRound.issues.length) {
      for (const issue of lastRound.issues.slice(0, 20)) {
        sections.push(
          `- [${issue.id}] ${issue.severity}｜${issue.item}｜${issue.location}｜${issue.problem}｜建议：${issue.suggestion}｜来源：${issue.source}`,
        );
      }
    } else {
      sections.push("- （上轮未记录问题明细）");
    }
    sections.push(`- 连续无新增阻塞轮数：${cleanRounds}`);
    const consecutiveBlocked = countConsecutiveBlockedRounds(history);
    if (consecutiveBlocked >= 2) {
      sections.push(
        "- 宿主提示：已连续 2 轮存在阻塞，达「最多 2 轮自动修复复审」上限；本轮如仍不通过，只输出未闭环项、所需作者设定与唯一阻塞点，等待用户补充设定或选择重写范围，不得继续自动重试。",
      );
    }
  } else {
    sections.push("- 本轮为本项目首次审核，无历史清单。");
  }

  sections.push("### 本轮判定要求");
  sections.push("- 报告必须包含「确定性检查」「上轮问题关闭状态」「净变化」三节；确定性检查结论原样引用，不得改写；");
  sections.push("- 工具判定的红线命中、时长整体越界、台词改写按阻塞问题计；工具判定通过项不得再列为问题；");
  sections.push("- 骨架容量体检结论为事实层必须原样引用；其中「严重超载」的阻塞判定按监督层技能规定的阶段口径执行；");
  sections.push("- 阻塞问题 = 0 即通过；若本轮阻塞为 0 且新增阻塞为 0（连续两轮无新增阻塞），直接判通过（不低于 B），不再因新增一般/提示问题降级；");
  sections.push(
    `- 报告末尾必须输出 <${SUPERVISION_META_TAG}> JSON 块（宿主解析用，不会展示给用户），字段见监督层技能说明。`,
  );

  return `\n\n【宿主预注入：确定性检查与审核历史】\n${sections.join("\n")}`;
}

/**
 * 骨架保存后的容量体检：把体检报告追加到保存确认消息，供决策层据此分流。
 * 骨架缺失/未识别到分集时静默跳过；体检异常仅追加失败提示，不阻断保存结果。
 */
async function appendSkeletonCapacityReport(projectIdValue: unknown, message: string): Promise<string> {
  try {
    const report = await runSkeletonChecks(Number(projectIdValue));
    if (!report.estimates.length) return message;
    return `${message}\n\n${skeletonReportToMarkdown(report)}`;
  } catch (err) {
    return `${message}\n\n（骨架容量体检执行失败：${u.error(err).message}；请在审核阶段补充核对单集容量）`;
  }
}

function longestTagPrefixSuffix(buffer: string, tag: string): number {
  const max = Math.min(buffer.length, tag.length - 1);
  for (let length = max; length > 0; length -= 1) {
    if (tag.startsWith(buffer.slice(buffer.length - length))) return length;
  }
  return 0;
}

function createSupervisionStreamState(): SupervisionStreamState {
  return { buffer: "", inMeta: false, metaText: "" };
}

/** 流式拦截 <supervisionMeta> 块：该块只用于持久化，不推送给前端 */
function consumeSupervisionStream(chunk: string, state: SupervisionStreamState): string {
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

function flushSupervisionStream(state: SupervisionStreamState): string {
  const tail = state.buffer;
  state.buffer = "";
  return tail;
}

export async function decisionAI(ctx: AgentContext) {
  const { isolationKey, text, userMessageTime, abortSignal, resTool } = ctx;

  const memory = new Memory("scriptAgent", isolationKey);
  await memory.add("user", text, { createTime: userMessageTime });

  const skill = path.join(u.getPath("skills"), "script_agent_decision.md");
  const prompt = await fs.promises.readFile(skill, "utf-8");
  const contentSafetyConstraint = await getContentSafetyConstraint();

  const mem = buildMemPrompt(await memory.get(text));

  const projectData = await u.db("o_project").where("id", resTool.data.projectId).first();

  const novelData = await u.db("o_novel").where("projectId", resTool.data.projectId).select("chapterIndex");

  const projectInfo = [
    "## 项目信息",
    `小说名称：${projectData?.name ?? "未知"}`,
    `小说类型：${projectData?.type ?? "未知"}`,
    `小说简介：${projectData?.intro ?? "无"}`,
    `目标改编影视视觉手册|画风：${projectData?.artStyle ?? "无"}`,
    `目标改编视频画幅：${projectData?.videoRatio ?? "16:9"}`,
    `章节数量：${novelData.length}章`,
  ].join("\n");
  const workflowContext = await getWorkflowContext(resTool.data.projectId);

  const { textStream } = await u.Ai.Text("scriptAgent:decisionAgent").stream({
    messages: [
      { role: "system", content: withContentSafetyConstraint(prompt, contentSafetyConstraint) },
      { role: "assistant", content: projectInfo + "\n\n" + workflowContext + "\n\n" + mem },
      { role: "user", content: text },
    ],
    abortSignal,
    tools: {
      ...memory.getTools(),
      ...useTools({ resTool: ctx.resTool, msg: ctx.msg }),
      ...createSubAgent(ctx, contentSafetyConstraint),
    },
    onFinish: async (completion) => {
      await memory.add("assistant:decision", removeAllXmlTags(completion.text));
    },
  });

  return textStream;
}

function createSubAgent(parentCtx: AgentContext, contentSafetyConstraint: string) {
  const { resTool, abortSignal } = parentCtx;
  const memory = new Memory("scriptAgent", parentCtx.isolationKey);
  let supervisionStarted = false;
  let supervisionCompleted = false;

  async function runAgent({
    modelKey,
    prompt,
    system,
    name,
    memoryKey,
    requiredArtifact,
    isSupervision,
    workflowStage,
    tools: extraTools,
    messages,
    repairScope,
  }: {
    modelKey: `scriptAgent:${string}`;
    prompt: string;
    system: string;
    name: string;
    memoryKey: string;
    requiredArtifact?: RequiredArtifact;
    isSupervision?: boolean;
    workflowStage?: "storySkeleton" | "adaptationStrategy" | "script" | "supervision";
    tools?: Record<string, any>;
    messages?: ModelMessage[];
    /** 剧本定点修复守卫：仅允许修改指定集（episodeKeys 为空 = 仅允许既有集，不得新增） */
    repairScope?: { episodeKeys: string[] } | null;
  }) {
    if (supervisionStarted || supervisionCompleted) {
      return "审核已开始或完成。本轮必须立即停止并等待用户下一条消息，不能继续执行或再次审核。";
    }
    if (isSupervision) supervisionStarted = true;
    resTool.workflowStatus("working", getWorkflowLabel(workflowStage), workflowStage);
    parentCtx.msg.complete();
    const subMsg = resTool.newMessage("assistant", name);
    const text = subMsg.text();
    const subAgentSystem = withContentSafetyConstraint(system, contentSafetyConstraint);
    const subAgentTools = { ...extraTools, ...useTools({ resTool, msg: subMsg }) };
    let fullResponse = "";
    let attemptMessages: ModelMessage[] = messages ?? [{ role: "user", content: prompt }];

    /**
     * 超长产出被单次输出上限截断（有开标签、无闭合标签）时，引导模型从中断处续写并拼接，直到闭合。
     * 每次请求只回带「已生成全文 + 续写指令」，输入随段落线性增长，不会重复堆叠。
     */
    async function continueTruncatedArtifact(params: {
      requiredArtifact: RequiredArtifact;
      workflowStage?: "storySkeleton" | "adaptationStrategy" | "script" | "supervision";
      baseMessages: ModelMessage[];
      initialText: string;
      appendVisible: (chunk: string) => void;
    }): Promise<string> {
      const label = getArtifactLabel(params.requiredArtifact);
      let current = params.initialText;

      for (let round = 1; round <= SUB_AGENT_MAX_CONTINUATIONS; round += 1) {
        if (abortSignal?.aborted) break;
        if (!isArtifactTruncated(current, params.requiredArtifact)) break;
        if (current.length >= SUB_AGENT_MAX_ARTIFACT_CHARS) {
          console.warn(`[scriptAgent] ${modelKey} ${label}产出已达 ${current.length} 字上限，停止续写`);
          break;
        }

        console.warn(
          `[scriptAgent] ${modelKey} ${label}产出被输出上限截断（已生成 ${current.length} 字），准备第 ${round}/${SUB_AGENT_MAX_CONTINUATIONS} 段续写`,
        );
        const progressState = subMsg.thinking(`输出较长，正在续写${label}第 ${round} 段...`);
        progressState.appendText(`已生成 ${current.length} 字，缺少闭合标签，正在从中断处继续输出`);
        progressState.complete();
        resTool.workflowStatus(
          "working",
          `${getWorkflowLabel(params.workflowStage)}（已生成 ${current.length} 字，续写第 ${round} 段）`,
          params.workflowStage,
        );

        let chunk = "";
        let continuationMessages: ModelMessage[] = [];
        try {
          const streamResult = await u.Ai.Text(modelKey).stream({
            system: subAgentSystem,
            messages: buildContinuationMessages(params.baseMessages, current, params.requiredArtifact),
            abortSignal,
            tools: subAgentTools,
          });
          for await (const piece of streamResult.textStream) {
            await new Promise<void>((resolve) => setTimeout(() => resolve(), 1));
            chunk += piece;
          }
          continuationMessages = (await streamResult.response).messages as ModelMessage[];
        } catch (err: any) {
          if (err?.name === "AbortError" || abortSignal?.aborted) throw err;
          console.warn(`[scriptAgent] ${modelKey} ${label}续写失败:`, u.error(err).message);
          break;
        }

        const { text: merged, appended } = spliceContinuation(current, chunk);
        if (appended.trim().length < 20) {
          // 模型改去补读资料：带上工具结果再续一轮；真正没有有效新增（例如从头重写）时才停止
          if (hasToolResults(continuationMessages)) {
            params.baseMessages = [...params.baseMessages, ...pickContinuationContext(continuationMessages)];
            console.warn(`[scriptAgent] ${modelKey} ${label}续写前补读了资料，带入工具结果后继续续写`);
            continue;
          }
          console.warn(`[scriptAgent] ${modelKey} ${label}续写未产生有效新增内容，停止续写`);
          break;
        }
        // 只把实际新增部分推给前端，保证前端预览与宿主拼接结果一致
        params.appendVisible(appended);
        current = merged;
        console.log(`[scriptAgent] ${modelKey} ${label}续写第 ${round} 段新增 ${appended.length} 字，累计 ${current.length} 字`);
      }

      return current;
    }

    for (let attempt = 1; attempt <= SUB_AGENT_MAX_ATTEMPTS; attempt++) {
      let attemptResponse = "";
      const supervisionStream = isSupervision ? createSupervisionStreamState() : undefined;
      try {
        const streamResult = await u.Ai.Text(modelKey).stream({
          system: subAgentSystem,
          messages: attemptMessages,
          abortSignal,
          tools: subAgentTools,
        });

        for await (const chunk of streamResult.textStream) {
          await new Promise<void>((resolve) => setTimeout(() => resolve(), 1));
          attemptResponse += chunk;
          if (supervisionStream) {
            const visible = consumeSupervisionStream(chunk, supervisionStream);
            if (visible) text.append(visible);
          } else {
            text.append(chunk);
          }
        }
        if (supervisionStream) {
          const tail = flushSupervisionStream(supervisionStream);
          if (tail) text.append(tail);
        }
        const responseMessages = (await streamResult.response).messages as ModelMessage[];
        if (!attemptResponse.trim()) {
          const toolsCompleted = hasToolResults(responseMessages);
          if (attempt === SUB_AGENT_MAX_ATTEMPTS) {
            throw new Error(toolsCompleted ? "资料读取完成，但模型未输出最终内容" : "模型未输出最终内容");
          }

          console.warn(
            `[scriptAgent] ${modelKey} ${toolsCompleted ? "工具调用后未输出正文" : "返回空内容"}，准备第 ${attempt + 1}/${SUB_AGENT_MAX_ATTEMPTS} 次尝试`,
          );
          const retryState = subMsg.thinking(toolsCompleted ? "资料已读取，正在补充最终结果..." : "模型未输出内容，正在重新生成...");
          retryState.appendText(`第 ${attempt + 1}/${SUB_AGENT_MAX_ATTEMPTS} 次尝试`);
          retryState.complete();
          resTool.workflowStatus(
            "retrying",
            `${getWorkflowLabel(workflowStage)}，${toolsCompleted ? "正在补充最终结果" : "正在重新生成空缺内容"}（${attempt + 1}/${SUB_AGENT_MAX_ATTEMPTS}）`,
            workflowStage,
          );
          attemptMessages = [
            ...attemptMessages,
            ...(toolsCompleted ? responseMessages : []),
            {
              role: "user",
              content: toolsCompleted
                ? "资料读取已完成。请直接基于以上工具结果输出最终结果，不要重复调用读取工具。"
                : "上一轮没有输出正文。请立即完成任务并输出最终结果，不要留空。",
            },
          ];
          await waitBeforeRetry(300 * attempt, abortSignal);
          continue;
        }
        if (requiredArtifact) {
          // 长产出（分集表 + 关键集展开等）容易撞上模型单次输出上限：先按截断续写补齐，再走常规校验
          attemptResponse = await continueTruncatedArtifact({
            requiredArtifact,
            workflowStage,
            baseMessages: [...attemptMessages, ...pickContinuationContext(responseMessages)],
            initialText: attemptResponse,
            appendVisible: (chunk) => text.append(chunk),
          });
          try {
            getRequiredArtifact(attemptResponse, requiredArtifact);
          } catch (err) {
            if (attempt === SUB_AGENT_MAX_ATTEMPTS) throw err;
            const errorMsg = u.error(err).message;
            console.warn(`[scriptAgent] ${modelKey} 产出格式无效，准备第 ${attempt + 1}/${SUB_AGENT_MAX_ATTEMPTS} 次尝试:`, errorMsg);
            const retryState = subMsg.thinking("产出格式未通过校验，正在自动重新生成...");
            retryState.appendText(`第 ${attempt + 1}/${SUB_AGENT_MAX_ATTEMPTS} 次尝试`);
            retryState.complete();
            resTool.workflowStatus("retrying", `${getWorkflowLabel(workflowStage)}，正在修复输出格式（${attempt + 1}/${SUB_AGENT_MAX_ATTEMPTS}）`, workflowStage);
            attemptMessages = [
              ...attemptMessages,
              ...responseMessages,
              {
                role: "user",
                content:
                  requiredArtifact === "scriptItem"
                    ? "上一轮产出未通过格式校验。请基于已有内容重新输出一个带 name 属性、开闭标签完整的 <scriptItem>；不要重复读取资料，不要输出解释、Markdown 代码围栏或保存说明。"
                    : `上一轮产出未通过格式校验。请基于已有内容重新输出一个开闭标签完整的 <${requiredArtifact}>；不要重复读取资料，不要输出解释、Markdown 代码围栏或保存说明。`,
              },
            ];
            await waitBeforeRetry(750 * attempt, abortSignal);
            continue;
          }
        }
        fullResponse = attemptResponse;
        break;
      } catch (err: any) {
        const aborted = err?.name === "AbortError" || abortSignal?.aborted;
        const partialOutput = Boolean(attemptResponse.trim());
        // 网络类瞬时错误即使输出到一半也允许重试（重新生成整段），避免长任务中途前功尽弃
        const canRetry = !aborted && isTransientAiError(err) && attempt < SUB_AGENT_MAX_ATTEMPTS;
        if (!canRetry) {
          const errorMessage = u.error(err).message;
          text.complete();
          subMsg.error(errorMessage);
          resTool.workflowStatus("error", `${getWorkflowLabel(workflowStage)}失败：${errorMessage}`, workflowStage);
          throw err;
        }

        console.warn(`[scriptAgent] ${modelKey} 调用失败，准备第 ${attempt + 1}/${SUB_AGENT_MAX_ATTEMPTS} 次尝试:`, u.error(err).message);
        const retryState = subMsg.thinking(partialOutput ? "输出中途被网络中断，正在重新生成..." : "模型服务连接异常，正在自动重试...");
        retryState.appendText(`第 ${attempt + 1}/${SUB_AGENT_MAX_ATTEMPTS} 次尝试`);
        retryState.complete();
        resTool.workflowStatus("retrying", `${getWorkflowLabel(workflowStage)}，正在重连模型服务（${attempt + 1}/${SUB_AGENT_MAX_ATTEMPTS}）`, workflowStage);
        if (partialOutput) {
          text.append("\n\n（上一轮输出中途被中断，下面重新完整生成）\n\n");
          attemptMessages = [
            ...attemptMessages,
            {
              role: "user",
              content: "上一轮输出因网络中断未完成。请忽略刚才的半截内容，从头完整输出最终结果，不要续写片段、不要省略。",
            },
          ];
        }
        await waitBeforeRetry(750 * attempt, abortSignal);
      }
    }

    let result = fullResponse;
    try {
      if (requiredArtifact) {
        const artifact = getRequiredArtifact(fullResponse, requiredArtifact);
        if (repairScope && requiredArtifact === "scriptItem" && artifact.type === "scriptItem") {
          // 定点修复保存守卫：越界集/新增集一律拒绝写入
          await assertScriptRepairScope(resTool.data.projectId, artifact.name, repairScope);
        }
        await persistPlanXml(resTool.data.projectId, artifact);
        result = getArtifactSuccessMessage(artifact);
        if (repairScope) {
          result += `\n\n（定点修复：${repairScope.episodeKeys.length ? `仅允许修改 ${repairScope.episodeKeys.join("、")}` : "仅允许修改既有集"}；授权范围外内容未被改动）`;
        }
      } else if (isSupervision) {
        // 审核报告：解析结构化轮次记录并持久化，返回给决策层的文本剥离 meta 块
        try {
          const record = parseSupervisionMeta(fullResponse);
          if (record) await appendSupervisionRound(resTool.data.projectId, record);
        } catch (err) {
          console.warn("[scriptAgent] 审核轮次记录写入失败，审核结果不受影响:", u.error(err).message);
        }
        result = stripSupervisionMeta(fullResponse);
      }
      text.complete();
      subMsg.complete();
      resTool.workflowStatus("complete", `${getWorkflowLabel(workflowStage)}完成`, workflowStage);
    } catch (err) {
      text.complete();
      subMsg.error(u.error(err).message);
      resTool.workflowStatus("error", `${getWorkflowLabel(workflowStage)}失败：${u.error(err).message}`, workflowStage);
      throw err;
    }

    try {
      await memory.add(memoryKey, requiredArtifact ? result : removeAllXmlTags(fullResponse), {
        name,
        createTime: new Date(subMsg.datetime).getTime(),
      });
    } catch (err) {
      console.warn(`[scriptAgent] ${memoryKey} 记忆写入失败，正式产出不受影响:`, u.error(err).message);
    }

    parentCtx.msg = resTool.newMessage("assistant", "视频策划");
    if (isSupervision) supervisionCompleted = true;
    return result;
  }

  /**
   * 批次回执：审核轮次落库后，用宿主确定性数据说清"完成了什么、还剩什么、下一步做什么"。
   * 不依赖模型复述，数字与工作区/审核记录完全一致。
   */
  async function buildBatchReceipt(): Promise<string> {
    const projectId = resTool.data.projectId;
    const [progress, rounds] = await Promise.all([loadScriptAgentProgress(projectId), readSupervisionHistory(projectId)]);
    const last = rounds[rounds.length - 1];
    const saved = progress.scripts.episodes.filter((episode) => episode.chars > 0);
    const savedText = saved.length
      ? `${progress.scripts.savedCount}${progress.scripts.targetEpisodes ? `/${progress.scripts.targetEpisodes}` : ""} 集（${saved
          .map((episode) => `EP${String(episode.episodeNo).padStart(2, "0")}`)
          .join("、")}）`
      : "尚无已保存剧本";
    const reviewText = last
      ? `${last.rating} 级 · 阻塞 ${last.blockingCount} · 已关闭 ${last.closedCount} · 遗留一般 ${last.mediumCount} / 提示 ${last.lightCount}`
      : "本次未记录审核结论";
    const nextText = progress.scripts.nextRange
      ? `继续生成 ${formatEpisodeRange(progress.scripts.nextRange.from, progress.scripts.nextRange.to)}`
      : progress.scripts.remaining === 0
        ? "目标集数已全部完成，可进入制作流程"
        : "继续编写剧本";
    return [
      "**批次回执**",
      "",
      "| 项 | 内容 |",
      "| --- | --- |",
      `| 本批范围 | ${last?.scope ?? "未标注"} |`,
      `| 审核结论 | ${reviewText} |`,
      `| 已生成剧本 | ${savedText} |`,
      `| 下一步 | ${nextText} |`,
    ].join("\n");
  }

  const promptInput = z.object({
    prompt: z.string().describe("交给子Agent的任务简约描述，100字以内"),
  });

  const run_sub_agent_storySkeleton = tool({
    description: "运行执行subAgent来完成故事骨架相关任务",
    inputSchema: promptInput,
    execute: async ({ prompt }) => {
      const skill = path.join(u.getPath("skills"), "script_execution_skeleton.md");
      const systemPrompt = await fs.promises.readFile(skill, "utf-8");

      const formatPrompt =
        "\n你必须输出一个完整的 <storySkeleton>故事骨架内容</storySkeleton>。该 XML 是唯一的写入协议，宿主会自动完成事务保存和回读校验；无需、也不得寻找额外写入工具。闭合 XML 后立即结束输出。";

      const result = await runAgent({
        modelKey: "scriptAgent:storySkeletonAgent",
        prompt,
        system: systemPrompt + formatPrompt,
        name: "编剧",
        memoryKey: "assistant:execution:storySkeleton",
        requiredArtifact: "storySkeleton",
        workflowStage: "storySkeleton",
        messages: [{ role: "user", content: prompt + formatPrompt }],
      });
      return appendSkeletonCapacityReport(resTool.data.projectId, result);
    },
  });

  const run_sub_agent_adaptationStrategy = tool({
    description: "运行执行subAgent来完成改编策略相关任务",
    inputSchema: promptInput,
    execute: async ({ prompt }) => {
      const skill = path.join(u.getPath("skills"), "script_execution_adaptation.md");
      const systemPrompt = await fs.promises.readFile(skill, "utf-8");

      const formatPrompt =
        "\n你必须输出一个完整的 <adaptationStrategy>改编策略内容</adaptationStrategy>。该 XML 是唯一的写入协议，宿主会自动完成事务保存和回读校验；无需、也不得寻找额外写入工具。闭合 XML 后立即结束输出。";

      return runAgent({
        modelKey: "scriptAgent:adaptationStrategyAgent",
        prompt,
        system: systemPrompt + formatPrompt,
        name: "编剧",
        memoryKey: "assistant:execution:adaptationStrategy",
        requiredArtifact: "adaptationStrategy",
        workflowStage: "adaptationStrategy",
        messages: [{ role: "user", content: prompt + formatPrompt }],
      });
    },
  });

  const run_sub_agent_script = tool({
    description: "运行执行subAgent来完成剧本相关任务（支持定点修复模式）",
    inputSchema: z.object({
      prompt: z.string().describe("交给子Agent的任务简约描述，100字以内"),
      mode: z
        .enum(["build", "repair"])
        .optional()
        .describe("build=编写/重做（默认）；repair=定点修复：仅允许修改审核问题涉及的集，其余集由宿主保存守卫拒绝"),
    }),
    execute: async ({ prompt, mode }) => {
      const skill = path.join(u.getPath("skills"), "script_execution_script.md");
      const systemPrompt = await fs.promises.readFile(skill, "utf-8");

      const scriptList = await u.db("o_script").where("projectId", resTool.data.projectId).select("id", "name");
      const scriptPrompt = ["## 可用剧本(ID:名称)", scriptList.map((s: any) => `${s.id}:${(s.name || "").replace(/[,:]/g, "")}`).join(","), ""].join(
        "\n",
      );

      const novelData = await u.db("o_novel").where("projectId", resTool.data.projectId).select("chapterIndex");

      const formatPrompt =
        '\n你必须只输出一个完整的 <scriptItem name="剧本名称">剧本内容</scriptItem>。该 XML 是唯一的写入协议，宿主会自动完成事务保存和回读校验；无需、也不得寻找额外写入工具。闭合 XML 后立即结束输出。';

      // 定点修复：宿主推导授权集、注入待修集全文，并在保存前强制校验范围
      let repairScope: { episodeKeys: string[] } | null = null;
      let repairInjection = "";
      if (mode === "repair") {
        try {
          const history = await readSupervisionHistory(resTool.data.projectId);
          const keys = resolveScriptRepairEpisodeKeys(history);
          repairScope = { episodeKeys: keys };
          const rows = (await u
            .db("o_script")
            .where("projectId", resTool.data.projectId)
            .select("name", "content")) as { name: string | null; content: string | null }[];
          const targets = keys.length
            ? rows.filter((row) => episodeNameMatchesKeys(String(row.name ?? ""), keys))
            : [];
          const scopeText = keys.length ? `只允许修改 ${keys.join("、")}` : "只允许修改既有集";
          if (targets.length) {
            const blocks = targets
              .map((row) => `#### 待修集当前全文：${row.name}\n${row.content ?? ""}`)
              .join("\n\n");
            repairInjection = `\n\n【宿主修复约束】本任务为定点修复：${scopeText}，其余集不得改动（宿主的保存守卫会拒绝越界写入）。请以下方当前全文为修复基准，输出修复后的完整 <scriptItem name="原集名">（name 必须与原集名一字不差）：\n\n${blocks}`;
          } else {
            repairInjection = `\n\n【宿主修复约束】本任务为定点修复：${scopeText}，其余集不得改动（宿主的保存守卫会拒绝越界写入）。请先读取待修集当前全文，再输出修复后的完整 <scriptItem name="原集名">。`;
          }
        } catch (err) {
          console.warn("[scriptAgent] 定点修复上下文构建失败，按无守卫流程处理:", u.error(err).message);
        }
      }

      return runAgent({
        modelKey: "scriptAgent:scriptAgent",
        prompt,
        system: systemPrompt + formatPrompt,
        messages: [
          { role: "assistant", content: scriptPrompt + `章节数量：${novelData.length}章` },
          { role: "user", content: prompt + repairInjection + formatPrompt },
        ],
        name: "编剧",
        memoryKey: "assistant:execution:script",
        requiredArtifact: "scriptItem",
        workflowStage: "script",
        repairScope,
      });
    },
  });

  const run_supervision_agent = tool({
    description: "运行监督层subAgent执行独立任务，完成后返回结果",
    inputSchema: promptInput,
    execute: async ({ prompt }) => {
      const skill = path.join(u.getPath("skills"), "script_agent_supervision.md");
      const systemPrompt = await fs.promises.readFile(skill, "utf-8");

      // 审核前由宿主强制注入确定性检查结果与上一轮问题清单，不依赖模型自觉调用工具
      let injection = "";
      try {
        const [checkReport, skeletonReport, history] = await Promise.all([
          runScriptChecks(Number(resTool.data.projectId)),
          runSkeletonChecks(Number(resTool.data.projectId)).catch(() => undefined),
          readSupervisionHistory(resTool.data.projectId),
        ]);
        const parts = [reportToMarkdown(checkReport)];
        if (skeletonReport?.estimates.length) parts.unshift(skeletonReportToMarkdown(skeletonReport));
        injection = buildSupervisionInjection(parts.join("\n\n"), history);
      } catch (err) {
        injection = `\n\n【宿主预注入：确定性检查与审核历史】\n- 确定性检查执行失败（${u.error(err).message}）；本轮审核需自行完成时长、原文台词与格式红线核对，并在报告中标注确定性检查缺失。`;
      }

      const result = await runAgent({
        modelKey: "scriptAgent:supervisionAgent",
        prompt: `${prompt}${injection}`,
        system: systemPrompt,
        name: "编辑",
        memoryKey: "assistant:supervision",
        isSupervision: true,
        workflowStage: "supervision",
      });

      // 审核轮次已在 runAgent 内落库：这里补一条宿主生成的结构化回执，
      // 让聊天流里直接看清"本批结论 + 已生成集数 + 下一步"，不依赖模型复述
      let receipt = "";
      try {
        receipt = await buildBatchReceipt();
        const receiptMessage = resTool.newMessage("assistant", "进度");
        receiptMessage.markdown(receipt);
        receiptMessage.complete();
      } catch (err) {
        console.warn("[scriptAgent] 批次回执生成失败，审核结果不受影响:", u.error(err).message);
      }
      return receipt ? `${result}\n\n${receipt}` : result;
    },
  });

  return {
    run_sub_agent_storySkeleton,
    run_sub_agent_adaptationStrategy,
    run_sub_agent_script,
    run_supervision_agent,
  };
}

function removeAllXmlTags(text: string): string {
  text = text.replace(/<([a-zA-Z][\w-]*)(\s+[^>]*)?>([\s\S]*?)<\/\1>/g, "");
  text = text.replace(/<([a-zA-Z][\w-]*)(\s+[^>]*)?\/>/g, "");
  text = text.replace(/<\/?[a-zA-Z][\w-]*(\s+[^>]*)?>/g, "");
  return text.trim();
}
