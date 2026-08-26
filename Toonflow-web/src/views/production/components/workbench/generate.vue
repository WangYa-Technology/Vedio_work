<template>
  <div class="generateContainer">
    <section class="sceneNavigator" v-if="sceneGroups.length">
      <div class="sceneToolbar f ac jb">
        <div class="sceneToolbarTitle">
          <strong>视频场次</strong>
          <span>场次批量推理，片段独立生成（单段最长 15 秒），当前 {{ activeSceneIndex + 1 }} / {{ sceneGroups.length }}</span>
        </div>
        <div class="sceneToolbarActions f ac">
          <t-checkbox v-model="checkAll" @change="handleCheckAll">{{ $t("workbench.generate.selectAll") }}</t-checkbox>
          <span class="selectedCount" v-if="selectedSceneCount">已选 {{ selectedSceneCount }} 场 · {{ selectedSegmentCount }} 段</span>
          <t-button size="small" variant="outline" :disabled="!selectedSegmentCount" @click="batchGenText">{{ $t("workbench.generate.batchGenerateText") }}</t-button>
          <t-button size="small" variant="outline" :disabled="!selectedSegmentCount" @click="batchGenVideo">{{ $t("workbench.generate.batchGenerateVideo") }}</t-button>
          <t-button size="small" :disabled="!selectedSegmentCount || !selectedImportableCount" @click="importVideo">
            {{ $t("workbench.generate.importVideo") }}
          </t-button>
        </div>
      </div>
      <div class="sceneGroups">
        <div
          class="sceneGroup"
          :class="{ active: sceneIndex === activeSceneIndex }"
          v-for="(scene, sceneIndex) in sceneGroups"
          :key="scene.key"
          role="button"
          tabindex="0"
          @click="selectScene(scene)"
          @keydown.enter="selectScene(scene)">
          <t-checkbox
            class="sceneGroupCheck"
            :checked="isSceneChecked(scene)"
            :indeterminate="isScenePartiallyChecked(scene)"
            @click.stop
            @change="(val: boolean) => toggleSceneCheck(scene, val)" />
          <div class="sceneGroupHeader">
            <strong>场次 {{ sceneIndex + 1 }}</strong>
            <span :title="scene.title">{{ scene.title }}</span>
            <small>{{ scene.entries.length }} 段 · {{ scene.duration }}s</small>
          </div>
          <div class="sceneGroupSegments">
            <span v-for="entry in scene.entries" :key="entry.track.id">{{ entry.track.segmentTitle }} {{ entry.track.duration }}s</span>
          </div>
        </div>
      </div>
      <div class="activeSceneSegments" v-if="activeSceneGroup">
        <span class="activeSceneSegmentsLabel">本场视频段</span>
        <button
          v-for="entry in activeSceneGroup.entries"
          :key="entry.track.id"
          type="button"
          :class="{ active: entry.index === activeTrackIndex }"
          @click="activeTrackIndex = entry.index">
          #{{ entry.index + 1 }} {{ entry.track.segmentTitle }} · {{ entry.track.duration }}s
        </button>
      </div>
    </section>
    <div class="data f">
      <div class="videoToImage">
        <div v-if="activeTrack" class="taskBrief">
          <div class="taskBriefHeader">
            <div>
              <span class="taskKicker">视频任务 #{{ activeTrackIndex + 1 }}</span>
              <h3>{{ activeTrack.title }}</h3>
            </div>
            <t-tag :theme="activeTrack.readiness?.ready ? 'success' : 'warning'" size="small">
              {{ activeTrack.readiness?.ready ? "参数已就绪" : "待补充" }}
            </t-tag>
          </div>
          <div class="storyboardPreview" v-if="activeTrack.storyboard?.src && shouldShowStoryboardPreview">
            <img :src="activeTrack.storyboard.src" alt="分镜预览" />
            <span>分镜预览图（当前模式不作为视频参考图提交）</span>
          </div>
          <div class="taskStats">
            <div>
              <span>片段时长</span>
              <strong>{{ activeTrack.duration }} 秒</strong>
            </div>
            <div>
              <span>参考图</span>
              <strong>{{ activeTrack.readiness?.referenceCount || 0 }} 张</strong>
            </div>
            <div>
              <span>模型</span>
              <strong>{{ projectConfig.modelName || "未配置" }}</strong>
            </div>
          </div>
          <div class="segmentTable" v-if="activeTrack.segmentRows?.length">
            <div class="segmentRow segmentRowHeader">
              <span>镜头</span>
              <span>画面与动作</span>
              <span>台词 / 音效</span>
              <span>时长</span>
              <span>景别 / 运镜</span>
            </div>
            <div class="segmentRow" v-for="row in activeTrack.segmentRows" :key="row.serial">
              <span>{{ row.serial }}</span>
              <span>{{ row.description }}</span>
              <div class="dialogueCell">
                <p><b>台词</b>{{ displaySegmentField(row.dialogue, "台词") }}</p>
                <p><b>音效</b>{{ displaySegmentField(row.sound, "音效") }}</p>
              </div>
              <span>{{ row.duration }}s</span>
              <span>{{ row.scale || "—" }} / {{ row.cameraMovement || "—" }}</span>
            </div>
          </div>
          <div class="taskNotice" v-if="activeTrack.readiness?.messages?.length">
            {{ activeTrack.readiness.messages.join("；") }}
          </div>
          <div class="taskNotice taskNoticeWarning" v-if="activeTrack.promptAudit?.length">
            提示词质量门：{{ activeTrack.promptAudit.join("；") }}
          </div>
        </div>
        <div v-else class="emptyVideo c">{{ $t("workbench.generate.noVideo") }}</div>
      </div>
      <div class="configurationParameters" :class="{ hasActive: trackList.length > 0 }">
        <div class="promptsMenu f ac jb">
          <div class="title">
            <t-tag theme="primary" size="small" style="margin-right: 10px">#{{ activeTrackIndex + 1 }}</t-tag>
            {{ $t("workbench.generate.prompt") }}
          </div>
          <div class="promptActions f ac">
            <t-select
              v-model="selectedVideoPromptTemplateId"
              :options="videoPromptTemplateOptions"
              :loading="videoPromptTemplateLoading"
              size="small"
              class="videoPromptTemplateSelect"
              @focus="loadVideoPromptTemplates"
              placeholder="选择视频推理模版" />
            <t-button size="small" class="genTextbtn" :loading="activeTrackGenTextLoading" @click="genText">AI生成本场提示词</t-button>
          </div>
        </div>
        <div v-if="activeScenePromptError" class="promptError" role="alert">
          <i-error-circle-filled size="16" />
          <span>{{ activeScenePromptError }}</span>
        </div>
        <div class="promptStack">
          <div class="promptSection">
            <div class="promptSectionHeader">
              <span>推理前内容</span>
              <small>当前片段的分镜与参考资产</small>
            </div>
            <div class="promptInput promptInputSource">
              <promptEditor
                :key="`source-${activeTrack?.id ?? 'empty'}`"
                :model-value="preInferenceText"
                :references="references"
                placeholder="暂无推理前内容"
                readonly />
            </div>
          </div>
          <div class="promptSection">
            <div class="promptSectionHeader">
              <span>推理后文本</span>
              <small :class="{ inferred: activeTrack?.promptSource === 'videoTrack' }">
                {{ activeTrack?.promptSource === "videoTrack" ? "已推理" : "待推理" }}
              </small>
            </div>
            <div class="promptInput promptInputResult">
              <promptEditor
                :key="`result-${activeTrack?.id ?? 'empty'}`"
                v-model="promptText"
                :references="references"
                :placeholder="$t('workbench.generate.promptPlaceholder')" />
            </div>
          </div>
        </div>
        <div class="modeOpt f w">
          <template v-if="isMixedMode">
            <div class="uploadBtn c fc" v-for="(item, index) in uploadBox" :key="index" v-show="item.src">
              <template v-if="item.src">
                <img v-if="item.fileType === 'image'" :src="item.src" class="uploadPreview" />
                <div v-else class="uploadPreview c">
                  <i-volume-notice v-if="item.fileType === 'audio'" size="24" />
                  <i-video v-else size="24" />
                </div>
                <div class="clearBtn" @click.stop="clearUpload(index)">
                  <i-close size="12" />
                </div>
              </template>
            </div>
            <div class="uploadBtn c fc" @click="handleMixedAdd">
              <i-plus size="24"></i-plus>
              {{ $t("workbench.generate.addReference") }}
            </div>
          </template>
          <template v-else>
            <div class="uploadBtn c fc" v-for="(item, index) in uploadBox" :key="index" @click="handleSelectSource(index)">
              <template v-if="item.src">
                <img :src="item.src" class="uploadPreview" />
                <div class="clearBtn" @click.stop="clearUpload(index)">
                  <i-close size="12" />
                </div>
              </template>
              <template v-else>
                <i-plus size="24"></i-plus>
                {{ item.label }}
              </template>
            </div>
          </template>
        </div>
        <!-- 分镜选择弹窗 -->
        <t-dialog
          v-model:visible="storyboardDialogVisible"
          :header="$t('workbench.generate.selectStoryboard')"
          :footer="false"
          width="800px"
          placement="center">
          <div class="storyboardGrid">
            <div class="storyboardItem" v-for="sb in storyboardList" :key="sb.id" @click="pickStoryboard(sb)">
              <img :src="sb.src" />
            </div>
          </div>
        </t-dialog>

        <div class="modeMenu f ac jb">
          <div class="left f ac">
            <div class="model">
              <modelSelect v-model="selectModel" type="video" size="small" />
            </div>
            <t-select v-if="!isB36Model" size="small" class="mode" v-model="selectMode">
              <t-option v-for="(item, index) in modeList" :key="index" :value="item.value" :label="item.label"></t-option>
            </t-select>
            <t-tooltip v-if="showAudioControl" :content="audioControlTooltip" placement="top">
              <t-button
                size="small"
                variant="outline"
                :theme="selectedAudio ? 'success' : 'danger'"
                class="audio"
                :class="{ fixed: modeOptions.audio === true }"
                :aria-label="audioControlTooltip"
                :aria-pressed="selectedAudio"
                @click="toggleAudio">
                <template #icon>
                  <SoundIcon v-if="selectedAudio" size="16" />
                  <SoundMuteIcon v-else size="16" />
                </template>
              </t-button>
            </t-tooltip>
            <t-select
              v-if="isB36Model"
              v-model="selectedMegapixels"
              size="small"
              class="megapixelSelect"
              :options="megapixelOptions"
              aria-label="百万像素" />
            <t-tooltip v-else content="生成清晰度" placement="top">
              <t-select
                v-model="selectedResolution"
                size="small"
                class="resolutionSelect"
                :options="resolutionOptions"
                aria-label="生成清晰度" />
            </t-tooltip>
            <t-tooltip content="片段时长" placement="top">
              <t-select
                :value="effectiveDuration"
                size="small"
                class="durationSelect"
                :options="durationOptions"
                aria-label="片段时长"
                @change="handleDurationSelect" />
            </t-tooltip>
            <t-popup v-if="modelParameters.length" trigger="click" placement="bottom-left">
              <t-tooltip content="工作流参数" placement="top">
                <t-button class="workflowParameterButton" size="small" variant="outline" shape="square" aria-label="工作流参数">
                  <template #icon><SettingIcon size="16" /></template>
                </t-button>
              </t-tooltip>
              <template #content>
                <div class="workflowParameterPanel">
                  <div v-for="parameter in modelParameters" :key="parameter.key" class="workflowParameterItem">
                    <div class="workflowParameterHeader">
                      <span class="workflowParameterLabel">
                        <span>{{ parameter.label }}</span>
                        <t-tooltip v-if="parameter.description" :content="parameter.description" placement="top">
                          <span class="workflowParameterHelp" tabindex="0" :aria-label="`${parameter.label} 参数说明`">!</span>
                        </t-tooltip>
                      </span>
                      <small v-if="parameter.description">{{ parameter.description }}</small>
                    </div>
                    <t-select
                      v-if="parameter.type === 'select'"
                      v-model="workflowParameters[parameter.key]"
                      size="small"
                      :options="parameter.options || []" />
                    <t-input-number
                      v-else-if="parameter.type === 'number'"
                      :value="Number(workflowParameters[parameter.key])"
                      size="small"
                      :min="parameter.min"
                      :max="parameter.max"
                      :step="parameter.step || 1"
                      :allowInputOverLimit="false"
                      @change="(value) => setWorkflowNumber(parameter.key, value)" />
                    <t-switch v-else v-model="workflowParameters[parameter.key]" size="small" />
                  </div>
                </div>
              </template>
            </t-popup>
          </div>
          <div class="genBtn">
            <t-button size="small" :disabled="!activeTrack" :loading="generating" @click="generateVideo">{{ $t("workbench.generate.generate") }}</t-button>
          </div>
        </div>
        <div class="history">
          <div class="titleBox f ac">
            <i-time />
            <span class="title">{{ $t("workbench.generate.history") }}（{{ activeTrackVideos.length }}）</span>
          </div>
          <div class="historyItemBox">
            <div
              class="historyItem"
              :class="{
                active: v.id === selectVideoId,
                generating: v.state === '生成中',
                failed: v.state === '生成失败',
              }"
              v-for="v in activeTrackVideos"
              :key="v.id"
              @click="previewVideo(v)">
              <video v-if="isVideoPlayable(v)" :src="v.src" preload="metadata" playsinline muted />
              <div v-if="isVideoPlayable(v)" class="playOverlay c"><PlayIcon size="22" /></div>
              <div v-if="v.state === '生成中'" class="loadingOverlay c fc">
                <t-loading size="24px" />
                <span class="loadingText">{{ $t("workbench.generate.generating") }}</span>
              </div>
              <t-tooltip v-else-if="v.state === '生成失败'" placement="top" :content="v.errorReason!" theme="light">
                <t-tag class="stateTag" theme="danger" size="small">
                  {{ $t("workbench.generate.generateFailed") }}
                </t-tag>
              </t-tooltip>
              <div v-if="isVideoPlayable(v)" class="selectBtn" @click.stop="selectVideo(v)">
                <i-check size="16" />
              </div>
              <div class="delBtn" @click.stop="handleDeleteVideo(v)">
                <i-delete size="16" />
              </div>
              <div v-if="isVideoPlayable(v)" class="download" @click.stop="downloadVideo(v)">
                <i-to-bottom size="16" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <t-dialog
      v-model:visible="videoPreviewVisible"
      :header="videoPreviewTitle"
      :footer="false"
      width="min(1120px, 90vw)"
      placement="center"
      destroy-on-close
      :close-on-overlay-click="false"
      @opened="handleVideoPreviewOpened"
      @close="closeVideoPreview">
      <div ref="videoPreviewDialogRef" class="videoPreviewDialog">
        <div class="videoPreviewStage" @click="toggleModalPlayback">
          <video
            ref="modalVideoRef"
            :src="modalVideoUrl"
            playsinline
            preload="metadata"
            @loadedmetadata="handleModalMetadata"
            @timeupdate="handleModalTimeUpdate"
            @play="modalPlaying = true"
            @pause="modalPlaying = false"
            @ended="modalPlaying = false"
            @volumechange="syncModalVolumeState"
            @error="handleModalVideoError" />
          <button
            v-if="!modalPlaying && !modalError"
            type="button"
            class="modalCenterPlay"
            :aria-label="modalEnded ? '重新播放' : '播放'"
            @click.stop="toggleModalPlayback">
            <PlayIcon size="38" />
          </button>
          <div v-if="modalError" class="modalVideoError c fc">
            <i-error-circle-filled size="30" />
            <span>{{ modalError }}</span>
          </div>
        </div>
        <div class="videoControlBar">
          <t-tooltip :content="modalPlaying ? '暂停' : modalEnded ? '重新播放' : '播放'" placement="top">
            <button type="button" class="mediaIconButton" :aria-label="modalPlaying ? '暂停' : '播放'" @click="toggleModalPlayback">
              <PauseIcon v-if="modalPlaying" size="20" />
              <PlayIcon v-else size="20" />
            </button>
          </t-tooltip>
          <span class="mediaTime">{{ formatMediaTime(modalCurrentTime) }} / {{ formatMediaTime(modalDuration) }}</span>
          <input
            class="mediaProgress"
            type="range"
            min="0"
            :max="Math.max(modalDuration, 0)"
            step="0.01"
            :value="modalCurrentTime"
            aria-label="播放进度"
            @input="seekModalVideo" />
          <t-tooltip :content="modalMuted ? '取消静音' : '静音'" placement="top">
            <button type="button" class="mediaIconButton" :aria-label="modalMuted ? '取消静音' : '静音'" @click="toggleModalMute">
              <SoundMuteIcon v-if="modalMuted || modalVolume === 0" size="20" />
              <SoundIcon v-else size="20" />
            </button>
          </t-tooltip>
          <input
            class="mediaVolume"
            type="range"
            min="0"
            max="1"
            step="0.05"
            :value="modalVolume"
            aria-label="音量"
            @input="changeModalVolume" />
          <span v-if="modalVideoDimensions" class="mediaResolution">{{ modalVideoDimensions }}</span>
          <t-tooltip content="全屏" placement="top">
            <button type="button" class="mediaIconButton" aria-label="全屏" @click="requestModalFullscreen">
              <FullscreenIcon size="20" />
            </button>
          </t-tooltip>
        </div>
      </div>
    </t-dialog>
  </div>
