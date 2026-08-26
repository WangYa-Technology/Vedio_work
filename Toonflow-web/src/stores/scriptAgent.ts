import axios from "@/utils/axios";
import settingStore from "@/stores/setting";
import { useChat } from "@/utils/useChat";
import { resolveApiBaseUrl } from "@/utils/backendUrl";
import { createEmptyProjectGlobalContext } from "@/types/projectGlobalContext";
import type { ProjectGlobalContext } from "@/types/projectGlobalContext";
import type { ChatMessagesData } from "@tdesign-vue-next/chat";
import type { WorkflowStatus } from "@/utils/useChat";
export { createEmptyProjectGlobalContext } from "@/types/projectGlobalContext";
export type { ProjectGlobalContext, ProjectGlobalContextType, ProjectGlobalMaterial } from "@/types/projectGlobalContext";

interface PlanData {
  storySkeleton: string;
  adaptationStrategy: string;
  script: { id?: number; name: string; content: string }[];
  projectGlobalContext: ProjectGlobalContext;
}

interface ScriptAgentRuntimeSnapshot {
  version: 1;
  messages: ChatMessagesData[];
  workflowStatus: WorkflowStatus;
  runState: {
    state: "idle" | "running" | "interrupted" | "complete" | "error";
    phase?: string;
    startedAt?: number;
    updatedAt: number;
    resumable: boolean;
  };
  updatedAt: number;
}

function createEmptyPlanData(): PlanData {
  return {
    storySkeleton: "",
    adaptationStrategy: "",
    script: [],
    projectGlobalContext: createEmptyProjectGlobalContext(),
  };
}

function clonePlanData(data: PlanData): PlanData {
  const emptyGlobalContext = createEmptyProjectGlobalContext();
  return {
    storySkeleton: data.storySkeleton || "",
    adaptationStrategy: data.adaptationStrategy || "",
    projectGlobalContext: {
      plot: { ...emptyGlobalContext.plot, ...data.projectGlobalContext.plot },
      character: { ...emptyGlobalContext.character, ...data.projectGlobalContext.character },
      world: { ...emptyGlobalContext.world, ...data.projectGlobalContext.world },
    },
    script: data.script.map((item) => ({
      ...(item.id !== undefined ? { id: item.id } : {}),
      name: item.name,
      content: item.content || "",
    })),
  };
}

