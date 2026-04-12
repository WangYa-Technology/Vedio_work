<template>
  <div class="productionLayout">
    <!-- Left Panel: Shot list grouped by episode -->
    <div class="shotPanel">
      <div class="panelHeader f ac jb">
        <span class="panelTitle">{{ $t("workbench.production.shots") }}</span>
        <div class="f ac" style="gap: 8px">
          <t-select
            :value="currentEpisodesId ?? undefined"
            :placeholder="$t('workbench.production.selectPlaceholder')"
            autoWidth
            :options="episodesOptions"
            filterable
            @change="handleEpisodesChange">
            <template #label>
              <i-document-folder size="20" />
            </template>
          </t-select>
          <t-tooltip placement="bottom" theme="primary" :content="$t('workbench.production.getFlowData')">
            <t-button variant="outline" size="small" @click="refreshData">
              <template #icon>
                <i-refresh size="14" />
              </template>
            </t-button>
          </t-tooltip>
          <i-loading-four class="spin" size="16" v-show="loadingData" />
        </div>
      </div>

      <div class="shotList" v-loading="loadingData">
        <template v-if="shots.length > 0">
          <template v-for="(episodeShots, episodeNumber) in shotsByEpisode" :key="episodeNumber">
            <div class="episodeHeader">
              <span>{{ $t("workbench.production.episode") }} {{ episodeNumber }}</span>
              <t-tag size="small" variant="light">{{ episodeShots.length }}</t-tag>
            </div>
            <div
              v-for="(shot, index) in episodeShots"
              :key="shot.id ?? index"
              class="shotCard">
              <div class="shotIndex">{{ index + 1 }}</div>
              <div class="shotContent">
                <div class="shotPrompt">{{ shot.prompt || shot.description || $t("workbench.production.noPrompt") }}</div>
                <div class="shotMeta f ac" style="gap: 8px; margin-top: 4px">
                  <t-tag v-if="shot.duration" size="small" variant="outline">{{ shot.duration }}s</t-tag>
                  <t-tag v-if="shot.track" size="small" variant="light">{{ shot.track }}</t-tag>
                  <t-tag v-if="shot.state" size="small" :theme="stateTheme(shot.state)">{{ shot.state }}</t-tag>
                </div>
                <div v-if="shot.src" class="shotImageWrap">
                  <t-image :src="shot.src" fit="contain" style="max-height: 120px; border-radius: 4px; margin-top: 6px" />
                </div>
              </div>
            </div>
          </template>
        </template>
        <div v-else class="emptyShots">
          <t-empty :description="$t('workbench.production.noShots')" />
        </div>
      </div>
    </div>

    <!-- Right Panel: Chat interface -->
    <div class="chatPanel">
      <div class="chatHeader f ac jb">
        <span class="f ac" style="gap: 6px">
          <i-dot theme="outline" :fill="connected ? 'green' : 'red'" />
          <span class="chatTitle">{{ currentEpisodeLabel || $t("workbench.production.storyboardAgent") }}</span>
        </span>
        <div class="f ac" style="gap: 6px">
          <t-popup trigger="click" placement="bottom-right">
            <t-button shape="square" variant="outline" size="small">
              <template #icon>
                <i-setting-config size="14" />
              </template>
            </t-button>
            <template #content>
              <div class="settingMenu">
                <div class="settingMenuItem" @click="handleReconnect">
                  <i-api size="14" />
                  <span>{{ $t("workbench.scriptAgent.reconnect") }}</span>
                </div>
                <div class="settingMenuItem" @click="handleClearMemory('message')">
                  <i-delete size="14" />
                  <span>{{ $t("workbench.production.chatBox.clearMessageMemory") }}</span>
                </div>
                <div class="settingMenuItem" @click="handleClearMemory('summary')">
                  <i-close size="14" />
                  <span>{{ $t("workbench.production.chatBox.clearSummaryMemory") }}</span>
                </div>
                <div class="settingMenuItem danger" @click="handleClearMemory('all')">
                  <i-delete-one size="14" />
                  <span>{{ $t("workbench.production.chatBox.clearAllMemory") }}</span>
                </div>
              </div>
            </template>
          </t-popup>
        </div>
      </div>

      <div class="chatBody" v-loading="loadingHistory">
        <t-chat-list :clear-history="false">
          <t-chat-message
            v-for="message in messages"
            :key="message.id"
            :message="message"
            :name="(message as any).name"
            :placement="message.role === 'user' ? 'right' : 'left'"
            :variant="message.role === 'user' ? 'base' : 'outline'"
            :handleActions="message.role === 'user' ? {} : handleActions"
            :status="message.status"
            allowContentSegmentCustom />
        </t-chat-list>

        <t-chat-sender
          class="chatSender"
          :disabled="status === 'pending' || status === 'streaming' || !connected"
          v-model="inputValue"
          :loading="status === 'pending' || status === 'streaming'"
          :placeholder="$t('workbench.production.chatBox.inputPlaceholder')"
          @send="handleSend"
          @stop="handleStop" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import axios from "@/utils/axios";
