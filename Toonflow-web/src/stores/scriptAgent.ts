import axios from "@/utils/axios";
import settingStore from "@/stores/setting";
import { DISCONNECT_LABEL_PREFIX, useChat } from "@/utils/useChat";
import { resolveApiBaseUrl } from "@/utils/backendUrl";
import { createEmptyProjectGlobalContext } from "@/types/projectGlobalContext";
import type { ProjectGlobalContext } from "@/types/projectGlobalContext";
import type { ChatMessagesData } from "@tdesign-vue-next/chat";
import type { WorkflowStatus } from "@/utils/useChat";
export { createEmptyProjectGlobalContext } from "@/types/projectGlobalContext";
export type { ProjectGlobalContext, ProjectGlobalContextType, ProjectGlobalMaterial } from "@/types/projectGlobalContext";

/** 审核轮次摘要（与后端 progress.ts 的 ReviewBrief 对齐） */
export interface ReviewBrief {
  rating: string;
  at: number;
  blocking: number;
  medium: number;
  light: number;
  closed: number;
}

export interface StageProgress {
  ready: boolean;
  chars: number;
  latestReview?: ReviewBrief;
}

export type EpisodeReviewStatus = "passed" | "blocked" | "issues" | "unreviewed";

export interface EpisodeProgress {
  episodeNo: number;
  name: string;
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

/** 进度快照：后端派生的只读数据，前端不得回写工作表（clonePlanData 已剔除） */
export interface ScriptAgentProgressSnapshot {
  stages: {
    storySkeleton: StageProgress;
    adaptationStrategy: StageProgress;
  };
  scripts: {
    targetEpisodes?: number;
    savedCount: number;
    remaining?: number;
    nextRange?: { from: number; to: number };
    episodes: EpisodeProgress[];
    latestReview?: ReviewBrief;
  };
  conclusive: string;
}

interface PlanData {
  storySkeleton: string;
  adaptationStrategy: string;
  script: { id?: number; name: string; content: string }[];
  projectGlobalContext: ProjectGlobalContext;
  /** 只读进度快照（由 /scriptAgent/getPlanData 提供，保存时不会回写） */
  progress?: ScriptAgentProgressSnapshot;
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

/**
 * 保存出口：只搬工作表的正式字段。
 * 派生进度（progress）由后端计算，刻意不在此拷贝——保证 /scriptAgent/setPlanData 永远不会用前端派生值覆盖后端真值。
 */
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
    // 后台任务结束（完成/失败/被停止）后自增：视图据此重新拉取正式工作区数据
    const runtimeSyncTick = ref(0);
    let saveQueue: Promise<void> = Promise.resolve();
    let runtimeHydratedProjectId: number | null = null;
    // 运行时快照统一节流保存：生成长剧本期间内容高频变化，若每个 chunk 都做全量
    // JSON 深拷贝 + 同步写 localStorage，会长时间占满主线程并拖累 Socket 心跳，
    // 直接表现为卡顿/“连接已断开”。权威数据在服务端运行记录，本地只做低频兜底。
    const RUNTIME_SNAPSHOT_MIN_INTERVAL_MS = 1500;
    const RUNTIME_SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;
    let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
    let lastSnapshotAt = 0;
    // 半异步：断连后在服务端后台运行的任务，前端通过轮询运行记录同步进度
    let backgroundSyncTimer: ReturnType<typeof setInterval> | null = null;
    const backgroundRunning = ref(false);
    const chatAuth = reactive({
      isolationKey: "",
      projectId: undefined as number | undefined,
    });

