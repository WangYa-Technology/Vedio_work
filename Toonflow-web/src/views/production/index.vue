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
          <t-button variant="outline" size="small" @click="workbenchVisible = true">
            <template #icon>
              <i-playback-progress size="14" />
            </template>
            {{ $t("workbench.production.wb.videoGeneration") }}
          </t-button>
          <i-loading-four class="spin" size="16" v-show="loadingData" />
        </div>
      </div>

      <div class="shotList" v-loading="loadingData">
        <template v-if="storyboardSegments.length > 0">
          <div
            v-for="(segment, index) in storyboardSegments"
            :key="segment.id"
            class="shotCard segmentCard">
            <div class="shotIndex">{{ index + 1 }}</div>
            <div class="shotContent">
              <div class="shotPrompt">{{ segment.sceneTitle }} / {{ segment.segmentTitle }}</div>
              <div class="shotMeta f ac" style="gap: 8px; margin-top: 4px; flex-wrap: wrap">
                <t-tag size="small" variant="outline">{{ segment.durationLabel }}</t-tag>
                <t-tag size="small" variant="light">{{ segment.rows.length }} 镜</t-tag>
              </div>
              <div class="shotFields">
                <div v-if="segment.assetNames" class="shotField">
                  <span class="shotFieldLabel">参考</span>
                  <span class="shotFieldValue">{{ segment.assetNames }}</span>
                </div>
                <div v-for="row in segment.rows" :key="`${segment.id}-${row.serial}`" class="segmentShot">
                  <div class="segmentShotHeader">
                    <t-tag size="small" variant="outline">镜头 {{ row.serial }}</t-tag>
                    <t-tag v-if="row.duration" size="small" variant="light">{{ row.duration }}s</t-tag>
                    <t-tag v-if="row.scale" size="small" variant="light">{{ row.scale }}</t-tag>
                    <t-tag v-if="row.cameraMovement" size="small" variant="light">{{ row.cameraMovement }}</t-tag>
                  </div>
                  <div class="segmentShotDesc">{{ row.description }}</div>
                  <div v-if="row.dialogue" class="segmentShotLine">台词：{{ row.dialogue }}</div>
                  <div v-if="row.sound" class="segmentShotLine">音效：{{ row.sound }}</div>
                </div>
              </div>
            </div>
          </div>
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
          <span class="chatTitle">{{ currentEpisodeLabel || $t("workbench.production.productionAgent") }}</span>
        </span>
        <div class="f ac" style="gap: 6px">
          <t-select
            :value="thinkLevel"
            :options="thinkLevelOptions"
            autoWidth
            size="small"
            @change="handleThinkLevelChange" />
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
          :textarea-props="{
            placeholder: $t('workbench.production.chatBox.inputPlaceholder'),
            autosize: { minRows: 2, maxRows: 5 },
          }"
          @send="handleSend"
          @stop="handleStop" />
      </div>
    </div>
  </div>
  <workbench v-model:visible="workbenchVisible" />
</template>

<script setup lang="ts">
import axios from "@/utils/axios";
import projectStore from "@/stores/project";
import productionAgentStore from "@/stores/productionAgent";
import workbench from "./components/workbench/index.vue";

const projectState = projectStore();
const { project, allProject } = storeToRefs(projectState);
const productionStore = productionAgentStore();
const { flowData, connected, messages, status, loadingHistory, thinkLevel } = storeToRefs(productionStore);

const inputValue = ref("");
const loadingData = ref(false);
const workbenchVisible = ref(false);
const episodesOptions = ref<{ label: string; value: number }[]>([]);
const currentEpisodesId = ref<number | null>(null);
const thinkLevelOptions = [
  { label: "关闭思考", value: 0 },
  { label: "快速思考", value: 1 },
  { label: "深度思考", value: 2 },
];
const storyboardShots = computed(() => (Array.isArray(flowData.value?.storyboard) ? flowData.value.storyboard : []));
const storyboardSegments = computed(() => {
  const segments = parseStoryboardTable(flowData.value?.storyboardTable || "");
  if (segments.length) return segments;
  return storyboardShots.value.map((shot: any, index: number) => ({
    id: `shot-${shot.id ?? index}`,
    sceneTitle: "分镜表",
    segmentTitle: `第 ${shot.shotNumber ?? index + 1} 镜`,
    durationLabel: shot.duration ? `${shot.duration}s` : "未标注时长",
    assetNames: shot.associateAssetsIds?.length ? `#${shot.associateAssetsIds.join(", #")}` : "",
    rows: [
      {
        serial: shot.shotNumber ?? index + 1,
        description: shot.content || shot.description || shot.videoDesc || "",
        duration: shot.duration,
        scale: shot.scale,
        cameraMovement: shot.cameraMovement,
        dialogue: shot.dialogue,
        sound: shot.sound,
      },
    ],
  }));
});

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

