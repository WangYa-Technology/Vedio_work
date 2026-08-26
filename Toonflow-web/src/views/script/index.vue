<template>
  <div class="script">
    <div class="actionBar">
      <div class="actionBar-left f ac">
        <t-input :placeholder="$t('workbench.script.searchPlaceholder')" v-model="searchQuery" class="searchInput" clearable style="width: 300px" />
        <t-button theme="primary" @click="onChange">
          <template #icon><i-search /></template>
          {{ $t("workbench.script.search") }}
        </t-button>
        <t-button theme="primary" @click="handleAddScript">
          <template #icon><i-plus /></template>
          {{ $t("workbench.script.addScript") }}
        </t-button>
      </div>
      <div class="actionBar-right f ac" v-if="scripts.length">
        <t-button :theme="isAllSelected ? 'default' : 'primary'" variant="outline" @click="toggleSelectAll(!isAllSelected)">
          {{ isAllSelected ? $t("workbench.script.cancelSelectAll") : $t("workbench.script.selectAll") }}
        </t-button>
        <t-button theme="primary" @click="handleExportScript" :disabled="selectedIds.length === 0">
          <template #icon><i-export /></template>
          {{ $t("workbench.script.exportScript") }}{{ selectedIds.length ? `(${selectedIds.length})` : "" }}
        </t-button>
        <t-button theme="primary" @click="handleExtractAssets" :loading="scriptLoad" :disabled="selectedIds.length === 0 || selectedHasActiveTask">
          <template #icon><i-export /></template>
          {{ $t("workbench.script.extractAssets") }}{{ selectedIds.length ? `(${selectedIds.length})` : "" }}
        </t-button>
        <t-button theme="primary" @click="handleBatchDelete" :disabled="selectedIds.length === 0 || selectedHasActiveTask">
          <template #icon><i-delete /></template>
          {{ $t("workbench.script.deleteScript") }}{{ selectedIds.length ? `(${selectedIds.length})` : "" }}
        </t-button>
      </div>
    </div>
    <div class="contentArea">
      <div v-if="scripts.length === 0" class="emptyState">
        <t-empty />
      </div>
      <div v-else class="scriptsList f w">
        <div v-for="(item, index) in scripts" :key="index" @click="handleScriptClick(item)" class="scriptCard">
          <t-card shadow hover-shadow :style="{ width: '400px', cursor: 'pointer' }">
            <template #header>
              <div class="cardHeader">
                <span class="cardTitle">{{ item.name }}</span>
                <t-checkbox :checked="selectedIds.includes(item.id)" @click.stop @change="toggleSelect(item.id)" class="cardCheckbox" />
              </div>
            </template>
            <span class="content">{{ item.content }}</span>

            <div class="assetStatus" :class="`is-${getAssetStatus(item)}`" @click.stop>
              <div class="assetStatusHeader">
                <div class="assetStatusTitle">
                  <i-time v-if="getAssetStatus(item) === 'queued'" size="16" />
                  <i-loading-four v-else-if="getAssetStatus(item) === 'running'" class="statusSpinner" size="16" />
                  <i-check v-else-if="getAssetStatus(item) === 'succeeded'" size="16" />
                  <i-error-circle-filled v-else-if="getAssetStatus(item) === 'failed' || getAssetStatus(item) === 'invalid'" size="16" />
                  <i-info v-else size="16" />
                  <span>{{ getAssetStatusText(item) }}</span>
                </div>
                <t-button
                  v-if="canRetryExtraction(item)"
                  size="small"
                  variant="text"
                  theme="primary"
                  :loading="extractingScriptIds.has(item.id)"
                  @click.stop="extractSingleScript(item.id)"
                >
                  <template #icon><i-refresh size="14" /></template>
                  {{ getAssetStatus(item) === "idle" ? $t("workbench.script.extractAssets") : $t("workbench.script.msg.retryExtract") }}
                </t-button>
              </div>
              <div v-if="isActiveExtraction(item) && item.extractStartedAt" class="assetStatusMeta">
                {{ $t("workbench.script.msg.statusElapsed", { duration: formatElapsed(item) }) }}
              </div>
              <div v-else-if="item.extractState === -1 && item.errorReason" class="assetStatusReason">
                {{ item.errorReason }}
              </div>
              <div v-if="getAssetStatus(item) !== 'succeeded' && item.relatedAssets?.length" class="assetStatusMeta">
                {{
                  $t(item.extractState == null ? "workbench.script.msg.statusManual" : "workbench.script.msg.statusPreserved", {
                    count: item.relatedAssets.length,
                  })
                }}
              </div>
              <div v-if="getAssetStatus(item) === 'succeeded'" class="assetTags">
                <t-tag v-for="asset in item.relatedAssets?.slice(0, 4)" :key="asset.id" variant="light-outline" size="small">
                  {{ asset.name }}
                </t-tag>
                <span v-if="(item.relatedAssets?.length || 0) > 4" class="moreAssets">+{{ (item.relatedAssets?.length || 0) - 4 }}</span>
              </div>
            </div>

            <div class="del">
              <i-delete theme="outline" size="18" @click.stop="handleDeleteScript(item.id)" style="cursor: pointer" />
            </div>
          </t-card>
        </div>
      </div>
    </div>
    <editScript v-model="detailsShow" :item="selectedScript" @searchScripts="searchScripts" />
    <addScript v-model="addScriptShow" @searchScripts="searchScripts" />
  </div>