import projectStore from "@/stores/project";
import storyboardAgentStore from "@/stores/storyboardAgent";

const { project } = storeToRefs(projectStore());
const store = storyboardAgentStore();
const { connected, messages, status, shots, shotsByEpisode, currentProjectId, currentScriptId, loadingHistory } = storeToRefs(store);

const inputValue = ref("");
const loadingData = ref(false);
const episodesOptions = ref<{ label: string; value: number }[]>([]);
const currentEpisodesId = ref<number | null>(null);

const currentEpisodeLabel = computed(() => {
  const ep = episodesOptions.value.find((o) => o.value === currentEpisodesId.value);
  return ep?.label ?? "";
});

function stateTheme(state: string) {
  if (state === "已完成") return "success";
  if (state === "生成中") return "warning";
  if (state === "生成失败") return "danger";
  return "default";
}

async function loadEpisodes() {
  const { data: scriptRes } = await axios.post("/script/getScrptApi", {
    projectId: project.value?.id,
    name: "",
  });
  episodesOptions.value = scriptRes.map((ep: any) => ({
    label: ep.name,
    value: ep.id,
  }));
  if (episodesOptions.value.length) {
    currentEpisodesId.value = episodesOptions.value[0].value;
  }
}

async function refreshData() {
  if (!project.value?.id) return;
  loadingData.value = true;
  try {
    await store.fetchStoryboardData(Number(project.value.id));
  } finally {
    loadingData.value = false;
  }
}

function handleEpisodesChange(value: unknown) {
  const rawValue = Array.isArray(value) ? value[0] : value;
  const nextId = Number(rawValue);
  if (!Number.isFinite(nextId) || nextId === currentEpisodesId.value) return;
  currentEpisodesId.value = nextId;
  store.updateContext(Number(project.value!.id), nextId);
  store.getHistory();
}

function handleSend(text: string) {
  store.chat(text);
  inputValue.value = "";
}

function handleStop() {
  store.stopGenerate();
}

function handleReconnect() {
  const dialog = DialogPlugin.confirm({
    header: $t("workbench.scriptAgent.msg.reconnect"),
    body: $t("workbench.scriptAgent.msg.notReconnect"),
    confirmBtn: $t("workbench.scriptAgent.msg.keepReconnect"),
    cancelBtn: $t("workbench.scriptAgent.msg.cancel"),
    theme: "warning",
    onConfirm: async () => {
      store.reconnect();
      dialog.destroy();
    },
  });
}

const handleActions = {
  suggestion: (data?: any) => {
    store.chat(data?.content?.prompt);
  },
};

const memoryTypeLabel: Record<string, string> = {
  message: $t("workbench.production.chatBox.messageMemory"),
  summary: $t("workbench.production.chatBox.summaryMemory"),
  all: $t("workbench.production.chatBox.allMemory"),
};

