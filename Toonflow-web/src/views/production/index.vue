<template>
  <div class="scriptAgent productionAgent productionLayout">
    <Splitpanes class="default-theme data f">
      <!-- Keep the production agent shell identical to the script agent shell. -->
      <Pane :size="30" :min-size="15" class="operate">
        <div class="box pr">
          <div class="sidebarHeader">
            <div class="sidebarHeading">
              <span class="sidebarTitle">制作记录</span>
              <span class="sidebarSubtitle">视频策划</span>
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
            class="inputBox"
            :disabled="workflowBusy || !connected || loadingData || loadingHistory"
            v-model="inputValue"
            :loading="workflowBusy"
            :textarea-props="{
              placeholder: $t('workbench.production.chatBox.inputPlaceholder'),
              autosize: { minRows: 2, maxRows: 5 },
            }"
            @send="handleSend"
            @stop="handleStop">
            <template #footer-prefix>
              <t-popup trigger="click" placement="top-left">
                <t-button shape="square" variant="outline" size="small">
                  <template #icon>
                    <i-setting-config size="16" />
                  </template>
                </t-button>
                <template #content>
                  <div class="settingMenu">
                    <div class="settingMenuItem settingMenuControl">
                      <span>思考级别</span>
                      <t-select :value="thinkLevel" :options="thinkLevelOptions" autoWidth size="small" @change="handleThinkLevelChange" />
                    </div>
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
            </template>
          </t-chat-sender>
        </div>
      </Pane>

      <Pane :size="70" :min-size="30" class="data shotPanel">
        <div class="tabsWrapper">
          <div class="workspaceToolbar">
            <div class="workspaceActions">
              <t-select
                class="episodeSelect"
                :value="currentEpisodesId ?? undefined"
                :placeholder="$t('workbench.production.selectPlaceholder')"
                size="small"
                :options="episodesOptions"
                filterable
                @change="handleEpisodesChange">
                <template #label>
                  <i-document-folder size="18" />
                </template>
              </t-select>
              <t-tooltip placement="bottom" theme="primary" :content="$t('workbench.production.getFlowData')">
                <t-button class="refreshButton" variant="outline" shape="square" size="small" @click="refreshData">
                  <template #icon>
                    <i-refresh size="16" />
                  </template>
                </t-button>
              </t-tooltip>
              <t-button class="workbenchButton" theme="primary" size="small" @click="workbenchVisible = true">
                <template #icon>
                  <i-playback-progress size="16" />
                </template>
                {{ $t("workbench.production.wb.videoGeneration") }}
              </t-button>
              <i-loading-four class="spin" size="16" v-show="loadingData" />
            </div>
          </div>
          <t-tabs v-model="activeWorkspaceTab">

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
      </Pane>
    </Splitpanes>
    <workbench v-model:visible="workbenchVisible" />
  </div>
</template>

