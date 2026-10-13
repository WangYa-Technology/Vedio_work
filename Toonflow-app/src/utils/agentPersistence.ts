import u from "@/utils";
import type { AIMessageContent, ChatMessagesData, ChatMessageStatus } from "@/socket/chatMessagesData";

export const SCRIPT_AGENT_RUNTIME_KEY = "scriptAgentRuntime";
export const PRODUCTION_AGENT_RUNTIME_KEY = "productionAgentRuntime";

/**
 * 运行记录落库节流间隔（毫秒）：长产出生成期间运行记录会高频更新，
 * 每次落库都是"全量深拷贝 + 整行写 SQLite"，间隔过小会长时间占用事件循环。
 * 可用环境变量 AGENT_RUNTIME_SAVE_INTERVAL_MS 覆盖（下限 200ms）。
 */
const RUNTIME_SAVE_INTERVAL_MS = Math.max(200, Number(process.env.AGENT_RUNTIME_SAVE_INTERVAL_MS) || 1000);
/**
 * 单条 thinking 文本落库上限（字符）：thinking 常回显整份骨架/章节原文（数万字），
 * 超长文本会让运行记录膨胀到 MB 级；超出部分截断保存并标记，前端仍以工作区正式数据为准。
 */
const RUNTIME_THINKING_MAX_CHARS = 20_000;
const RUNTIME_THINKING_TRUNCATE_SUFFIX = "\n…（内容过长，运行记录中已截断）";

export function getAgentIsolationKey(userId: number, projectId: number, agentType: string, episodesId?: number) {
  return `${userId}:${projectId}:${agentType}${episodesId !== undefined ? `:${episodesId}` : ""}`;
}

export interface AgentWorkflowStatus {
  state: "idle" | "working" | "retrying" | "complete" | "error";
  label: string;
  phase?: string;
}

export interface AgentRunState {
  state: "idle" | "running" | "interrupted" | "complete" | "error";
  phase?: string;
  startedAt?: number;
  updatedAt: number;
  resumable: boolean;
}

export interface AgentRuntimeData {
  version: 1;
  messages: ChatMessagesData[];
  workflowStatus: AgentWorkflowStatus;
  runState: AgentRunState;
  updatedAt: number;
}

/** 运行记录结构与 Agent 无关，保留旧名作为类型别名。 */
export type ScriptAgentRuntimeData = AgentRuntimeData;

function emptyRuntime(): AgentRuntimeData {
  const now = Date.now();
  return {
    version: 1,
    messages: [],
    workflowStatus: { state: "idle", label: "" },
    runState: { state: "idle", updatedAt: now, resumable: false },
    updatedAt: now,
  };
}

function normalizeRuntime(data: Partial<AgentRuntimeData> | null | undefined): AgentRuntimeData | null {
  if (!data || !Array.isArray(data.messages)) return null;
  const fallback = emptyRuntime();
  return {
    version: 1,
    messages: data.messages,
    workflowStatus: data.workflowStatus ?? fallback.workflowStatus,
    runState: data.runState ?? fallback.runState,
    updatedAt: Number(data.updatedAt) || fallback.updatedAt,
  };
}

interface RuntimeScope {
  projectId: number;
  episodesId?: number;
  key: string;
}

function scopeWhere(scope: RuntimeScope) {
  return scope.episodesId !== undefined
    ? { projectId: scope.projectId, episodesId: scope.episodesId, key: scope.key }
    : { projectId: scope.projectId, key: scope.key };
}

async function readAgentRuntime(scope: RuntimeScope): Promise<AgentRuntimeData | null> {
  const row = await u.db("o_agentWorkData").where(scopeWhere(scope)).select("data").first();
  if (!row?.data) return null;
  try {
    return normalizeRuntime(JSON.parse(row.data) as Partial<AgentRuntimeData>);
  } catch {
    return null;
  }
}

async function writeAgentRuntime(scope: RuntimeScope, runtime: AgentRuntimeData) {
  const now = Date.now();
  const payload = JSON.stringify({ ...runtime, version: 1, updatedAt: runtime.updatedAt || now });
  const where = scopeWhere(scope);
  await u.db.transaction(async (trx) => {
    const row = await trx("o_agentWorkData").where(where).select("id", "data").first();
    if (row) {
      try {
        const savedUpdatedAt = Number(JSON.parse(row.data ?? "{}").updatedAt) || 0;
        if (savedUpdatedAt > runtime.updatedAt) return;
      } catch {
        // Replace malformed runtime data with the validated incoming snapshot.
      }
      await trx("o_agentWorkData").where({ id: row.id, ...where }).update({ data: payload, updateTime: now });
    } else {
      await trx("o_agentWorkData").insert({ ...where, data: payload, createTime: now, updateTime: now });
    }
  });
}