</template>

<script setup lang="ts">
import type { Ref } from "vue";
import promptEditor from "@/components/promptEditor.vue";
import assetsCheck, { type AssetType, type ClipMediaType } from "@/utils/assetsCheck";
import { DialogPlugin } from "tdesign-vue-next";
import { FullscreenIcon, PauseIcon, PlayIcon, SettingIcon, SoundIcon, SoundMuteIcon } from "tdesign-icons-vue-next";
import axios from "@/utils/axios";
import projectStore from "@/stores/project";
import settingStore from "@/stores/setting";
import { resolveBackendAssetUrl } from "@/utils/backendUrl";

const episodesId = inject<Ref<number>>("episodesId")!;

const { project } = storeToRefs(projectStore());
const { baseUrl } = storeToRefs(settingStore());

// Keep the state refs above computed values that read them. The workbench can
// mount asynchronously when the dialog opens, so a computed getter must never
// close over a still-uninitialized binding.
const trackList = ref<TrackItem[]>([]);
const activeTrackIndex = ref(0);
const activeTrack = computed(() => trackList.value[activeTrackIndex.value] || null);
const projectConfig = ref<Record<string, any>>({});
const trackSelectedVideoMap = ref<Record<number, number>>({});
const modeOptions = ref<VideoModel>({} as VideoModel);

const promptText = computed({
  get: () => {
    const track = trackList.value[activeTrackIndex.value];
    return track?.prompt ?? "";
  },
  set: (val: string) => {
    const track = trackList.value[activeTrackIndex.value];
    if (track) track.prompt = val;
  },
});
const selectedResolution = ref("480p");
const selectedMegapixels = ref("0.4");
const selectedDuration = ref(8);
// 用户是否手动选择过时长，手动选择后不再被 track.duration 覆盖
const userSelectedDuration = ref(false);

//仅批量生成视频，如果单个生成视频切换模型需要选择时长
function clampDuration(trackDuration: number): number {
  const drMap = modeOptions.value.durationResolutionMap;
  if (Array.isArray(drMap) && drMap.length > 0 && drMap[0].duration?.length) {
    const durations = drMap[0].duration;
    const minDuration = Math.min(...durations);
    const maxDuration = Math.max(...durations);
    return Math.max(minDuration, Math.min(trackDuration, maxDuration));
  }
  return trackDuration;
}

const effectiveDuration = computed(() => {
  // 用户手动选择过时长，直接用 selectedDuration
  if (userSelectedDuration.value) return selectedDuration.value;
  // 否则用 track 的 duration（约束到模型支持范围）
  const trackDuration = trackList.value[activeTrackIndex.value]?.duration || selectedDuration.value;
  return clampDuration(trackDuration);
});
const selectedAudio = ref(false);
const generatingMap = ref<Record<number, boolean>>({});
const generating = computed(() => {
  const trackId = trackList.value[activeTrackIndex.value]?.id;
  return trackId != null ? !!generatingMap.value[trackId] : false;
});
const genTextLoadingMap = ref<Record<number, boolean>>({});
const scenePromptErrorMap = ref<Record<string, string>>({});

interface VideoPromptTemplate {
  id: number;
  name: string;
  type: string;
  data: string;
}

const videoPromptTemplates = ref<VideoPromptTemplate[]>([]);
const selectedVideoPromptTemplateId = ref<number>();
const videoPromptTemplateLoading = ref(false);
const videoPromptTemplateOptions = computed(() => videoPromptTemplates.value.map((item) => ({ label: item.name, value: item.id })));