export default defineStore(
  "scriptAgent",
  () => {
    const planData = ref<PlanData>(createEmptyPlanData());
    const currentProjectId = ref<number | null>(null);
    const contextVersion = ref(0);
    let saveQueue: Promise<void> = Promise.resolve();
    let runtimeHydratedProjectId: number | null = null;
    let runtimeSaveTimer: ReturnType<typeof setTimeout> | null = null;
    const chatAuth = reactive({
      isolationKey: "",
      projectId: undefined as number | undefined,
    });

    const { connected, messages, renderableMessages, chat, stopGenerate, socket, status, workflowStatus, connect, reconnect, disconnect, clearMessages } = useChat({
      url: `${resolveApiBaseUrl(settingStore().baseUrl)}/socket/scriptAgent`,
      auth: chatAuth,
      manageLifecycle: false,
      xmlTags: [
        { tag: "storySkeleton", keepInMessage: false },
        { tag: "adaptationStrategy", keepInMessage: false },
        { tag: "scriptItem", keepInMessage: false },
      ],
      onXmlTag: (data) => {
        const { tag, value, attrs } = data;
        if (tag === "storySkeleton") {
          planData.value.storySkeleton = value;
        } else if (tag === "adaptationStrategy") {
          planData.value.adaptationStrategy = value;
        } else if (tag === "scriptItem") {
          // 流式场景：合并 children 到现有数据，保留已有项的 id，不删除 children 中不存在的条目
          const name = attrs.name ?? "";
          const content = value;
          if (name) {
            const existingIndex = planData.value.script.findIndex((s) => s.name === name);
            if (existingIndex !== -1) {
              // 已存在则更新 content，保留 id
              planData.value.script[existingIndex].content = content;
            } else {
              // 不存在则追加新条目
              planData.value.script.push({ name, content });
            }
          }
        }
      },
      autoConnect: false,
    });
    const runtimeSnapshotKey = (projectId: number) => `toonflow:agent:script:${projectId}`;
    const runtimeMessages = () => messages.value.filter((message) => message.id !== "welcome");

    function createRuntimeSnapshot(): ScriptAgentRuntimeSnapshot {
      const now = Date.now();
      const busy = workflowStatus.value.state === "working" || workflowStatus.value.state === "retrying";
      return {
        version: 1,
        messages: JSON.parse(JSON.stringify(runtimeMessages())),
        workflowStatus: { ...workflowStatus.value },
        runState: {
          state: busy ? "running" : workflowStatus.value.state === "error" ? "error" : "complete",
          ...(workflowStatus.value.phase ? { phase: workflowStatus.value.phase } : {}),
          updatedAt: now,
          resumable: workflowStatus.value.state === "error",
        },
        updatedAt: now,
      };
    }

    function readLocalRuntime(projectId: number): ScriptAgentRuntimeSnapshot | null {
      try {
        const saved = JSON.parse(localStorage.getItem(runtimeSnapshotKey(projectId)) || "null");
        if (!Array.isArray(saved?.messages)) return null;
        const updatedAt = Number(saved.updatedAt ?? saved.savedAt) || 0;
        return {
          version: 1,
          messages: saved.messages.filter((message: ChatMessagesData) => message?.id !== "welcome"),
          workflowStatus: saved.workflowStatus ?? { state: "idle", label: "" },
          runState: saved.runState ?? { state: "complete", updatedAt, resumable: false },
          updatedAt,
        };
      } catch {
        return null;
      }
    }

    function sanitizeRuntime(snapshot: ScriptAgentRuntimeSnapshot): ScriptAgentRuntimeSnapshot {
      const hiddenTags = ["storySkeleton", "adaptationStrategy", "scriptItem"];
      const normalized = JSON.parse(JSON.stringify(snapshot)) as ScriptAgentRuntimeSnapshot;
      normalized.messages = normalized.messages.filter((message) => message.id !== "welcome");
      for (const message of normalized.messages) {
        if (message.role === "assistant") {
          for (const content of message.content ?? []) {
            if ((content.type === "text" || content.type === "markdown") && typeof content.data === "string") {
              for (const tag of hiddenTags) {
                content.data = content.data
                  .replace(new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tag}>`, "g"), "")
                  .replace(new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*$`, "g"), "");
              }
            }
          }
        }
      }
      if (normalized.runState.state === "running") {
        normalized.runState = { ...normalized.runState, state: "interrupted", resumable: true };
        normalized.workflowStatus = { state: "error", label: "上次生成已中断，可继续", phase: normalized.runState.phase };
      }
      if (normalized.runState.state === "interrupted") {
        for (const message of normalized.messages) {
          if (message.status === "pending" || message.status === "streaming") message.status = "error";
          if (message.role === "assistant") {
            for (const content of message.content ?? []) {
              if (content.status === "pending" || content.status === "streaming") content.status = "error";
            }
          }
        }
      }
      return normalized;
    }

    async function loadRuntime(projectId: number) {
      const normalizedProjectId = Number(projectId);
      const local = readLocalRuntime(normalizedProjectId);
      let remote: ScriptAgentRuntimeSnapshot | null = null;
      try {
        const response: any = await axios.post("/agents/getRuntime", { projectId: normalizedProjectId, agentType: "scriptAgent" });
        if (response?.data && Array.isArray(response.data.messages)) remote = response.data;
      } catch (error) {
        console.error("[scriptAgent] 服务端运行记录加载失败，使用本地缓存:", error);
      }
      if (currentProjectId.value !== normalizedProjectId) return false;
      const selected = remote && (!local || remote.updatedAt >= local.updatedAt) ? remote : local;
      runtimeHydratedProjectId = normalizedProjectId;
      if (!selected) return false;
      const normalized = sanitizeRuntime(selected);
      messages.value = normalized.messages;
      workflowStatus.value = normalized.workflowStatus;
      return normalized.messages.length > 0 || Boolean(normalized.workflowStatus.label);
    }

    async function clearRuntime(projectId: number) {
      if (runtimeSaveTimer) clearTimeout(runtimeSaveTimer);
      runtimeSaveTimer = null;
      runtimeHydratedProjectId = null;
      localStorage.removeItem(runtimeSnapshotKey(projectId));
      clearMessages();
      await axios.post("/agents/clearRuntime", { projectId, agentType: "scriptAgent" });
      if (currentProjectId.value === projectId) runtimeHydratedProjectId = projectId;
    }

    watch(
      [currentProjectId, messages, workflowStatus],
      () => {
        const projectId = currentProjectId.value;
        if (!projectId) return;
        const snapshot = createRuntimeSnapshot();
        try {
          localStorage.setItem(runtimeSnapshotKey(projectId), JSON.stringify(snapshot));
        } catch {
          // Browser storage is only a fallback; server persistence remains authoritative.
        }
        if (runtimeHydratedProjectId !== projectId) return;
        if (runtimeSaveTimer) clearTimeout(runtimeSaveTimer);
        runtimeSaveTimer = setTimeout(() => {
          runtimeSaveTimer = null;
          if (currentProjectId.value !== projectId || runtimeHydratedProjectId !== projectId) return;
          const data = createRuntimeSnapshot();
          void axios.post("/agents/setRuntime", { projectId, agentType: "scriptAgent", data }).catch((error) => {
            console.error("[scriptAgent] 服务端运行记录保存失败:", error);
          });
        }, 300);
      },
      { deep: true },
    );
    // 注册 getPlanData 事件（无需依赖组件生命周期）
    watch(
      socket,
      (s) => {
        if (s) {
          s.on("getPlanData", (_, callback) => {
            callback(planData.value);
          });
        }
      },
      { immediate: true },
    );

    function setPlanData(
      source: PlanData = planData.value,
      projectId: number | null = currentProjectId.value,
      version = contextVersion.value,
    ) {
      if (projectId === null || version !== contextVersion.value || projectId !== currentProjectId.value) {
        return Promise.resolve();
      }

      const snapshot = clonePlanData(source);
      const task = saveQueue.then(async () => {
        // A project switch can happen while an earlier save is in flight. Never
        // send a queued snapshot under the new project's context.
        if (version !== contextVersion.value || projectId !== currentProjectId.value) return;
        await axios.post("/scriptAgent/setPlanData", {
          projectId,
          agentType: "scriptAgent",
          data: snapshot,
        });
      });
      saveQueue = task.catch((error) => {
        console.error("[scriptAgent] 工作区数据保存失败:", error);
      });
      return task;
    }

    function updateContext(projectId: number) {
      const normalizedProjectId = Number(projectId);
      if (!Number.isSafeInteger(normalizedProjectId) || normalizedProjectId <= 0) return false;
      const changed = currentProjectId.value !== normalizedProjectId;
      if (changed && socket.value) disconnect();

      currentProjectId.value = normalizedProjectId;
      chatAuth.isolationKey = `${normalizedProjectId}:scriptAgent`;
      chatAuth.projectId = normalizedProjectId;
      if (socket.value) {
        socket.value.auth = { token: localStorage.getItem("token"), ...chatAuth };
      }

      if (changed) {
        if (runtimeSaveTimer) clearTimeout(runtimeSaveTimer);
        runtimeSaveTimer = null;
        runtimeHydratedProjectId = null;
        contextVersion.value += 1;
        planData.value = createEmptyPlanData();
        clearMessages();
      }

      if (!connected.value) connect();
      return true;
    }

    return {
      connected,
      messages,
      renderableMessages,
      chat,
      stopGenerate,
      socket,
      status,
      workflowStatus,
      planData,
      currentProjectId,
      setPlanData,
      loadRuntime,
      clearRuntime,
      updateContext,
      reconnect,
      disconnect,
    };
  },
  { persist: false },
);
