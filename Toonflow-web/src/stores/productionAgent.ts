import axios from "@/utils/axios";
import projectStore from "@/stores/project";
import settingStore from "@/stores/setting";
import { useChat } from "@/utils/useChat";
import type { FlowData } from "@/views/production/types";
import type { ChatMessagesData } from "@tdesign-vue-next/chat";
import { useThrottleFn } from "@vueuse/core";

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

    const { connected, messages, chat, stopGenerate, socket, status, reconnect, connect, disconnect } = useChat({
      url: `${settingStore().baseUrl}/socket/productionAgent`,
      auth: chatAuth,
      manageLifecycle: false,
      autoConnect: false,
      xmlTags: [
        { tag: "script", keepInMessage: false },
        { tag: "scriptPlan", keepInMessage: false },
        { tag: "storyboardTable", keepInMessage: false },
      ],
      onXmlTag: async (data) => {
        const { tag, value, status } = data;
        if (tag === "script") {
          flowData.value.script = value ?? "";
        } else if (tag === "scriptPlan") {
          flowData.value.scriptPlan = value ?? "";
        } else if (tag === "storyboardTable") {
          flowData.value.storyboardTable = value ?? "";
        }
        if (status == "complete") {
          throttledFn();
        }
      },
      onError: (error) => {
        window.$message.error(error.message || "生产 Agent 请求失败");
      },
    });

    // 实际的节流方法
    const throttledFn = useThrottleFn(
      () => {
        setFlowData(episodesId.value);
      },
      500,
      true,
      true,
    );
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

    async function getFlowData() {
      const projectId = resolveProjectId();
      const episodeId = resolveScriptId();
      if (!projectId || !episodeId) return;
      const { data } = await axios.post("/production/getFlowData", {
        projectId,
        episodesId: episodeId,
      });
      flowData.value = data;
    }
    function updateContext(projectId?: number, scriptId?: number) {
      if (typeof projectId === "number") currentProjectId.value = projectId;
      if (typeof scriptId === "number") episodesId.value = scriptId;
      const resolvedProjectId = resolveProjectId();
      if (!resolvedProjectId) return;
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
      if (!connected.value) connect();
      socket.value?.emit("updateContext", ctx);
    }

    function setDataContext(projectId: number, scriptId: number) {
      currentProjectId.value = projectId;
      episodesId.value = scriptId;
    }
    const loadingHistory = ref(false);
    async function getHistory() {
      loadingHistory.value = true;
      try {
        const projectId = resolveProjectId();
        const episodeId = resolveScriptId();
        if (!projectId) {
          messages.value = [...defMsg];
          return;
        }
        const { data } = await axios.post(`/agents/getMemory`, {
          projectId,
          episodesId: episodeId,
          agentType: "productionAgent",
        });
        messages.value = [...defMsg, ...(Array.isArray(data) ? data : [])];
      } catch (error: any) {
        messages.value = [...defMsg];
        window.$message.error(error?.message || "生产 Agent 历史记录加载失败");
      } finally {
        loadingHistory.value = false;
      }
    }

    const thinkLevel = ref(0);
    function updateThinkConfig(level: number) {
      thinkLevel.value = Number(level) || 0;
      socket.value?.emit("updateThinkConfig", {
        think: thinkLevel.value > 0,
        thinlLevel: thinkLevel.value,
      });
    }

    return {
      connected,
      messages,
      chat,
      stopGenerate,
      socket,
      status,
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
      thinkLevel,
      updateThinkConfig,
      reconnect,
      disconnect,
    };
  },
  { persist: false },
);
