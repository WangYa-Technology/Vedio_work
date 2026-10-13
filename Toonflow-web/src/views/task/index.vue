<template>
  <div class="task">
    <div class="header">
      <div class="headerInfo fc">
        <span class="title">{{ $t("workbench.task.title") }}</span>
        <span class="sub">{{ $t("workbench.task.subtitle") }}</span>
      </div>
      <div class="headerActions f ac">
        <t-button
          variant="outline"
          theme="danger"
          :disabled="!selectedRepairableRows.length || repairSubmitting"
          :loading="repairSubmitting"
          @click="batchRepairTasks">
          {{ $t("workbench.task.repairSelected") }}
          {{ selectedRepairableRows.length ? `(${selectedRepairableRows.length})` : "" }}
        </t-button>
        <t-button @click="getTaskList">
          <template #icon>
            <i-redo :size="20" />
          </template>
          {{ $t("workbench.task.refresh") }}
        </t-button>
      </div>
    </div>
    <div class="list">
      <div class="search f">
        <t-select :label="$t('workbench.task.project')" v-model="projectId" :options="projectData" @change="onFilterChange" />
        <t-select
          :label="$t('workbench.task.categoryLabel')"
          v-model="taskClass"
          :options="categoryOptions"
          @change="onFilterChange"
          style="margin-left: 20px" />
        <t-select
          :label="$t('workbench.task.stateLabel')"
          v-model="taskState"
          :options="stateOptions"
          @change="onFilterChange"
          style="margin-left: 20px" />
      </div>
      <div class="content">
        <t-table
          :data="taskList"
          :columns="columns"
          row-key="id"
          :loading="pagination.loading"
          :selected-row-keys="selectedRowKeys"
          hover
          stripe
          @select-change="handleSelectChange">
          <template #state="{ row }">
            <t-tooltip v-if="row.state === '生成失败'" :content="row.reason || $t('workbench.task.noFailReason')" placement="top">
              <span class="stateText stateFail">{{ row.state }}</span>
            </t-tooltip>
            <span v-else class="stateText" :class="row.state === '进行中' ? 'stateRunning' : 'stateSuccess'">
              {{ row.state }}
            </span>
          </template>
          <template #startTime="{ row }">
            <span>{{ dayjs(row.startTime).format("YYYY-MM-DD HH:mm:ss") }}</span>
          </template>
          <template #operation="{ row }">
            <t-button
              v-if="isRepairable(row)"
              size="small"
              variant="text"
              theme="primary"
              :disabled="repairSubmitting"
              @click.stop="repairTask(row)">
              {{ $t("workbench.task.repair") }}
            </t-button>
            <span v-else class="operationPlaceholder">—</span>
          </template>
        </t-table>
        <t-pagination
          class="paginationWrap"
          v-model:current="pagination.page"
          v-model:pageSize="pagination.limit"
          show-sizer
          :total="pagination.total"
          @page-size-change="getTaskList"
          @current-change="getTaskList" />
      </div>
    </div>
    <videoRepairDialog
      v-model:visible="repairVisible"
      :title="repairState.title"
      :message="repairState.message"
      :fixed="repairState.fixed"
      :blockers="repairState.blockers"
      :submitted="repairState.submitted"
      :refreshable="repairState.refreshable"
      :support-regenerate="false"
      @mark-failed="handleRepairMarkFailed"
      @refresh="handleRepairRefresh" />
  </div>
</template>

<script setup lang="ts">
import dayjs from "dayjs";
import axios from "@/utils/axios";
import projectStore from "@/stores/project";
import { DialogPlugin } from "tdesign-vue-next";
import videoRepairDialog from "@/views/production/components/workbench/videoRepairDialog.vue";

const { project } = storeToRefs(projectStore());

interface TaskItem {
  id: number;
  taskClass: string;
  relatedObjects: string;
  model: string;
  projectName: string;
  episode: string;
  state: string;
  startTime: number;
  projectId?: number;
  describe?: string;
  reason?: string;
}

const columns = [
  { colKey: "row-select", type: "multiple", width: 48 },
  { colKey: "taskClass", title: $t("workbench.task.col.taskClass"), width: 120, ellipsis: true },
  { colKey: "relatedObjects", title: $t("workbench.task.col.relatedObjects"), width: 120, ellipsis: true },
  { colKey: "model", title: $t("workbench.task.col.model"), width: 280, ellipsis: true },
  { colKey: "describe", title: $t("workbench.task.col.describe"), ellipsis: true },
  { colKey: "state", title: $t("workbench.task.col.state"), width: 100, cell: "state" },
  { colKey: "startTime", title: $t("workbench.task.col.startTime"), width: 200, cell: "startTime" },
  { colKey: "operation", title: $t("workbench.task.col.operation"), width: 96, cell: "operation" },
];