</template>

<script setup lang="ts">
import axios from "@/utils/axios";
import editScript from "./components/editScript.vue";
import addScript from "./components/addScript.vue";
import projectStore from "@/stores/project";
import settingStore from "@/stores/setting";
const { otherSetting } = storeToRefs(settingStore());
const { project } = storeToRefs(projectStore());
interface ScriptAsset {
  id: number;
  name: string;
  describe: string;
  prompt: string;
  type: "role" | "tool" | "scene" | "clip";
}
interface Script {
  id: number;
  name: string;
  content: string;
  createTime?: number;
  extractState?: -2 | -1 | 0 | 1 | 2 | null; // -2 内容已更新 -1 失败 0 提取中 1 成功 2 等待
  errorReason?: string;
  extractStartedAt?: number | null;
  extractFinishedAt?: number | null;
  relatedAssets?: ScriptAsset[];
}
const scripts = ref<Script[]>([]);
const searchQuery = ref("");
const addScriptShow = ref(false);
const selectedIds = ref<number[]>([]);
const scriptLoad = ref(false);
const extractingScriptIds = ref(new Set<number>());
const statusClock = ref(Date.now());
let statusClockTimer: ReturnType<typeof setInterval> | null = null;
const isAllSelected = computed(() => scripts.value.length > 0 && selectedIds.value.length === scripts.value.length);
const selectedHasActiveTask = computed(() => selectedIds.value.some((id) => scripts.value.some((script) => script.id === id && isActiveExtraction(script))));

type AssetStatus = "idle" | "queued" | "running" | "succeeded" | "failed" | "stale" | "invalid";

function getAssetStatus(item: Script): AssetStatus {
  if (item.extractState === 2) return "queued";
  if (item.extractState === 0) return "running";
  if (item.extractState === -1) return "failed";
  if (item.extractState === -2) return "stale";
  if (item.extractState === 1) return item.relatedAssets?.length ? "succeeded" : "invalid";
  return "idle";
}

function getAssetStatusText(item: Script) {
  const keys: Record<AssetStatus, string> = {
    idle: "workbench.script.msg.statusNotExtracted",
    queued: "workbench.script.msg.statusQueued",
    running: "workbench.script.msg.statusRunning",
    succeeded: "workbench.script.msg.statusSucceeded",
    failed: "workbench.script.msg.statusFailed",
    stale: "workbench.script.msg.statusStale",
    invalid: "workbench.script.msg.statusEmpty",
  };
  return $t(keys[getAssetStatus(item)], { count: item.relatedAssets?.length || 0 });
}

function isActiveExtraction(item: Script) {
  return item.extractState === 0 || item.extractState === 2;
}

function canRetryExtraction(item: Script) {
  return ["idle", "failed", "stale", "invalid"].includes(getAssetStatus(item));
}