export async function readScriptAgentRuntime(projectId: number): Promise<AgentRuntimeData | null> {
  return readAgentRuntime({ projectId, key: SCRIPT_AGENT_RUNTIME_KEY });
}

export async function writeScriptAgentRuntime(projectId: number, runtime: AgentRuntimeData) {
  return writeAgentRuntime({ projectId, key: SCRIPT_AGENT_RUNTIME_KEY }, runtime);
}

export async function readProductionAgentRuntime(projectId: number, episodesId: number): Promise<AgentRuntimeData | null> {
  return readAgentRuntime({ projectId, episodesId, key: PRODUCTION_AGENT_RUNTIME_KEY });
}

export async function writeProductionAgentRuntime(projectId: number, episodesId: number, runtime: AgentRuntimeData) {
  return writeAgentRuntime({ projectId, episodesId, key: PRODUCTION_AGENT_RUNTIME_KEY }, runtime);
}

function deepMerge(target: any, source: any): any {
  if (!source || typeof source !== "object") return source;
  const result = { ...(target && typeof target === "object" ? target : {}) };
  for (const [key, value] of Object.entries(source)) {
    if (Array.isArray(value)) result[key] = [...(Array.isArray(result[key]) ? result[key] : []), ...value];
    else if (value && typeof value === "object") result[key] = deepMerge(result[key], value);
    else if (value !== undefined) result[key] = value;
  }
  return result;
}

export interface AgentRuntimePersistence {
  logTag: string;
  read: () => Promise<AgentRuntimeData | null>;
  write: (runtime: AgentRuntimeData) => Promise<void>;
  /** 流式文本中出现这些 XML 标签时，运行记录不再累积其内容（大体量产出以正式工作区数据为准，避免高频全量落库）。 */
  hiddenStreamTags?: string[];
}

export class AgentRuntimeRecorder {
  protected runtime: AgentRuntimeData = emptyRuntime();
  private saveTimer: NodeJS.Timeout | null = null;
  private saveQueue: Promise<void> = Promise.resolve();
  private hiddenContentIds = new Set<string>();

  constructor(private readonly persistence: AgentRuntimePersistence) {}

  async load() {
    this.runtime = (await this.persistence.read()) ?? emptyRuntime();
  }

  /** 运行记录显示任务仍在后台运行时返回 true。 */
  isRunning() {
    return this.runtime.runState.state === "running";
  }

  addUserMessage(content: string) {
    const now = Date.now();
    this.runtime.messages.push({
      id: `user_${now}`,
      role: "user",
      status: "complete",
      datetime: new Date(now).toISOString(),
      content: [{ type: "text", data: content, status: "complete" }],
    });
    this.runtime.runState = { state: "running", startedAt: now, updatedAt: now, resumable: false };
    this.touch();
  }

  recordOutgoing(event: string, data: any) {
    if (event === "message") {
      this.runtime.messages.push(data as ChatMessagesData);
    } else if (event === "message:update") {
      const message = this.runtime.messages.find((item) => item.id === data?.id);
      if (message) {
        if (data.status) message.status = data.status as ChatMessageStatus;
        if (data.ext) message.ext = { ...message.ext, ...data.ext };
      }
    } else if (event === "content:add") {
      const message = this.runtime.messages.find((item) => item.id === data?.messageId);
      if (message?.role === "assistant") {
        message.content ??= [];
        const content = data.content as AIMessageContent;
        if (content.type === "thinking") {
          const firstNonThinking = message.content.findIndex((item) => item.type !== "thinking");
          if (firstNonThinking === -1) message.content.push(content);
          else message.content.splice(firstNonThinking, 0, content);
        } else {
          message.content.push(content);
        }
      }
    } else if (event === "content:update") {
      this.updateContent(data);
    } else if (event === "workflow:status") {
      this.updateWorkflow(data);
    } else {
      return;
    }
    this.touch(event === "workflow:status" || data?.status === "complete" || data?.status === "error" || data?.status === "stop");
  }

  /**
   * 标记上次任务已中断。
   * @param label 结论式文案（如"已保存 EP01-EP03（3/19 集），审核通过（B）；可继续生成 EP04-EP08"）；
   *              不传时保留通用文案，调用方可在计算失败时回退。
   */
  markInterrupted(label?: string) {
    if (this.runtime.runState.state !== "running") return;
    const now = Date.now();
    for (const message of this.runtime.messages) {
      if (message.status === "pending" || message.status === "streaming") message.status = "error";
      if (message.role === "assistant") {
        for (const content of message.content ?? []) {
          if (content.status === "pending" || content.status === "streaming") content.status = "error";
        }
      }
    }
    // 传入结论句时直接采用（说清"已完成什么、下一步做什么"），不传则保留通用兜底文案
    const text = typeof label === "string" && label.trim() ? label.trim() : "上次生成已中断，可继续";
    this.runtime.workflowStatus = { state: "error", label: text, phase: this.runtime.runState.phase };
    this.runtime.runState = { ...this.runtime.runState, state: "interrupted", updatedAt: now, resumable: true };
    this.touch(true);
  }

