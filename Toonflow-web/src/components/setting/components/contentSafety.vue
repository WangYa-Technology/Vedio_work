<template>
  <div class="contentSafetyConfig">
    <t-alert theme="info" :title="$t('settings.contentSafety.desc')" />
    <t-form label-align="top" class="form">
      <t-form-item>
        <template #label>
          <span>{{ $t("settings.contentSafety.constraint") }}</span>
          <t-button theme="default" variant="text" size="small" @click="restoreDefault">
            {{ $t("settings.contentSafety.restoreDefault") }}
          </t-button>
        </template>
        <t-textarea
          v-model="constraint"
          :autosize="{ minRows: 10, maxRows: 22 }"
          :maxlength="20000"
          :placeholder="$t('settings.contentSafety.placeholder')" />
      </t-form-item>
      <div class="actions">
        <t-button theme="primary" :loading="saving" @click="save">{{ $t("settings.contentSafety.save") }}</t-button>
      </div>
    </t-form>
  </div>
</template>

<script setup lang="ts">
import { MessagePlugin } from "tdesign-vue-next";
import axios from "@/utils/axios";

const constraint = ref("");
const defaultConstraint = ref("");
const saving = ref(false);

async function load() {
  try {
    const { data } = await axios.get("/setting/contentSafety/getContentSafety");
    constraint.value = data?.constraint ?? "";
    defaultConstraint.value = data?.defaultConstraint ?? "";
  } catch (error: any) {
    MessagePlugin.error(error?.message || "获取内容安全约束失败");
  }
}

function restoreDefault() {
  constraint.value = defaultConstraint.value;
}

async function save() {
  saving.value = true;
  try {
    await axios.post("/setting/contentSafety/updateContentSafety", { constraint: constraint.value });
    MessagePlugin.success("内容安全约束已保存，后续 Agent 生成会自动带入");
  } catch (error: any) {
    MessagePlugin.error(error?.message || "保存内容安全约束失败");
  } finally {
    saving.value = false;
  }
}

load();
</script>

<style lang="scss" scoped>
.contentSafetyConfig {
  width: 100%;
}

.form {
  margin-top: 16px;
}

.actions {
  display: flex;
  justify-content: flex-end;
}
</style>