<script setup lang="ts">
import axios from "@/utils/axios";
import projectStore from "@/stores/project";
import productionAgentStore from "@/stores/productionAgent";
import workbench from "./components/workbench/index.vue";
import { MdPreview } from "md-editor-v3";
import "md-editor-v3/lib/preview.css";
import { useRouter } from "vue-router";
import { Splitpanes, Pane } from "splitpanes";

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
  if (!/<(?:sceneSummary(?:Table)?|sceneNotes|transitions)\b/i.test(content)) return "";

  const readTag = (block: string, names: string[]) => {
    const pattern = names.join("|");
    const match = block.match(new RegExp(`<(?:(?:${pattern}))\\b[^>]*>([\\s\\S]*?)<\\/(?:(?:${pattern}))>`, "i"));
    return match?.[1]?.trim() || "";
  };
  const readAttribute = (attributes: string, names: string[]) => {
    const pattern = names.join("|");
    const match = attributes.match(new RegExp(`\\b(?:${pattern})\\s*=\\s*(?:["']([^"']*)["']|([^\\s>]+))`, "i"));
    return (match?.[1] || match?.[2] || "").trim();
  };
  const readScenes = (section: string) =>
    [...section.matchAll(/<scene\b([^>]*)>([\s\S]*?)<\/scene>/gi)].map((match) => ({ attributes: match[1], content: match[2] }));
  const readText = (block: string, names: string[]) => readTag(block, names).replace(/\s+/g, " ").trim();
  const cell = (value: string) => value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  const sceneId = (scene: { attributes: string; content: string }) =>
    readText(scene.content, ["sceneId", "sceneid"]) || readAttribute(scene.attributes, ["id", "sceneId"]);
  const summary = readTag(content, ["sceneSummaryTable", "scenesummarytable", "sceneSummary", "scenesummary"]);
  const notes = readTag(content, ["sceneNotes", "scenenotes"]);
  const transitions = readTag(content, ["transitions"]);
  const summaryScenes = readScenes(summary);
  const noteScenes = readScenes(notes);
  if (!summaryScenes.length && !noteScenes.length) return "";
  const sceneNameById = new Map<string, string>();
  summaryScenes.forEach((scene) => {
    const id = sceneId(scene);
    if (id) sceneNameById.set(id, readText(scene.content, ["sceneName", "scenename"]));
  });

  const sections: string[] = [];
  if (summaryScenes.length) {
    sections.push(
      [
        "## 分场汇总表",
        "",
        "| 场次 | 场景名 | 台词条数 | 台词字数 | 情绪浓度 | 情绪基调 |",
        "|---|---|---:|---:|---:|---|",
        ...summaryScenes.map((scene) => {
          const id = sceneId(scene);
          const name = readText(scene.content, ["sceneName", "scenename"]);
          const dialogueCount = readText(scene.content, ["dialogueCount", "dialoguecount", "dialogueLines", "dialoguelines"]) || "0";
          const dialogueWordCount = readText(scene.content, ["dialogueWordCount", "dialoguewordcount", "dialogueChars", "dialoguechars"]) || "0";
          const emotionIntensity = readText(scene.content, ["emotionIntensity", "emotionintensity"]) || "0";
          const emotionTone = readText(scene.content, ["emotionTone", "emotiontone", "emotionBase", "emotionbase"]);
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
      const id = sceneId(scene);
      const name = sceneNameById.get(id) || "";
      noteLines.push(`### ${cell([id, name].filter(Boolean).join(" · ")) || "未命名场次"}`, "");
      const notesBlock = readTag(scene.content, ["notes"]) || scene.content;
      const items = [...notesBlock.matchAll(/<item\b([^>]*)>([\s\S]*?)<\/item>/gi)]
        .map((match) => ({
          label: readAttribute(match[1], ["type", "label"]),
          value: match[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(),
        }))
        .filter((item) => Boolean(item.value));
      const fields = Object.entries(noteFieldLabels)
        .map(([tag, label]) => {
          const value = readText(notesBlock, [tag]);
          return value ? `- **${label}**：${value}` : "";
        })
        .filter(Boolean);
      if (items.length) noteLines.push(...items.map((item) => `- ${item.label ? `**${item.label}**：` : ""}${item.value}`), "");
      else if (fields.length) noteLines.push(...fields, "");
      else noteLines.push("无", "");
    }
    sections.push(noteLines.join("\n").trim());
  }

  if (transitions) {
    const transitionRows = [...transitions.matchAll(/<transition\b([^>]*)>([\s\S]*?)<\/transition>/gi)].map((match) => {
      const from = readAttribute(match[1], ["from"]) || readText(match[2], ["from"]);
      const to = readAttribute(match[1], ["to"]) || readText(match[2], ["to"]);
      return {
        between: [from, to].filter(Boolean).join(" → "),
        mode: readText(match[2], ["mode", "transitionMode", "transitionType"]),
        description: readText(match[2], ["description", "desc"]),
      };
    });
    const transitionContent = transitionRows.length
      ? [
          "| 场间 | 过渡方式 | 说明 |",
          "|---|---|---|",
          ...transitionRows.map((row) => `| ${cell(row.between)} | ${cell(row.mode)} | ${cell(row.description)} |`),
        ].join("\n")
      : transitions;
    sections.push(["## 场间过渡", "", transitionContent].join("\n"));
  }
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
        container: production-chat / inline-size;
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
        }

        .workflowSpinner {
          animation: productionWorkflowRotate 0.9s linear infinite;
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

      .tabsWrapper {
        flex: 1;
        overflow: hidden;
        display: flex;
        flex-direction: column;

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

.productionLayout {
  .shotPanel {
    container: production-workspace / inline-size;

    .workspaceToolbar {
      min-height: 48px;
      padding: 6px 12px;
      display: flex;
      align-items: center;
      justify-content: flex-end;
      flex-shrink: 0;
      box-sizing: border-box;
      border-bottom: 1px solid var(--td-border-level-1-color);
      background: var(--td-bg-color-container);
    }

    .workspaceActions {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      min-height: 36px;
      padding: 0 2px;

      :deep(.t-select) {
        width: 100%;
      }

      :deep(.t-select__wrap) {
        width: clamp(190px, 22vw, 260px);
        min-width: 0;
        flex: 0 1 260px;
      }

      :deep(.episodeSelect .t-input__wrap),
      :deep(.episodeSelect .t-input) {
        width: 100%;
        min-width: 0;
      }

      :deep(.episodeSelect .t-input) {
        height: 32px;
      }

      :deep(.episodeSelect .t-input__inner) {
        min-width: 0;
        text-overflow: ellipsis;
      }

      :deep(.t-button) {
        flex-shrink: 0;
        height: 32px;
      }

      .refreshButton {
        width: 32px;
        color: var(--td-text-color-primary);
        border-color: var(--td-border-level-2-color);
        background: var(--td-bg-color-secondarycontainer);
      }

      .workbenchButton {
        min-width: 88px;
        padding: 0 14px;
        gap: 6px;
        justify-content: center;
        font-weight: 600;
        box-shadow: 0 2px 7px rgba(0, 0, 0, 0.18);

        :deep(.t-button__text) {
          flex: 0 0 auto;
        }
      }

      .spin {
        flex-shrink: 0;
      }
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
}

.productionAgent .tabsWrapper {
  :deep(.t-tabs__header) {
    flex-shrink: 0;
    padding-left: 8px;
  }
}

@container production-workspace (max-width: 680px) {
  .productionAgent .workspaceToolbar {
    padding-inline: 8px;

    .workspaceActions {
      width: 100%;

      :deep(.t-select__wrap) {
        width: auto;
        min-width: 0;
        flex: 1;
      }
    }
  }
}

.productionAgent.productionLayout {
  height: calc(100% - 16px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.productionAgent .box {
  container: production-chat / inline-size;
}

@container production-chat (max-width: 360px) {
  .productionAgent .box .nextAction {
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
  }

  .productionAgent .box .nextActionCopy {
    width: 100%;
  }

  .productionAgent .box .nextAction :deep(.t-button) {
    width: 100%;
    min-width: 0;
    min-height: 30px;
    height: auto;
    white-space: normal;
    line-height: 1.35;
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