function formatElapsed(item: Script) {
  if (!item.extractStartedAt) return "";
  const end = item.extractFinishedAt || statusClock.value;
  const totalSeconds = Math.max(1, Math.floor((end - item.extractStartedAt) / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}
function toggleSelect(id: number) {
  const idx = selectedIds.value.indexOf(id);
  if (idx === -1) {
    selectedIds.value.push(id);
  } else {
    selectedIds.value.splice(idx, 1);
  }
}

function toggleSelectAll(checked: boolean) {
  if (checked) {
    selectedIds.value = scripts.value.map((s) => s.id);
  } else {
    selectedIds.value = [];
  }
}
// 搜索剧本
async function searchScripts() {
  try {
    const res = await axios.post("/script/getScrptApi", {
      projectId: project.value?.id,
      name: searchQuery.value,
    });
    scripts.value = res.data;
  } catch (error) {
    console.error("搜索剧本失败:", error);
    window.$message.error($t("workbench.script.msg.searchFailed"));
  }
}
onMounted(() => {
  searchScripts();
  statusClockTimer = setInterval(() => {
    statusClock.value = Date.now();
  }, 1000);
});
// 搜索输入变化
function onChange() {
  searchScripts();
}
// 新增剧本
function handleAddScript() {
  addScriptShow.value = true;
}
//导出剧本
async function handleExportScript() {
  if (!selectedIds.value.length) {
    window.$message.warning($t("workbench.script.msg.selectExport"));
    return;
  }
  try {
    const res = await axios.post("/script/exportScript", { id: selectedIds.value }, { responseType: "blob" });
    const blob = new Blob([res as any], { type: "application/zip" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `script_${new Date().toISOString().slice(0, 10)}.zip`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    window.$message.success($t("workbench.script.msg.exportSuccess"));
  } catch (error) {
    console.error("导出剧本失败:", error);
    window.$message.error((error as Error).message ?? $t("workbench.script.msg.exportFailed"));
  }
}
const selectedScript = ref<Script>({
  id: 0,
  name: "",
  content: "",
});
const detailsShow = ref(false);
// 点击剧本卡片
function handleScriptClick(item: Script) {
  if (isActiveExtraction(item)) {
    window.$message.warning($t("workbench.script.msg.extractingInProgress"));
    return;
  }
  selectedScript.value = { ...item };
  detailsShow.value = true;
}
// 删除剧本
async function handleDeleteScript(scriptId: number) {
  //判断是否有资产正在提取中
  const extractingIds = new Set(activeExtractionData.value.map((s) => s.id));
  if (extractingIds.has(scriptId)) {
    return window.$message.error($t("workbench.script.msg.extractingInProgress"));
  }
  const dialog = DialogPlugin.confirm({
    header: $t("workbench.script.msg.deleteHeader"),
    body: $t("workbench.script.msg.deleteBody"),
    confirmBtn: $t("workbench.script.msg.deleteConfirm"),
    cancelBtn: $t("workbench.script.msg.cancel"),
    theme: "warning",
    onConfirm: async () => {
      try {
        await axios.post("/script/delScript", { ids: [scriptId] });
        window.$message.success($t("workbench.script.msg.deleteSuccess"));
        searchScripts();
        dialog.destroy();
      } catch (error) {
        console.error("删除剧本失败:", error);
        window.$message.error($t("workbench.script.msg.deleteFailed"));
        dialog.destroy();
      }
    },
    onClose: () => {
      dialog.destroy();
    },
  });
}
//提取资产
async function submitAssetExtraction(ids: number[]) {
  if (!project.value) return window.$message.error($t("workbench.script.msg.projectNotFound"));
  const extractingIds = new Set(activeExtractionData.value.map((s) => s.id));
  if (ids.some((id) => extractingIds.has(id))) {
    return window.$message.error($t("workbench.script.msg.extractingInProgress"));
  }
  scriptLoad.value = true;
  extractingScriptIds.value = new Set([...extractingScriptIds.value, ...ids]);
  try {
    await axios.post("/script/extractAssets", {
      scriptIds: ids,
      projectId: project.value!.id,
      groupSize: otherSetting.value.assetsBatchGenereateSize,
    });
    await searchScripts();
  } catch (e) {
    window.$message.error((e as any)?.message || $t("workbench.script.msg.extractFailed"));
  } finally {
    scriptLoad.value = false;
    const nextIds = new Set(extractingScriptIds.value);
    ids.forEach((id) => nextIds.delete(id));
    extractingScriptIds.value = nextIds;
  }
}

function handleExtractAssets() {
  return submitAssetExtraction(selectedIds.value);
}

function extractSingleScript(scriptId: number) {
  return submitAssetExtraction([scriptId]);
}
//批量删除剧本
async function handleBatchDelete() {
  if (!selectedIds.value.length) {
    window.$message.warning($t("workbench.script.msg.selectDelScript"));
    return;
  }
  //判断是否有资产正在提取中
  const extractingIds = new Set(activeExtractionData.value.map((s) => s.id));
  if (selectedIds.value.some((id) => extractingIds.has(id))) {
    return window.$message.error($t("workbench.script.msg.extractingInProgress"));
  }
  const dialog = DialogPlugin.confirm({
    header: $t("workbench.script.msg.batchDeleteHeader"),
    body: $t("workbench.script.msg.batchDeleteBody", { count: selectedIds.value.length }),
    confirmBtn: $t("workbench.script.msg.deleteConfirm"),
    cancelBtn: $t("workbench.script.msg.cancel"),
    theme: "warning",
    onConfirm: async () => {
      try {
        await axios.post("/script/delScript", { ids: selectedIds.value });
        window.$message.success($t("workbench.script.msg.batchDeleteSuccess"));
        searchScripts();
        dialog.destroy();
      } catch (error) {
        console.error("删除剧本失败:", error);
        window.$message.error($t("workbench.script.msg.deleteFailed"));
        dialog.destroy();
      } finally {
        selectedIds.value = [];
      }
    },
    onClose: () => {
      dialog.destroy();
    },
  });
}

let pollingTimer: ReturnType<typeof setInterval> | null = null;
let pollingInFlight = false;

function startPolling() {
  if (pollingTimer) return;
  pollingTimer = setInterval(async () => {
    if (activeExtractionData.value.length === 0) {
      stopPolling();
      return;
    }
    await pollScriptAssets();
  }, 3000);
}

function stopPolling() {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }
}
const activeExtractionData = computed(() => {
  return scripts.value.filter(isActiveExtraction);
});
// 轮询相关

async function pollScriptAssets() {
  if (activeExtractionData.value.length === 0 || pollingInFlight) return;
  pollingInFlight = true;
  const ids = activeExtractionData.value.map((item) => item.id);
  try {
    const { data } = await axios.post("/script/pollScriptAssets", { ids });
    let hasCompletedTask = false;
    for (const state of data as Pick<Script, "id" | "extractState" | "errorReason" | "extractStartedAt" | "extractFinishedAt">[]) {
      const script = scripts.value.find((item) => item.id === state.id);
      if (script) Object.assign(script, state);
      if (state.extractState !== 0 && state.extractState !== 2) hasCompletedTask = true;
    }
    if (hasCompletedTask) await searchScripts();
  } catch (e) {
    console.error("轮询事件状态失败:", e);
  } finally {
    pollingInFlight = false;
  }
}
watch(
  () => activeExtractionData.value.length,
  (activeCount) => {
    if (activeCount > 0) {
      startPolling();
    } else {
      stopPolling();
    }
  },
);

onUnmounted(() => {
  stopPolling();
  if (statusClockTimer) clearInterval(statusClockTimer);
});
</script>

<style lang="scss" scoped>
.script {
  .smHead {
    margin-bottom: 32px;
  }
  .actionBar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 24px;
    .actionBar-left {
      gap: 10px;
    }
    .actionBar-right {
      gap: 12px;
      .countBox {
        gap: 5px;
      }
    }
  }
  .contentArea {
    .scriptsList {
      gap: 20px;
      .scriptCard {
        position: relative;
      }
      .content {
        display: -webkit-box;
        -webkit-box-orient: vertical;
        overflow: hidden;
        -webkit-line-clamp: 1;
      }
      .cardHeader {
        display: flex;
        align-items: center;
        justify-content: space-between;
        width: 100%;
        .cardTitle {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          flex: 1;
        }
        .cardCheckbox {
          flex-shrink: 0;
          margin-left: 12px;
        }
      }
      .assetTags {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-top: 8px;
      }
      .assetStatus {
        margin-top: 14px;
        padding: 10px 12px;
        border-left: 3px solid var(--td-border-level-2-color);
        background: var(--td-bg-color-container-hover);

        .assetStatusHeader {
          min-height: 24px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
        }

        .assetStatusTitle {
          min-width: 0;
          display: flex;
          align-items: center;
          gap: 7px;
          font-size: 13px;
          font-weight: 600;
          color: var(--td-text-color-primary);
        }

        .assetStatusMeta,
        .assetStatusReason {
          margin-top: 6px;
          font-size: 12px;
          line-height: 18px;
          color: var(--td-text-color-secondary);
        }

        .assetStatusReason {
          color: var(--td-error-color);
          overflow-wrap: anywhere;
        }

        .moreAssets {
          align-self: center;
          font-size: 12px;
          color: var(--td-text-color-secondary);
        }

        &.is-queued,
        &.is-running {
          border-left-color: var(--td-brand-color);
        }

        &.is-succeeded {
          border-left-color: var(--td-success-color);

          .assetStatusTitle {
            color: var(--td-success-color);
          }
        }

        &.is-failed,
        &.is-invalid {
          border-left-color: var(--td-error-color);

          .assetStatusTitle {
            color: var(--td-error-color);
          }
        }

        &.is-stale {
          border-left-color: var(--td-warning-color);

          .assetStatusTitle {
            color: var(--td-warning-color);
          }
        }

        .statusSpinner {
          animation: status-spin 1s linear infinite;
        }
      }
      .del {
        text-align: right;
        opacity: 0.6;
        transition: opacity 0.2s;
      }
      .del:hover {
        opacity: 1;
      }
    }
    .emptyState {
      display: flex;
      justify-content: center;
      align-items: center;
      height: 600px;
    }
  }
}

@keyframes status-spin {
  to {
    transform: rotate(360deg);
  }
}

.settingDialogContent {
  padding: 16px 0;
  .settingItem {
    gap: 12px;
    margin-bottom: 16px;
    &:last-child {
      margin-bottom: 0;
    }
    .settingLabel {
      white-space: nowrap;
      min-width: 80px;
    }
  }
}
.settingDialogFooter {
  display: flex;
  justify-content: flex-end;
  margin-top: 24px;
}
</style>
