<template>
  <t-dialog
    body="String"
    :header="false"
    :footer="false"
    :closeBtn="false"
    v-model:visible="visible"
    attach="body"
    placement="center"
    mode="modal"
    width="92vw"
    dialogClassName="noFooter"
    class="fullscreenDialog">
    <div class="closure">
      <i-close-small theme="outline" size="24" fill="#4a4a4a" @click="visible = false" />
    </div>
    <div class="topMenu f ac">
      <t-tooltip :content="$t('workbench.production.wb.quickPreview')" placement="bottom" theme="light" destroyOnClose :showArrow="false">
        <div class="item fc c" :class="{ active: activeMenu === 'preview' }" @click="changeMenu('preview')">
          <i-blackboard class="icon" />
          <span class="title">{{ $t("workbench.production.wb.quickPreview") }}</span>
        </div>
      </t-tooltip>
      <t-tooltip :content="$t('workbench.production.wb.videoGeneration')" placement="bottom" theme="light" destroyOnClose :showArrow="false">
        <div class="item fc c" :class="{ active: activeMenu === 'generate' }" @click="changeMenu('generate')">
          <i-playback-progress class="icon" />
          <span class="title">{{ $t("workbench.production.wb.videoGeneration") }}</span>
        </div>
      </t-tooltip>
      <t-tooltip :content="$t('workbench.production.wb.videoEditing')" placement="bottom" theme="light" destroyOnClose :showArrow="false">
        <div class="item fc c" :class="{ active: activeMenu === 'editVideo' }" @click="changeMenu('editVideo')">
          <i-editing class="icon" />
          <span class="title">{{ $t("workbench.production.wb.videoEditing") }}</span>
        </div>
      </t-tooltip>
    </div>
    <div class="content">
      <preview v-if="activeMenu === 'preview'" />
      <generate v-if="activeMenu === 'generate'" @importVideo="handleBatchDownload" v-model="extractLines" />
      <KeepAlive>
        <editVideo
          v-if="activeMenu === 'editVideo'"
          :initial-tracks="editorTracks"
          :initial-video-items="initialVideoItems"
          :initial-media-items="mediaItems"
          :initial-audio-items="audioItems"
          :initial-image-items="imageItems"
          :canvas-width="canvasWidth"
          :canvas-height="canvasHeight"
          ref="editVideoRef" />
      </KeepAlive>
    </div>
    <div v-if="importLoading" class="importLoadingMask">
      <div class="importLoadingContent">
        <t-loading size="large" :text="$t('workbench.production.wb.importingLoading')" />
      </div>
    </div>
  </t-dialog>
</template>

<script setup lang="ts">
import axios from "@/utils/axios";
import preview from "./preview.vue";
import generate from "./generate.vue";
import editVideo from "./editVideo/index.vue";
import { generateId, type Track } from "vue-clip-track";
import type { Ref } from "vue";
import type { MediaItem, AudioItem } from "./editVideo/utils/mediaData";
import projectStore from "@/stores/project";
import productionAgentStore from "@/stores/productionAgent";
import settingStore from "@/stores/setting";
import { resolveBackendAssetUrl } from "@/utils/backendUrl";
const { project } = storeToRefs(projectStore());
const { currentScriptId } = storeToRefs(productionAgentStore());
const { baseUrl } = storeToRefs(settingStore());

// 预览和分镜台组件通过 inject 获取当前集数，由工作台统一提供剧集上下文。
provide("episodesId", currentScriptId as unknown as Ref<number>);

const visible = defineModel("visible", {
  type: Boolean,
  default: false,
});
const activeMenu = ref("preview");

// 画布尺寸配置
const canvasWidth = ref(1920);
const canvasHeight = ref(1080);