  async flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.enqueueSave();
  }

  private updateContent(data: any) {
    const message = this.runtime.messages.find((item) => item.id === data?.messageId);
    if (message?.role !== "assistant") return;
    const content = message.content?.find((item) => item.id === data?.contentId);
    if (!content) return;
    if (content.id && this.hiddenContentIds.has(content.id)) return;
    if (data.status) content.status = data.status;
    if (data.data === undefined || data.data === null) return;
    if (data.strategy === "append") {
      if (typeof content.data === "string" && typeof data.data === "string") content.data += data.data;
      else content.data = deepMerge(content.data, data.data);
    } else if (content.data && typeof content.data === "object" && typeof data.data === "object") {
      content.data = { ...content.data, ...data.data };
    } else {
      content.data = data.data;
    }
    // XML 产出（分镜表 / 剧本等）逐块到达后即被识别并停止累积，运行记录只保留对话内容
    if (content.id && typeof content.data === "string" && this.shouldHideStreamContent(content.data)) {
      this.hiddenContentIds.add(content.id);
      content.data = "";
    }
  }

  private shouldHideStreamContent(text: string) {
    const tags = this.persistence.hiddenStreamTags;
    if (!tags?.length) return false;
    return tags.some((tag) => text.includes(`<${tag}`));
  }

  private updateWorkflow(data: Partial<AgentWorkflowStatus>) {
    const now = Date.now();
    this.runtime.workflowStatus = {
      state: data.state ?? "idle",
      label: data.label ?? "",
      ...(data.phase ? { phase: data.phase } : {}),
    };
    if (data.state === "working" || data.state === "retrying") {
      this.runtime.runState = { ...this.runtime.runState, state: "running", phase: data.phase, updatedAt: now, resumable: false };
    } else if (data.state === "error") {
      this.runtime.runState = { ...this.runtime.runState, state: "error", phase: data.phase, updatedAt: now, resumable: true };
    } else if (data.state === "idle" || data.state === "complete") {
      this.runtime.runState = { ...this.runtime.runState, state: "complete", phase: data.phase, updatedAt: now, resumable: false };
    }
  }

  private touch(immediate = false) {
    this.runtime.updatedAt = Date.now();
    if (immediate) {
      if (this.saveTimer) clearTimeout(this.saveTimer);
      this.saveTimer = null;
      void this.enqueueSave();
      return;
    }
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.enqueueSave();
    }, RUNTIME_SAVE_INTERVAL_MS);
  }

  /** 落库前瘦身：截断超长 thinking 文本，避免运行记录膨胀与单次写入过重 */
  private buildPersistedSnapshot(): AgentRuntimeData {
    const snapshot = JSON.parse(JSON.stringify(this.runtime)) as AgentRuntimeData;
    for (const message of snapshot.messages) {
      for (const content of message.content ?? []) {
        if (content.type !== "thinking") continue;
        const text = content.data?.text;
        if (typeof text === "string" && text.length > RUNTIME_THINKING_MAX_CHARS) {
          content.data.text = `${text.slice(0, RUNTIME_THINKING_MAX_CHARS)}${RUNTIME_THINKING_TRUNCATE_SUFFIX}`;
        }
      }
    }
    return snapshot;
  }

  private enqueueSave() {
    const snapshot = this.buildPersistedSnapshot();
    this.saveQueue = this.saveQueue.then(() => this.persistence.write(snapshot)).catch((error) => {
      console.error(`[${this.persistence.logTag}] 运行记录保存失败:`, error);
    });
    return this.saveQueue;
  }
}

export class ScriptAgentRuntimeRecorder extends AgentRuntimeRecorder {
  constructor(projectId: number) {
    super({
      logTag: "scriptAgent",
      read: () => readScriptAgentRuntime(projectId),
      write: (runtime) => writeScriptAgentRuntime(projectId, runtime),
      hiddenStreamTags: ["storySkeleton", "adaptationStrategy", "scriptItem"],
    });
  }
}

export class ProductionAgentRuntimeRecorder extends AgentRuntimeRecorder {
  constructor(projectId: number, episodesId: number) {
    super({
      logTag: "productionAgent",
      read: () => readProductionAgentRuntime(projectId, episodesId),
      write: (runtime) => writeProductionAgentRuntime(projectId, episodesId, runtime),
      hiddenStreamTags: ["script", "scriptPlan", "storyboardTable"],
    });
  }
}
