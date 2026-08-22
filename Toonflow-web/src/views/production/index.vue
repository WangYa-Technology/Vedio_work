<template>
  <div class="productionLayout">
    <!-- Left Panel: Director plan and shot list -->
    <div class="shotPanel">
      <t-tabs v-model="activeWorkspaceTab" class="workspaceTabs">
        <template #action>
          <div class="workspaceActions">
            <t-select
              :value="currentEpisodesId ?? undefined"
              :placeholder="$t('workbench.production.selectPlaceholder')"
              autoWidth
              size="small"
              :options="episodesOptions"
              filterable
              @change="handleEpisodesChange">
              <template #label>
                <i-document-folder size="18" />
              </template>
            </t-select>
            <t-tooltip placement="bottom" theme="primary" :content="$t('workbench.production.getFlowData')">
              <t-button variant="outline" shape="square" size="small" @click="refreshData">
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
        </template>

        <t-tab-panel value="directorPlan" :label="$t('workbench.production.directorPlan')">
          <div class="directorPlan" v-loading="loadingData">
            <MdPreview v-if="directorPlanPreview" :modelValue="directorPlanPreview" />
            <div v-else class="workspaceEmpty">
              <t-empty :description="$t('workbench.production.noDirectorPlan')" />
            </div>
          </div>
        </t-tab-panel>

        <t-tab-panel value="storyboard" :label="$t('workbench.production.storyboardList')">
          <div class="shotList" v-loading="loadingData">
            <template v-if="storyboardSegments.length > 0">
              <div v-for="(segment, index) in storyboardSegments" :key="segment.id" class="shotCard segmentCard">
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
            <div v-else class="workspaceEmpty">
              <t-empty :description="$t('workbench.production.noShots')" />
            </div>
          </div>
        </t-tab-panel>
      </t-tabs>
    </div>

    <!-- Right Panel: Chat interface -->
    <div class="chatPanel">
      <div class="chatHeader f ac jb">
        <span class="f ac" style="gap: 6px">
          <i-dot theme="outline" :fill="connected ? 'green' : 'red'" />
          <span class="chatTitle">{{ currentEpisodeLabel || $t("workbench.production.productionAgent") }}</span>
        </span>
        <div class="f ac" style="gap: 6px">
          <t-select :value="thinkLevel" :options="thinkLevelOptions" autoWidth size="small" @change="handleThinkLevelChange" />
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
            v-for="message in renderableMessages"
            :key="message.id"
            :message="message"
            :name="(message as any).name"
            :placement="message.role === 'user' ? 'right' : 'left'"
            :variant="message.role === 'user' ? 'base' : 'outline'"
            :handleActions="message.role === 'user' ? {} : handleActions"
            :status="message.status"
            allowContentSegmentCustom />
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
        </div>
        <div v-if="nextAction" class="nextAction">
          <div class="nextActionCopy">
            <span class="nextActionTitle">{{ nextAction.title }}</span>
            <span>{{ nextAction.description }}</span>
          </div>
          <t-button size="small" theme="primary" :disabled="workflowBusy || loadingData || loadingHistory" @click="runNextAction">
            {{ nextAction.label }}
          </t-button>
          <t-button v-if="nextAction.openAssets" size="small" variant="outline" :disabled="workflowBusy || loadingData || loadingHistory" @click="openAssetLibrary">
            打开资产库
          </t-button>
        </div>

        <t-chat-sender
          class="chatSender"
          :disabled="workflowBusy || !connected || loadingData || loadingHistory"
          v-model="inputValue"
          :loading="workflowBusy"
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
import { MdPreview } from "md-editor-v3";
import "md-editor-v3/lib/preview.css";
import { useRouter } from "vue-router";

const projectState = projectStore();
const { project, allProject } = storeToRefs(projectState);
const productionStore = productionAgentStore();
const router = useRouter();
const { flowData, connected, renderableMessages, status, workflowStatus, loadingHistory, thinkLevel } = storeToRefs(productionStore);