function parseStoryboardTable(markdown: string) {
  const lines = markdown.split(/\r?\n/);
  const segments: any[] = [];
  let currentScene = "";
  let currentSegment: any = null;

  const finishSegment = () => {
    if (currentSegment?.rows?.length) segments.push(currentSegment);
    currentSegment = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("## ")) {
      finishSegment();
      currentScene = line.replace(/^##\s*/, "").trim();
      continue;
    }
    const segmentMatch = line.match(/^###\s*(片段[^\s（(]+)(?:[（(]([^）)]+)[）)])?/);
    if (segmentMatch) {
      finishSegment();
      currentSegment = {
        id: `segment-${segments.length + 1}`,
        sceneTitle: currentScene || "未命名场景",
        segmentTitle: segmentMatch[1],
        durationLabel: segmentMatch[2] || "未标注时长",
        assetNames: "",
        assetIds: "",
        rows: [],
      };
      continue;
    }
    if (!currentSegment) continue;
    if (line.startsWith("**引用资产名称**")) {
      currentSegment.assetNames = line.replace(/^\*\*引用资产名称\*\*[:：]\s*/, "").replace(/^\[/, "").replace(/\]$/, "");
      continue;
    }
    if (line.startsWith("**引用资产ID**")) {
      currentSegment.assetIds = line.replace(/^\*\*引用资产ID\*\*[:：]\s*/, "").replace(/^\[/, "").replace(/\]$/, "");
      continue;
    }
    if (!line.startsWith("|") || line.includes("---") || line.includes("序号")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length < 7) continue;
    currentSegment.rows.push({
      serial: cells[0],
      description: cells[1],
      duration: cells[2],
      scale: cells[3],
      cameraMovement: cells[4],
      dialogue: cells[5].replace(/^台词[：:]\s*/, "").trim(),
      sound: cells[6].replace(/^音效[：:]\s*/, "").trim(),
    });
  }
  finishSegment();
  return segments;
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
  if (episodesOptions.value.length && !episodesOptions.value.some((item) => item.value === currentEpisodesId.value)) {
    currentEpisodesId.value = episodesOptions.value[0].value;
  }
}

async function ensureProjectContext() {
  if (project.value?.id) return true;
  const { data } = await axios.post("/project/getProject");
  const projects = Array.isArray(data) ? data : [];
  allProject.value = projects;
  if (!projects.length) return false;

  project.value = [...projects].sort((a: any, b: any) => Number(b.createTime || 0) - Number(a.createTime || 0))[0];
  return Boolean(project.value?.id);
}

async function refreshData() {
  if (!project.value?.id) return;
  loadingData.value = true;
  try {
    const scriptId = currentEpisodesId.value;
    if (!scriptId) return;
    productionStore.updateContext(Number(project.value.id), scriptId);
    await Promise.all([productionStore.getFlowData(), productionStore.getHistory()]);
  } finally {
    loadingData.value = false;
  }
}

async function handleEpisodesChange(value: unknown) {
  const rawValue = Array.isArray(value) ? value[0] : value;
  const nextId = Number(rawValue);
  if (!Number.isFinite(nextId) || nextId === currentEpisodesId.value) return;
  currentEpisodesId.value = nextId;
  productionStore.updateContext(Number(project.value!.id), nextId);
  loadingData.value = true;
  try {
    await Promise.all([productionStore.getFlowData(), productionStore.getHistory()]);
  } finally {
    loadingData.value = false;
  }
}

function handleSend(text: string) {
  productionStore.chat(text);
  inputValue.value = "";
}

function handleStop() {
  productionStore.stopGenerate();
}

function handleThinkLevelChange(value: unknown) {
  const rawValue = Array.isArray(value) ? value[0] : value;
  productionStore.updateThinkConfig(Number(rawValue));
}

function handleReconnect() {
  const dialog = DialogPlugin.confirm({
    header: $t("workbench.scriptAgent.msg.reconnect"),
    body: $t("workbench.scriptAgent.msg.notReconnect"),
    confirmBtn: $t("workbench.scriptAgent.msg.keepReconnect"),
    cancelBtn: $t("workbench.scriptAgent.msg.cancel"),
    theme: "warning",
    onConfirm: async () => {
      productionStore.reconnect();
      dialog.destroy();
    },
  });
}

const handleActions = {
  suggestion: (data?: any) => {
    productionStore.chat(data?.content?.prompt);
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
        agentType: "productionAgent",
        episodesId: currentEpisodesId.value,
        type,
      });
      window.$message.success($t("workbench.production.chatBox.memoryCleared", { type: memoryTypeLabel[type] }));
      dialog.destroy();
      productionStore.getHistory();
    },
  });
}

