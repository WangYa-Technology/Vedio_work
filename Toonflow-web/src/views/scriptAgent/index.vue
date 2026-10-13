<template>
  <div class="scriptAgent">
    <Splitpanes class="default-theme data f">
      <Pane :size="30" :min-size="15" class="operate">
        <div class="box pr">
          <div class="sidebarHeader">
            <div class="sidebarHeading">
              <span class="sidebarTitle">创作记录</span>
              <span class="sidebarSubtitle">剧本策划</span>
            </div>
            <div class="connectionState" :class="{ 'is-offline': !connected }">
              <i-dot theme="outline" :fill="connected ? 'green' : 'red'" />
              <span>{{ connected ? "已连接" : "未连接" }}</span>
            </div>
          </div>
          <t-chat-list :clear-history="false" :show-scroll-button="false">
            <t-chat-message
              v-for="message in renderableMessages"
              :key="message.id"
              :message="message"
              :name="(message as any).name"
              :placement="message.role === 'user' ? 'right' : 'left'"
              :variant="message.role === 'user' ? 'base' : 'text'"
              :handleActions="message.role === 'user' ? {} : handleActions"
              :status="message.status"
              allowContentSegmentCustom>
              <!-- <template #actionbar> -->
              <!-- <t-chat-actionbar :action-bar="['replay', 'copy']" /> -->
              <!-- <t-chat-actionbar :action-bar="['replay', 'copy']" /> -->
              <!-- </template> -->
            </t-chat-message>
          </t-chat-list>
          <div
            v-if="showWorkflowStatus"
            class="workflowStatus"
            :class="`is-${workflowStatus.state}`"
            role="status"
            aria-live="polite">
            <i-loading-four v-if="workflowBusy" class="workflowSpinner" size="16" />
            <i-info v-else-if="workflowStatus.state === 'error'" size="16" />
            <span>{{ workflowStatusLabel }}</span>
            <span v-if="lastActivitySeconds !== null" class="activityHint">最后活跃 {{ lastActivitySeconds }} 秒前</span>
          </div>
          <div v-if="nextAction" class="nextAction">
            <div class="nextActionCopy">
              <span class="nextActionTitle">{{ nextAction.title }}</span>
              <span>{{ nextAction.description }}</span>
            </div>
            <t-button size="small" theme="primary" :disabled="workflowBusy || loadingProjectData" @click="runNextAction">
              {{ nextAction.label }}
            </t-button>
          </div>
          <t-chat-sender
            class="inputBox"
            :disabled="status === 'pending' || status === 'streaming' || loadingProjectData || !activeProjectId || !connected"
            v-model="inputValue"
            :loading="status === 'pending' || status === 'streaming'"
            placeholder="$t('workbench.scriptAgent.inputPlaceholder')"
            @send="handleSend"
            @stop="handleStop">
            <template #footer-prefix>
              <t-popup trigger="click" placement="top-left">
                <!-- 断连期间必须保留"重新连接"入口，因此这里不按生成状态禁用 -->
                <t-button shape="square" variant="outline" size="small" :disabled="loadingProjectData">
                  <template #icon>
                    <i-setting-config size="16" />
                  </template>
                </t-button>
                <template #content>
                  <div class="settingMenu">
                    <div class="settingMenuItem" @click="handleReconnect()">
                      <i-api size="14" />
                      <span>{{ $t("workbench.scriptAgent.reconnect") }}</span>
                    </div>
                    <div class="settingMenuItem" @click="handleClearMemory('message')">
                      <i-delete size="14" />
                      <span>{{ $t("workbench.scriptAgent.clearMessageMemory") }}</span>
                    </div>
                    <div class="settingMenuItem" @click="handleClearMemory('summary')">
                      <i-close size="14" />
                      <span>{{ $t("workbench.scriptAgent.clearSummaryMemory") }}</span>
                    </div>
                    <div class="settingMenuItem danger" @click="handleClearMemory('all')">
                      <i-delete-one size="14" />
                      <span>{{ $t("workbench.scriptAgent.clearAllMemory") }}</span>
                    </div>
                  </div>
                </template>
              </t-popup>
            </template>
          </t-chat-sender>
          <transition name="fade">
            <div v-if="forceGenerateVisible" class="forceGenerateMask">
              <div class="forceGenerateCard">
                <div class="forceGenerateDesc">{{ $t("workbench.scriptAgent.forceGenerate.desc") }}</div>
                <div class="forceGenerateActions">
                  <t-button @click="forceGenerateVisible = false">{{ $t("workbench.scriptAgent.forceGenerate.confirm") }}</t-button>
                </div>
              </div>
            </div>
          </transition>
        </div>
      </Pane>
      <Pane :size="70" :min-size="30" class="data">
        <div v-if="stageProgress" class="progressPanel">
          <div class="stagePills">
            <button
              type="button"
              class="stagePill"
              :class="{ 'is-ready': stageProgress.storySkeleton.ready, 'is-active': currentTable === 1 }"
              @click="currentTable = 1">
              <span class="stageName">{{ $t("workbench.scriptAgent.storySkeleton") }}</span>
              <span class="stageMeta">{{ stageMeta(stageProgress.storySkeleton) }}</span>
            </button>
            <button
              type="button"
              class="stagePill"
              :class="{ 'is-ready': stageProgress.adaptationStrategy.ready, 'is-active': currentTable === 2 }"
              @click="currentTable = 2">
              <span class="stageName">{{ $t("workbench.scriptAgent.adaptationStrategy") }}</span>
              <span class="stageMeta">{{ stageMeta(stageProgress.adaptationStrategy) }}</span>
            </button>
            <button
              type="button"
              class="stagePill"
              :class="{ 'is-ready': (scriptProgress?.savedCount ?? 0) > 0, 'is-active': currentTable === 3 }"
              @click="currentTable = 3">
              <span class="stageName">{{ $t("workbench.scriptAgent.script") }}</span>
              <span class="stageMeta">{{ scriptStageMeta }}</span>
            </button>
          </div>
          <div v-if="scriptProgress" class="progressRow">
            <div class="progressTrack">
              <span class="progressText">{{ episodeCountText }}</span>
              <t-progress :percentage="scriptProgressPercentage" :label="false" size="small" />
            </div>
            <t-button v-if="nextBatchRange && !workflowBusy" size="small" theme="primary" @click="startNextBatch">
              {{ $t("workbench.scriptAgent.progress.continueRange", { range: formatEpisodeRange(nextBatchRange.from, nextBatchRange.to) }) }}
            </t-button>
          </div>
          <div v-if="conclusiveText" class="conclusiveLine">{{ conclusiveText }}</div>
        </div>
        <div class="tabsWrapper">
          <t-tabs v-model="currentTable">
            <template #action>
              <div class="ac stageTabActions" v-if="currentTable == 1">
                <t-button @click="editMdPreview">{{ $t("workbench.scriptAgent.edit") }}</t-button>
                <t-button
                  theme="danger"
                  variant="outline"
                  :disabled="!planData.storySkeleton || workflowBusy || deletingStage"
                  @click="confirmDeleteStage('storySkeleton')">
                  <template #icon><i-delete size="16" /></template>
                  删除
                </t-button>
              </div>
              <div class="ac stageTabActions" v-else-if="currentTable == 2">
                <t-button @click="editMdPreview">{{ $t("workbench.scriptAgent.edit") }}</t-button>
                <t-button
                  theme="danger"
                  variant="outline"
                  :disabled="!planData.adaptationStrategy || workflowBusy || deletingStage"
                  @click="confirmDeleteStage('adaptationStrategy')">
                  <template #icon><i-delete size="16" /></template>
                  删除
                </t-button>
              </div>
            </template>
            <!-- <t-tab-panel :value="1" :label="$t('workbench.scriptAgent.chapterEvents')">
              <pre>{{ planData.event }}</pre>
            </t-tab-panel> -->
            <t-tab-panel :value="1" :label="$t('workbench.scriptAgent.storySkeleton')">
              <div class="panelContent">
                <div v-if="stageProgress?.storySkeleton.ready" class="stageReviewLine">{{ stageMeta(stageProgress.storySkeleton) }}</div>
                <MdPreview v-if="planData.storySkeleton" :modelValue="normalizeScriptAgentContent(planData.storySkeleton)" />
                <t-empty v-else :title="$t('workbench.scriptAgent.noContent')" />
              </div>
            </t-tab-panel>
            <t-tab-panel :value="2" :label="$t('workbench.scriptAgent.adaptationStrategy')">
              <div class="panelContent">
                <div v-if="stageProgress?.adaptationStrategy.ready" class="stageReviewLine">{{ stageMeta(stageProgress.adaptationStrategy) }}</div>
                <MdPreview v-if="planData.adaptationStrategy" :modelValue="normalizeScriptAgentContent(planData.adaptationStrategy)" />
                <t-empty v-else :title="$t('workbench.scriptAgent.noContent')" />
              </div>
            </t-tab-panel>
            <t-tab-panel :value="3" :label="$t('workbench.scriptAgent.script')">
              <div class="panelContent">
                <t-empty v-if="!planData.script?.length" :title="$t('workbench.scriptAgent.noContent')" />
                <div v-else class="scriptList">
                  <div v-for="(item, index) in planData.script" :key="index" class="scriptCard">
                    <div class="scriptCardHeader">
                      <div class="scriptCardHeaderLeft">
                        <span class="scriptIndex">#{{ index + 1 }}</span>
                        <span class="scriptTitle">{{ item.name }}</span>
                      </div>
                      <div class="scriptCardActions">
                        <t-button size="small" @click="editScript(index)">
                          <template #icon><i-edit size="14" /></template>
                        </t-button>
                        <t-button theme="danger" variant="outline" size="small" @click="delScript(index)">
                          <template #icon><i-delete size="14" /></template>
                        </t-button>
                      </div>
                    </div>
                    <div class="scriptCardMeta">
                      <span class="metaChip">EP{{ String(scriptBadgeOf(item.name, index)?.episodeNo ?? episodeNoFromScriptName(item.name, index)).padStart(2, "0") }}</span>
                      <span class="metaChip">{{ $t("workbench.scriptAgent.progress.chars", { chars: scriptBadgeOf(item.name, index)?.chars ?? item.content.trim().length }) }}</span>
                      <t-tag size="small" variant="light" :theme="reviewBadgeTheme(scriptBadgeOf(item.name, index)?.review)">
                        {{ reviewBadgeText(scriptBadgeOf(item.name, index)?.review) }}
                      </t-tag>
                      <span v-if="scriptBadgeOf(item.name, index)?.savedAt" class="metaTime">{{ formatSavedAt(scriptBadgeOf(item.name, index)?.savedAt) }}</span>
                    </div>
                    <div class="scriptCardBody">
                      <pre v-if="item.content">{{ item.content }}</pre>
                      <span v-else class="emptyContent">{{ $t("workbench.scriptAgent.noContent") }}</span>
                    </div>
                  </div>
                </div>
              </div>
            </t-tab-panel>
          </t-tabs>
        </div>
      </Pane>
    </Splitpanes>
    <editMdPreivew v-model="dialogVisible" @save="onConfirm" :content="editContent" />

    <!-- 剧本编辑对话框 -->
    <t-dialog
      v-model:visible="scriptEditVisible"
      :header="$t('workbench.scriptAgent.editScript')"
      width="80%"
      top="10vh"
      placement="center"
      :confirm-btn="{ content: $t('workbench.scriptAgent.save'), theme: 'primary' }"
      @confirm="saveScript"
      @close="scriptEditVisible = false">
      <div class="scriptEditForm">
        <div class="scriptEditField">
          <label>{{ $t("workbench.scriptAgent.scriptTitle") }}</label>
          <t-input v-model="scriptEditData.name" :placeholder="$t('workbench.scriptAgent.titlePlaceholder')" />
        </div>
        <div class="scriptEditField">
          <label>{{ $t("workbench.scriptAgent.content") }}</label>
          <MdEditor
            v-model="scriptEditData.content"
            :theme="'light'"
            :toolbars="toolbars"
            :footers="[]"
            style="height: 50vh"
            @onUploadImg="() => {}"
            @drop.prevent />
        </div>
      </div>
    </t-dialog>
  </div>
