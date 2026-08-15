<template>
  <div class="promptManage">
    <div class="promptToolbar">
      <div>
        <h3>提示词模版</h3>
        <p>自定义图片或视频提示词推理规则，保存后会出现在对应生成阶段的模版选择器中。</p>
      </div>
      <t-button theme="primary" @click="startCreate">
        <template #icon><t-icon name="add" /></template>
        新增提示词模版
      </t-button>
    </div>

    <div class="promptGrid" v-if="data.length">
      <t-card v-for="value in data" :key="value.id" bordered class="promptCard" @click="openShow(value)">
        <div class="promptCardHeader">
          <div class="promptCardTitle">
            <span>{{ value.name }}</span>
            <t-tag size="small" :theme="value.source === 'user' ? 'warning' : 'primary'">
              {{ value.source === "user" ? "自定义" : "官方" }}
            </t-tag>
          </div>
          <t-button
            v-if="value.source === 'user'"
            shape="square"
            size="small"
            variant="text"
            theme="danger"
            title="删除模版"
            @click.stop="confirmDelete(value)">
            <template #icon><t-icon name="delete" /></template>
          </t-button>
        </div>
        <div class="promptType">{{ typeLabel(value.type) }}</div>
        <div class="promptPreview">{{ value.data }}</div>
      </t-card>
    </div>
    <t-empty v-else description="暂无提示词模版" />

    <t-dialog
      v-model:visible="visible"
      :header="creating ? '新增提示词模版' : '编辑提示词模版'"
      width="760px"
      :close-on-overlay-click="false"
      :confirm-btn="{ content: creating ? '创建模版' : '保存修改', loading: submitting }"
      @confirm="onConfirm"
      top="7vh">
      <t-form label-align="top">
        <div class="promptFormGrid">
          <t-form-item label="模版名称" required-mark>
            <t-input v-model="promptData.name" :disabled="!creating && promptData.source !== 'user'" placeholder="例如：写实角色图片提示词" />
          </t-form-item>
          <t-form-item label="应用阶段" required-mark>
            <t-select
              v-if="creating || promptData.source === 'user'"
              v-model="promptData.type"
              :options="templateTypeOptions"
              placeholder="选择图片或视频提示词生成" />
            <t-input v-else :value="typeLabel(promptData.type)" disabled />
          </t-form-item>
        </div>
        <t-form-item label="模版内容" required-mark>
          <MdEditor
            v-model="promptData.data"
            :theme="'light'"
            :toolbars="promptToolbars"
            :footers="[]"
            style="height: 52vh"
            placeholder="输入推理规则。可以使用 {{输入文本}}、{{图片列表}} 等变量。"
            @onUploadImg="() => {}" />
        </t-form-item>
      </t-form>
    </t-dialog>
  </div>
</template>

<script setup lang="ts">
import axios from "@/utils/axios";
import { MdEditor } from "md-editor-v3";
import type { ToolbarNames } from "md-editor-v3";
import { DialogPlugin } from "tdesign-vue-next";
import { ref } from "vue";

interface PromptItem {
  id: number;
  name: string;
  type: string;
  data: string;
  source: "official" | "user";
}

const templateTypeOptions = [
  { label: "图片提示词生成", value: "imagePromptGeneration" },
  { label: "视频提示词生成", value: "videoPromptGeneration" },
];
const promptToolbars: ToolbarNames[] = [
  "bold",
  "italic",
  "strikeThrough",
  "-",
  "unorderedList",
  "orderedList",
  "-",
  "revoke",
  "next",
  "=",
  "preview",
];

const visible = ref(false);
const creating = ref(false);
const submitting = ref(false);
const data = ref<PromptItem[]>([]);
const promptData = ref<PromptItem>({ id: 0, name: "", type: "imagePromptGeneration", data: "", source: "user" });

onMounted(getPrompt);

function typeLabel(type: string) {
  return templateTypeOptions.find((item) => item.value === type)?.label || type;
}

