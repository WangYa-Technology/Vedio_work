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
const { project } = storeToRefs(projectStore());
const { currentScriptId } = storeToRefs(productionAgentStore());

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

onMounted(() => {
  editFootage();
});
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
  const ext = src.split("?")[0].split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"].includes(ext)) return "image";
  if (["mp4", "webm", "ogg", "mov", "avi", "mkv"].includes(ext)) return "video";
  if (["mp3", "wav", "ogg", "aac", "flac", "m4a"].includes(ext)) return "audio";
  return "unknown";
}

//切换菜单
function changeMenu(type: string) {
  activeMenu.value = type;
  if (type == "editVideo") editFootage();
}
//查询剪辑素材
function editFootage() {
  axios
    .post("/assets/getMaterialData", {
      projectId: project.value?.id,
    })
    .then(({ data }) => {
      const videoList = data.data.filter((item: any) => getMediaType(item.filePath) === "video");
      const audioList = data.data.filter((item: any) => getMediaType(item.filePath) === "audio");
      const imageList = data.data.filter((item: any) => getMediaType(item.filePath) === "image");

      initialVideoItems.value = data.video.map((item: any) => ({
        id: `video-${item.id}`,
        type: "video",
        name: $t("workbench.production.wb.storyboardVideoName", { storyboard: item.storyboard }),
        duration: item.duration || 0,
        icon: "🎬",
        color: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
        url: item.filePath,
        selected: item.selected || false,
      }));
      mediaItems.value = videoList.map((item: any) => ({
        id: `video-${item.id}`,
        type: "video",
        name: item.name,
        duration: item.duration || 0,
        icon: "🎥",
        color: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
        url: item.filePath,
        loading: true,
      }));
      audioItems.value = audioList.map((item: any) => ({
        id: `audio-${item.id}`,
        type: "audio",
        name: item.name,
        duration: item.duration || 0,
        url: item.filePath,
        loading: true,
      }));
      imageItems.value = imageList.map((item: any) => ({
        id: `image-${item.id}`,
        type: "image",
        name: item.name,
        duration: item.duration || 5,
        icon: "🖼️",
        color: "linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)",
        url: item.filePath,
        loading: true,
      }));
    });
}

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
    editFootage();
    window.$message.success(`已导入 ${value.length} 个视频片段到剪辑台`);
  } catch (error: any) {
    window.$message.error(error?.message || "导入剪辑台失败");
  } finally {
    importLoading.value = false;
  }
}
</script>

<style lang="scss" scoped>
.fullscreenDialog {
  :deep(.t-dialog__body) {
    display: flex;
    flex-direction: column;
    height: 88vh;
    min-height: 620px;
    overflow: hidden;
    position: relative;
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
    top: var(--td-comp-paddingTB-xl);
    right: var(--td-comp-paddingLR-xxl);
    z-index: 9999;
    cursor: pointer;
    margin-top: 20px;
  }
  .topMenu {
    padding-bottom: 16px;
    width: fit-content;
    margin-top: 10px;
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
    overflow: hidden;
  }
  .editImage {
    width: 100%;
    height: 75vh;
  }
}
</style>