onMounted(() => {
  const size = project.value?.videoRatio;
  if (size == "16:9") {
    canvasWidth.value = 1920;
    canvasHeight.value = 1080;
  } else if (size == "1:1") {
    canvasWidth.value = 1080;
    canvasHeight.value = 1080;
  } else if (size == "9:16") {
    canvasWidth.value = 1080;
    canvasHeight.value = 1920;
  }
});

// ============ 剪辑台素材 ============

/** 资源库 - 分镜视频 */
const initialVideoItems = ref<MediaItem[]>([]);

/** 资源库 - 视频素材 */
const mediaItems = ref<MediaItem[]>([]);

/** 资源库 - 音频素材 */
const audioItems = ref<AudioItem[]>([]);

/** 资源库 - 图片素材 */
const imageItems = ref<MediaItem[]>([]);

const extractLines = ref(false);
const importLoading = ref(false);
const materialsLoading = ref(false);
let materialRequestId = 0;
type MediaType = "image" | "video" | "audio" | "unknown";
type ImportVideoItem = {
  trackId: number;
  videoId: number;
  src: string;
  duration: number;
};
const editVideoRef = ref<{ importVideos: (items: ImportVideoItem[]) => Promise<void> }>();

function getMediaType(src?: string): MediaType {
  if (!src) return "unknown";
  const ext = src.split(/[?#]/)[0].split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"].includes(ext)) return "image";
  if (["mp4", "webm", "ogg", "mov", "avi", "mkv"].includes(ext)) return "video";
  if (["mp3", "wav", "ogg", "aac", "flac", "m4a"].includes(ext)) return "audio";
  return "unknown";
}

//切换菜单
function changeMenu(type: string) {
  activeMenu.value = type;
  if (type === "editVideo") void editFootage();
}

function resolveMaterialPayload(response: any): { assets: any[]; videos: any[] } {
  // Axios normally returns the API envelope, but tolerate an already-unwrapped
  // payload so the editor remains compatible with older local servers.
  const envelope = response?.data ?? response;
  const payload = envelope?.data && !Array.isArray(envelope.data) ? envelope.data : envelope;
  return {
    assets: Array.isArray(payload?.data) ? payload.data : [],
    videos: Array.isArray(payload?.video) ? payload.video : [],
  };
}

function resolveMaterialUrl(value?: string | null) {
  return value ? resolveBackendAssetUrl(value, baseUrl.value) : "";
}

//查询剪辑素材
async function editFootage() {
  const projectId = project.value?.id;
  if (!projectId) return;

  const requestId = ++materialRequestId;
  materialsLoading.value = true;
  try {
    const response = await axios.post("/assets/getMaterialData", {
      projectId,
      ...(currentScriptId.value ? { scriptId: currentScriptId.value } : {}),
    });
    const { assets, videos } = resolveMaterialPayload(response);
    if (requestId !== materialRequestId) return;

    const videoList = assets.filter((item: any) => getMediaType(item.filePath) === "video");
    const audioList = assets.filter((item: any) => getMediaType(item.filePath) === "audio");
    const imageList = assets.filter((item: any) => getMediaType(item.filePath) === "image");

    initialVideoItems.value = videos
      .filter((item: any) => item.filePath)
      .map((item: any) => ({
        id: `video-${item.id}`,
        type: "video",
        name: item.storyboard || item.name || `分镜视频 #${item.videoTrackId || item.id}`,
        duration: Number(item.duration || item.time || 0),
        icon: "🎬",
        color: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
        url: resolveMaterialUrl(item.filePath),
        selected: item.selected || false,
      }));
      mediaItems.value = videoList.map((item: any) => ({
        id: `video-${item.id}`,
        type: "video",
        name: item.name,
        duration: item.duration || 0,
        icon: "🎥",
        color: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
        url: resolveMaterialUrl(item.filePath),
        loading: true,
      }));
      audioItems.value = audioList.map((item: any) => ({
        id: `audio-${item.id}`,
        type: "audio",
        name: item.name,
        duration: item.duration || 0,
        url: resolveMaterialUrl(item.filePath),
        loading: true,
      }));
      imageItems.value = imageList.map((item: any) => ({
        id: `image-${item.id}`,
        type: "image",
        name: item.name,
        duration: item.duration || 5,
        icon: "🖼️",
        color: "linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)",
        url: resolveMaterialUrl(item.filePath),
        loading: true,
      }));
  } catch (error) {
    if (requestId !== materialRequestId) return;
    // Keep the editor usable when an optional material endpoint is temporarily
    // unavailable; stale lists are worse than an explicit empty state.
    initialVideoItems.value = [];
    mediaItems.value = [];
    audioItems.value = [];
    imageItems.value = [];
    console.warn("剪辑台素材加载失败", error);
  } finally {
    if (requestId === materialRequestId) materialsLoading.value = false;
  }
}

watch(
  [() => project.value?.id, () => currentScriptId.value],
  ([projectId]) => {
    if (projectId) void editFootage();
  },
  { immediate: true },
);

function createInitialTracks(): Track[] {
  const createTrack = (type: Track["type"], name: string, order: number, isMain: boolean = false): Track => ({
    id: generateId("track-"),
    type,
    name,
    visible: true,
    locked: false,
    clips: [],
    order,
    ...(isMain && { isMain }),
  });
  return [
    createTrack("video", "主轨道", 0, true),
    createTrack("audio", "音频", 2),
    createTrack("subtitle", "字幕", 3),
    createTrack("filter", "滤镜", 4),
  ];
}

const editorTracks = createInitialTracks();

//导入到剪辑台
async function handleBatchDownload(value: ImportVideoItem[]) {
  if (!value.length || importLoading.value) return;
  importLoading.value = true;
  try {
    activeMenu.value = "editVideo";
    await nextTick();
    await editVideoRef.value?.importVideos(value);
    void editFootage();
    window.$message.success(`已导入 ${value.length} 个视频片段到剪辑台`);
  } catch (error: any) {
    window.$message.error(error?.message || "导入剪辑台失败");
  } finally {
    importLoading.value = false;
  }
}
</script>

<style lang="scss">
.fullscreenDialog {
  .t-dialog__position {
    box-sizing: border-box;
    height: 100%;
    min-height: 0;
    padding-block: clamp(12px, 2vh, 24px);
  }

  .t-dialog {
    display: flex;
    flex-direction: column;
    height: 100%;
    max-height: 100%;
    overflow: hidden;
    padding: 12px 16px 16px;
  }

  .t-dialog__body {
    display: flex;
    flex: 1;
    flex-direction: column;
    height: auto;
    min-height: 0;
    max-height: none;
    overflow: hidden;
    position: relative;
    box-sizing: border-box;
    padding: 0;
  }

  .importLoadingMask {
    position: absolute;
    inset: 0;
    background: rgba(255, 255, 255, 0.85);
    z-index: 9999;
    display: flex;
    align-items: center;
    justify-content: center;
    backdrop-filter: blur(4px);
    .importLoadingContent {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 16px;
    }
  }
  .closure {
    position: absolute;
    top: 12px;
    right: 16px;
    z-index: 9999;
    cursor: pointer;
    width: 36px;
    height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .topMenu {
    flex: 0 0 auto;
    min-height: 58px;
    padding-bottom: 10px;
    width: fit-content;
    margin-top: 0;
    .item {
      margin-right: 4px;
      cursor: pointer;
      width: 86px;
      min-height: 58px;
      padding: 4px 6px;
      .icon {
        font-size: 24px;
      }
      .title {
        font-size: 10px;
        white-space: nowrap;
        line-height: 14px;
      }
      &:hover {
        background-color: #ecedef;
        border-radius: 16px;
      }
    }
    .active {
      background-color: #000 !important;
      color: #fff;
      border-radius: 16px;
    }
  }
  .content {
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
  .editImage {
    width: 100%;
    height: 100%;
  }
}
</style>
