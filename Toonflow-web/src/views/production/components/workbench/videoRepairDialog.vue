<template>
  <t-dialog
    :visible="visible"
    :header="title || $t('workbench.generate.repairDialogTitle')"
    :footer="false"
    width="min(560px, 92vw)"
    placement="center"
    destroy-on-close
    @update:visible="(value: boolean) => emit('update:visible', value)"
    @close="emit('update:visible', false)">
    <div class="repairBody">
      <p v-if="message" class="repairMessage">{{ message }}</p>

      <div v-if="fixed.length" class="repairSection">
        <div class="repairSectionTitle isFixed">
          <CheckCircleFilledIcon size="16" />
          <span>{{ $t("workbench.generate.repairAutoFixed") }}</span>
        </div>
        <ul class="repairList">
          <li v-for="(item, index) in fixed" :key="`fixed-${index}`">{{ item }}</li>
        </ul>
      </div>

      <div v-if="blockers.length" class="repairSection">
        <div class="repairSectionTitle isBlocker">
          <ErrorCircleFilledIcon size="16" />
          <span>{{ $t("workbench.generate.repairNeedAction") }}</span>
        </div>
        <ul class="repairList">
          <li v-for="(item, index) in blockers" :key="`blocker-${index}`">{{ item.message }}</li>
        </ul>
        <p v-if="needsReferences" class="repairHint">
          {{ $t("workbench.generate.repairSelectReferences") }}
        </p>
        <p v-if="needsRegeneratePrompt && !supportRegenerate" class="repairHint">
          {{ $t("workbench.generate.repairRegenerateInWorkbench") }}
        </p>
      </div>

      <p v-if="submitted && !blockers.length" class="repairSubmitted">
        {{ $t("workbench.generate.repairSubmitted") }}
      </p>
    </div>

    <div class="repairFooter">
      <t-button
        v-if="needsRegeneratePrompt && supportRegenerate"
        size="small"
        variant="outline"
        :loading="regenerating"
        @click="emit('regenerate')">
        {{ $t("workbench.generate.repairRegeneratePrompt") }}
      </t-button>
      <t-button
        v-if="needsMarkFailed"
        size="small"
        variant="outline"
        @click="emit('markFailed')">
        {{ $t("workbench.generate.repairMarkFailed") }}
      </t-button>
      <t-button v-if="refreshable" size="small" variant="outline" @click="emit('refresh')">
        {{ $t("workbench.generate.repairRefresh") }}
      </t-button>
      <t-button size="small" @click="emit('update:visible', false)">
        {{ $t("workbench.generate.repairClose") }}
      </t-button>
    </div>
  </t-dialog>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { CheckCircleFilledIcon, ErrorCircleFilledIcon } from "tdesign-icons-vue-next";

interface RepairBlocker {
  code?: string;
  message: string;
  action?: string;
}

const props = withDefaults(
  defineProps<{
    visible: boolean;
    title?: string;
    message?: string;
    fixed?: string[];
    blockers?: RepairBlocker[];
    /** 是否已成功提交修复任务（用于展示「正在生成中」提示） */
    submitted?: boolean;
    /** 是否展示「刷新列表」动作（批量修复结束后需要手动确认结果） */
    refreshable?: boolean;
    /** 正在重新推理该镜提示词 */
    regenerating?: boolean;
    /** 当前入口是否支持「重新推该镜提示词」（任务页不支持，只给指引） */
    supportRegenerate?: boolean;
  }>(),
  {
    title: "",
    message: "",
    fixed: () => [],
    blockers: () => [],
    submitted: false,
    refreshable: false,
    regenerating: false,
    supportRegenerate: true,
  },
);

const emit = defineEmits<{
  "update:visible": [value: boolean];
  regenerate: [];
  markFailed: [];
  refresh: [];
}>();

const actions = computed(() =>
  props.blockers.map((blocker) => String(blocker.action || "")),
);
const needsRegeneratePrompt = computed(() => actions.value.includes("regeneratePrompt"));
const needsReferences = computed(() => actions.value.includes("selectReferences"));
const needsMarkFailed = computed(() => actions.value.includes("markFailed"));
</script>

<style lang="scss" scoped>
.repairBody {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-height: 52vh;
  overflow-y: auto;

  .repairMessage {
    margin: 0;
    font-size: 13px;
    line-height: 1.6;
    color: var(--td-text-color-primary);
    word-break: break-word;
  }

  .repairSection {
    border: 1px solid var(--td-component-border);
    border-radius: 8px;
    padding: 10px 12px;

    .repairSectionTitle {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 6px;

      &.isFixed {
        color: var(--td-success-color);
      }

      &.isBlocker {
        color: var(--td-error-color);
      }
    }

    .repairList {
      margin: 0;
      padding-left: 18px;
      display: flex;
      flex-direction: column;
      gap: 4px;

      li {
        font-size: 12px;
        line-height: 1.6;
        color: var(--td-text-color-secondary);
        word-break: break-word;
      }
    }

    .repairHint {
      margin: 8px 0 0;
      font-size: 12px;
      color: var(--td-text-color-placeholder);
    }
  }

  .repairSubmitted {
    margin: 0;
    font-size: 13px;
    color: var(--td-success-color);
  }
}

.repairFooter {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}
</style>