</template>

<script setup lang="ts">
import { MdEditor } from "md-editor-v3";
import type { ToolbarNames } from "md-editor-v3";
import { MdPreview } from "md-editor-v3";
import { Splitpanes, Pane } from "splitpanes";
import "splitpanes/dist/splitpanes.css";
import axios from "@/utils/axios";
import type { ChatMessagesData } from "@tdesign-vue-next/chat";
import projectStore from "@/stores/project";
import router from "@/router";
const { project } = storeToRefs(projectStore());
import editMdPreivew from "@/components/editMdPreivew.vue";
import scriptAgentStore, { type EpisodeProgress, type ScriptAgentProgressSnapshot } from "@/stores/scriptAgent";
import { createEmptyProjectGlobalContext } from "@/types/projectGlobalContext";
import type { ProjectGlobalMaterial } from "@/types/projectGlobalContext";
import { normalizeScriptAgentContent } from "@/utils/scriptAgentContent";
import { getLastActivityAgoMs } from "@/utils/chatDiagnostics";
import { useI18n } from "vue-i18n";
const { t } = useI18n();
const scriptAgent = scriptAgentStore();
const { connected, messages, renderableMessages, status, workflowStatus, planData } = storeToRefs(scriptAgent);
const currentTable = ref(1);
const inputValue = ref("");
const activeProjectId = computed<number | null>(() => {
  const id = Number(project.value?.id);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
});
const loadingProjectData = ref(false);
const projectLoadVersion = ref(0);
const planRequestVersion = ref(0);
const forceGenerateVisible = ref(false);
const novelData = ref<any[]>([]);