const inputValue = ref("");
const loadingData = ref(false);
const workbenchVisible = ref(false);
const activeWorkspaceTab = ref<"directorPlan" | "storyboard">("directorPlan");
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
const directorPlanPreview = computed(() => formatDirectorPlan(flowData.value?.scriptPlan || ""));
function parseStoryboardTableReferenceIds(markdown: string) {
  return [...String(markdown || "").matchAll(/\*\*引用资产ID\*\*\s*[：:]\s*(?:\[|［)([^\]］]*)(?:\]|］)/g)]
    .flatMap((match) => match[1].match(/\d+/g) || [])
    .map(Number)
    .filter(Number.isFinite);
}

const assetIndex = computed(() => {
  const entries = flowData.value.assets.flatMap((asset) => [asset, ...(asset.derive || [])]);
  return new Map(entries.map((asset) => [Number(asset.id), asset]));
});
const requiredAssetIds = computed(() => {
  const ids = flowData.value.storyboard.length
    ? flowData.value.storyboard.flatMap((item) => item.associateAssetsIds || [])
    : parseStoryboardTableReferenceIds(flowData.value.storyboardTable);
  return [...new Set(ids.map(Number).filter(Number.isFinite))];
});
const missingRequiredAssets = computed(() =>
  requiredAssetIds.value
    .map((id) => assetIndex.value.get(id) || { id, name: `素材 #${id}`, src: "", state: "未生成" })
    .filter((asset) => !asset.src),
);
const workflowBusy = computed(() =>
  status.value === "pending" || status.value === "streaming" || workflowStatus.value.state === "working" || workflowStatus.value.state === "retrying",
);
const showWorkflowStatus = computed(() => Boolean(workflowStatus.value.label) && (workflowBusy.value || workflowStatus.value.state === "error"));
const workflowStatusLabel = computed(() => workflowStatus.value.label || "正在处理当前制作任务");
const productionStage = computed(() => {
  if (!flowData.value.scriptPlan.trim()) return "directorPlan" as const;
  if (!flowData.value.storyboardTable.trim()) return "storyboardTable" as const;
  if (missingRequiredAssets.value.length) return "assetImages" as const;
  if (!flowData.value.storyboard.length) return "storyboardPanel" as const;
  if (flowData.value.storyboard.some((item) => item.state !== "已完成")) return "storyboardGen" as const;
  return "complete" as const;
});
const nextAction = computed(() => {
  if (workflowBusy.value || loadingData.value || loadingHistory.value || !currentEpisodesId.value || !connected.value) return null;
  const failed = workflowStatus.value.state === "error";
  switch (productionStage.value) {
    case "directorPlan":
      return {
        title: "还没有导演规划",
        description: "先根据当前剧本制定导演规划，再继续分镜流程。",
        label: failed ? "重新制定" : "制定导演规划",
        prompt: "继续执行导演规划",
      };
    case "storyboardTable":
      return {
        title: "导演规划已完成",
        description: "继续构建分镜表，完成后会进入正式分镜面板。",
        label: failed ? "重新构建" : "构建分镜表",
        prompt: "继续构建分镜表",
        openAssets: true,
      };
    case "assetImages": {
      const names = missingRequiredAssets.value.map((asset) => `${asset.name}（${asset.id}）`).join("、");
      const generating = missingRequiredAssets.value.some((asset) => asset.state === "生成中");
      return {
        title: generating ? "分镜所需素材正在生成" : "分镜所需素材未就绪",
        description: generating
          ? `${names}尚未生成完成，完成后才能进入分镜面板和视频生成。`
          : `先补充生成${names}，系统会按片段自动关联对应素材。`,
        label: generating ? "刷新素材状态" : failed ? "重新生成素材" : "生成缺失素材",
        prompt: generating ? "" : `分镜引用的素材未就绪，请先生成这些缺失素材：${names}。素材就绪前不要进入分镜面板或视频生成。`,
        refresh: generating,
        openAssets: !generating,
      };
    }
    case "storyboardPanel":
      return {
        title: "分镜表已保存",
        description: "将已保存的分镜表写入正式分镜面板，不重复生成前置内容。",
        label: failed ? "重新写入" : "写入分镜面板",
        prompt: "继续写入正式分镜面板",
      };
    case "storyboardGen":
      return {
        title: "分镜面板已就绪",
        description: "继续处理分镜图片生成和失败项。",
        label: failed ? "重新处理" : "继续生成分镜图",
        prompt: "继续生成分镜图并检查失败项",
      };
    default:
      return null;
  }
});