const stateOptions = [
  { label: $t("workbench.task.stateAll"), value: "" },
  { label: $t("workbench.task.stateRunning"), value: "进行中" },
  { label: $t("workbench.task.stateCompleted"), value: "已完成" },
  { label: $t("workbench.task.stateFailed"), value: "生成失败" },
];

const pagination = ref({ page: 1, limit: 10, total: 0, loading: false });
const categoryOptions = ref<{ label: string; value: string }[]>([]);
const projectData = ref<{ label: string; value: string }[]>([]);
const taskClass = ref("");
const taskState = ref("");
const projectId = ref("");
const taskList = ref<TaskItem[]>([]);

onMounted(() => {
  getTaskList();
  getCategories();
  getProject();
});

function onFilterChange() {
  pagination.value.page = 1;
  getTaskList();
}

async function getCategories() {
  const { data } = await axios.post("/task/getTaskCategories").catch(() => ({ data: [] }));
  categoryOptions.value = [
    { label: $t("workbench.task.stateAll"), value: "" },
    ...data.map((i: any) => ({ label: i.taskClass, value: i.taskClass })),
  ];
}

async function getProject() {
  const { data } = await axios.post("/task/getProject").catch(() => ({ data: [] }));
  projectData.value = [{ label: $t("workbench.task.stateAll"), value: "" }, ...data.map((i: any) => ({ label: i.name, value: i.id }))];
}

async function getTaskList() {
  pagination.value.loading = true;
  try {
    const { data } = await axios.post("/task/getTaskApi", {
      page: pagination.value.page,
      limit: pagination.value.limit,
      taskClass: taskClass.value,
      state: taskState.value,
      projectId: projectId.value || project.value?.id,
    });
    taskList.value = data.data;
    pagination.value.total = data.total;
    selectedRowKeys.value = selectedRowKeys.value.filter((key) => taskList.value.some((row) => row.id === key));
  } catch {
    window.$message.error($t("workbench.task.fetchFailed"));
  } finally {
    pagination.value.loading = false;
  }
}

// ---------------- 生成失败修复 ----------------
interface RepairBlockerItem {
  code?: string;
  message: string;
  action?: string;
}

interface RepairDialogState {
  title: string;
  message: string;
  fixed: string[];
  blockers: RepairBlockerItem[];
  submitted: boolean;
  refreshable: boolean;
}

interface RepairOutcome {
  ok: boolean;
  label: string;
  message: string;
  fixed: string[];
  blockers: RepairBlockerItem[];
}

const selectedRowKeys = ref<number[]>([]);
const repairVisible = ref(false);
const repairSubmitting = ref(false);
const repairVideoId = ref<number | null>(null);
const repairState = ref<RepairDialogState>({
  title: "",
  message: "",
  fixed: [],
  blockers: [],
  submitted: false,
  refreshable: false,
});

function handleSelectChange(value: Array<string | number>) {
  selectedRowKeys.value = value.filter((key): key is number => typeof key === "number");
}

// 只有「视频生成」且失败的任务能按快照修复（其它任务类型没有视频快照）。
function isRepairable(row: TaskItem) {
  return row.taskClass === "videoGeneration" && row.state === "生成失败";
}

const selectedRepairableRows = computed(() => taskList.value.filter((row) => selectedRowKeys.value.includes(row.id) && isRepairable(row)));

function readTaskContext(row: TaskItem) {
  try {
    const parsed = JSON.parse(String(row.relatedObjects || "{}"));
    return {
      videoId: Number(parsed?.videoId) || null,
      trackId: Number(parsed?.trackId) || null,
    };
  } catch {
    return { videoId: null, trackId: null };
  }
}

function readRepairFailure(caught: any) {
  const envelope = caught?.response?.data ?? caught;
  const payload = envelope?.data ?? {};
  return {
    message: envelope?.message || caught?.message || "修复失败，请稍后重试",
    fixed: Array.isArray(payload.fixed) ? payload.fixed : [],
    blockers: Array.isArray(payload.blockers) ? payload.blockers : [],
  };
}

function openRepairDialog(state: Partial<RepairDialogState>) {
  repairState.value = {
    title: state.title || $t("workbench.generate.repairDialogTitle"),
    message: state.message || "",
    fixed: state.fixed || [],
    blockers: state.blockers || [],
    submitted: Boolean(state.submitted),
    refreshable: Boolean(state.refreshable),
  };
  repairVisible.value = true;
}