const workflowBusy = computed(() =>
  status.value === "pending" || status.value === "streaming" || workflowStatus.value.state === "working" || workflowStatus.value.state === "retrying",
);
const showWorkflowStatus = computed(() => Boolean(workflowStatus.value.label) && (workflowBusy.value || workflowStatus.value.state === "error"));
const workflowStatusLabel = computed(() => {
  const recordLabel = workflowStatus.value.label || "正在处理当前任务";
  // 非忙碌的失败/中断态：优先展示"已完成什么、下一步做什么"的确定性结论；
  // 老记录里"上次生成已中断，可继续"这类含糊文案会被结论替换
  if (!workflowBusy.value && workflowStatus.value.state === "error" && conclusiveText.value && !recordLabel.includes(conclusiveText.value)) {
    return conclusiveText.value;
  }
  return recordLabel;
});

// "最后活跃 X 秒前"：忙碌时每秒刷新，用于分辨后端是"在跑"还是"卡住了"
const lastActivitySeconds = ref<number | null>(null);
let activityTimer: ReturnType<typeof setInterval> | null = null;
function stopActivityTimer() {
  if (!activityTimer) return;
  clearInterval(activityTimer);
  activityTimer = null;
  lastActivitySeconds.value = null;
}
watch(workflowBusy, (busy) => {
  if (!busy) {
    stopActivityTimer();
    return;
  }
  if (activityTimer) return;
  const refresh = () => {
    const ago = getLastActivityAgoMs();
    lastActivitySeconds.value = ago >= 0 ? Math.round(ago / 1000) : null;
  };
  refresh();
  activityTimer = setInterval(refresh, 1000);
});
onUnmounted(stopActivityTimer);

function getTargetEpisodeCount(...contents: string[]) {
  const text = contents.join("\n");
  const taggedCount = text.match(/<集数>\s*(\d+)\s*集?\s*<\/集数>/)?.[1];
  const describedCount = text.match(/(?:总共|共|目标|拆分为|规划为)\s*(\d+)\s*集/)?.[1];
  const count = Number(taggedCount ?? describedCount);
  return Number.isSafeInteger(count) && count > 0 && count <= 100 ? count : undefined;
}

/* ==================== 进度快照（后端派生，只读展示） ==================== */
const progressSnapshot = computed(() => planData.value.progress);
const stageProgress = computed(() => progressSnapshot.value?.stages);
const scriptProgress = computed(() => progressSnapshot.value?.scripts);
const conclusiveText = computed(() => progressSnapshot.value?.conclusive ?? "");
const nextBatchRange = computed(() => scriptProgress.value?.nextRange);

// 优先用后端确定性进度，缺失（老后端/接口失败）时回退到原有文本推导
const targetEpisodeCount = computed(
  () => scriptProgress.value?.targetEpisodes ?? getTargetEpisodeCount(planData.value.adaptationStrategy, planData.value.storySkeleton),
);
const persistedScriptCount = computed(
  () => scriptProgress.value?.savedCount ?? planData.value.script.filter((item) => item.name.trim() && item.content.trim()).length,
);
const remainingScriptCount = computed(() => {
  const fromProgress = scriptProgress.value?.remaining;
  if (fromProgress !== undefined) return fromProgress;
  return targetEpisodeCount.value === undefined ? undefined : Math.max(targetEpisodeCount.value - persistedScriptCount.value, 0);
});

function formatEpisodeRange(from: number, to: number) {
  const label = (value: number) => `EP${String(value).padStart(2, "0")}`;
  return from === to ? label(from) : `${label(from)}-${label(to)}`;
}

/** 阶段胶囊文案：未生成 / 已生成（字数）· 最近审核评级 */
function stageMeta(progress?: { ready: boolean; chars: number; latestReview?: { rating: string } }) {
  if (!progress?.ready) return t("workbench.scriptAgent.progress.notStarted");
  const parts = [t("workbench.scriptAgent.progress.generated", { chars: progress.chars })];
  if (progress.latestReview?.rating) parts.push(t("workbench.scriptAgent.progress.ratingShort", { rating: progress.latestReview.rating }));
  return parts.join(" · ");
}

const scriptStageMeta = computed(() => {
  const scripts = scriptProgress.value;
  if (!scripts) return t("workbench.scriptAgent.progress.notStarted");
  const total = scripts.targetEpisodes;
  const parts = [
    total === undefined
      ? t("workbench.scriptAgent.progress.episodesUnknown", { saved: scripts.savedCount })
      : t("workbench.scriptAgent.progress.episodes", { saved: scripts.savedCount, target: total }),
  ];
  if (scripts.latestReview?.rating) parts.push(t("workbench.scriptAgent.progress.ratingShort", { rating: scripts.latestReview.rating }));
  return parts.join(" · ");
});

const scriptProgressPercentage = computed(() => {
  const scripts = scriptProgress.value;
  if (!scripts?.targetEpisodes) return 0;
  return Math.min(100, Math.round((scripts.savedCount / scripts.targetEpisodes) * 100));
});

/** 剧本集数进度文案：3/19 集；目标集数未识别时只显示已保存数 */
const episodeCountText = computed(() => {
  const scripts = scriptProgress.value;
  if (!scripts) return "";
  return scripts.targetEpisodes === undefined
    ? t("workbench.scriptAgent.progress.episodesUnknown", { saved: scripts.savedCount })
    : t("workbench.scriptAgent.progress.episodes", { saved: scripts.savedCount, target: scripts.targetEpisodes });
});