async function getPrompt() {
  const response = await axios.post("/setting/promptManage/getPrompt");
  data.value = (Array.isArray(response.data) ? response.data : []).map((item: any) => ({
    id: Number(item.id),
    name: item.name || "未命名模版",
    type: item.type || "",
    data: item.data || "",
    source: item.source === "user" ? "user" : "official",
  }));
}

function startCreate() {
  creating.value = true;
  promptData.value = { id: 0, name: "", type: "imagePromptGeneration", data: "", source: "user" };
  visible.value = true;
}

function openShow(value: PromptItem) {
  creating.value = false;
  promptData.value = { ...value };
  visible.value = true;
}

function notifyTemplatesUpdated() {
  window.dispatchEvent(new CustomEvent("prompt-templates-updated"));
}

async function onConfirm() {
  const payload = {
    id: promptData.value.id,
    name: promptData.value.name.trim(),
    type: promptData.value.type,
    data: promptData.value.data.trim(),
  };
  if (!payload.name) return window.$message.warning("请输入模版名称");
  if (!templateTypeOptions.some((item) => item.value === payload.type) && (creating.value || promptData.value.source === "user")) {
    return window.$message.warning("请选择图片或视频提示词生成阶段");
  }
  if (!payload.data) return window.$message.warning("请输入模版内容");

  submitting.value = true;
  try {
    if (creating.value) {
      await axios.post("/setting/promptManage/addPrompt", payload);
      window.$message.success("自定义提示词模版已创建");
    } else {
      await axios.post("/setting/promptManage/updatePrompt", payload);
      window.$message.success("提示词模版已保存");
    }
    await getPrompt();
    notifyTemplatesUpdated();
    visible.value = false;
  } finally {
    submitting.value = false;
  }
}

function confirmDelete(value: PromptItem) {
  const dialog = DialogPlugin.confirm({
    header: "删除提示词模版",
    body: `确认删除“${value.name}”吗？删除后对应生成阶段将不能再选择该模版。`,
    confirmBtn: { theme: "danger", content: "删除" },
    onConfirm: async () => {
      await axios.post("/setting/promptManage/deletePrompt", { id: value.id });
      dialog.destroy();
      await getPrompt();
      notifyTemplatesUpdated();
      window.$message.success("自定义提示词模版已删除");
    },
    onCancel: () => dialog.destroy(),
  });
}
</script>

<style lang="scss" scoped>
.promptManage {
  .promptToolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
    padding-bottom: 16px;
    margin-bottom: 16px;
    border-bottom: 1px solid var(--td-component-border);

    h3 {
      margin: 0 0 4px;
      font-size: 18px;
    }

    p {
      margin: 0;
      color: var(--td-text-color-secondary);
      font-size: 13px;
    }
  }

  .promptGrid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 14px;
  }

  .promptCard {
    cursor: pointer;

    &:hover {
      border-color: var(--td-brand-color);
    }
  }

  .promptCardHeader,
  .promptCardTitle {
    display: flex;
    align-items: center;
  }

  .promptCardHeader {
    justify-content: space-between;
    gap: 12px;
  }

  .promptCardTitle {
    min-width: 0;
    gap: 8px;
    font-size: 15px;
    font-weight: 700;
  }

  .promptType {
    margin-top: 8px;
    color: var(--td-text-color-secondary);
    font-size: 12px;
  }

  .promptPreview {
    display: -webkit-box;
    margin-top: 10px;
    overflow: hidden;
    color: var(--td-text-color-secondary);
    font-size: 13px;
    line-height: 1.6;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
  }
}

.promptFormGrid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}

@media (max-width: 760px) {
  .promptManage {
    .promptToolbar {
      align-items: flex-start;
      flex-direction: column;
    }

    .promptGrid {
      grid-template-columns: 1fr;
    }
  }

  .promptFormGrid {
    grid-template-columns: 1fr;
  }
}
</style>