const currentEpisodeLabel = computed(() => {
  const ep = episodesOptions.value.find((o) => o.value === currentEpisodesId.value);
  return ep?.label ?? "";
});

watch(
  [() => flowData.value?.scriptPlan, () => flowData.value?.storyboardTable],
  ([scriptPlan, storyboardTable], [previousScriptPlan, previousStoryboardTable]) => {
    if (storyboardTable?.trim() && storyboardTable !== previousStoryboardTable) {
      activeWorkspaceTab.value = "storyboard";
    } else if (scriptPlan?.trim() && scriptPlan !== previousScriptPlan) {
      activeWorkspaceTab.value = "directorPlan";
    }
  },
);

function formatDirectorPlan(content: string) {
  let markdown = content
    .trim()
    .replace(/^<scriptPlan>\s*/i, "")
    .replace(/\s*<\/scriptPlan>$/i, "");

  // Models may emit the structured contract with English tag names even though
  // the planning skill documents Chinese section labels. Normalize that form
  // before Markdown preview; otherwise md-editor treats the custom tags as HTML
  // and collapses the entire plan into one unreadable paragraph.
  const englishPlan = formatEnglishDirectorPlan(markdown);
  if (englishPlan) return englishPlan;

  // Older production runs stored Markdown inside XML section wrappers
  // (`sceneSummary` + `notes`). Do not pass those wrappers to md-editor: custom
  // HTML-like tags make the table render as one plain paragraph.
  const hybridPlan = formatHybridDirectorPlan(markdown);
  if (hybridPlan) return hybridPlan;

  const sectionTags = ["分场汇总表", "逐场注意事项", "场间过渡"];
  const fieldTags = ["情感砸点", "一致性锚点", "空间距离", "环境音", "易错提示"];
  const hasStructuredTags = sectionTags.some((tag) => markdown.includes(`<${tag}>`)) || /<场次\b/.test(markdown);

  if (hasStructuredTags) {
    markdown = markdown.replace(/^[\t ]+/gm, "");
  }

  for (const tag of sectionTags) {
    markdown = markdown.replace(new RegExp(`<${tag}>\\s*`, "g"), `## ${tag}\n\n`).replace(new RegExp(`\\s*</${tag}>`, "g"), "\n\n");
  }

  markdown = markdown.replace(/<场次\s+id\s*=\s*["']?([^"'>\s]+)["']?\s*>\s*/g, (_match, id) => `### ${id}\n\n`).replace(/\s*<\/场次>/g, "\n\n");

  for (const tag of fieldTags) {
    markdown = markdown.replace(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, "g"), (_match, value) => {
      return `- **${tag}**：${String(value).trim()}\n`;
    });
  }

  return markdown.replace(/\n{3,}/g, "\n\n").trim();
}