/** 每集进度：按集号匹配剧本卡片，用于徽标；匹配不到时按列表顺序兜底 */
function episodeNoFromScriptName(name: string, fallbackIndex: number) {
  const matched = String(name ?? "").match(/\bEP\s*0*(\d{1,4})\b/i) ?? String(name ?? "").match(/第\s*0*(\d{1,4})\s*集/);
  const value = Number(matched?.[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallbackIndex + 1;
}
const episodeProgressByNo = computed(() => {
  const map = new Map<number, EpisodeProgress>();
  for (const episode of scriptProgress.value?.episodes ?? []) map.set(episode.episodeNo, episode);
  return map;
});
function scriptBadgeOf(name: string, index: number) {
  return episodeProgressByNo.value.get(episodeNoFromScriptName(name, index));
}
function reviewBadgeText(review?: EpisodeProgress["review"]) {
  if (!review || review.status === "unreviewed") return t("workbench.scriptAgent.progress.reviewUnreviewed");
  if (review.status === "blocked") return t("workbench.scriptAgent.progress.reviewBlocked", { count: review.blocking });
  if (review.status === "issues") return t("workbench.scriptAgent.progress.reviewIssues", { count: review.medium + review.light });
  return t("workbench.scriptAgent.progress.reviewPassed");
}
function reviewBadgeTheme(review?: EpisodeProgress["review"]) {
  if (!review || review.status === "unreviewed") return "default";
  if (review.status === "blocked") return "danger";
  if (review.status === "issues") return "warning";
  return "success";
}
function formatSavedAt(at?: number) {
  if (!at) return "";
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
/** 面板里的进度操作按钮：直接发起"继续生成 EPxx-EPyy" */
function startNextBatch() {
  const range = nextBatchRange.value;
  if (!range || workflowBusy.value) return;
  scriptAgent.chat(`继续生成 ${formatEpisodeRange(range.from, range.to)}`);
}

const nextAction = computed(() => {
  if (workflowBusy.value || loadingProjectData.value || !activeProjectId.value) return null;
  if (workflowStatus.value.state === "error" && workflowStatus.value.phase === "supervision" && persistedScriptCount.value > 0) {
    return {
      title: "剧本审核未完成",
      description: "已生成的剧本仍保留在工作区，请先重新完成逻辑审核。",
      label: "重试审核",
      prompt: "重试剧本逻辑审核",
      type: "chat" as const,
    };
  }
  if (remainingScriptCount.value !== undefined && remainingScriptCount.value > 0) {
    const generatedCount = persistedScriptCount.value;
    const range = nextBatchRange.value;
    const rangeText = range ? formatEpisodeRange(range.from, range.to) : "";
    return {
      title: "剧本尚未完成",
      description: range
        ? `已生成 ${generatedCount}/${targetEpisodeCount.value} 集，下一步 ${rangeText}（共 ${remainingScriptCount.value} 集待生成）。`
        : `已生成 ${generatedCount}/${targetEpisodeCount.value} 集，剩余 ${remainingScriptCount.value} 集待生成。`,
      label: range ? `继续生成 ${rangeText}` : workflowStatus.value.state === "error" ? "重新生成" : "继续生成",
      prompt: range ? `继续生成 ${rangeText}` : "继续生成剩余剧本",
      type: "chat" as const,
    };
  }
  if (persistedScriptCount.value > 0) {
    return {
      title: "剧本已就绪",
      description: "前往剧本管理，先提取角色、场景和道具资产，再进入制作流程。",
      label: "去提取资产",
      type: "script" as const,
    };
  }
  if (planData.value.adaptationStrategy.trim()) {
    return {
      title: "改编策略已完成",
      description: "继续生成剧本，系统会按已确认的集数顺序执行。",
      label: "生成剧本",
      prompt: "继续生成剧本",
      type: "chat" as const,
    };
  }
  if (planData.value.storySkeleton.trim()) {
    return {
      title: "故事骨架已完成",
      description: "继续制定改编策略，系统会自动进行后续审核。",
      label: "制定策略",
      prompt: "继续制定改编策略",
      type: "chat" as const,
    };
  }
  return {
    title: "准备开始策划",
    description: "生成故事骨架后，系统会继续推进后续阶段。",
    label: "开始策划",
    prompt: "开始生成故事骨架",
    type: "chat" as const,
  };
});
const toolbars: ToolbarNames[] = [
  "bold",
  "underline",
  "italic",
  "strikeThrough",
  "-",
  "title",
  "sub",
  "sup",
  "quote",
  "unorderedList",
  "orderedList",
  "task",
  "-",
  "codeRow",
  "code",
  "table",
  "-",
  "revoke",
  "next",
  "=",
  "preview",
];
const defMsg: ChatMessagesData[] = [
  {
    id: "welcome",
    role: "assistant",
    content: [
      { type: "text", status: "complete", data: $t("workbench.scriptAgent.welcomeMsg") },
      {
        type: "suggestion",
        status: "complete",
        data: [{ title: $t("workbench.scriptAgent.start"), prompt: $t("workbench.scriptAgent.start") }],
      },
    ],
  },
];

function resetProjectView() {
  planData.value = { storySkeleton: "", adaptationStrategy: "", script: [], projectGlobalContext: createEmptyProjectGlobalContext() };
  novelData.value = [];
  forceGenerateVisible.value = false;
  messages.value = [...defMsg];
}

function normalizePlanResponse(response: any) {
  const payload = response?.data ?? response ?? {};
  const value = payload?.data ?? payload;
  const emptyGlobalContext = createEmptyProjectGlobalContext();
  const normalizeGlobalMaterial = (material: any, fallback: ProjectGlobalMaterial): ProjectGlobalMaterial => ({
    content: typeof material?.content === "string" ? material.content : fallback.content,
    sourceName: typeof material?.sourceName === "string" ? material.sourceName : fallback.sourceName,
    ...(Number.isFinite(Number(material?.updatedAt)) ? { updatedAt: Number(material.updatedAt) } : {}),
    canonStatus: ["approved", "proposed", "unresolved"].includes(material?.canonStatus) ? material.canonStatus : fallback.canonStatus,
  });
  return {
    storySkeleton: typeof value?.storySkeleton === "string" ? value.storySkeleton : "",
    adaptationStrategy: typeof value?.adaptationStrategy === "string" ? value.adaptationStrategy : "",
    script: Array.isArray(value?.script)
      ? value.script
          .filter((item: any) => item && typeof item.name === "string" && item.name.trim())
          .map((item: any) => ({
            ...(Number.isSafeInteger(Number(item.id)) ? { id: Number(item.id) } : {}),
            name: item.name,
            content: typeof item.content === "string" ? item.content : "",
          }))
      : [],
    projectGlobalContext: {
      plot: normalizeGlobalMaterial(value?.projectGlobalContext?.plot, emptyGlobalContext.plot),
      character: normalizeGlobalMaterial(value?.projectGlobalContext?.character, emptyGlobalContext.character),
      world: normalizeGlobalMaterial(value?.projectGlobalContext?.world, emptyGlobalContext.world),
    },
    // 只读进度快照：后端派生，缺字段时保持 undefined（界面自动回退到文本推导）
    progress: normalizeProgress(value?.progress),
  };
}

function normalizeProgress(input: any): ScriptAgentProgressSnapshot | undefined {
  if (!input || typeof input !== "object") return undefined;
  const normalizeReview = (review: any) =>
    review && typeof review === "object" && Number.isFinite(Number(review.at))
      ? {
          rating: typeof review.rating === "string" ? review.rating : "-",
          at: Number(review.at),
          blocking: Number(review.blocking) || 0,
          medium: Number(review.medium) || 0,
          light: Number(review.light) || 0,
          closed: Number(review.closed) || 0,
        }
      : undefined;
  const normalizeStage = (stage: any) => ({
    ready: Boolean(stage?.ready),
    chars: Number(stage?.chars) || 0,
    ...(normalizeReview(stage?.latestReview) ? { latestReview: normalizeReview(stage?.latestReview) } : {}),
  });
  const scripts = input.scripts && typeof input.scripts === "object" ? input.scripts : {};
  return {
    stages: {
      storySkeleton: normalizeStage(input.stages?.storySkeleton),
      adaptationStrategy: normalizeStage(input.stages?.adaptationStrategy),
    },
    scripts: {
      ...(Number.isSafeInteger(Number(scripts.targetEpisodes)) && Number(scripts.targetEpisodes) > 0
        ? { targetEpisodes: Number(scripts.targetEpisodes) }
        : {}),
      savedCount: Number(scripts.savedCount) || 0,
      ...(Number.isFinite(Number(scripts.remaining)) ? { remaining: Math.max(Number(scripts.remaining), 0) } : {}),
      ...(Number(scripts.nextRange?.from) > 0 && Number(scripts.nextRange?.to) >= Number(scripts.nextRange?.from)
        ? { nextRange: { from: Number(scripts.nextRange.from), to: Number(scripts.nextRange.to) } }
        : {}),
      episodes: Array.isArray(scripts.episodes)
        ? scripts.episodes
            .filter((episode: any) => Number.isSafeInteger(Number(episode?.episodeNo)) && Number(episode.episodeNo) > 0)
            .map((episode: any) => ({
              episodeNo: Number(episode.episodeNo),
              name: typeof episode.name === "string" ? episode.name : "",
              chars: Number(episode.chars) || 0,
              ...(Number.isFinite(Number(episode.savedAt)) ? { savedAt: Number(episode.savedAt) } : {}),
              review: {
                status: ["passed", "blocked", "issues"].includes(episode.review?.status) ? episode.review.status : "unreviewed",
                ...(typeof episode.review?.rating === "string" ? { rating: episode.review.rating } : {}),
                blocking: Number(episode.review?.blocking) || 0,
                medium: Number(episode.review?.medium) || 0,
                light: Number(episode.review?.light) || 0,
                ...(Number.isFinite(Number(episode.review?.at)) ? { at: Number(episode.review.at) } : {}),
              },
            }))
        : [],
      ...(normalizeReview(scripts.latestReview) ? { latestReview: normalizeReview(scripts.latestReview) } : {}),
    },
    conclusive: typeof input.conclusive === "string" ? input.conclusive : "",
  };
}

async function getPlanData(projectId = activeProjectId.value) {
  if (!projectId) return;
  const requestVersion = ++planRequestVersion.value;
  try {
    const response = await axios.post("/scriptAgent/getPlanData", { projectId, agentType: "scriptAgent" });
    if (requestVersion !== planRequestVersion.value || activeProjectId.value !== projectId) return;
    planData.value = normalizePlanResponse(response);
  } catch (error: any) {
    if (requestVersion === planRequestVersion.value && activeProjectId.value === projectId) {
      console.error("加载脚本 Agent 工作区失败:", error);
      window.$message.error(error?.message || "脚本 Agent 工作区加载失败");
    }
  }
}

//快捷发送
const handleActions = {
  suggestion: (data?: any) => {
    scriptAgentStore().chat(data?.content?.prompt);
  },
};

function handleSend(text: string) {
  if (activeProjectId.value && scriptAgent.chat(text)) inputValue.value = "";
}
function handleStop() {
  scriptAgent.stopGenerate();
}

function runNextAction() {
  const action = nextAction.value;
  if (!action) return;
  if (action.type === "script") {
    router.push("/script");
    return;
  }
  if (scriptAgent.chat(action.prompt)) {
    inputValue.value = "";
  }
}

const memoryTypeLabel: Record<string, string> = {
  message: $t("workbench.scriptAgent.memoryType.message"),
  summary: $t("workbench.scriptAgent.memoryType.summary"),
  all: $t("workbench.scriptAgent.memoryType.all"),
};
function handleClearMemory(type: "message" | "summary" | "all") {
  const dialog = DialogPlugin.confirm({
    header: $t("workbench.scriptAgent.msg.clearConfirm"),
    body: $t("workbench.scriptAgent.msg.clearBody", { type: memoryTypeLabel[type] }),
    confirmBtn: $t("workbench.scriptAgent.msg.confirmClear"),
    cancelBtn: $t("workbench.scriptAgent.msg.cancel"),
    theme: "warning",
    onConfirm: async () => {
      const projectId = activeProjectId.value;
      if (!projectId) return;
      await axios.post(`/agents/clearMemory`, { projectId, agentType: "scriptAgent", type });
      if (type === "message" || type === "all") await scriptAgent.clearRuntime(projectId);
      window.$message.success($t("workbench.scriptAgent.msg.memoryCleared", { type: memoryTypeLabel[type] }));
      dialog.destroy();
      await getHistory(projectId, projectLoadVersion.value);
    },
  });
}
function handleReconnect() {
  const dialog = DialogPlugin.confirm({
    header: $t("workbench.scriptAgent.msg.reconnect"),
    body: $t("workbench.scriptAgent.msg.notReconnect"),
    confirmBtn: $t("workbench.scriptAgent.msg.keepReconnect"),
    cancelBtn: $t("workbench.scriptAgent.msg.cancel"),
    theme: "warning",
    onConfirm: async () => {
      scriptAgent.reconnect();
      dialog.destroy();
    },
  });
}

const loadingHistory = ref(false);
async function getHistory(projectId: number, loadVersion: number) {
  loadingHistory.value = true;
  try {
    const restored = await scriptAgent.loadRuntime(projectId);
    if (loadVersion !== projectLoadVersion.value || activeProjectId.value !== projectId) return;
    if (restored) {
      messages.value = [...defMsg, ...messages.value.filter((message) => message.id !== "welcome")];
      return;
    }
    const { data } = await axios.post(`/agents/getMemory`, {
      projectId,
      agentType: "scriptAgent",
    });
    if (loadVersion !== projectLoadVersion.value || activeProjectId.value !== projectId) return;
    messages.value = [...defMsg, ...(Array.isArray(data) && data.length ? data : [])];
  } catch (error) {
    console.error("加载脚本 Agent 历史失败:", error);
  } finally {
    if (loadVersion === projectLoadVersion.value) loadingHistory.value = false;
  }
}

async function getNovel(projectId: number, loadVersion: number) {
  try {
    const { data } = await axios.post("/novel/getNovelData", { projectId });
    if (loadVersion !== projectLoadVersion.value || activeProjectId.value !== projectId) return;
    novelData.value = Array.isArray(data) ? data : [];
    forceGenerateVisible.value = novelData.value.some((item: any) => item.eventState === 0);
  } catch (error) {
    console.error("加载小说数据失败:", error);
  }
}

const dialogVisible = ref(false);
const editContent = ref("");
//编辑markdown
function editMdPreview() {
  if (currentTable.value == 1) editContent.value = planData.value.storySkeleton;
  else if (currentTable.value == 2) editContent.value = planData.value.adaptationStrategy;
  dialogVisible.value = true;
}

const scriptEditIndex = ref(-1);
const scriptEditData = ref({
  name: "",
  content: "",
});
const scriptEditVisible = ref(false);

function editScript(index: number) {
  const item = planData.value.script[index];
  scriptEditIndex.value = index;
  scriptEditData.value = {
    name: item.name,
    content: item.content,
  };
  scriptEditVisible.value = true;
}

async function saveScript() {
  if (scriptEditIndex.value < 0) return;
  const current = planData.value.script[scriptEditIndex.value];
  planData.value.script[scriptEditIndex.value] = { ...current, ...scriptEditData.value };
  await scriptAgent.setPlanData();
  await getPlanData();
  window.$message.success($t("workbench.scriptAgent.msg.scriptUpdated"));
  scriptEditVisible.value = false;
}
async function delScript(index: number) {
  const item = planData.value.script[index];
  const dialog = DialogPlugin.confirm({
    header: $t("workbench.scriptAgent.msg.deleteConfirm"),
    body: $t("workbench.scriptAgent.msg.deleteBody"),
    confirmBtn: $t("workbench.scriptAgent.msg.confirmDelete"),
    cancelBtn: $t("workbench.scriptAgent.msg.cancel"),
    theme: "danger",
    onConfirm: async () => {
      if (item.id) {
        await axios.post("/script/delScript", { ids: [item.id] });
        planData.value.script.splice(index, 1);
      } else {
        planData.value.script.splice(index, 1);
      }
      await scriptAgent.setPlanData();
      await getPlanData();
      window.$message.success($t("workbench.scriptAgent.msg.scriptDeleted"));
      dialog.destroy();
    },
  });
}

/* ==================== 阶段内容删除（故事骨架 / 改编策略） ==================== */
const deletingStage = ref(false);

const stageLabels: Record<"storySkeleton" | "adaptationStrategy", string> = {
  storySkeleton: "故事骨架",
  adaptationStrategy: "改编策略",
};

function confirmDeleteStage(stage: "storySkeleton" | "adaptationStrategy") {
  const label = stageLabels[stage];
  const dialog = DialogPlugin.confirm({
    header: `删除${label}`,
    body: `确定删除全部${label}吗？仅清空该阶段内容，项目设定与已生成的剧本不受影响，删除后可回到对话框让 AI 重新生成。`,
    confirmBtn: "删除",
    cancelBtn: "取消",
    theme: "danger",
    onConfirm: async () => {
      dialog.destroy();
      await deleteStage(stage);
    },
  });
}

async function deleteStage(stage: "storySkeleton" | "adaptationStrategy") {
  const projectId = activeProjectId.value;
  if (!projectId || deletingStage.value) return;
  const label = stageLabels[stage];
  deletingStage.value = true;
  try {
    await axios.post("/scriptAgent/deleteStage", { projectId, stage });
    window.$message.success(`${label}已删除，可回到对话框重新生成`);
    await getPlanData();
  } catch (error: any) {
    window.$message.error(error?.message || `删除${label}失败`);
  } finally {
    deletingStage.value = false;
  }
}
async function onConfirm(value: string) {
  const projectId = activeProjectId.value;
  if (!projectId) return;
  try {
    if (currentTable.value == 1) planData.value.storySkeleton = value;
    if (currentTable.value == 2) planData.value.adaptationStrategy = value;
    await scriptAgent.setPlanData();
    await getPlanData(projectId);
    window.$message.success($t("workbench.scriptAgent.msg.updated"));
  } catch {
    window.$message.error($t("workbench.scriptAgent.msg.error"));
  }
}

async function refreshProjectData(projectId: number | null) {
  const loadVersion = ++projectLoadVersion.value;
  ++planRequestVersion.value;
  loadingProjectData.value = Boolean(projectId);
  loadingHistory.value = Boolean(projectId);
  resetProjectView();

  if (!projectId || !scriptAgent.updateContext(projectId)) {
    scriptAgent.disconnect();
    loadingProjectData.value = false;
    loadingHistory.value = false;
    return;
  }

  await Promise.allSettled([
    getPlanData(projectId),
    getHistory(projectId, loadVersion),
    getNovel(projectId, loadVersion),
  ]);
  if (loadVersion === projectLoadVersion.value && activeProjectId.value === projectId) {
    loadingProjectData.value = false;
  }
}

watch(activeProjectId, (projectId) => void refreshProjectData(projectId), { immediate: true });
// 后台任务结束（多为断连期间在服务端跑完）后，重新拉取正式工作区数据补上前端没收到的那部分
watch(
  () => scriptAgent.runtimeSyncTick,
  () => void getPlanData(),
);

onUnmounted(() => {
  ++projectLoadVersion.value;
  ++planRequestVersion.value;
  // 离开页面不主动断开连接，避免中断正在运行的剧本任务；
  // 连接生命周期由项目切换 / 明确的操作（重新连接、停止）管理。
});

</script>

<style lang="scss" scoped>
@keyframes workflowRotate {
  to {
    transform: rotate(360deg);
  }
}

.scriptAgent {
  height: calc(100% - 16px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  :deep(.splitpanes__pane) {
    background-color: transparent !important;
  }
  :deep(.splitpanes__splitter) {
    border-left: none;
    margin-left: 1px;
  }
  .data {
    flex: 1;
    overflow: hidden;
    :deep(.operate) {
      display: flex;
      flex-direction: column;
      min-height: 0;
      min-width: 250px;
      height: 100%;
      .box {
        flex: 1;
        display: flex;
        flex-direction: column;
        container: script-chat / inline-size;
        border-radius: 8px;
        border: 1px solid var(--td-border-level-2-color);
        background-color: #fff;
        overflow: hidden;
        position: relative;
        width: 100%;
        height: 100%;
        --td-chat-item-gap: 18px;
        --td-chat-font-size: 14px;
        --td-chat-item-content-base-padding: 9px 11px;
        --td-chat-item-content-radius: 6px;
        --td-chat-item-content-gap: 6px;
        --td-chat-item-text-padding: 8px 10px;
        --td-chat-item-text-radius: 6px;
        --td-chat-item-think-padding-tb: 7px;
        --td-chat-item-think-padding-lr: 9px;
        --td-chat-item-think-inner-padding: 0 9px 7px;
        --td-chat-item-think-title-gap: 6px;
        --td-chat-md-content-gap-main: 0 0 6px;
        --td-chat-md-content-gap-t1: 14px 0 8px;
        --td-chat-md-content-gap-t2: 12px 0 7px;
        --td-chat-md-content-gap-t3: 10px 0 6px;
        --td-chat-md-h1-font: 600 16px / 1.5 var(--td-font-family);
        --td-chat-md-h2-font: 600 15px / 1.5 var(--td-font-family);
        --td-chat-md-h3-font: 600 14px / 1.5 var(--td-font-family);
        --td-chat-md-table-font-size: 12px;
        --td-chat-md-table-th-font: 600 12px / 1.5 var(--td-font-family);
        --td-chat-md-table-td-font: 400 12px / 1.5 var(--td-font-family);
        --td-chat-md-table-th-padding: 6px 8px;

        .sidebarHeader {
          min-height: 52px;
          padding: 10px 12px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          flex-shrink: 0;
          border-bottom: 1px solid var(--td-border-level-1-color);
          background: var(--td-bg-color-container);
        }
        .sidebarHeading {
          min-width: 0;
          display: flex;
          align-items: baseline;
          gap: 8px;
        }
        .sidebarTitle {
          color: var(--td-text-color-primary);
          font-size: 14px;
          font-weight: 600;
        }
        .sidebarSubtitle {
          color: var(--td-text-color-placeholder);
          font-size: 12px;
        }
        .connectionState {
          display: inline-flex;
          align-items: center;
          gap: 3px;
          flex-shrink: 0;
          color: var(--td-success-color);
          font-size: 12px;

          &.is-offline {
            color: var(--td-error-color);
          }
        }
        .inputBox {
          padding: 8px 12px 10px;
          flex-shrink: 0;
          border-top: 1px solid var(--td-border-level-1-color);
          background: var(--td-bg-color-container);

          .t-chat-sender__textarea {
            padding: 9px 10px;
          }
          .t-chat-sender__textarea__wrapper {
            height: 40px;
          }
          .t-textarea__inner {
            min-height: 40px !important;
            height: 40px !important;
          }
        }
        .workflowStatus {
          display: flex;
          align-items: center;
          gap: 8px;
          min-height: 36px;
          margin: 0 12px 10px;
          padding: 8px 11px;
          color: var(--td-text-color-secondary);
          font-size: 13px;
          border: 1px solid var(--td-border-level-2-color);
          border-radius: 6px;
          background: var(--td-bg-color-secondarycontainer);

          &.is-error {
            color: var(--td-error-color);
            border-color: var(--td-error-color-4);
          }
          .activityHint {
            margin-left: auto;
            font-size: 12px;
            opacity: 0.72;
            white-space: nowrap;
          }
        }
        .workflowSpinner {
          animation: workflowRotate 0.9s linear infinite;
          flex-shrink: 0;
        }
        .nextAction {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          margin: 0 12px 10px;
          padding: 11px 12px;
          border: 1px solid var(--td-brand-color-3);
          border-radius: 6px;
          background: var(--td-bg-color-secondarycontainer);

          .nextActionCopy {
            display: flex;
            min-width: 0;
            flex-direction: column;
            gap: 3px;
            color: var(--td-text-color-secondary);
            font-size: 12px;
            line-height: 1.5;
          }
          .nextActionTitle {
            color: var(--td-text-color-primary);
            font-size: 13px;
            font-weight: 600;
          }
        }
      }
      .t-chat__list {
        min-height: 0;
        padding: 14px 12px 4px;
        scroll-padding-bottom: 12px;
        background: #fbfbfb;
      }
      t-chat-item {
        min-width: 0;
      }
      t-chat-item::part(t-chat__item__header) {
        min-height: 20px;
        padding: 0 0 5px;
      }
      t-chat-item::part(t-chat__item__name) {
        padding: 0;
        color: var(--td-text-color-secondary);
        font-size: 12px;
        font-weight: 600;
      }
      t-chat-item[placement="left"]::part(t-chat__item__content) {
        padding: 0 0 0 10px;
        border: 0;
        border-left: 2px solid var(--td-border-level-2-color);
        border-radius: 0;
        background: transparent;
      }
      t-chat-item[placement="left"][status="error"]::part(t-chat__item__content) {
        border-left-color: var(--td-error-color-4);
      }
      t-chat-item::part(t-chat__item__think__header__content) {
        font-size: 12px;
      }
      t-chat-item::part(t-chat__item__think__inner) {
        max-height: 132px;
        overflow: auto;
        font-size: 12px;
        line-height: 1.55;
      }
      t-chat-item::part(md_h1),
      t-chat-item::part(md_h2),
      t-chat-item::part(md_h3),
      t-chat-item::part(md_p),
      t-chat-item::part(md_li) {
        letter-spacing: 0;
        overflow-wrap: anywhere;
      }
      t-chat-item::part(md_table) {
        display: block;
        max-width: 100%;
        overflow-x: auto;
      }
      t-chat-item::part(md_th),
      t-chat-item::part(md_td) {
        min-width: 92px;
        padding: 6px 8px;
      }
    }
    :deep(.data) {
      display: flex;
      flex-direction: column;
      height: 100%;
      position: relative;
      .progressPanel {
        margin: 10px 12px 0;
        padding: 10px 12px;
        border: 1px solid var(--td-border-level-2-color);
        border-radius: 8px;
        background: linear-gradient(180deg, var(--td-bg-color-container) 0%, var(--td-bg-color-secondarycontainer) 100%);
        display: flex;
        flex-direction: column;
        gap: 8px;

        .stagePills {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
        }

        .stagePill {
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          gap: 2px;
          flex: 1 1 120px;
          min-width: 0;
          padding: 6px 10px;
          border: 1px solid var(--td-border-level-2-color);
          border-radius: 6px;
          background: var(--td-bg-color-container);
          cursor: pointer;
          transition:
            border-color 0.2s ease,
            box-shadow 0.2s ease;

          &:hover {
            border-color: var(--td-brand-color);
            box-shadow: 0 2px 8px rgba(0, 82, 217, 0.12);
          }

          &.is-active {
            border-color: var(--td-brand-color);
            box-shadow: inset 0 0 0 1px var(--td-brand-color);
          }

          &.is-ready .stageName {
            color: var(--td-success-color);
          }

          .stageName {
            font-size: 13px;
            font-weight: 600;
            color: var(--td-text-color-primary);
          }

          .stageMeta {
            max-width: 100%;
            overflow: hidden;
            font-size: 12px;
            color: var(--td-text-color-secondary);
            white-space: nowrap;
            text-overflow: ellipsis;
          }
        }

        .progressRow {
          display: flex;
          align-items: center;
          gap: 10px;

          .progressTrack {
            display: flex;
            flex: 1;
            align-items: center;
            gap: 8px;
            min-width: 0;

            .progressText {
              font-size: 12px;
              color: var(--td-text-color-secondary);
              white-space: nowrap;
            }

            .t-progress {
              flex: 1;
              min-width: 80px;
              transition: width 0.3s ease;
            }
          }
        }

        .conclusiveLine {
          font-size: 12px;
          line-height: 1.6;
          color: var(--td-text-color-secondary);
          word-break: break-word;
        }
      }
      .stageTabActions {
        gap: 8px;
      }

      .tabsWrapper {
        flex: 1;
        overflow: hidden;
        display: flex;
        flex-direction: column;
        transition: padding-bottom 0.3s ease;
        .t-tabs {
          display: flex;
          flex-direction: column;
          height: 100%;
          .t-tabs__header {
            flex-shrink: 0;
          }
          .t-tabs__content {
            flex: 1;
            overflow: hidden;
          }
          .t-tab-panel {
            height: 100%;
          }
        }
      }
    }
  }
}

@container script-chat (max-width: 420px) {
  .scriptAgent .box .nextAction {
    flex-direction: column;
    align-items: stretch;
    gap: 9px;
  }

  .scriptAgent .box .nextAction .t-button {
    width: 100%;
    min-width: 0;
  }
}

.panelContent {
  height: 100%;
  overflow-y: auto;
  padding: 12px 16px;
  box-sizing: border-box;
}

.stageReviewLine {
  margin-bottom: 8px;
  padding: 6px 10px;
  border-left: 3px solid var(--td-brand-color);
  border-radius: 4px;
  background: var(--td-bg-color-secondarycontainer);
  font-size: 12px;
  color: var(--td-text-color-secondary);
}

.scriptCardMeta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 8px 12px 0;

  .metaChip {
    padding: 1px 6px;
    border-radius: 4px;
    background: var(--td-bg-color-secondarycontainer);
    font-size: 12px;
    line-height: 18px;
    color: var(--td-text-color-secondary);
  }

  .metaTime {
    margin-left: auto;
    font-size: 12px;
    color: var(--td-text-color-placeholder);
  }
}

.scriptList {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
}

.scriptCard {
  border: 1px solid var(--td-border-level-2-color);
  border-radius: 8px;
  overflow: hidden;
  background: #fff;
  display: flex;
  flex-direction: column;
  transition: box-shadow 0.2s ease;
  .scriptCardHeader {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 12px;
    background-color: #f5f7fa;
    border-bottom: 1px solid var(--td-border-level-2-color);
    .scriptCardHeaderLeft {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }
    .scriptCardActions {
      flex-shrink: 0;
      display: flex;
      gap: 4px;
    }
    .scriptIndex {
      font-size: 12px;
      font-weight: 600;
      flex-shrink: 0;
      background: #e6e3e3;
      padding: 1px 6px;
      border-radius: 4px;
    }
    .scriptTitle {
      font-size: 14px;
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  }
  .scriptCardBody {
    font-size: 13px;
    line-height: 1.7;
    padding: 10px 12px;
    flex: 1;
    max-height: 300px;
    overflow-y: auto;
    pre {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-all;
      font-family: inherit;
    }
    .emptyContent {
      display: block;
      font-size: 13px;
    }
    :deep(.md-editor-preview-wrapper) {
      padding: 0;
    }
  }
  .scriptCardFooter {
    gap: 8px;
    padding: 8px 12px;
    border-top: 1px solid #e6e3e3;
    background-color: #fafafa;
    .assetsLabel {
      display: flex;
      align-items: center;
      gap: 3px;
      font-size: 12px;
      white-space: nowrap;
      margin-top: 2px;
      flex-shrink: 0;
    }
    .assetsTags {
      display: flex;
      flex-wrap: wrap;
      gap: 5.6px;
    }
  }
}

.scriptEditForm {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 4px 0;
  .scriptEditField {
    display: flex;
    flex-direction: column;
    gap: 6px;
    label {
      font-size: 13px;
      font-weight: 500;
    }
    .assets-list {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 5px;
      margin-top: 10px;
    }
  }
  .assetsEditor {
    display: flex;
    flex-direction: column;
    gap: 8px;
    border-radius: 6px;
    padding: 8px 12px;
    background: #fafafa;
    .assetsTagList {
      display: flex;
      flex-wrap: wrap;
      gap: 5.6px;
      min-height: 24px;
    }
    .assetsInputRow {
      display: flex;
      gap: 8px;
      align-items: center;
    }
  }
}

.forceGenerateMask {
  position: absolute;
  inset: 0;
  background: rgba(170, 170, 170, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  border-radius: 10px;
  .forceGenerateCard {
    background: #fdfbfb;
    border-radius: 12px;
    padding: 28px 32px 24px;
    max-width: 300px;
    width: 90%;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    .forceGenerateActions {
      display: flex;
      gap: 12px;
      margin-top: 8px;
      width: 100%;
      justify-content: center;
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
:deep(.t-tabs__operations--right) {
  top: 0;
  bottom: 0;
}
:deep(.t-tabs__btn--right) {
  display: none;
}
</style>
