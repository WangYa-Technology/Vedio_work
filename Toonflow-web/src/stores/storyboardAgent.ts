import axios from "@/utils/axios";
import projectStore from "@/stores/project";
import settingStore from "@/stores/setting";
import { useChat } from "@/utils/useChat";

export default defineStore(
  "storyboardAgent",
  () => {
    // Storyboard data state
    const shots = ref<any[]>([]);
    const characterBible = ref<any>(null);
    const directorAlignment = ref<any>(null);
    const assetPrompts = ref<any[]>([]);
    const currentScriptId = ref<number | null>(null);
    const platformMode = ref<"seedance" | "jurilü" | "generic">("generic");
    const currentProjectId = ref<number | null>(null);

    // Computed: shots grouped by episode
    const shotsByEpisode = computed(() => {
      const grouped: Record<number, any[]> = {};
      for (const shot of shots.value) {
        const ep = shot.episodeNumber ?? 0;
        if (!grouped[ep]) grouped[ep] = [];
        grouped[ep].push(shot);
      }
      return grouped;
    });

    const { connected, messages, chat, stopGenerate, socket, status, reconnect, connect, disconnect } = useChat({
      url: `${settingStore().baseUrl}/socket/storyboardAgent`,
      auth: {
        isolationKey: `${projectStore().project?.id}:storyboardAgent`,
        projectId: projectStore().project?.id,
        scriptId: currentScriptId.value,
      },
      manageLifecycle: false,
      autoConnect: false,
    });

    // Register socket event handlers when socket is ready
    watch(
      socket,
      (s) => {
        if (s) {
          s.on("connect", () => {
            getHistory();
          });
          s.on("storyboard:shotsUpdated", () => {
            fetchShots();
          });
          s.on("storyboard:characterBibleUpdated", () => {
            fetchCharacterBible();
          });
          s.on("storyboard:directorAlignmentUpdated", () => {
            fetchDirectorAlignment();
          });
          s.on("storyboard:assetPromptsUpdated", () => {
            fetchAssetPrompts();
          });
        }
      },
      { immediate: true },
    );

    function updateContext(projectId: number, scriptId?: number) {
      currentProjectId.value = projectId;
      if (scriptId !== undefined) currentScriptId.value = scriptId;

      const ctx = {
        isolationKey: `${projectId}:storyboardAgent${scriptId !== undefined ? `:${scriptId}` : ""}`,
        projectId,
        scriptId,
      };
      if (!connected.value) connect();
      socket.value?.emit("updateContext", ctx);
    }

    // HTTP data fetch functions
    async function fetchStoryboardData(projectId?: number) {
      const pid = projectId ?? currentProjectId.value;
      if (!pid) return;
      const { data } = await axios.post("/storyboard/getStoryboardData", { projectId: pid });
      if (data.data) {
        shots.value = data.data.shots || [];
        characterBible.value = data.data.characterBible ?? null;
        directorAlignment.value = data.data.directorAlignment ?? null;
        assetPrompts.value = data.data.assetPrompts || [];
      }
    }

    async function fetchShots() {
      if (!currentProjectId.value) return;
      const { data } = await axios.post("/storyboard/getStoryboardData", { projectId: currentProjectId.value });
      if (data.data) shots.value = data.data.shots || [];
    }

    async function fetchCharacterBible() {
      if (!currentProjectId.value) return;
      const { data } = await axios.post("/storyboard/getCharacterBible", { projectId: currentProjectId.value });
      if (data.data !== undefined) characterBible.value = data.data;
    }

    async function fetchDirectorAlignment() {
      if (!currentProjectId.value) return;
      const { data } = await axios.post("/storyboard/getDirectorAlignment", { projectId: currentProjectId.value });
      if (data.data !== undefined) directorAlignment.value = data.data;
    }

    async function fetchAssetPrompts() {
      if (!currentProjectId.value) return;
      const { data } = await axios.post("/storyboard/getAssetPrompts", { projectId: currentProjectId.value });
      if (data.data) assetPrompts.value = data.data;
    }

    async function setPlatformMode(mode: "seedance" | "jurilü" | "generic") {
      if (!currentProjectId.value) return;
      await axios.post("/storyboard/setPlatformMode", { projectId: currentProjectId.value, platformMode: mode });
      platformMode.value = mode;
      await fetchShots();
    }

    const loadingHistory = ref(false);
    async function getHistory() {
      loadingHistory.value = true;
      const { data } = await axios.post("/agents/getMemory", {
        projectId: currentProjectId.value ?? projectStore().project?.id,
        agentType: "storyboardAgent",
      });
      messages.value = [];
      messages.value = [...data];
      loadingHistory.value = false;
    }

    return {
      connected,
      messages,
      chat,
      stopGenerate,
      socket,
      status,
      reconnect,
      connect,
      disconnect,
      shots,
      characterBible,
      directorAlignment,
      assetPrompts,
      currentScriptId,
      platformMode,
      currentProjectId,
      shotsByEpisode,
      loadingHistory,
      updateContext,
      fetchStoryboardData,
      fetchShots,
      fetchCharacterBible,
      fetchDirectorAlignment,
      fetchAssetPrompts,
      setPlatformMode,
      getHistory,
    };
  },
  { persist: false },
);