function handleClearMemory(type: "message" | "summary" | "all") {
  const dialog = DialogPlugin.confirm({
    header: $t("workbench.production.chatBox.confirmClear"),
    body: $t("workbench.production.chatBox.confirmClearBody", { type: memoryTypeLabel[type] }),
    confirmBtn: $t("workbench.production.chatBox.confirmClearBtn"),
    cancelBtn: $t("workbench.production.cancel"),
    theme: "warning",
    onConfirm: async () => {
      await axios.post("/agents/clearMemory", {
        projectId: project.value?.id,
        agentType: "storyboardAgent",
        episodesId: currentEpisodesId.value,
        type,
      });
      window.$message.success($t("workbench.production.chatBox.memoryCleared", { type: memoryTypeLabel[type] }));
      dialog.destroy();
      store.getHistory();
    },
  });
}

onMounted(async () => {
  if (!project.value?.id) return;
  await loadEpisodes();
  store.connect();
  currentProjectId.value = Number(project.value.id);
  if (currentEpisodesId.value) {
    currentScriptId.value = currentEpisodesId.value;
  }
  loadingData.value = true;
  try {
    await store.fetchStoryboardData(Number(project.value.id));
  } finally {
    loadingData.value = false;
  }
});

onUnmounted(() => {
  store.disconnect();
});
</script>

<style lang="scss" scoped>
.productionLayout {
  display: flex;
  height: 100%;
  overflow: hidden;

  .shotPanel {
    width: 60%;
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--td-border-level-1-color, #e7e7e7);
    overflow: hidden;

    .panelHeader {
      padding: 10px 16px;
      border-bottom: 1px solid var(--td-border-level-1-color, #e7e7e7);
      flex-shrink: 0;

      .panelTitle {
        font-size: 16px;
        font-weight: 600;
      }
    }

    .shotList {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;

      .episodeHeader {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 4px 4px;
        font-size: 13px;
        font-weight: 600;
        color: var(--td-text-color-secondary, #777);
        border-bottom: 1px solid var(--td-border-level-1-color, #e7e7e7);
        margin-top: 8px;

        &:first-child {
          margin-top: 0;
        }
      }

      .shotCard {
        display: flex;
        gap: 10px;
        padding: 10px;
        background: var(--td-bg-color-container, #fff);
        border: 1px solid var(--td-border-level-1-color, #e7e7e7);
        border-radius: 8px;
        transition: box-shadow 0.2s;

        &:hover {
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
        }

        .shotIndex {
          flex-shrink: 0;
          width: 28px;
          height: 28px;
          border-radius: 50%;
          background: var(--td-brand-color-light, #e8f0fe);
          color: var(--td-brand-color, #0052d9);
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 12px;
          font-weight: 600;
        }

        .shotContent {
          flex: 1;
          min-width: 0;

          .shotPrompt {
            font-size: 13px;
            line-height: 1.5;
            color: var(--td-text-color-primary, #333);
            word-break: break-word;
          }

          .shotImageWrap {
            margin-top: 6px;
          }
        }
      }

      .emptyShots {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
      }
    }
  }

  .chatPanel {
    width: 40%;
    display: flex;
    flex-direction: column;
    overflow: hidden;

    .chatHeader {
      padding: 10px 16px;
      border-bottom: 1px solid var(--td-border-level-1-color, #e7e7e7);
      flex-shrink: 0;

      .chatTitle {
        font-size: 15px;
        font-weight: 600;
      }
    }

    .chatBody {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      padding: 0 8px;

      :deep(.t-chat__list) {
        flex: 1;
        overflow-y: auto;
      }

      .chatSender {
        flex-shrink: 0;
        padding-bottom: 8px;
      }
    }
  }
}

.settingMenu {
  padding: 4px 0;
  .settingMenuItem {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 16px;
    font-size: 13px;
    cursor: pointer;
    white-space: nowrap;
    &:hover {
      background-color: #f3f3f3;
    }
    &.danger {
      color: #e34d59;
    }
  }
}
</style>