async function submitRepair(row: TaskItem): Promise<RepairOutcome> {
  const label = row.describe || `任务 ${row.id}`;
  const context = readTaskContext(row);
  if (context.videoId == null && context.trackId == null) {
    return {
      ok: false,
      label,
      message: "该任务没有关联的视频记录，请到制作台对应片段上发起生成",
      fixed: [],
      blockers: [],
    };
  }
  try {
    const { data, message } = await axios.post("/production/workbench/retryVideo", {
      ...(context.videoId != null ? { videoId: context.videoId } : {}),
      ...(context.trackId != null ? { trackId: context.trackId } : {}),
      projectId: row.projectId,
    });
    return {
      ok: true,
      label,
      message: message || $t("workbench.generate.repairSubmitted"),
      fixed: Array.isArray(data?.fixed) ? data.fixed : [],
      blockers: [],
    };
  } catch (caught: any) {
    const failure = readRepairFailure(caught);
    return {
      ok: false,
      label,
      message: failure.message,
      fixed: failure.fixed,
      blockers: failure.blockers,
    };
  }
}

async function repairTask(row: TaskItem) {
  if (repairSubmitting.value) return;
  repairSubmitting.value = true;
  repairVideoId.value = readTaskContext(row).videoId;
  try {
    const outcome = await submitRepair(row);
    openRepairDialog({
      message: outcome.ok ? outcome.message : `${outcome.label}：${outcome.message}`,
      fixed: outcome.fixed,
      blockers: outcome.blockers,
      submitted: outcome.ok,
    });
    if (outcome.ok) {
      window.$message.success($t("workbench.generate.repairSubmitted"));
    }
    await getTaskList();
  } finally {
    repairSubmitting.value = false;
  }
}

function batchRepairTasks() {
  const rows = selectedRepairableRows.value;
  if (!rows.length || repairSubmitting.value) return;
  const dlg = DialogPlugin.confirm({
    header: $t("workbench.task.repairSelected"),
    body: $t("workbench.task.repairConfirm", { count: rows.length }),
    onConfirm: async () => {
      dlg.destroy();
      repairSubmitting.value = true;
      try {
        const outcomes: RepairOutcome[] = [];
        for (const row of rows) {
          outcomes.push(await submitRepair(row));
        }
        const submitted = outcomes.filter((item) => item.ok).length;
        const failed = outcomes.length - submitted;
        openRepairDialog({
          title: $t("workbench.task.repairSelected"),
          message: $t("workbench.generate.repairBatchSummary", { submitted, failed }),
          fixed: outcomes.flatMap((item) => item.fixed),
          blockers: outcomes
            .filter((item) => !item.ok)
            .map((item) => ({ message: `${item.label}：${item.message}`, action: item.blockers[0]?.action })),
          submitted: submitted > 0,
          refreshable: failed > 0,
        });
        if (failed) {
          window.$message.warning($t("workbench.generate.repairBatchSummary", { submitted, failed }));
        } else {
          window.$message.success($t("workbench.generate.repairBatchDone"));
        }
        await getTaskList();
      } finally {
        repairSubmitting.value = false;
      }
    },
    onCancel: () => dlg.destroy(),
  });
}

async function handleRepairMarkFailed() {
  if (repairVideoId.value == null) {
    window.$message.warning($t("workbench.task.repairGoToWorkbench"));
    return;
  }
  try {
    const { data, message } = await axios.post("/production/workbench/markVideoFailed", {
      videoId: repairVideoId.value,
      retry: true,
    });
    openRepairDialog({
      message: message || $t("workbench.generate.repairSubmitted"),
      fixed: Array.isArray(data?.fixed) ? data.fixed : [],
      submitted: true,
    });
    window.$message.success($t("workbench.generate.repairSubmitted"));
    await getTaskList();
  } catch (caught: any) {
    const failure = readRepairFailure(caught);
    openRepairDialog({
      message: failure.message,
      fixed: failure.fixed,
      blockers: failure.blockers,
      refreshable: true,
    });
  }
}

async function handleRepairRefresh() {
  await getTaskList();
  window.$message.success($t("workbench.generate.repairRefreshDone"));
}
</script>

<style lang="scss" scoped>
.task {
  .header {
    padding-top: 32px;
    margin-bottom: 32px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    .title {
      font-size: 32px;
      font-weight: 600;
    }
    .sub {
      opacity: 0.5;
    }
    .headerActions {
      gap: 12px;
    }
  }
  .stateText {
    font-weight: bold;
  }
  .stateFail {
    color: #ff4d4f;
    cursor: pointer;
  }
  .stateRunning {
    color: #1890ff;
  }
  .stateSuccess {
    color: #52c41a;
  }
  .operationPlaceholder {
    opacity: 0.3;
  }
  .paginationWrap {
    margin-top: 10px;
  }
}
</style>
