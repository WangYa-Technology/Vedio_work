import u from "@/utils";
import type { AIMessageContent, ChatMessagesData, ChatMessageStatus } from "@/socket/chatMessagesData";

export const SCRIPT_AGENT_RUNTIME_KEY = "scriptAgentRuntime";

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

export interface ScriptAgentRuntimeData {
  version: 1;
  messages: ChatMessagesData[];
  workflowStatus: AgentWorkflowStatus;
  runState: AgentRunState;
  updatedAt: number;
}

function emptyRuntime(): ScriptAgentRuntimeData {
  const now = Date.now();
  return {
    version: 1,
    messages: [],
    workflowStatus: { state: "idle", label: "" },
    runState: { state: "idle", updatedAt: now, resumable: false },
    updatedAt: now,
  };
}

export async function readScriptAgentRuntime(projectId: number): Promise<ScriptAgentRuntimeData | null> {
  const row = await u.db("o_agentWorkData").where({ projectId, key: SCRIPT_AGENT_RUNTIME_KEY }).select("data").first();
  if (!row?.data) return null;
  try {
    const data = JSON.parse(row.data) as Partial<ScriptAgentRuntimeData>;
    if (!Array.isArray(data.messages)) return null;
    const fallback = emptyRuntime();
    return {
      version: 1,
      messages: data.messages,
      workflowStatus: data.workflowStatus ?? fallback.workflowStatus,
      runState: data.runState ?? fallback.runState,
      updatedAt: Number(data.updatedAt) || fallback.updatedAt,
    };
  } catch {
    return null;
  }
}

export async function writeScriptAgentRuntime(projectId: number, runtime: ScriptAgentRuntimeData) {
  const now = Date.now();
  const payload = JSON.stringify({ ...runtime, version: 1, updatedAt: runtime.updatedAt || now });
  await u.db.transaction(async (trx) => {
    const row = await trx("o_agentWorkData").where({ projectId, key: SCRIPT_AGENT_RUNTIME_KEY }).select("id", "data").first();
    if (row) {
      try {
        const savedUpdatedAt = Number(JSON.parse(row.data ?? "{}").updatedAt) || 0;
        if (savedUpdatedAt > runtime.updatedAt) return;
      } catch {
        // Replace malformed runtime data with the validated incoming snapshot.
      }
      await trx("o_agentWorkData").where({ id: row.id, projectId, key: SCRIPT_AGENT_RUNTIME_KEY }).update({ data: payload, updateTime: now });
    } else {
      await trx("o_agentWorkData").insert({ projectId, key: SCRIPT_AGENT_RUNTIME_KEY, data: payload, createTime: now, updateTime: now });
    }
  });
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

export class ScriptAgentRuntimeRecorder {
  private runtime: ScriptAgentRuntimeData = emptyRuntime();
  private saveTimer: NodeJS.Timeout | null = null;
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(private readonly projectId: number) {}

  async load() {
    this.runtime = (await readScriptAgentRuntime(this.projectId)) ?? emptyRuntime();
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

  markInterrupted() {
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
    this.runtime.workflowStatus = { state: "error", label: "上次生成已中断，可继续", phase: this.runtime.runState.phase };
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
    }, 300);
  }

  private enqueueSave() {
    const snapshot = JSON.parse(JSON.stringify(this.runtime)) as ScriptAgentRuntimeData;
    this.saveQueue = this.saveQueue.then(() => writeScriptAgentRuntime(this.projectId, snapshot)).catch((error) => {
      console.error("[scriptAgent] 运行记录保存失败:", error);
    });
    return this.saveQueue;
  }
}