function displaySegmentField(value: string | undefined, label: string) {
  return String(value || "")
    .trim()
    .replace(new RegExp(`^${label}[：:]\\s*`), "")
    .trim() || "无";
}

function getRequestErrorMessage(caught: any) {
  const payload = caught?.response?.data ?? caught?.data ?? caught;
  const message = payload?.message ?? payload?.error?.message ?? caught?.message;
  if (typeof message === "string" && message.trim()) return message.trim();
  if (typeof payload === "string" && payload.trim()) return payload.trim();
  return "请求失败，请稍后重试";
}

async function loadVideoPromptTemplates() {
  videoPromptTemplateLoading.value = true;
  try {
    const { data } = await axios.post("/setting/promptManage/getPrompt");
    videoPromptTemplates.value = (Array.isArray(data) ? data : [])
      .filter((item: any) => item.type === "videoPromptGeneration")
      .map((item: any) => ({ id: Number(item.id), name: item.name || "未命名视频模版", type: item.type, data: item.data || "" }));
    if (!videoPromptTemplates.value.some((item) => item.id === selectedVideoPromptTemplateId.value)) {
      selectedVideoPromptTemplateId.value = videoPromptTemplates.value[0]?.id;
    }
  } finally {
    videoPromptTemplateLoading.value = false;
  }
}

async function generateScenePrompts(scene: SceneGroup, requestedIds?: number[]) {
  if (!selectedVideoPromptTemplateId.value) {
    window.$message.warning("请先选择视频推理模版");
    return;
  }
  const trackIds = (requestedIds?.length ? requestedIds : scene.entries.map((entry) => entry.track.id)).filter(Boolean);
  if (!trackIds.length || trackIds.some((id) => genTextLoadingMap.value[id])) return;
  scenePromptErrorMap.value[scene.key] = "";
  trackIds.forEach((id) => (genTextLoadingMap.value[id] = true));
  try {
    const { data } = await axios.post("/production/workbench/generateVideoPrompt", {
      projectId: project.value?.id,
      scriptId: episodesId.value,
      sceneTitle: scene.key === "__unassigned__" ? "" : scene.key,
      trackIds,
      templateId: selectedVideoPromptTemplateId.value,
      model: selectModel.value,
      mode: selectMode.value,
    });
    for (const result of data?.prompts || []) {
      const targetTrack = trackList.value.find((item) => item.id === Number(result.trackId));
      if (targetTrack) {
        targetTrack.prompt = result.prompt;
        targetTrack.promptSource = "videoTrack";
      }
    }
    window.$message.success(`${scene.title} 的 ${trackIds.length} 段视频提示词已生成`);
  } catch (caught: any) {
    const message = getRequestErrorMessage(caught);
    scenePromptErrorMap.value[scene.key] = message;
    // Do not leave an older English result looking like the failed request
    // succeeded. The saved server version remains recoverable on refresh.
    for (const id of trackIds) {
      const targetTrack = trackList.value.find((item) => item.id === Number(id));
      if (targetTrack) {
        targetTrack.prompt = "";
        targetTrack.promptSource = undefined;
      }
    }
    window.$message.error(message);
  } finally {
    trackIds.forEach((id) => (genTextLoadingMap.value[id] = false));
  }
}

async function genText() {
  const activeTrack = trackList.value[activeTrackIndex.value];
  if (!activeSceneGroup.value || activeTrack?.id == null) return;
  await generateScenePrompts(activeSceneGroup.value, [activeTrack.id]);
}

interface VideoItem {
  id: number;
  src: string;
  state: "未生成" | "生成中" | "已完成" | "生成失败";
}

const selectVideoId = ref<number | null>(null);

interface HistoryVideoItem {
  errorReason?: string | null;
  src: string;
  id?: number;
  duration?: number | string | null;
  projectId?: number | null;
  scriptId?: number | null;
  state?: string | null;
  time?: number | null;
  videoTrackId?: number | null;
  playable?: boolean;
}

const historyVideo = ref<HistoryVideoItem[]>([]);
const videoPreviewVisible = ref(false);
const modalVideoRef = ref<HTMLVideoElement | null>(null);
const videoPreviewDialogRef = ref<HTMLDivElement | null>(null);
const modalVideoUrl = ref("");
const modalPlaying = ref(false);
const modalCurrentTime = ref(0);
const modalDuration = ref(0);
const modalVolume = ref(1);
const modalMuted = ref(false);
const modalVideoDimensions = ref("");
const modalError = ref("");
const modalEnded = computed(() => modalDuration.value > 0 && modalCurrentTime.value >= modalDuration.value - 0.05);
const videoPreviewTitle = computed(() => {
  const suffix = modalVideoDimensions.value ? ` · ${modalVideoDimensions.value}` : "";
  return `视频预览 #${activeTrackIndex.value + 1}${suffix}`;
});

const activeTrackVideos = computed(() => {
  const track = trackList.value[activeTrackIndex.value];
  if (!track?.id) return [];
  return historyVideo.value.filter((v) => v.videoTrackId === track.id);
});

function isVideoPlayable(v: HistoryVideoItem) {
  return v.state !== "生成中" && v.state !== "生成失败" && v.playable !== false && Boolean(v.src);
}

function previewVideo(v: HistoryVideoItem) {
  if (!isVideoPlayable(v)) {
    window.$message.error(v.errorReason || "视频文件不可用，请重新生成");
    return;
  }
  openVideoPreview(v);
}

function openVideoPreview(v: HistoryVideoItem) {
  if (!isVideoPlayable(v)) return;
  modalVideoUrl.value = v.src;
  modalCurrentTime.value = 0;
  modalDuration.value = 0;
  modalVideoDimensions.value = "";
  modalError.value = "";
  modalPlaying.value = false;
  modalMuted.value = false;
  videoPreviewVisible.value = true;
}

function handleVideoPreviewOpened() {
  const player = modalVideoRef.value;
  if (!player) return;
  player.muted = false;
  player.volume = modalVolume.value;
  player.load();
}

function handleModalMetadata() {
  const player = modalVideoRef.value;
  if (!player) return;
  modalDuration.value = Number.isFinite(player.duration) ? player.duration : 0;
  modalCurrentTime.value = player.currentTime || 0;
  modalVideoDimensions.value = player.videoWidth && player.videoHeight
    ? `${Math.min(player.videoWidth, player.videoHeight)}p · ${player.videoWidth}×${player.videoHeight}`
    : "";
  modalError.value = "";
  syncModalVolumeState();
}

function handleModalTimeUpdate() {
  const player = modalVideoRef.value;
  if (!player) return;
  modalCurrentTime.value = player.currentTime || 0;
}

function handleModalVideoError() {
  modalPlaying.value = false;
  modalError.value = "视频加载失败，请重新生成或检查视频文件";
}

async function toggleModalPlayback() {
  const player = modalVideoRef.value;
  if (!player || modalError.value) return;
  if (!player.paused) {
    player.pause();
    return;
  }
  if (player.ended || modalEnded.value) {
    player.currentTime = 0;
    modalCurrentTime.value = 0;
  }
  player.muted = modalMuted.value;
  player.volume = modalVolume.value;
  try {
    await player.play();
  } catch {
    window.$message.warning("浏览器阻止了播放，请再次点击播放按钮");
  }
}

function seekModalVideo(event: Event) {
  const player = modalVideoRef.value;
  if (!player) return;
  const value = Number((event.target as HTMLInputElement).value);
  if (!Number.isFinite(value)) return;
  player.currentTime = value;
  modalCurrentTime.value = value;
}

function toggleModalMute() {
  const player = modalVideoRef.value;
  if (!player) return;
  if (player.muted || player.volume === 0) {
    if (player.volume === 0) player.volume = 0.8;
    player.muted = false;
  } else {
    player.muted = true;
  }
  syncModalVolumeState();
}

function changeModalVolume(event: Event) {
  const player = modalVideoRef.value;
  if (!player) return;
  const value = Math.max(0, Math.min(1, Number((event.target as HTMLInputElement).value)));
  player.volume = value;
  player.muted = value === 0;
  syncModalVolumeState();
}

function syncModalVolumeState() {
  const player = modalVideoRef.value;
  if (!player) return;
  modalVolume.value = player.volume;
  modalMuted.value = player.muted || player.volume === 0;
}

async function requestModalFullscreen() {
  const container = videoPreviewDialogRef.value;
  const player = modalVideoRef.value as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
  try {
    if (container?.requestFullscreen) {
      await container.requestFullscreen();
    } else {
      player?.webkitEnterFullscreen?.();
    }
  } catch {
    window.$message.warning("当前浏览器无法进入全屏模式");
  }
}

function closeVideoPreview() {
  modalVideoRef.value?.pause();
  modalPlaying.value = false;
  videoPreviewVisible.value = false;
}