function formatHybridDirectorPlan(content: string) {
  const readBlock = (names: string[]) => {
    const pattern = names.join("|");
    const match = content.match(new RegExp(`<(?:(?:${pattern}))\\b[^>]*>([\\s\\S]*?)<\\/(?:(?:${pattern}))>`, "i"));
    return match?.[1]?.trim() || "";
  };

  const summary = readBlock(["sceneSummary", "scenesummary"]);
  const notes = readBlock(["sceneNotes", "scenenotes", "notes"]);
  const transitions = readBlock(["transitions"]);
  if (!summary && !notes && !transitions) return "";

  const sections: string[] = [];
  if (summary) sections.push(["## 分场汇总表", "", summary].join("\n"));
  if (notes) {
    const normalizedNotes = notes
      .replace(/^[ \t]*([A-Za-z]+\d+)\s*:\s*$/gm, "### $1")
      .replace(/^[ \t]*(Sc\d+)\s*$/gm, "### $1")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    sections.push(["## 逐场注意事项", "", normalizedNotes].join("\n"));
  }
  if (transitions) sections.push(["## 场间过渡", "", transitions].join("\n"));
  return sections.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

function formatEnglishDirectorPlan(content: string) {
  if (!/<(?:sceneSummary|sceneNotes|transitions)\b/i.test(content)) return "";

  const readTag = (block: string, names: string[]) => {
    const pattern = names.join("|");
    const match = block.match(new RegExp(`<(?:(?:${pattern}))\\b[^>]*>([\\s\\S]*?)<\\/(?:(?:${pattern}))>`, "i"));
    return match?.[1]?.trim() || "";
  };
  const readScenes = (section: string) =>
    [...section.matchAll(/<scene\b[^>]*>([\s\S]*?)<\/scene>/gi)].map((match) => match[1]);
  const readText = (block: string, names: string[]) => readTag(block, names).replace(/\s+/g, " ").trim();
  const cell = (value: string) => value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  const summary = readTag(content, ["sceneSummary", "scenesummary"]);
  const notes = readTag(content, ["sceneNotes", "scenenotes"]);
  const transitions = readTag(content, ["transitions"]);
  const summaryScenes = readScenes(summary);
  const noteScenes = readScenes(notes);
  if (!summaryScenes.length && !noteScenes.length) return "";

  const sections: string[] = [];
  if (summaryScenes.length) {
    sections.push(
      [
        "## 分场汇总表",
        "",
        "| 场次 | 场景名 | 台词条数 | 台词字数 | 情绪浓度 | 情绪基调 |",
        "|---|---|---:|---:|---:|---|",
        ...summaryScenes.map((scene) => {
          const id = readText(scene, ["sceneId", "sceneid"]);
          const name = readText(scene, ["sceneName", "scenename"]);
          const dialogueCount = readText(scene, ["dialogueCount", "dialoguecount"]) || "0";
          const dialogueWordCount = readText(scene, ["dialogueWordCount", "dialoguewordcount"]) || "0";
          const emotionIntensity = readText(scene, ["emotionIntensity", "emotionintensity"]) || "0";
          const emotionTone = readText(scene, ["emotionTone", "emotiontone"]);
          return `| ${cell(id)} | ${cell(name)} | ${cell(dialogueCount)} | ${cell(dialogueWordCount)} | ${cell(emotionIntensity)} | ${cell(emotionTone)} |`;
        }),
      ].join("\n"),
    );
  }

  if (noteScenes.length) {
    const noteLines = ["## 逐场注意事项", ""];
    const noteFieldLabels: Record<string, string> = {
      emotionalBeat: "情绪节点",
      continuityAnchor: "连续性锚点",
      spatialDistance: "空间距离",
      environmentSound: "环境音",
      errorWarning: "易错提示",
    };
    for (const scene of noteScenes) {
      const id = readText(scene, ["sceneId", "sceneid"]);
      noteLines.push(`### ${cell(id) || "未命名场次"}`, "");
      const notesBlock = readTag(scene, ["notes"]);
      const items = [...notesBlock.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)]
        .map((match) => match[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim())
        .filter(Boolean);
      const fields = Object.entries(noteFieldLabels)
        .map(([tag, label]) => {
          const value = readText(notesBlock, [tag]);
          return value ? `- **${label}**：${value}` : "";
        })
        .filter(Boolean);
      if (items.length) noteLines.push(...items.map((item) => `- ${item}`), "");
      else if (fields.length) noteLines.push(...fields, "");
      else noteLines.push("无", "");
    }
    sections.push(noteLines.join("\n").trim());
  }

  if (transitions) sections.push(["## 场间过渡", "", transitions].join("\n"));
  return sections.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

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
  let tableColumns: string[] = [];

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
      tableColumns = [];
      continue;
    }
    if (!currentSegment) continue;
    if (line.startsWith("**引用资产名称**")) {
      currentSegment.assetNames = line
        .replace(/^\*\*引用资产名称\*\*[:：]\s*/, "")
        .replace(/^\[/, "")
        .replace(/\]$/, "");
      continue;
    }
    if (line.startsWith("**引用资产ID**")) {
      currentSegment.assetIds = line
        .replace(/^\*\*引用资产ID\*\*[:：]\s*/, "")
        .replace(/^\[/, "")
        .replace(/\]$/, "");
      continue;
    }
    if (!line.startsWith("|") || line.includes("---")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.includes("序号")) {
      tableColumns = cells;
      continue;
    }
    if (cells.length < 7) continue;
    const value = (name: string, fallbackIndex: number) => {
      const index = tableColumns.indexOf(name);
      return cells[index >= 0 ? index : fallbackIndex] || "";
    };
    const legacyCamera = value("运镜", 4);
    currentSegment.rows.push({
      serial: value("序号", 0),
      description: value("画面描述", 1),
      duration: value("时长", 2),
      scale: value("景别", 3),
      cameraMovement: legacyCamera,
      dialogue: value("台词", 5).replace(/^台词[：:]\s*/, "").trim(),
      sound: value("音效", 6).replace(/^音效[：:]\s*/, "").trim(),
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

function runNextAction() {
  const action = nextAction.value;
  if (!action) return;
  if ("refresh" in action && action.refresh) {
    refreshData();
    return;
  }
  productionStore.chat(action.prompt);
}

function openAssetLibrary() {
  router.push({ path: "/assets", query: { from: "production" } });
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

    .workspaceTabs {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;

      :deep(.t-tabs__header) {
        flex-shrink: 0;
        padding-left: 8px;
      }

      :deep(.t-tabs__content) {
        flex: 1;
        min-height: 0;
        overflow: hidden;
      }

      :deep(.t-tab-panel) {
        height: 100%;
        min-height: 0;
        overflow: hidden;
      }

      :deep(.t-tabs__operations--right) {
        top: 0;
        bottom: 0;
        padding-right: 12px;
      }

      :deep(.t-tabs__btn--right) {
        display: none;
      }
    }

    .workspaceActions {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .directorPlan {
      height: 100%;
      display: flex;
      flex-direction: column;
      overflow-y: auto;
      box-sizing: border-box;
      padding: 16px 20px 32px;

      :deep(.md-editor-preview-wrapper) {
        padding: 0;
      }

      :deep(.md-editor-preview) {
        color: var(--td-text-color-primary, #333);
        font-size: 14px;
        line-height: 1.75;

        h2 {
          margin: 24px 0 12px;
          padding-bottom: 8px;
          border-bottom: 1px solid var(--td-border-level-1-color, #e7e7e7);
          font-size: 18px;
          font-weight: 600;
          line-height: 1.4;
        }

        h2:first-child {
          margin-top: 0;
        }

        h3 {
          margin: 20px 0 8px;
          font-size: 15px;
          font-weight: 600;
          line-height: 1.4;
        }

        table {
          width: 100%;
          margin: 0 0 20px;
          border-collapse: collapse;
          font-size: 13px;
        }

        th,
        td {
          padding: 8px 10px;
          border: 1px solid var(--td-border-level-1-color, #e7e7e7);
          text-align: left;
          vertical-align: top;
        }

        th {
          background: var(--td-bg-color-page, #f5f5f5);
          font-weight: 600;
        }

        li {
          margin-bottom: 6px;
        }
      }
    }

    .workspaceEmpty {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .shotList {
      height: 100%;
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      box-sizing: border-box;
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

      .workflowStatus {
        display: flex;
        align-items: center;
        gap: 8px;
        min-height: 34px;
        margin: 0 8px 8px;
        padding: 7px 10px;
        border: 1px solid var(--td-brand-color-3, #b5c7e8);
        border-radius: 6px;
        background: var(--td-brand-color-1, #f0f5ff);
        color: var(--td-brand-color, #0052d9);
        font-size: 12px;
        line-height: 1.4;

        &.is-error {
          border-color: var(--td-error-color-3, #f3b9bd);
          background: var(--td-error-color-1, #fff0f0);
          color: var(--td-error-color, #d54941);
        }

        .workflowSpinner {
          flex-shrink: 0;
          animation: productionWorkflowRotate 0.9s linear infinite;
        }
      }

      .nextAction {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        margin: 0 8px 8px;
        padding: 9px 10px;
        border: 1px solid var(--td-brand-color-3, #b5c7e8);
        border-radius: 6px;
        background: var(--td-brand-color-1, #f0f5ff);

        .nextActionCopy {
          display: flex;
          min-width: 0;
          flex-direction: column;
          gap: 3px;
          color: var(--td-text-color-secondary, #777);
          font-size: 12px;
          line-height: 1.45;
        }

        .nextActionTitle {
          color: var(--td-text-color-primary, #333);
          font-size: 13px;
          font-weight: 600;
        }
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

@keyframes productionWorkflowRotate {
  to {
    transform: rotate(360deg);
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