onMounted(async () => {
  loadingData.value = true;
  try {
    const hasProject = await ensureProjectContext();
    if (!hasProject) return;
    await loadEpisodes();
    if (!currentEpisodesId.value) return;
    // 首次进入时也要通过 updateContext 设置 socket 的项目/剧集上下文；
    // 仅调用 connect 会用到初始化时的空 scriptId，后续聊天和状态推送会落到错误上下文。
    productionStore.updateContext(Number(project.value!.id), currentEpisodesId.value);
    await Promise.all([productionStore.getFlowData(), productionStore.getHistory()]);
  } catch (error) {
    console.error("加载制作页数据失败:", error);
    window.$message.error("加载项目或分镜数据失败");
  } finally {
    loadingData.value = false;
  }
});

onUnmounted(() => {
  productionStore.disconnect();
});
</script>

<style lang="scss" scoped>
.productionLayout {
  display: flex;
  height: 100%;
  overflow: hidden;

  .shotPanel {
    width: 60%;
    min-height: 0;
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
      min-height: 0;
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

          .shotFields {
            display: flex;
            flex-direction: column;
            gap: 4px;
            margin-top: 6px;

            .shotField {
              display: flex;
              gap: 6px;
              align-items: flex-start;
              font-size: 12px;
              line-height: 1.45;
              color: var(--td-text-color-secondary, #666);

              .shotFieldLabel {
                flex-shrink: 0;
                min-width: 34px;
                color: var(--td-text-color-placeholder, #999);
              }

              .shotFieldValue {
                flex: 1;
                min-width: 0;
                word-break: break-word;
              }
            }
          }

        }
      }

      .segmentCard {
        .shotPrompt {
          font-weight: 700;
        }

        .segmentShot {
          margin-top: 8px;
          padding: 8px;
          border: 1px solid var(--td-border-level-1-color, #ececec);
          border-radius: 6px;
          background: var(--td-bg-color-page, #fafafa);
        }

        .segmentShotHeader {
          display: flex;
          gap: 5px;
          flex-wrap: wrap;
          margin-bottom: 5px;
        }

        .segmentShotDesc {
          color: var(--td-text-color-primary, #333);
          font-size: 12px;
          line-height: 1.55;
          word-break: break-word;
        }

        .segmentShotLine {
          margin-top: 4px;
          color: var(--td-text-color-secondary, #666);
          font-size: 12px;
          line-height: 1.5;
          word-break: break-word;
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
    min-height: 0;
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
      min-height: 0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      padding: 0 8px;

      :deep(.t-chat__list) {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
      }

      .chatSender {
        flex-shrink: 0;
        padding-bottom: 8px;

        :deep(.t-chat-sender__textarea) {
          border-color: var(--td-border-level-2-color, #d0d0d0);
          background: var(--td-bg-color-container, #fff);
        }

        :deep(.t-textarea__inner::placeholder) {
          color: var(--td-text-color-placeholder, #999);
          opacity: 1;
        }
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