    const { connected, messages, renderableMessages, contentVersion, chat, stopGenerate, socket, status, workflowStatus, connect, reconnect, disconnect, clearMessages } = useChat({
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

    function stopBackgroundSync() {
      if (backgroundSyncTimer) clearInterval(backgroundSyncTimer);
      backgroundSyncTimer = null;
      backgroundRunning.value = false;
    }

    async function fetchRuntimeSnapshot(projectId: number): Promise<ScriptAgentRuntimeSnapshot | null> {
      try {
        const response: any = await axios.post("/agents/getRuntime", { projectId, agentType: "scriptAgent" });
        if (response?.data && Array.isArray(response.data.messages)) return response.data;
      } catch (error) {
        console.error("[scriptAgent] 后台任务进度同步失败:", error);
      }
      return null;
    }

    function startBackgroundSync(projectId: number) {
      stopBackgroundSync();
      backgroundRunning.value = true;
      const tick = async () => {
        if (!backgroundRunning.value || currentProjectId.value !== projectId) {
          stopBackgroundSync();
          return;
        }
        const data = await fetchRuntimeSnapshot(projectId);
        if (!data || currentProjectId.value !== projectId) return;
        messages.value = data.messages;
        const running = data.runState?.state === "running";
        // 断连且任务仍在后台运行时，保留"连接已断开（原因）…"提示，
        // 不让后台任务的阶段文案把它顶掉；终态仍以运行记录为准。
        const keepDisconnectLabel = !connected.value && workflowStatus.value.label.startsWith(DISCONNECT_LABEL_PREFIX);
        if (data.workflowStatus && !(keepDisconnectLabel && running)) workflowStatus.value = data.workflowStatus;
        if (!running) {
          // 后台任务已结束（完成 / 失败 / 被停止）：回收本地忙碌态，
          // 并通知视图重新拉取正式工作区数据（断连期间流式内容没有到达前端）
          status.value = "idle";
          runtimeSyncTick.value += 1;
          stopBackgroundSync();
        }
      };
      void tick();
      backgroundSyncTimer = setInterval(() => void tick(), 3000);
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
      // 服务端记录仍是 running 时以服务端为准：后台任务是否存活只有服务端知道，
      // 本地快照可能只是断连瞬间写下的 error 状态，不能因为时间戳更新就覆盖它。
      const selected =
        remote && (remote.runState?.state === "running" || !local || remote.updatedAt >= local.updatedAt)
          ? remote
          : local;
      runtimeHydratedProjectId = normalizedProjectId;
      if (!selected) return false;
      // 半异步：任务仍在后台运行时，保持运行态并开启进度轮询，不要误标为“已中断”。
      // 本地快照显示 running 时同样进入同步态：真相只有服务端知道（首次轮询即会校正）。
      if (selected.runState?.state === "running") {
        messages.value = selected.messages;
        const isRemoteRunning = selected === remote;
        workflowStatus.value =
          isRemoteRunning && selected.workflowStatus?.label
            ? selected.workflowStatus
            : { state: "working", label: isRemoteRunning ? "任务正在后台运行，正在同步进度…" : "检测到可能有后台任务在运行，正在同步进度…" };
        startBackgroundSync(normalizedProjectId);
        return true;
      }
      const wasBackground = backgroundRunning.value;
      stopBackgroundSync();
      const normalized = sanitizeRuntime(selected);
      messages.value = normalized.messages;
      workflowStatus.value = normalized.workflowStatus;
      // 断连恢复或后台任务结束：回收本地残留的流式忙碌态，避免输入框被永久锁死
      if (wasBackground || !connected.value) status.value = "idle";
      return normalized.messages.length > 0 || Boolean(normalized.workflowStatus.label);
    }

    async function clearRuntime(projectId: number) {
      stopBackgroundSync();
      cancelRuntimeSnapshot();
      runtimeHydratedProjectId = null;
      localStorage.removeItem(runtimeSnapshotKey(projectId));
      clearMessages();
      await axios.post("/agents/clearRuntime", { projectId, agentType: "scriptAgent" });
      if (currentProjectId.value === projectId) runtimeHydratedProjectId = projectId;
    }

    function saveRuntimeSnapshot() {
      const projectId = currentProjectId.value;
      if (!projectId) return;
      // 后台任务运行期间由服务端运行记录作为唯一数据源，前端不回写快照，避免覆盖后台进度
      if (backgroundRunning.value) return;
      const snapshot = createRuntimeSnapshot();
      let serialized = "";
      try {
        serialized = JSON.stringify(snapshot);
      } catch (error) {
        console.error("[scriptAgent] 运行时快照序列化失败:", error);
        return;
      }
      // 超大快照跳过本地缓存：localStorage 同步写会阻塞主线程，浏览器配额也容易超限
      if (serialized.length <= RUNTIME_SNAPSHOT_MAX_BYTES) {
        try {
          localStorage.setItem(runtimeSnapshotKey(projectId), serialized);
        } catch {
          // Browser storage is only a fallback; server persistence remains authoritative.
        }
      }
      if (runtimeHydratedProjectId !== projectId) return;
      // 断连期间不回写服务端运行记录：断连时本地会把状态标成“连接已断开”，
      // 若回写会覆盖后台任务仍在推进的 running 状态，导致重连后无法通过运行记录
      // 恢复进度同步（任务真正的结束由服务端自行落库）。
      if (!connected.value) return;
      // 生成中的 running 记录由服务端运行记录器持续写入（实时进度比前端节流快照更新），
      // 前端只在生成结束后补写最终状态，避免节流后的旧快照回退覆盖服务端进度。
      if (snapshot.runState.state === "running") return;
      void axios.post("/agents/setRuntime", { projectId, agentType: "scriptAgent", data: snapshot }).catch((error) => {
        console.error("[scriptAgent] 服务端运行记录保存失败:", error);
      });
    }

    /** 内容高频变化时合并为一次保存，避免每来一个 chunk 就全量深拷贝 + 同步写盘 */
    function scheduleRuntimeSnapshot() {
      if (snapshotTimer) return;
      const wait = Math.max(0, RUNTIME_SNAPSHOT_MIN_INTERVAL_MS - (Date.now() - lastSnapshotAt));
      snapshotTimer = setTimeout(() => {
        snapshotTimer = null;
        lastSnapshotAt = Date.now();
        saveRuntimeSnapshot();
      }, wait);
    }

    function cancelRuntimeSnapshot() {
      if (snapshotTimer) clearTimeout(snapshotTimer);
      snapshotTimer = null;
    }

    // 用 contentVersion 浅层感知内容变化：不再对 messages 做 deep watch 深遍历
    watch([currentProjectId, contentVersion, workflowStatus], () => scheduleRuntimeSnapshot(), { deep: true });
    // 用户在页面发起新生成时，实时流接管进度展示，后台轮询让位（仅连接可用时让位）
    watch(status, (value) => {
      if (backgroundRunning.value && connected.value && (value === "streaming" || value === "pending")) {
        stopBackgroundSync();
      }
    });
    // 断线重连后自动同步运行记录；断连时改用 HTTP 轮询继续同步后台进度（getRuntime 不依赖 socket）
    let sawConnected = false;
    watch(connected, (value) => {
      if (!value) {
        const projectId = currentProjectId.value;
        const busy =
          workflowStatus.value.state === "working" ||
          workflowStatus.value.state === "retrying" ||
          status.value === "streaming" ||
          status.value === "pending";
        if (projectId && busy) startBackgroundSync(projectId);
        return;
      }
      if (!sawConnected) {
        sawConnected = true;
        return;
      }
      if (currentProjectId.value) void loadRuntime(currentProjectId.value);
    });
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
        stopBackgroundSync();
        cancelRuntimeSnapshot();
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
      backgroundRunning,
      planData,
      currentProjectId,
      runtimeSyncTick,
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