function formatMediaTime(value: number) {
  if (!Number.isFinite(value) || value < 0) return "0:00";
  const totalSeconds = Math.floor(value);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

async function selectVideo(v: HistoryVideoItem) {
  if (!isVideoPlayable(v)) return;
  const activeTrack = trackList.value[activeTrackIndex.value];
  if (v.id != null) {
    selectVideoId.value = v.id;
    if (activeTrack?.id != null) {
      trackSelectedVideoMap.value[activeTrack.id] = v.id;
    }
  }
  try {
    await axios.post("/production/workbench/selectVideo", {
      projectId: project.value?.id,
      scriptId: episodesId.value ?? 0,
      videoId: v.id,
      trackId: trackList.value[activeTrackIndex.value]?.id,
    });
    window.$message.success($t("workbench.generate.selectVideoSuccess"));
    getGenerateData();
  } catch (error) {
    window.$message.error($t("workbench.generate.selectVideoFailed"));
  }
}

type ReferenceType = "videoReference" | "imageReference" | "audioReference" | "textReference";
type Type = "imageReference" | "startImage" | "endImage" | "videoReference" | "audioReference";
type VideoMode = "singleImage" | "multiImage" | "startEndRequired" | "endFrameOptional" | "startFrameOptional" | "text" | string[];

interface UploadItem {
  fileType: "image" | "video" | "audio";
  type: Type;
  sources: "assets" | "storyboard";
  id?: number;
  src?: string;
  label?: string;
  prompt?: string;
}

interface VideoModel {
  name: string; // 显示名称
  modelName: string; //全局唯一
  type: "video";
  mode: (
    | "singleImage" // 单图
    | "multiImage" // 旧版多图模式
    | "startEndRequired" // 首尾帧（两张都得有）
    | "endFrameOptional" // 首尾帧（尾帧可选）
    | "startFrameOptional" // 首尾帧（首帧可选）
    | "text" // 文本生视频
    | string[] // 混合参考，可携带 :数量 上限
  )[];
  associationSkills?: string; // 关联技能，多个技能用逗号分隔
  audio: "optional" | false | true; // 音频配置
  durationResolutionMap: { duration: number[]; resolution: string[] }[];
  parameters?: VideoModelParameter[];
}

type WorkflowParameterValue = string | number | boolean;
interface VideoModelParameter {
  key: string;
  label: string;
  type: "select" | "number" | "boolean";
  default: WorkflowParameterValue;
  description?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: Array<{ label: string; value: WorkflowParameterValue; description?: string }>;
}
const workflowParameters = ref<Record<string, WorkflowParameterValue>>({});
const modelParameters = computed(() => modeOptions.value.parameters || []);

function setWorkflowNumber(key: string, value: string | number | undefined) {
  const number = Number(value);
  if (Number.isFinite(number)) workflowParameters.value[key] = number;
}
const B36_MODEL_ID = "comfyui-minimax-h3:minimax-h3-reference-to-video";
const B36_MEGAPIXEL_RESOLUTIONS = new Map<number, [number, number]>([
  [0.2, [608, 352]],
  [0.3, [736, 416]],
  [0.4, [864, 480]],
  [0.5, [960, 544]],
  [0.6, [1056, 608]],
  [0.7, [1152, 640]],
  [0.8, [1216, 672]],
  [0.9, [1280, 736]],
]);
const showAudioControl = computed(() => modeOptions.value.audio === true || modeOptions.value.audio === "optional");
const audioControlTooltip = computed(() => {
  if (modeOptions.value.audio === true) return "当前模型固定生成声音";
  return selectedAudio.value ? "生成声音已开启" : "生成声音已关闭";
});
const resolutionOptions = computed(() => {
  const values = modeOptions.value.durationResolutionMap?.[0]?.resolution || [];
  return values.map((value) => ({ label: formatResolutionOption(value), value }));
});
const durationOptions = computed(() => {
  const values = modeOptions.value.durationResolutionMap?.[0]?.duration || [];
  return values.map((value) => ({ label: `${value} 秒`, value }));
});

function formatResolutionOption(value: string) {
  const match = String(value || "").match(/(\d+)\s*[x*×]\s*(\d+)/i);
  if (!match) return value;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return `${Math.min(width, height)}p · ${width}×${height}`;
}

function toggleAudio() {
  if (modeOptions.value.audio !== "optional") return;
  selectedAudio.value = !selectedAudio.value;
}

const modeList = computed(() => {
  const modeLabelMap: Record<string, string> = {
    singleImage: "单图",
    startEndRequired: "首尾帧",
    endFrameOptional: "尾帧可选",
    startFrameOptional: "首帧可选",
    text: "文本生视频",
    multiImage: "多图参考",
    videoReference: "视频",
    imageReference: "图片",
    audioReference: "音频",
    textReference: "文本",
  };
  return modeOptions.value.mode
    ? modeOptions.value.mode.map((mode) => {
        if (Array.isArray(mode)) {
          return {
            value: JSON.stringify(mode),
            label:
              mode
                .map((m) => {
                  const token = parseReferenceToken(m);
                  return `${modeLabelMap[token.type] || token.type}${token.count ? `×${token.count}` : ""}`;
                })
                .join(" + ") + "参考",
          };
        }
        // 普通字符串
        return {
          value: mode,
          label: modeLabelMap[mode] || mode,
        };
      })
    : [];
});

const selectModel = ref<string>();
const selectMode = ref<string>();
const isB36Model = computed(() => selectModel.value === B36_MODEL_ID || modeOptions.value.name?.startsWith("B36"));

function roundTo32(value: number) {
  return Math.max(32, Math.round(value / 32) * 32);
}

function getB36Resolution(megapixels: number) {
  const ratioText = String(projectConfig.value.videoRatio || "16:9");
  const [ratioWidth, ratioHeight] = ratioText.split(":").map(Number);
  const landscape = B36_MEGAPIXEL_RESOLUTIONS.get(megapixels) || B36_MEGAPIXEL_RESOLUTIONS.get(0.4)!;
  if (ratioWidth === 16 && ratioHeight === 9) return `${landscape[0]}x${landscape[1]}`;
  if (ratioWidth === 9 && ratioHeight === 16) return `${landscape[1]}x${landscape[0]}`;

  const ratio = ratioWidth > 0 && ratioHeight > 0 ? ratioWidth / ratioHeight : 16 / 9;
  const targetPixels = megapixels * 1_000_000;
  const width = roundTo32(Math.sqrt(targetPixels * ratio));
  const height = roundTo32(width / ratio);
  return `${width}x${height}`;
}

const megapixelOptions = computed(() =>
  [...B36_MEGAPIXEL_RESOLUTIONS.keys()].map((value) => {
    const resolution = getB36Resolution(value);
    return { label: `${value.toFixed(1)} MP · ${resolution.replace("x", "×")}`, value: value.toFixed(1) };
  }),
);

function syncB36Resolution() {
  if (isB36Model.value) selectedResolution.value = getB36Resolution(Number(selectedMegapixels.value));
}

const isMixedMode = computed(() => {
  const mode = parseMode(selectMode.value || "");
  return Array.isArray(mode) || mode === "multiImage";
});

const mixedReferenceLimit = computed(() => {
  const mode = parseMode(selectMode.value || "");
  if (mode === "multiImage") {
    return projectConfig.value.modeCapabilities?.find((item: { type?: string }) => item.type === "imageReference")?.count;
  }
  if (!Array.isArray(mode)) return undefined;
  return mode.map(parseReferenceToken).find((item) => item.type === "imageReference")?.count;
});

const mixedClipMediaTypes = computed<ClipMediaType[]>(() => {
  const mode = parseMode(selectMode.value || "");
  if (mode === "multiImage") return ["image"];
  if (!Array.isArray(mode)) return [];
  const map: Record<string, ClipMediaType> = {
    audioReference: "audio",
    imageReference: "image",
    videoReference: "video",
  };
  return mode
    .map((m) => parseReferenceToken(m).type)
    .filter((m) => m in map)
    .map((m) => map[m]);
});

function parseReferenceToken(value: string) {
  const [type, countText] = value.split(":");
  const count = Number(countText);
  return { type, count: Number.isFinite(count) && count > 0 ? count : undefined };
}

function parseMode(value: string): VideoMode | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.map(String);
    }
  } catch {
    return value as Exclude<VideoMode, ReferenceType[]>;
  }
  return value as Exclude<VideoMode, ReferenceType[]>;
}

function serializeMode(mode: string | string[]) {
  return Array.isArray(mode) ? JSON.stringify(mode) : String(mode);
}

function resolvePreferredMode(modes: Array<string | string[]>, preferredMode: string) {
  const values = modes.map(serializeMode);
  if (!values.length) return undefined;
  if (values.includes(preferredMode)) return preferredMode;

  const preferred = parseMode(preferredMode);
  if (Array.isArray(preferred)) {
    const preferredTypes = new Set(preferred.map((item) => parseReferenceToken(item).type));
    const compatible = modes.find((mode) => {
      if (!Array.isArray(mode)) return false;
      const candidateTypes = new Set(mode.map((item) => parseReferenceToken(item).type));
      return [...preferredTypes].every((type) => candidateTypes.has(type));
    });
    if (compatible) return serializeMode(compatible);
  }

  return values[0];
}

interface TrackMedia {
  src: string;
  id?: number;
  name?: string;
  type?: string;
  prompt?: string;
  fileType: "image" | "video" | "audio";
  sources?: "assets" | "storyboard";
}

function normalizeTrackMedia<T extends TrackMedia>(media: T): T {
  return {
    ...media,
    src: media.src ? resolveBackendAssetUrl(media.src, baseUrl.value) : "",
  };
}

function normalizeTrackItem(track: TrackItem): TrackItem {
  return {
    ...track,
    medias: (track.medias || []).map(normalizeTrackMedia),
    availableMedias: (track.availableMedias || []).map(normalizeTrackMedia),
    referenceAssets: (track.referenceAssets || []).map(normalizeTrackMedia),
    storyboard: track.storyboard ? normalizeTrackMedia(track.storyboard) : undefined,
    videoList: (track.videoList || []).map((video) => ({
      ...video,
      src: video.src ? resolveBackendAssetUrl(video.src, baseUrl.value) : "",
    })),
  };
}

interface TrackItem {
  id: number;
  prompt: string;
  state: "未生成" | "生成中" | "已完成" | "生成失败";
  reason?: string;
  selectVideoId?: number | null;
  medias: TrackMedia[];
  videoList: VideoItem[];
  duration: number;
  title?: string;
  segmentTitle?: string;
  sceneTitle?: string;
  storyboardId?: number;
  imagePrompt?: string;
  videoDesc?: string;
  promptSource?: string;
  promptTemplateId?: number | null;
  promptTemplateVersion?: string | null;
  promptInferenceSnapshot?: string | null;
  promptAudit?: string[];
  segmentRows?: Array<{
    serial: string;
    description: string;
    duration: number;
    scale: string;
    cameraMovement: string;
    dialogue: string;
    sound: string;
  }>;
  storyboard?: TrackMedia & { state?: string };
  availableMedias?: TrackMedia[];
  referenceAssets?: TrackMedia[];
  excludesStoryboard?: boolean;
  readiness?: {
    ready: boolean;
    referenceCount: number;
    referenceLimit?: number | null;
    messages: string[];
  };
}
interface SceneGroup {
  key: string;
  title: string;
  duration: number;
  entries: Array<{ track: TrackItem; index: number }>;
}
function inferenceAssetTypeLabel(media: TrackMedia) {
  const type = String(media.type || "").toLowerCase();
  if (type === "role" || type === "character") return "角色";
  if (type === "scene") return "场景";
  if (type === "props" || type === "prop" || type === "tool") return "道具";
  if (media.fileType === "video") return "视频";
  if (media.fileType === "audio") return "音频";
  return "图片";
}

