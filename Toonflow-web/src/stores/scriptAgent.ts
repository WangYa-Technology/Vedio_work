import axios from "@/utils/axios";
import settingStore from "@/stores/setting";
import { useChat } from "@/utils/useChat";

interface PlanData {
  storySkeleton: string;
  adaptationStrategy: string;
  script: { id?: number; name: string; content: string }[];
}

function createEmptyPlanData(): PlanData {
  return {
    storySkeleton: "",
    adaptationStrategy: "",
    script: [],
  };
}

function clonePlanData(data: PlanData): PlanData {
  return {
    storySkeleton: data.storySkeleton || "",
    adaptationStrategy: data.adaptationStrategy || "",
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
    const chatAuth = reactive({
      isolationKey: "",
      projectId: undefined as number | undefined,
    });

    const { connected, messages, renderableMessages, chat, stopGenerate, socket, status, connect, reconnect, disconnect, clearMessages } = useChat({
      url: `${settingStore().baseUrl}/socket/scriptAgent`,
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
      planData,
      currentProjectId,
      setPlanData,
      updateContext,
      reconnect,
      disconnect,
    };
  },
  { persist: false },
);
