import axios from "@/utils/axios";
import projectStore from "@/stores/project";
import settingStore from "@/stores/setting";
import { DISCONNECT_LABEL_PREFIX, useChat, type WorkflowStatus } from "@/utils/useChat";
import type { FlowData } from "@/views/production/types";
import type { ChatMessagesData } from "@tdesign-vue-next/chat";
import { resolveApiBaseUrl } from "@/utils/backendUrl";

interface ProductionAgentRuntimeSnapshot {
  version: 1;
  messages: ChatMessagesData[];
  workflowStatus: WorkflowStatus;
  runState: {
    state: "idle" | "running" | "interrupted" | "complete" | "error";
    phase?: string;
    updatedAt: number;
    resumable: boolean;
  };
  updatedAt: number;
}

export default defineStore(
  "productionAgent",
  () => {
    const defMsg: ChatMessagesData[] = [
      {
        id: "welcome",
        role: "assistant",
        content: [
          { type: "text", status: "complete", data: $t("workbench.production.chatBox.welcomeMessage") },
          {
            type: "suggestion",
            status: "complete",
            data: [{ title: $t("workbench.production.chatBox.startMakingVideo"), prompt: $t("workbench.production.chatBox.startMakingVideoPrompt") }],
          },
        ],
      },
    ];
    onMounted(() => {
      if (messages.value.length <= 0) messages.value = [...defMsg, ...messages.value];
    });

    const flowData = ref<FlowData>({
      script: "", // 剧本
      scriptPlan: "", //导演计划
      storyboardTable: "", //分镜表
      assets: [], // 衍生资产
      storyboard: [], //分镜面板
      workbench: {
        videoList: [],
      }, // 工作台数据
    });

    const episodesId = ref<number>();
    const currentProjectId = ref<number | null>(null);
    const chatAuth = reactive({
      isolationKey: "",
      projectId: undefined as number | undefined,
      scriptId: undefined as number | undefined,
    });

    const { connected, messages, renderableMessages, contentVersion, chat, stopGenerate, socket, status, workflowStatus, reconnect, connect, disconnect, clearMessages } = useChat({
      url: `${resolveApiBaseUrl(settingStore().baseUrl)}/socket/productionAgent`,
      auth: chatAuth,
      manageLifecycle: false,
      autoConnect: false,
      xmlTags: [
        { tag: "script", keepInMessage: false },
        { tag: "scriptPlan", keepInMessage: false },
        { tag: "storyboardTable", keepInMessage: false },
      ],
      onXmlTag: async (data) => {
        const { tag, value } = data;
        if (tag === "script") {
          flowData.value.script = value ?? "";
        } else if (tag === "scriptPlan") {
          flowData.value.scriptPlan = value ?? "";
        } else if (tag === "storyboardTable") {
          flowData.value.storyboardTable = value ?? "";
        }
      },
      onError: (error) => {
        window.$message.error(error.message || "生产 Agent 请求失败");
      },
    });
    // ==== 运行记录（半异步）：断连后任务在服务端后台继续运行，前端通过运行记录同步进度 ====
    const hiddenXmlTags = ["script", "scriptPlan", "storyboardTable"];
    let runtimeHydratedKey: string | null = null;
    // 运行时快照统一节流保存：生成长内容期间每个 chunk 都做全量 JSON 深拷贝 + 同步写
    // localStorage 会长时间占满主线程并拖累 Socket 心跳，直接表现为卡顿/“连接已断开”。
    const RUNTIME_SNAPSHOT_MIN_INTERVAL_MS = 1500;
    const RUNTIME_SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;
    let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
    let lastSnapshotAt = 0;
    let backgroundSyncTimer: ReturnType<typeof setInterval> | null = null;
    const backgroundRunning = ref(false);

    const runtimeSnapshotKey = (projectId: number, scriptId?: number) => `toonflow:agent:production:${projectId}:${scriptId ?? 0}`;

    const stripHiddenXml = (text: string) => {
      let sanitized = text;
      for (const tag of hiddenXmlTags) {
        sanitized = sanitized.replace(new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tag}>`, "g"), "");
        sanitized = sanitized.replace(new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*$`, "g"), "");
      }
      return sanitized;
    };

    const sanitizeRuntimeMessages = (list: ChatMessagesData[]) =>
      (JSON.parse(JSON.stringify(list)) as ChatMessagesData[]).map((message) => {
        if (message.role !== "assistant") return message;
        for (const content of message.content ?? []) {
          if ((content.type === "text" || content.type === "markdown") && typeof content.data === "string") {
            content.data = stripHiddenXml(content.data);
          }
        }
        return message;
      });

    function createRuntimeSnapshot(): ProductionAgentRuntimeSnapshot {
      const now = Date.now();
      const busy = workflowStatus.value.state === "working" || workflowStatus.value.state === "retrying";
      return {
        version: 1,
        messages: (JSON.parse(JSON.stringify(messages.value.filter((message) => message.id !== "welcome"))) as ChatMessagesData[]).slice(-500),
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

    function readLocalRuntime(projectId: number, scriptId: number): ProductionAgentRuntimeSnapshot | null {
      try {
        const saved = JSON.parse(localStorage.getItem(runtimeSnapshotKey(projectId, scriptId)) || "null");
        if (!Array.isArray(saved?.messages)) return null;
        const updatedAt = Number(saved.updatedAt ?? saved.savedAt) || 0;
        return {
          version: 1,
          messages: saved.messages.filter((message: ChatMessagesData) => message?.id !== "welcome"),
          workflowStatus: saved.workflowStatus ?? { state: "idle", label: "" },
          runState: saved.runState ?? { state: "idle", updatedAt, resumable: false },
          updatedAt,
        };
      } catch {
        return null;
      }
    }

    function sanitizeRuntime(snapshot: ProductionAgentRuntimeSnapshot): ProductionAgentRuntimeSnapshot {
      const normalized: ProductionAgentRuntimeSnapshot = {
        ...snapshot,
        messages: sanitizeRuntimeMessages(snapshot.messages.filter((message) => message.id !== "welcome")),
      };
      if (normalized.runState?.state === "interrupted") {
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

    async function fetchRuntimeSnapshot(projectId: number, scriptId: number): Promise<ProductionAgentRuntimeSnapshot | null> {
      try {
        const response: any = await axios.post("/agents/getRuntime", { projectId, agentType: "productionAgent", episodesId: scriptId });
        if (response?.data && Array.isArray(response.data.messages)) return response.data;
      } catch (error) {
        console.error("[productionAgent] 后台任务进度同步失败:", error);
      }
      return null;
    }

    function startBackgroundSync(projectId: number, scriptId: number) {
      stopBackgroundSync();
      backgroundRunning.value = true;
      const tick = async () => {
        if (!backgroundRunning.value || resolveProjectId() !== projectId || resolveScriptId() !== scriptId) {
          stopBackgroundSync();
          return;
        }
        const data = await fetchRuntimeSnapshot(projectId, scriptId);
        if (!data || resolveProjectId() !== projectId || resolveScriptId() !== scriptId) return;
        messages.value = sanitizeRuntimeMessages(data.messages);
        const running = data.runState?.state === "running";
        // 断连且任务仍在后台运行时，保留"连接已断开（原因）…"提示，
        // 不让后台任务的阶段文案把它顶掉；终态仍以运行记录为准。
        const keepDisconnectLabel = !connected.value && workflowStatus.value.label.startsWith(DISCONNECT_LABEL_PREFIX);
        if (data.workflowStatus && !(keepDisconnectLabel && running)) workflowStatus.value = data.workflowStatus;
        if (!running) {
          // 后台任务已结束（完成 / 失败 / 被停止）：回收本地忙碌态，退出轮询并刷新正式工作区数据
          status.value = "idle";
          stopBackgroundSync();
          await getFlowData();
        }
      };
      void tick();
      backgroundSyncTimer = setInterval(() => void tick(), 3000);
    }

    async function loadRuntime(projectId: number, scriptId: number) {
      const key = runtimeSnapshotKey(projectId, scriptId);
      const local = readLocalRuntime(projectId, scriptId);
      let remote: ProductionAgentRuntimeSnapshot | null = null;
      try {
        const response: any = await axios.post("/agents/getRuntime", { projectId, agentType: "productionAgent", episodesId: scriptId });
        if (response?.data && Array.isArray(response.data.messages)) remote = response.data;
      } catch (error) {
        console.error("[productionAgent] 服务端运行记录加载失败，使用本地缓存:", error);
      }
      if (resolveProjectId() !== projectId || resolveScriptId() !== scriptId) return false;
      // 服务端记录仍是 running 时以服务端为准：后台任务是否存活只有服务端知道，
      // 本地快照可能只是断连瞬间写下的 error 状态，不能因为时间戳更新就覆盖它。
      const selected =
        remote && (remote.runState?.state === "running" || !local || remote.updatedAt >= local.updatedAt)
          ? remote
          : local;
      runtimeHydratedKey = key;
      if (!selected) return false;
      // 半异步：任务仍在后台运行时，保持运行态并开启进度轮询，不要误标为“已中断”。
      // 本地快照显示 running 时同样进入同步态：真相只有服务端知道（首次轮询即会校正）。
      if (selected.runState?.state === "running") {
        messages.value = sanitizeRuntimeMessages(selected.messages);
        const isRemoteRunning = selected === remote;
        workflowStatus.value =
          isRemoteRunning && selected.workflowStatus?.label
            ? selected.workflowStatus
            : { state: "working", label: isRemoteRunning ? "任务正在后台运行，正在同步进度…" : "检测到可能有后台任务在运行，正在同步进度…" };
        startBackgroundSync(projectId, scriptId);
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

    async function clearRuntime(projectId: number, scriptId: number) {
      stopBackgroundSync();
      cancelRuntimeSnapshot();
      runtimeHydratedKey = null;
      localStorage.removeItem(runtimeSnapshotKey(projectId, scriptId));
      clearMessages();
      await axios.post("/agents/clearRuntime", { projectId, agentType: "productionAgent", episodesId: scriptId });
      if (resolveProjectId() === projectId && resolveScriptId() === scriptId) runtimeHydratedKey = runtimeSnapshotKey(projectId, scriptId);
    }

    function saveRuntimeSnapshot() {
      const projectId = currentProjectId.value;
      const scriptId = episodesId.value;
      if (!projectId || !scriptId) return;
      // 后台任务运行期间由服务端运行记录作为唯一数据源，前端不回写快照，避免覆盖后台进度
      if (backgroundRunning.value) return;
      const key = runtimeSnapshotKey(projectId, scriptId);
      const snapshot = createRuntimeSnapshot();
      let serialized = "";
      try {
        serialized = JSON.stringify(snapshot);
      } catch (error) {
        console.error("[productionAgent] 运行时快照序列化失败:", error);
        return;
      }
      // 超大快照跳过本地缓存：localStorage 同步写会阻塞主线程，浏览器配额也容易超限
      if (serialized.length <= RUNTIME_SNAPSHOT_MAX_BYTES) {
        try {
          localStorage.setItem(key, serialized);
        } catch {
          // Browser storage is only a fallback; server persistence remains authoritative.
        }
      }
      if (runtimeHydratedKey !== key) return;
      // 断连期间不回写服务端运行记录：断连时本地会把状态标成“连接已断开”，
      // 若回写会覆盖后台任务仍在推进的 running 状态，导致重连后无法通过运行记录
      // 恢复进度同步（任务真正的结束由服务端自行落库）。
      if (!connected.value) return;
      // 生成中的 running 记录由服务端运行记录器持续写入（实时进度比前端节流快照更新），
      // 前端只在生成结束后补写最终状态，避免节流后的旧快照回退覆盖服务端进度。
      if (snapshot.runState.state === "running") return;
      void axios.post("/agents/setRuntime", { projectId, agentType: "productionAgent", episodesId: scriptId, data: snapshot }).catch((error) => {
        console.error("[productionAgent] 服务端运行记录保存失败:", error);
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
    watch([currentProjectId, episodesId, contentVersion, workflowStatus], () => scheduleRuntimeSnapshot(), { deep: true });
    // 断线重连后自动同步运行记录；断连时改用 HTTP 轮询继续同步后台进度（getRuntime 不依赖 socket）
    let sawConnected = false;
    watch(connected, (value) => {
      if (!value) {
        const projectId = resolveProjectId();
        const scriptId = resolveScriptId();
        const busy =
          workflowStatus.value.state === "working" ||
          workflowStatus.value.state === "retrying" ||
          status.value === "streaming" ||
          status.value === "pending";
        if (projectId && scriptId && busy) startBackgroundSync(projectId, scriptId);
        return;
      }
      if (!sawConnected) {
        sawConnected = true;
        return;
      }
      const projectId = resolveProjectId();
      const scriptId = resolveScriptId();
      if (projectId && scriptId) void loadRuntime(projectId, scriptId);
    });
    // 用户在页面发起新生成时，实时流接管进度展示，后台轮询让位（仅连接可用时让位）
    watch(status, (value) => {
      if (backgroundRunning.value && connected.value && (value === "streaming" || value === "pending")) {
        stopBackgroundSync();
      }
    });

    // 注册 getPlanData 事件（无需依赖组件生命周期）
    watch(
      socket,
      (s) => {
        if (s) {
          s.on("connect", () => {
            getHistory();
          });
          s.on("getFlowData", (_, callback) => {
            callback(flowData.value);
          });
          s.on("updateStoryboardAssetBinding", (data) => {
            const storyboard = flowData.value.storyboard.find((item) => item.id === data.storyboardId);
            if (!storyboard) return;
            if (Array.isArray(data.associateAssetsIds)) {
              storyboard.associateAssetsIds = [...data.associateAssetsIds];
            }
          });
          s.on("updateStoryboardPrompt", (data) => {
            const storyboard = flowData.value.storyboard.find((item) => item.id === data?.storyboardId);
            if (!storyboard || typeof data?.prompt !== "string") return;
            storyboard.prompt = data.prompt;
            if (typeof data.videoDesc === "string") storyboard.videoDesc = data.videoDesc;
          });
          s.on("flowDataUpdated", async () => {
            await getFlowData();
          });
        }
      },
      { immediate: true },
    );

    function resolveProjectId() {
      const value = currentProjectId.value ?? projectStore().project?.id;
      if (value == null) return undefined;
      const projectId = Number(value);
      return Number.isFinite(projectId) ? projectId : undefined;
    }

    function resolveScriptId(scriptId?: number) {
      return scriptId ?? episodesId.value;
    }

    async function setFlowData(scriptId?: number) {
      const projectId = resolveProjectId();
      const episodeId = resolveScriptId(scriptId);
      if (!projectId || !episodeId) return;
      await axios.post("/production/saveFlowData", {
        projectId,
        data: flowData.value,
        episodesId: episodeId,
      });
    }

    let flowDataRequestId = 0;

    async function getFlowData() {
      const projectId = resolveProjectId();
      const episodeId = resolveScriptId();
      if (!projectId || !episodeId) return;
      const requestId = ++flowDataRequestId;
      const { data } = await axios.post("/production/getFlowData", {
        projectId,
        episodesId: episodeId,
      });
      if (
        requestId !== flowDataRequestId ||
        resolveProjectId() !== projectId ||
        resolveScriptId() !== episodeId
      ) return;
      flowData.value = data;
    }
    function updateContext(projectId?: number, scriptId?: number) {
      if (typeof projectId === "number") currentProjectId.value = projectId;
      if (typeof scriptId === "number") episodesId.value = scriptId;
      const resolvedProjectId = resolveProjectId();
      if (!resolvedProjectId) return;
      stopBackgroundSync();
      cancelRuntimeSnapshot();
      runtimeHydratedKey = null;
      chatAuth.isolationKey = `${resolvedProjectId}:productionAgent${episodesId.value != null ? `:${episodesId.value}` : ""}`;
      chatAuth.projectId = resolvedProjectId;
      chatAuth.scriptId = episodesId.value;
      const ctx = {
        isolationKey: chatAuth.isolationKey,
        projectId: resolvedProjectId,
        scriptId: episodesId.value,
      };
      if (socket.value) {
        socket.value.auth = {
          token: localStorage.getItem("token"),
          ...ctx,
        };
      }
      if (!connected.value) {
        connect();
        socket.value?.once("connect", () => socket.value?.emit("updateContext", ctx));
      } else {
        socket.value?.emit("updateContext", ctx);
      }
    }

    function setDataContext(projectId: number, scriptId: number) {
      currentProjectId.value = projectId;
      episodesId.value = scriptId;
    }
    const loadingHistory = ref(false);
    let historyRequestId = 0;
    async function getHistory() {
      const projectId = resolveProjectId();
      const episodeId = resolveScriptId();
      if (!projectId) {
        messages.value = [...defMsg];
        return;
      }
      const requestId = ++historyRequestId;
      loadingHistory.value = true;
      try {
        // 优先恢复运行记录（含断连后仍在后台运行的任务进度），无记录时回退到记忆
        if (episodeId) {
          const restored = await loadRuntime(projectId, episodeId);
          if (requestId !== historyRequestId || resolveProjectId() !== projectId || resolveScriptId() !== episodeId) return;
          if (restored) {
            messages.value = [...defMsg, ...messages.value.filter((message) => message.id !== "welcome")];
            return;
          }
        }
        const { data } = await axios.post(`/agents/getMemory`, {
          projectId,
          episodesId: episodeId,
          agentType: "productionAgent",
        });
        if (
          requestId !== historyRequestId ||
          resolveProjectId() !== projectId ||
          resolveScriptId() !== episodeId
        ) return;
        messages.value = [...defMsg, ...(Array.isArray(data) ? data : [])];
      } catch (error: any) {
        if (requestId !== historyRequestId || resolveProjectId() !== projectId || resolveScriptId() !== episodeId) return;
        messages.value = [...defMsg];
        window.$message.error(error?.message || "生产 Agent 历史记录加载失败");
      } finally {
        if (requestId === historyRequestId) loadingHistory.value = false;
      }
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
      flowData,
      setFlowData,
      getFlowData,
      episodesId,
      currentProjectId,
      currentScriptId: episodesId,
      updateContext,
      setDataContext,
      getHistory,
      loadingHistory,
      reconnect,
      disconnect,
      backgroundRunning,
      loadRuntime,
      clearRuntime,
    };
  },
  { persist: false },
);