const preInferenceText = computed(() => {
  const track = activeTrack.value;
  if (!track) return "";

  const referenceToken = String(projectConfig.value.referenceToken || "@图");
  const referenceMap = (track.medias || [])
    .map((media, index) => `${referenceToken}${index + 1}：${media.name || "未命名资产"}（${inferenceAssetTypeLabel(media)}）`)
    .join("\n");
  const videoDescription = track.segmentRows?.length
    ? track.segmentRows
        .map(
          (row) =>
            `${row.serial}. ${row.description}；${row.duration}s；${row.scale || "未标注"}；${row.cameraMovement || "未标注"}；台词：${displaySegmentField(row.dialogue, "台词")}；音效：${displaySegmentField(row.sound, "音效")}`,
        )
        .join("\n")
    : String(track.videoDesc || "").trim();

  return [
    `片段：${track.segmentTitle || track.title || `#${activeTrackIndex.value + 1}`}`,
    `模型：${projectConfig.value.modelDisplayName || projectConfig.value.modelName || "未配置"}`,
    `模式：${projectConfig.value.mode || "未标注"}；画幅：${projectConfig.value.videoRatio || "16:9"}；画风：${projectConfig.value.artStyle || "未标注"}`,
    track.promptTemplateVersion
      ? `提示词模板版本：${track.promptTemplateId || "未标注"} / ${track.promptTemplateVersion}`
      : "提示词模板版本：尚未生成",
    `时长：${track.duration || 0} 秒`,
    referenceMap ? `[参考资产]\n${referenceMap}` : "",
    videoDescription ? `[视频描述]\n${videoDescription}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
});

function displaySceneTitle(value?: string) {
  const title = String(value || "")
    .split(/[｜|]/)[0]
    .trim();
  return title || "未标注场次";
}

const sceneGroups = computed<SceneGroup[]>(() => {
  const groups = new Map<string, SceneGroup>();
  trackList.value.forEach((track, index) => {
    const rawTitle = String(track.sceneTitle || "").trim();
    const key = rawTitle || "__unassigned__";
    const group = groups.get(key) || {
      key,
      title: displaySceneTitle(rawTitle),
      duration: 0,
      entries: [],
    };
    group.duration += Number(track.duration) || 0;
    group.entries.push({ track, index });
    groups.set(key, group);
  });
  return Array.from(groups.values());
});

const activeSceneIndex = computed(() =>
  Math.max(
    0,
    sceneGroups.value.findIndex((scene) => scene.entries.some((entry) => entry.index === activeTrackIndex.value)),
  ),
);
const activeSceneGroup = computed(() => sceneGroups.value[activeSceneIndex.value] || null);
const activeTrackGenTextLoading = computed(() => {
  return Boolean(activeSceneGroup.value?.entries.some((entry) => genTextLoadingMap.value[entry.track.id]));
});
const activeScenePromptError = computed(() => {
  const key = activeSceneGroup.value?.key;
  return key ? scenePromptErrorMap.value[key] || "" : "";
});
const shouldShowStoryboardPreview = computed(() => !isMixedMode.value && !activeTrack.value?.excludesStoryboard);

function selectScene(scene: SceneGroup) {
  if (!scene.entries.some((entry) => entry.index === activeTrackIndex.value)) {
    activeTrackIndex.value = scene.entries[0]?.index ?? 0;
  }
}

function isSceneChecked(scene: SceneGroup) {
  return scene.entries.length > 0 && scene.entries.every((entry) => checkedTrackIds.value.includes(entry.track.id));
}

function isScenePartiallyChecked(scene: SceneGroup) {
  const selected = scene.entries.filter((entry) => checkedTrackIds.value.includes(entry.track.id)).length;
  return selected > 0 && selected < scene.entries.length;
}

function toggleSceneCheck(scene: SceneGroup, checked: boolean) {
  scene.entries.forEach((entry) => toggleCheck(entry.track.id, checked));
}

async function addTrack() {
  const { data } = await axios.post("/production/workbench/addTrack", {
    projectId: project.value?.id,
    scriptId: episodesId.value ?? 0,
  });
  const trackId = typeof data === "object" && data !== null ? data.id : data;
  trackList.value.push({ id: trackId, prompt: "", state: "未生成", medias: [], videoList: [], duration: 0 });
  activeTrackIndex.value = trackList.value.length - 1;
}

function confirmDeleteTrack(index: number) {
  const dlg = DialogPlugin.confirm({
    header: $t("workbench.generate.del"),
    body: $t("workbench.generate.delConfirm"),
    onConfirm: () => {
      dlg.destroy();
      deleteTrack(index);
      window.$message.success($t("workbench.generate.delSuccess"));
      getGenerateData();
    },
    onCancel: () => {
      dlg.destroy();
    },
  });
}

async function deleteTrack(index: number) {
  const track = trackList.value[index];
  if (!track) return;
  await axios.post("/production/workbench/deleteTrack", { id: track.id });
  if (activeTrackIndex.value >= trackList.value.length) {
    activeTrackIndex.value = trackList.value.length - 1;
  }
}

const uploadBox = ref<UploadItem[]>([]);

const references = computed(() => {
  return uploadBox.value
    .filter((item) => item.src)
    .map((item) => ({
      type: item.fileType,
      src: item.src!,
    }));
});

interface StoryboardItem {
  src: string;
  createTime?: number | null;
  duration?: string | null;
  flowId?: number | null;
  id?: number;
  index?: number | null;
  projectId?: number | null;
  prompt?: string | null;
  reason?: string | null;
  scriptId?: number | null;
  state?: string | null;
  trackId?: number | null;
}
const storyboardList = ref<StoryboardItem[]>([]);
const storyboardDialogVisible = ref(false);
const pendingIndex = ref(-1);

function buildUploadBox(value: string): UploadItem[] {
  const currentMode = parseMode(value);
  if (!currentMode) return [];
  const modeUploadMap: Record<Exclude<VideoMode, string[]>, UploadItem[]> = {
    singleImage: [{ fileType: "image", type: "imageReference", sources: "storyboard", label: "参考图片" }],
    multiImage: [],
    startEndRequired: [
      { fileType: "image", type: "startImage", sources: "storyboard", label: "首帧" },
      { fileType: "image", type: "endImage", sources: "storyboard", label: "末帧" },
    ],
    endFrameOptional: [
      { fileType: "image", type: "startImage", sources: "storyboard", label: "首帧" },
      { fileType: "image", type: "endImage", sources: "storyboard", label: "末帧(可选)" },
    ],
    startFrameOptional: [
      { fileType: "image", type: "startImage", sources: "storyboard", label: "首帧(可选)" },
      { fileType: "image", type: "endImage", sources: "storyboard", label: "末帧" },
    ],
    text: [],
  };

  if (Array.isArray(currentMode)) {
    return [];
  }

  return (modeUploadMap[currentMode] || []).map((item) => ({ ...item }));
}

const fileTypeMap: Record<UploadItem["fileType"], AssetType[]> = {
  image: ["role", "scene", "tool"],
  video: ["clip"],
  audio: ["clip"],
};

function handleSelectSource(index: number) {
  const item = uploadBox.value[index];
  if (!item) return;
  pendingIndex.value = index;

  const dlg = DialogPlugin.confirm({
    header: $t("workbench.generate.selectSource"),
    confirmBtn: $t("workbench.generate.confirm"),
    cancelBtn: $t("workbench.generate.cancel"),
    onConfirm: async () => {
      dlg.destroy();
      const assets = await assetsCheck({ types: fileTypeMap[item.fileType], multiple: false });
      if (assets.length > 0) {
        userEditedUploadBox.value = true;
        uploadBox.value[index] = { ...item, sources: "assets", src: assets[0].src, id: assets[0].id, prompt: assets[0].prompt };
      }
    },
    onCancel: () => {
      dlg.destroy();
      storyboardDialogVisible.value = true;
    },
  });
}

async function handleMixedAdd() {
  const assets = await assetsCheck({
    types: ["role", "tool", "scene", "clip"],
    clipMediaTypes: mixedClipMediaTypes.value,
    multiple: true,
  });
  if (!assets.length) return;
  userEditedUploadBox.value = true;
  const remaining = mixedReferenceLimit.value ? Math.max(0, mixedReferenceLimit.value - uploadBox.value.length) : assets.length;
  for (const asset of assets.slice(0, remaining)) {
    const fileType = getFileTypeByExt(asset.src);
    uploadBox.value.push({
      fileType,
      type: refTypeMap[fileType] as Type,
      sources: "assets",
      src: asset.src,
      id: asset.id,
      prompt: asset.prompt,
      label: "",
    });
  }
  if (assets.length > remaining) {
    window.$message.warning(`当前模型最多支持 ${mixedReferenceLimit.value} 张参考图`);
  }
}

const refTypeMap: Record<string, ReferenceType> = {
  image: "imageReference",
  video: "videoReference",
  audio: "audioReference",
};

function getFileTypeByExt(src: string | undefined): "image" | "video" | "audio" {
  const ext = src?.split(".").pop()?.toLowerCase() ?? "";
  const videoExts = ["mp4", "webm", "mov", "avi", "mkv"];
  const audioExts = ["mp3", "wav", "ogg", "aac", "flac", "m4a"];
  if (videoExts.includes(ext)) return "video";
  if (audioExts.includes(ext)) return "audio";
  return "image";
}

function pickStoryboard(sb: StoryboardItem) {
  storyboardDialogVisible.value = false;
  userEditedUploadBox.value = true;
  if (isMixedMode.value) {
    window.$message.warning("图片多参考模式仅使用资产参考图，不使用故事板图");
    return;
  }
  const item = uploadBox.value[pendingIndex.value];
  if (!item) return;
  uploadBox.value[pendingIndex.value] = { ...item, sources: "storyboard", src: sb.src, id: sb.id, prompt: sb.prompt ?? undefined };
}

function clearUpload(index: number) {
  const item = uploadBox.value[index];
  if (!item) return;
  userEditedUploadBox.value = true;
  if (isMixedMode.value) {
    uploadBox.value.splice(index, 1);
  } else {
    uploadBox.value[index] = { ...item, sources: "storyboard", src: undefined, id: undefined, prompt: undefined };
  }
}

async function generateVideo() {
  const trackId = trackList.value[activeTrackIndex.value]?.id;
  if (trackId == null) {
    window.$message.warning("当前视频片段尚未加载，请稍后重试");
    return;
  }
  if (generatingMap.value[trackId]) {
    window.$message.warning("当前视频片段正在生成中");
    return;
  }
  const dlg = DialogPlugin.confirm({
    header: $t("workbench.generate.generateConfirm"),
    body: $t("workbench.generate.generateConfirmBody"),
    onConfirm: async () => {
      dlg.destroy();
      generatingMap.value[trackId] = true;
      try {
        const payload = {
          projectId: project.value?.id,
          scriptId: episodesId.value,
          uploadData: uploadBox.value.filter((item) => Boolean(item.src)),
          prompt: promptText.value,
          model: selectModel.value,
          mode: selectMode.value,
          resolution: selectedResolution.value,
          duration: effectiveDuration.value,
          audio: selectedAudio.value,
          parameters: workflowParameters.value,
          promptTemplateId: selectedVideoPromptTemplateId.value,
          trackId,
        };
        await axios.post("/production/workbench/generateVideo", payload);
        window.$message.success($t("workbench.generate.generateStarted"));
        getVideoList();
      } catch (caught: any) {
        window.$message.error(getRequestErrorMessage(caught));
      } finally {
        generatingMap.value[trackId] = false;
      }
    },
    onCancel: () => {
      dlg.destroy();
    },
  });
}

watch(selectModel, (val) => {
  if (!val) {
    modeOptions.value = {} as VideoModel;
    selectMode.value = undefined;
    selectedAudio.value = false;
    workflowParameters.value = {};
    return;
  }
  axios.post("/modelSelect/getModelDetail", { modelId: val }).then(({ data }) => {
    modeOptions.value = data;
    selectedAudio.value = data.audio === true || data.audio === "optional";
    workflowParameters.value = Object.fromEntries(
      (data.parameters || []).map((parameter: VideoModelParameter) => [parameter.key, parameter.default]),
    );
    const preferredMode = projectConfig.value.mode || selectMode.value || project.value?.mode || "";
    selectMode.value = resolvePreferredMode(data.mode || [], String(preferredMode));
    // 重置分辨率和时长为第一个可选项
    const drMap = data.durationResolutionMap;
    if (Array.isArray(drMap) && drMap.length > 0) {
      if (isB36Model.value) {
        syncB36Resolution();
      } else if (drMap[0].resolution?.length) {
        selectedResolution.value = drMap[0].resolution[0];
      }
      if (drMap[0].duration?.length) {
        selectedDuration.value = drMap[0].duration[0];
      }
    }
    // 切换模型时重置手动选择标记
    userSelectedDuration.value = false;
  });
});

watch([selectedMegapixels, isB36Model, () => projectConfig.value.videoRatio], syncB36Resolution, { immediate: true });

const userEditedUploadBox = ref(false);

watch(selectMode, (val) => {
  if (!val) return (uploadBox.value = []);
  userEditedUploadBox.value = false;
  uploadBox.value = buildUploadBox(val);
  syncMediasToUploadBox();
});

watch(
  uploadBox,
  (items) => {
    if (!userEditedUploadBox.value) return;
    const track = trackList.value[activeTrackIndex.value];
    if (!track) return;
    track.medias = items
      .filter((item) => item.src)
      .map((item) => ({ src: item.src!, id: item.id, prompt: item.prompt, fileType: item.fileType, sources: item.sources }));
  },
  { deep: true },
);

const checkedTrackIds = ref<number[]>([]);
const checkAll = ref(false);
const selectedSceneCount = computed(
  () => sceneGroups.value.filter((scene) => scene.entries.some((entry) => checkedTrackIds.value.includes(entry.track.id))).length,
);
const selectedSegmentCount = computed(() => checkedTrackIds.value.length);
const selectedTracks = computed(() => trackList.value.filter((track) => checkedTrackIds.value.includes(track.id)));
const selectedImportableCount = computed(
  () => selectedTracks.value.filter((track) => {
    const selectedVideoId = trackSelectedVideoMap.value[track.id] ?? track.selectVideoId;
    return selectedVideoId != null && track.videoList.some((video) => video.id === selectedVideoId && isVideoPlayable(video));
  }).length,
);

function handleCheckAll(val: boolean) {
  const allTrackIds = trackList.value.map((track) => track.id).filter((id): id is number => id != null);
  checkedTrackIds.value = val ? allTrackIds : [];
}

function checkTrack(id: number) {
  if (id == null) return;
  const isChecked = checkedTrackIds.value.includes(id);
  toggleCheck(id, !isChecked);
}

function toggleCheck(trackId: number | undefined, val: boolean) {
  if (trackId == null) return;
  if (val) {
    if (!checkedTrackIds.value.includes(trackId)) {
      checkedTrackIds.value.push(trackId);
    }
  } else {
    checkedTrackIds.value = checkedTrackIds.value.filter((id) => id !== trackId);
  }
  const allTrackIds = trackList.value.map((track) => track.id).filter((id): id is number => id != null);
  checkAll.value = allTrackIds.length > 0 && allTrackIds.every((id) => checkedTrackIds.value.includes(id));
}

watch(
  trackList,
  (list) => {
    const validIds = list.map((track) => track.id).filter((id): id is number => id != null);
    checkedTrackIds.value = checkedTrackIds.value.filter((id) => validIds.includes(id));
    checkAll.value = validIds.length > 0 && validIds.every((id) => checkedTrackIds.value.includes(id));
    genTextLoadingMap.value = Object.fromEntries(Object.entries(genTextLoadingMap.value).filter(([id]) => validIds.includes(Number(id))));
    generatingMap.value = Object.fromEntries(Object.entries(generatingMap.value).filter(([id]) => validIds.includes(Number(id))));
  },
  { deep: true },
);

async function batchGenText() {
  if (!checkedTrackIds.value.length) {
    window.$message.warning("请先勾选需要推理的视频片段，或使用全选");
    return;
  }
  for (const scene of sceneGroups.value) {
    const requestedIds = scene.entries
      .map((entry) => entry.track.id)
      .filter((id) => checkedTrackIds.value.includes(id));
    if (requestedIds.length) {
      await generateScenePrompts(scene, requestedIds);
    }
  }
}

function batchGenVideo() {
  const dlg = DialogPlugin.confirm({
    header: $t("workbench.generate.generateConfirm"),
    body: $t("workbench.generate.generateVideosInBatches"),
    onConfirm: async () => {
      dlg.destroy();
      const modeTemplate = selectMode.value ? buildUploadBox(selectMode.value) : [];
      trackList.value
        .filter((track) => checkedTrackIds.value.includes(track.id))
        .forEach(async (track) => {
          const trackId = track.id;
          if (trackId == null || generatingMap.value[trackId]) return;
          generatingMap.value[trackId] = true;
          try {
            const uploadData = isMixedMode.value
              ? track.medias.slice(0, mixedReferenceLimit.value || track.medias.length).filter((item) => Boolean(item.src))
              : modeTemplate.map((_, i) => track.medias[i]).filter((item) => item && Boolean(item.src));
            const payload = {
              projectId: project.value?.id,
              duration: clampDuration(track.duration || selectedDuration.value),
              scriptId: episodesId.value,
              uploadData: uploadData.map((item) => {
                return {
                  id: item.id,
                  sources: item.sources ? item.sources : "storyboard",
                  fileType: item.fileType,
                };
              }),
              prompt: track.prompt,
              model: selectModel.value,
              mode: selectMode.value,
              resolution: selectedResolution.value,
              audio: selectedAudio.value,
              parameters: workflowParameters.value,
              promptTemplateId: selectedVideoPromptTemplateId.value,
              trackId,
            };
            if (payload.prompt === "") return window.$message.warning($t("workbench.generate.skipDataWithEmptyVideoPromptWords"));
            await axios.post("/production/workbench/generateVideo", payload);
            window.$message.success($t("workbench.generate.generateStarted"));
            getVideoList();
          } catch (caught: any) {
            window.$message.error(getRequestErrorMessage(caught));
          } finally {
            generatingMap.value[trackId] = false;
          }
        });
    },
    onCancel: () => {
      dlg.destroy();
    },
  });
}

type ImportVideoItem = { trackId: number; videoId: number; src: string; duration: number };
const emit = defineEmits<{
  importVideo: [videoList: ImportVideoItem[]];
}>();
function importVideo() {
  if (checkedTrackIds.value.length === 0) {
    return window.$message.warning($t("workbench.generate.selectTrackFirst"));
  }
  const videoList: ImportVideoItem[] = trackList.value
    .filter((track) => track.id != null && checkedTrackIds.value.includes(track.id))
    .map((track) => {
      const trackId = track.id!;
      const selectedVid = trackSelectedVideoMap.value[trackId] ?? track.selectVideoId;
      if (!selectedVid) return null;
      const video = historyVideo.value.find((item) => item.id === selectedVid && item.videoTrackId === trackId);
      if (!video || !isVideoPlayable(video) || video.id == null) return null;
      const duration = Number(video.duration ?? video.time ?? track.duration ?? selectedDuration.value);
      return {
        trackId,
        videoId: video.id,
        src: video.src,
        duration: Number.isFinite(duration) && duration > 0 ? duration : selectedDuration.value,
      };
    })
    .filter((item): item is ImportVideoItem => item !== null);
  if (videoList.length === 0) {
    return window.$message.warning($t("workbench.generate.noSelectedVideo"));
  }
  emit("importVideo", videoList);
}

async function getGenerateData() {
  if (!project.value?.id || !episodesId.value) return;
  const { data } = await axios.post("/production/workbench/getGenerateData", {
    projectId: project.value?.id,
    scriptId: episodesId.value ?? 0,
  });
  projectConfig.value = data.projectConfig || {};
  if (data.projectConfig?.videoModel && data.projectConfig.videoModel !== selectModel.value) {
    selectModel.value = String(data.projectConfig.videoModel);
  }
  trackList.value = Array.isArray(data.trackList)
    ? data.trackList.map((track: TrackItem) => normalizeTrackItem(track))
    : [];
  if (data.projectConfig?.mode) {
    selectMode.value = String(data.projectConfig.mode);
  }
  if (activeTrackIndex.value >= trackList.value.length) activeTrackIndex.value = 0;
  trackSelectedVideoMap.value = {};
  for (const track of trackList.value) {
    if (track.id != null && track.selectVideoId != null) {
      trackSelectedVideoMap.value[track.id] = track.selectVideoId;
    }
  }
  storyboardList.value = Array.isArray(data.storyboardList)
    ? data.storyboardList.map((storyboard: StoryboardItem) => ({
        ...storyboard,
        src: storyboard.src ? resolveBackendAssetUrl(storyboard.src, baseUrl.value) : "",
      }))
    : [];
  syncMediasToUploadBox();
  getVideoList();
}

function syncMediasToUploadBox() {
  const track = trackList.value[activeTrackIndex.value];
  if (!track) return;
  const medias = track.medias;
  if (isMixedMode.value) {
    userEditedUploadBox.value = false;
    uploadBox.value = medias.map((media) => ({
      fileType: media.fileType,
      type: refTypeMap[media.fileType] as Type,
      sources: media.sources ?? "assets",
      src: media.src,
      id: media.id,
      prompt: media.prompt,
      label: media.name || "",
    }));
    return;
  }
  uploadBox.value = uploadBox.value.map((item, i) => {
    const media = medias[i];
    if (media?.src) {
      return { ...item, src: media.src, id: media.id, prompt: media.prompt, sources: media.sources ?? item.sources };
    }
    return { ...item, src: undefined, id: undefined, prompt: undefined };
  });
}

function restoreActiveTrackSelection() {
  const track = trackList.value[activeTrackIndex.value];
  if (!track?.id) {
    selectVideoId.value = null;
    return;
  }

  const selectedId = trackSelectedVideoMap.value[track.id] ?? track.selectVideoId ?? null;
  selectVideoId.value = selectedId;
}

watch(
  [() => project.value?.id, () => episodesId.value],
  ([projectId, scriptId]) => {
    if (!projectId || !scriptId) return;
    selectModel.value = project.value?.videoModel || "";
    selectMode.value = project.value?.mode || "";
    getGenerateData();
  },
  { immediate: true },
);

onMounted(() => {
  loadVideoPromptTemplates();
});

const hasGeneratedVideo = computed(() => {
  return historyVideo.value.some((v) => v.state === "生成中");
});

let pollTimer: number | null = null;

function startPoll() {
  if (pollTimer !== null) return;
  pollTimer = window.setInterval(() => {
    getVideoList();
  }, 3000);
}

function stopPoll() {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

watch(
  () => hasGeneratedVideo.value,
  (newValue) => {
    if (newValue) {
      startPoll();
    } else {
      stopPoll();
    }
  },
);

onUnmounted(() => {
  stopPoll();
  modalVideoRef.value?.pause();
});

async function getVideoList() {
  if (!project.value?.id || !episodesId.value) return;
  const { data } = await axios.post("/production/workbench/getVideoList", {
    projectId: project.value?.id,
    scriptId: episodesId.value ?? 0,
  });
  const oldList = historyVideo.value;
  const normalizedData = (Array.isArray(data) ? data : []).map((item: HistoryVideoItem) => ({
    ...item,
    src: item.src ? resolveBackendAssetUrl(item.src, baseUrl.value) : "",
  }));
  historyVideo.value = normalizedData;
  restoreActiveTrackSelection();
  // 检测生成完成的视频并提醒用户
  for (const item of normalizedData) {
    const old = oldList.find((o) => o.id === item.id);
    if (!old) continue;
    if (old.state === "生成中" && item.state === "已完成") {
      window.$message.success($t("workbench.generate.generateSuccess"));
    } else if (old.state === "生成中" && item.state === "生成失败") {
      window.$message.error(item.errorReason || $t("workbench.generate.generateFailed"));
    }
  }
}

watch(activeTrackIndex, () => {
  // 切换 track 时重置手动选择标记，让新 track 的 duration 自动生效
  userSelectedDuration.value = false;
  syncMediasToUploadBox();
  restoreActiveTrackSelection();
});
function handleDurationChange(dur: number) {
  selectedDuration.value = dur;
  userSelectedDuration.value = true;
}

function handleDurationSelect(value: unknown) {
  const duration = Number(value);
  if (!Number.isFinite(duration)) return;
  handleDurationChange(duration);
}
//删除视频
function handleDeleteVideo(value: HistoryVideoItem) {
  const dlg = DialogPlugin.confirm({
    header: $t("workbench.generate.del"),
    body: $t("workbench.generate.delVideo"),
    onConfirm: () => {
      axios
        .post(`/production/workbench/delVideo`, {
          id: value.id,
        })
        .then(() => {
          window.$message.success($t("workbench.generate.delSuccess"));
          dlg.destroy();
          getVideoList();
        });
    },
    onCancel: () => {
      dlg.destroy();
    },
  });
}
//下载视频
async function downloadVideo(value: HistoryVideoItem) {
  const url = value.src;
  const response = await fetch(url);
  const blob = await response.blob();
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  const filename = "视频" + ".mp4";
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(link.href);
}
</script>

<style lang="scss" scoped>
.generateContainer {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  gap: 12px;
  .sceneNavigator {
    flex: 0 0 auto;
    padding: 10px 12px 12px;
    border: 1px solid var(--td-component-border);
    border-radius: 6px;
    background: var(--td-bg-color-container);
    .sceneToolbar {
      gap: 16px;
      margin-bottom: 9px;
      .sceneToolbarTitle {
        display: flex;
        align-items: baseline;
        gap: 10px;
        min-width: 0;
        strong {
          flex: 0 0 auto;
          font-size: 13px;
        }
        span {
          overflow: hidden;
          color: var(--td-text-color-secondary);
          font-size: 11px;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
      }
      .sceneToolbarActions {
        flex: 0 0 auto;
        gap: 8px;
      }
      .selectedCount {
        color: var(--td-text-color-secondary);
        font-size: 11px;
      }
    }
    .sceneGroups {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 10px;
    }
    .sceneGroup {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      align-items: center;
      gap: 5px 8px;
      min-width: 0;
      height: 62px;
      min-height: 62px;
      padding: 8px 10px;
      border: 1px solid var(--td-component-border);
      border-left: 3px solid var(--td-component-border);
      border-radius: 4px;
      overflow: hidden;
      cursor: pointer;
      &:hover {
        border-color: var(--td-brand-color);
      }
      &.active {
        border-color: var(--td-brand-color);
        border-left-color: var(--td-brand-color);
        background: var(--td-brand-color-light);
      }
      .sceneGroupCheck {
        grid-row: 1 / span 2;
      }
    }
    .sceneGroupHeader {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: center;
      gap: 6px;
      strong {
        font-size: 11px;
      }
      span {
        overflow: hidden;
        color: var(--td-text-color-secondary);
        font-size: 11px;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      small {
        color: var(--td-text-color-placeholder);
        font-size: 10px;
      }
    }
    .sceneGroupSegments {
      grid-column: 2;
      display: flex;
      max-height: 28px;
      flex-wrap: wrap;
      gap: 4px 8px;
      overflow: hidden;
      span {
        color: var(--td-text-color-secondary);
        font-size: 9px;
        white-space: nowrap;
      }
    }
    .activeSceneSegments {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 9px;
      padding-top: 9px;
      border-top: 1px solid var(--td-component-border);
      .activeSceneSegmentsLabel {
        flex: 0 0 auto;
        margin-right: 2px;
        color: var(--td-text-color-secondary);
        font-size: 10px;
      }
      button {
        min-height: 28px;
        padding: 4px 9px;
        color: var(--td-text-color-secondary);
        font-size: 10px;
        border: 1px solid var(--td-component-border);
        border-radius: 4px;
        background: var(--td-bg-color-container);
        cursor: pointer;
        &:hover,
        &.active {
          color: var(--td-brand-color);
          border-color: var(--td-brand-color);
          background: var(--td-brand-color-light);
        }
      }
    }
  }
  .data {
    width: 100%;
    flex: 1;
    height: auto;
    gap: 10px;
    min-height: 0;
    .videoToImage {
      position: relative;
      background: var(--td-bg-color-secondarycontainer);
      width: 100%;
      height: 100%;
      display: flex;
      flex: 1;
      gap: 24px;
      min-height: 0;
      border-radius: 8px;
      overflow: hidden;
      .emptyVideo {
        width: 100%;
        height: 100%;
        color: var(--td-text-color-placeholder);
      }
      .taskBrief {
        width: 100%;
        height: 100%;
        padding: 18px;
        overflow-y: auto;
        color: var(--td-text-color-primary);
        background: var(--td-bg-color-container);
      }
      .taskBriefHeader {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 14px;
        h3 {
          margin: 4px 0 0;
          font-size: 15px;
          line-height: 1.45;
        }
      }
      .taskKicker {
        color: var(--td-text-color-secondary);
        font-size: 12px;
      }
      .storyboardPreview {
        position: relative;
        width: 100%;
        overflow: hidden;
        border: 1px solid var(--td-component-border);
        border-radius: 6px;
        background: #111;
        img {
          display: block;
          width: 100%;
          max-height: 230px;
          object-fit: contain;
        }
        span {
          position: absolute;
          right: 8px;
          bottom: 8px;
          padding: 4px 7px;
          color: #fff;
          font-size: 11px;
          background: rgba(0, 0, 0, 0.68);
          border-radius: 4px;
        }
      }
      .taskStats {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 8px;
        margin: 12px 0;
        div {
          padding: 9px 10px;
          border: 1px solid var(--td-component-border);
          border-radius: 6px;
        }
        span,
        strong {
          display: block;
        }
        span {
          color: var(--td-text-color-secondary);
          font-size: 11px;
        }
        strong {
          margin-top: 4px;
          overflow: hidden;
          font-size: 12px;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
      }
      .segmentTable {
        overflow: hidden;
        border: 1px solid var(--td-component-border);
        border-radius: 6px;
      }
      .segmentRow {
        display: grid;
        grid-template-columns: 36px minmax(180px, 1.25fr) minmax(150px, 0.9fr) 42px minmax(90px, 0.4fr);
        border-top: 1px solid var(--td-component-border);
        &:first-child {
          border-top: 0;
        }
        > span,
        > .dialogueCell {
          padding: 7px 8px;
          font-size: 11px;
          line-height: 1.45;
        }
        .dialogueCell {
          p {
            margin: 0;
            overflow-wrap: anywhere;
            + p {
              margin-top: 4px;
              color: var(--td-text-color-secondary);
            }
          }
          b {
            margin-right: 5px;
            color: var(--td-text-color-secondary);
            font-weight: 500;
          }
        }
      }
      .segmentRowHeader {
        color: var(--td-text-color-secondary);
        background: var(--td-bg-color-secondarycontainer);
        font-weight: 600;
      }
      .taskNotice {
        margin-top: 10px;
        padding: 8px 10px;
        color: var(--td-warning-color-7);
        font-size: 11px;
        line-height: 1.5;
        background: var(--td-warning-color-1);
        border-radius: 5px;
      }
    }
    .configurationParameters {
      width: 50%;
      height: 100%;
      overflow-y: auto;
      border: 1px solid var(--td-component-border);
      height: 100%;
      border-radius: 8px;
      padding: 16px;
      .activeTrackInfo {
        padding: 8px 0;
        gap: 8px;
        margin-bottom: 4px;
      }
      .promptsMenu {
        .title {
          font-weight: bold;
        }
        .promptActions {
          gap: 8px;
          min-width: 0;
        }
        .videoPromptTemplateSelect {
          width: 210px;
        }
        padding-top: 10px;
        padding-bottom: 10px;
      }
      .promptError {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        margin-bottom: 8px;
        padding: 8px 10px;
        border: 1px solid var(--td-error-color-3);
        border-radius: 6px;
        color: var(--td-error-color);
        background: var(--td-error-color-1);
        font-size: 12px;
        line-height: 1.5;
        word-break: break-word;
      }
      .promptStack {
        display: grid;
        gap: 10px;
      }
      .promptSectionHeader {
        display: flex;
        align-items: center;
        justify-content: space-between;
        min-height: 22px;
        margin-bottom: 5px;
        font-size: 12px;
        span {
          color: var(--td-text-color-primary);
          font-weight: 600;
        }
        small {
          color: var(--td-text-color-placeholder);
          font-size: 11px;
          &.inferred {
            color: var(--td-success-color);
          }
        }
      }
      .promptInput {
        border: 1px solid var(--td-component-border);
        border-radius: 6px;
        overflow: hidden;
      }
      .promptInputSource {
        height: 132px;
        background: var(--td-bg-color-secondarycontainer);
      }
      .promptInputResult {
        height: 162px;
      }
      .modeOpt {
        width: 100%;
        padding-top: 10px;
        padding-bottom: 10px;
        border-bottom: 1px solid var(--td-component-border);
        gap: 8px;
        .uploadBtn {
          width: 80px;
          height: 80px;
          position: relative;
          border: 1px dashed var(--td-component-border);
          border-radius: 8px;
          &:hover {
            border-color: var(--td-text-color);
            cursor: pointer;
          }
          .uploadPreview {
            width: 100%;
            height: 100%;
            object-fit: cover;
            border-radius: 8px;
          }
          .clearBtn {
            position: absolute;
            top: -6px;
            right: -6px;
            width: 18px;
            height: 18px;
            border-radius: 50%;
            background: rgba(0, 0, 0, 0.6);
            color: #fff;
            display: none;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            &:hover {
              background: rgba(0, 0, 0, 0.85);
            }
          }
          &:hover .clearBtn {
            display: flex;
          }
        }
      }
      .storyboardGrid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 12px;
        max-height: 60vh;
        overflow-y: auto;
        padding: 4px;
        .storyboardItem {
          cursor: pointer;
          border-radius: 8px;
          overflow: hidden;
          border: 2px solid transparent;
          transition:
            border-color 0.2s,
            box-shadow 0.2s;
          &:hover {
            border-color: var(--td-brand-color);
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
          }
          img {
            width: 100%;
            aspect-ratio: 16/9;
            object-fit: cover;
            display: block;
          }
        }
      }
      .modeMenu {
        width: 100%;
        padding-top: 10px;
        padding-bottom: 10px;
        border-bottom: 1px solid var(--td-component-border);
        .left {
          flex: 1;
          flex-wrap: wrap;
          gap: 8px;
          .mode {
            width: 180px;
          }
          .audio {
            width: 32px;
            min-width: 32px;
            padding: 0;
            &.fixed {
              cursor: default;
            }
          }
          .resolutionSelect {
            width: 156px;
          }
          .megapixelSelect {
            width: 176px;
          }
          .durationSelect {
            width: 84px;
          }
          .workflowParameterButton {
            width: 32px;
            min-width: 32px;
          }
        }
      }
      .history {
        .titleBox {
          .title {
            font-weight: bold;
          }
          padding-top: 10px;
          padding-bottom: 10px;
        }
        .historyItemBox {
          height: 100%;
          overflow: hidden;
          display: grid;
          grid-template-columns: repeat(6, 1fr);
          gap: 8px;
          .historyItem {
            width: 100%;
            aspect-ratio: 1/1;
            border-radius: 8px;
            overflow: hidden;
            cursor: pointer;
            position: relative;
            border: 2px solid var(--td-component-border);
            background: var(--td-bg-color-secondarycontainer);
            transition:
              border-color 0.2s,
              box-shadow 0.2s;
            &.active {
              border-color: var(--td-brand-color);
              box-shadow: 0 0 0 2px rgba(var(--td-brand-color-rgb, 0, 82, 217), 0.2);
            }
            &.generating {
              border-color: var(--td-brand-color);
              border-style: dashed;
            }
            &.failed {
              border-color: var(--td-error-color);
            }
            &:hover {
              border-color: var(--td-brand-color);
              box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
            }
            video {
              width: 100%;
              height: 100%;
              object-fit: cover;
              pointer-events: none;
            }
            .playOverlay {
              position: absolute;
              inset: 0;
              color: #fff;
              background: rgba(0, 0, 0, 0.16);
              opacity: 0;
              pointer-events: none;
              transition: opacity 0.2s;
            }
            &:hover .playOverlay {
              opacity: 1;
            }
            .loadingOverlay {
              position: absolute;
              inset: 0;
              background: rgba(0, 0, 0, 0.45);
              color: #fff;
              gap: 6px;
              .loadingText {
                font-size: 10px;
              }
            }
            .selectBtn {
              position: absolute;
              bottom: 4px;
              right: 4px;
              width: 24px;
              height: 24px;
              border-radius: 50%;
              background: rgba(0, 0, 0, 0.5);
              color: #fff;
              display: none;
              align-items: center;
              justify-content: center;
              cursor: pointer;
              transition: background 0.2s;
              &:hover {
                background: var(--td-brand-color);
              }
            }
            &:hover .selectBtn {
              display: flex;
            }
            &.active .selectBtn {
              display: flex;
              background: var(--td-brand-color);
            }
            .delBtn {
              position: absolute;
              top: 4px;
              right: 4px;
              width: 24px;
              height: 24px;
              border-radius: 50%;
              background: rgba(0, 0, 0, 0.5);
              color: #fff;
              display: none;
              align-items: center;
              justify-content: center;
              cursor: pointer;
              transition: background 0.2s;
            }
            &:hover .delBtn {
              display: flex;
            }
            .stateTag {
              position: absolute;
              bottom: 4px;
              left: 4px;
            }
            .download {
              position: absolute;
              top: 4px;
              left: 4px;
              width: 24px;
              height: 24px;
              border-radius: 50%;
              background: rgba(0, 0, 0, 0.5);
              color: #fff;
              display: none;
              align-items: center;
              justify-content: center;
              cursor: pointer;
              transition: background 0.2s;
            }
            &:hover .download {
              display: flex;
            }
          }
        }
      }
    }
  }
}

.workflowParameterPanel {
  width: 300px;
  padding: 12px;
  display: grid;
  gap: 14px;
  background: var(--td-bg-color-container);
  .workflowParameterItem {
    display: grid;
    gap: 7px;
  }
  .workflowParameterHeader {
    display: grid;
    gap: 3px;
    font-size: 13px;
    color: var(--td-text-color-primary);
    .workflowParameterLabel {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      min-width: 0;
    }
    .workflowParameterHelp {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 15px;
      height: 15px;
      border: 1px solid var(--td-brand-color);
      border-radius: 50%;
      color: var(--td-brand-color);
      font-size: 11px;
      font-weight: 700;
      line-height: 1;
      cursor: help;
      outline: none;
      &:focus-visible {
        box-shadow: 0 0 0 2px var(--td-brand-color-focus);
      }
    }
    small {
      font-size: 12px;
      line-height: 1.45;
      color: var(--td-text-color-secondary);
    }
  }
}

.videoPreviewDialog {
  width: 100%;
  overflow: hidden;
  border: 1px solid #2a2a2f;
  border-radius: 6px;
  color: #fff;
  background: #0f0f12;
  &:fullscreen {
    display: flex;
    flex-direction: column;
    justify-content: center;
    border: 0;
    border-radius: 0;
    background: #000;
    .videoPreviewStage {
      flex: 1;
      height: auto;
      max-height: none;
    }
  }
}

.videoPreviewStage {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: min(68vh, 630px);
  min-height: 320px;
  overflow: hidden;
  background: #08080a;
  cursor: pointer;
  video {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
}

.modalCenterPlay {
  position: absolute;
  top: 50%;
  left: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 72px;
  height: 72px;
  padding: 0;
  color: #fff;
  border: 1px solid rgba(255, 255, 255, 0.72);
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.62);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.3);
  cursor: pointer;
  transform: translate(-50%, -50%);
  transition:
    background 0.16s,
    transform 0.16s;
  &:hover {
    background: rgba(0, 0, 0, 0.82);
    transform: translate(-50%, -50%) scale(1.04);
  }
}

.modalVideoError {
  position: absolute;
  inset: 0;
  gap: 8px;
  color: #fff;
  font-size: 13px;
  background: rgba(0, 0, 0, 0.78);
}

.videoControlBar {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 54px;
  padding: 8px 12px;
  border-top: 1px solid #29292e;
  background: #151519;
}

.mediaIconButton {
  display: flex;
  flex: 0 0 36px;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  padding: 0;
  color: #fff;
  border: 1px solid #3b3b42;
  border-radius: 4px;
  background: #222228;
  cursor: pointer;
  transition:
    border-color 0.16s,
    background 0.16s;
  &:hover {
    border-color: #fff;
    background: #303038;
  }
}

.mediaTime,
.mediaResolution {
  flex: 0 0 auto;
  color: #d8d8dd;
  font-size: 12px;
  white-space: nowrap;
}

.mediaResolution {
  min-width: 118px;
  text-align: right;
}

.mediaProgress,
.mediaVolume {
  height: 20px;
  margin: 0;
  accent-color: #fff;
  cursor: pointer;
}

.mediaProgress {
  flex: 1 1 auto;
  min-width: 120px;
}

.mediaVolume {
  flex: 0 0 92px;
  width: 92px;
}

@media (max-width: 900px) {
  .videoPreviewStage {
    min-height: 220px;
  }
  .mediaVolume,
  .mediaResolution {
    display: none;
  }
  .mediaTime {
    font-size: 11px;
  }
}
</style>
