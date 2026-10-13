<template>
  <div class="videoLibrary">
    <div class="header">
      <div class="headerInfo fc">
        <span class="title">{{ $t("workbench.videoLibrary.title") }}</span>
        <span class="sub">
          {{ project?.name ? `${project.name} · ${$t("workbench.videoLibrary.total", { count: totalVideos })}` : $t("workbench.selectProject") }}
        </span>
      </div>
      <t-button :loading="loading" @click="loadLibrary">
        <template #icon>
          <i-redo :size="20" />
        </template>
        {{ $t("workbench.videoLibrary.refresh") }}
      </t-button>
    </div>
    <div class="content" v-loading="loading">
      <div class="placeholder fc c" v-if="!project?.id">
        <i-folder-open size="42" />
        <span>{{ $t("workbench.videoLibrary.noProject") }}</span>
      </div>
      <div class="placeholder fc c" v-else-if="!totalVideos">
        <i-movie size="42" />
        <span>{{ $t("workbench.videoLibrary.empty") }}</span>
        <span class="tip">{{ $t("workbench.videoLibrary.emptyTip") }}</span>
      </div>
      <div class="episodeList" v-else>
        <div class="episodeCard" v-for="episode in episodes" :key="episode.scriptId ?? 'other'">
          <div class="episodeHeader f ac">
            <span class="episodeBadge">{{ episodeLabel(episode) }}</span>
            <span class="episodeName" v-if="episode.name">{{ episode.name }}</span>
            <span class="episodeCount">{{ $t("workbench.videoLibrary.videoCount", { count: episode.videos.length }) }}</span>
          </div>
          <div class="videoGrid">
            <div class="videoCard" v-for="video in episode.videos" :key="video.id" :class="{ disabled: !video.playable }" @click="openPreview(episode, video)">
              <video v-if="video.playable" :src="thumbnailSrc(video)" preload="metadata" playsinline muted @loadedmetadata="applyDuration(video, $event)" />
              <div class="cardMask" v-if="video.playable">
                <PlayIcon size="30" />
              </div>
              <div class="cardState fc c" v-else-if="video.state === '生成中'">
                <t-loading size="22px" />
                <span>{{ $t("workbench.videoLibrary.generating") }}</span>
              </div>
              <div class="cardState fc c failed" v-else>
                <i-error-circle-filled size="22" />
                <span>{{ $t("workbench.videoLibrary.failed") }}</span>
              </div>
              <span class="episodeTag">{{ episodeLabel(episode) }}</span>
              <div class="cardMeta f ac jb">
                <span class="shot" v-if="video.trackIndex">{{ $t("workbench.videoLibrary.shot", { index: video.trackIndex }) }}</span>
                <span class="shot" v-else>&nbsp;</span>
                <span class="duration">{{ formatDuration(video.duration) }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <t-dialog
      v-model:visible="previewVisible"
      :header="previewTitle"
      :footer="false"
      width="min(1080px, 92vw)"
      placement="center"
      destroy-on-close
      :close-on-overlay-click="false"
      @opened="handlePreviewOpened"
      @close="closePreview">
      <div class="previewDialog">
        <div class="previewStage c" @click="togglePlayback">
          <video
            ref="playerRef"
            :src="previewUrl"
            playsinline
            preload="metadata"
            @loadedmetadata="handleMetadata"
            @timeupdate="handleTimeUpdate"
            @play="playing = true"
            @pause="playing = false"
            @ended="playing = false"
            @volumechange="syncVolumeState"
            @error="handleVideoError" />
          <button v-if="!playing && !videoError" type="button" class="centerPlay c" @click.stop="togglePlayback">
            <PlayIcon size="36" />
          </button>
          <div v-if="videoError" class="previewError fc c">
            <i-error-circle-filled size="28" />
            <span>{{ videoError }}</span>
          </div>
        </div>
        <div class="controlBar f ac">
          <t-tooltip :content="playing ? $t('workbench.videoLibrary.pause') : $t('workbench.videoLibrary.play')" placement="top">
            <button type="button" class="iconBtn c" @click="togglePlayback">
              <PauseIcon v-if="playing" size="18" />
              <PlayIcon v-else size="18" />
            </button>
          </t-tooltip>
          <span class="mediaTime">{{ formatDuration(currentTime) }} / {{ formatDuration(duration) }}</span>
          <input class="progress" type="range" min="0" :max="Math.max(duration, 0)" step="0.01" :value="currentTime" @input="seek" />
          <t-tooltip :content="muted ? $t('workbench.videoLibrary.unmute') : $t('workbench.videoLibrary.mute')" placement="top">
            <button type="button" class="iconBtn c" @click="toggleMute">
              <SoundMuteIcon v-if="muted" size="18" />
              <SoundIcon v-else size="18" />
            </button>
          </t-tooltip>
          <t-tooltip :content="$t('workbench.videoLibrary.fullscreen')" placement="top">
            <button type="button" class="iconBtn c" @click="requestFullscreen">
              <FullscreenIcon size="18" />
            </button>
          </t-tooltip>
        </div>
      </div>
    </t-dialog>
  </div>
</template>

<script setup lang="ts">
import axios from "@/utils/axios";
import projectStore from "@/stores/project";
import settingStore from "@/stores/setting";
import { resolveBackendAssetUrl } from "@/utils/backendUrl";
import { FullscreenIcon, PauseIcon, PlayIcon, SoundIcon, SoundMuteIcon } from "tdesign-icons-vue-next";

interface LibraryVideo {
  id: number;
  src: string;
  state: string;
  playable: boolean;
  duration: number;
  createTime: number;
  videoTrackId: number;
  trackIndex: number;
  errorReason: string;
}

interface LibraryEpisode {
  scriptId: number | null;
  episode: number | null;
  name: string;
  createTime: number;
  videos: LibraryVideo[];
}

const { project } = storeToRefs(projectStore());
const { baseUrl } = storeToRefs(settingStore());

const loading = ref(false);
const episodes = ref<LibraryEpisode[]>([]);
const totalVideos = computed(() => episodes.value.reduce((sum, episode) => sum + episode.videos.length, 0));

const previewVisible = ref(false);
const playerRef = ref<HTMLVideoElement | null>(null);
const previewUrl = ref("");
const previewHeader = ref("");
const previewVideoId = ref<number | null>(null);
// 签名链接有效期 15 分钟，播放失败时最多自动刷新一次列表换新链接。
let retriedExpiredLink = false;
const playing = ref(false);
const currentTime = ref(0);
const duration = ref(0);
const muted = ref(false);
const videoError = ref("");
const previewTitle = computed(() => previewHeader.value);

const episodeLabel = (episode: LibraryEpisode) =>
  episode.episode ? window.$t("workbench.videoLibrary.episode", { episode: episode.episode }) : window.$t("workbench.videoLibrary.otherEpisode");

function formatDuration(seconds: number) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

const thumbnailSrc = (video: LibraryVideo) => (video.src ? `${video.src}#t=0.1` : "");

function applyDuration(video: LibraryVideo, event: Event) {
  const player = event.target as HTMLVideoElement;
  if (Number.isFinite(player.duration) && player.duration > 0) video.duration = player.duration;
}

async function loadLibrary() {
  if (!project.value?.id) {
    episodes.value = [];
    return;
  }
  loading.value = true;
  try {
    const { data } = await axios.post("/production/workbench/getVideoLibrary", {
      projectId: Number(project.value.id),
    });
    const list: LibraryEpisode[] = Array.isArray(data?.episodes) ? data.episodes : [];
    // 只展示有成片的剧集，避免空白分组干扰浏览。
    episodes.value = list
      .filter((episode) => (episode.videos || []).length)
      .map((episode) => ({
        ...episode,
        videos: (episode.videos || []).map((video) => ({
          ...video,
          src: video.src ? resolveBackendAssetUrl(video.src, baseUrl.value) : "",
        })),
      }));
  } catch (caught: any) {
    window.$message.error(caught?.message || window.$t("workbench.videoLibrary.loadFailed"));
  } finally {
    loading.value = false;
  }
}

function openPreview(episode: LibraryEpisode, video: LibraryVideo) {
  if (!video.playable) {
    window.$message.error(video.errorReason || window.$t("workbench.videoLibrary.failed"));
    return;
  }
  previewUrl.value = video.src;
  previewVideoId.value = video.id;
  retriedExpiredLink = false;
  const label = episodeLabel(episode);
  const shot = video.trackIndex ? ` · ${window.$t("workbench.videoLibrary.shot", { index: video.trackIndex })}` : "";
  previewHeader.value = `${label}${shot}`;
  currentTime.value = 0;
  duration.value = video.duration || 0;
  videoError.value = "";
  playing.value = false;
  previewVisible.value = true;
}

function handlePreviewOpened() {
  const player = playerRef.value;
  if (!player) return;
  player.muted = false;
  player.load();
}

function handleMetadata() {
  const player = playerRef.value;
  if (!player) return;
  duration.value = Number.isFinite(player.duration) ? player.duration : 0;
  currentTime.value = player.currentTime || 0;
  videoError.value = "";
  syncVolumeState();
}

function handleTimeUpdate() {
  const player = playerRef.value;
  if (!player) return;
  currentTime.value = player.currentTime || 0;
}

async function handleVideoError() {
  playing.value = false;
  const videoId = previewVideoId.value;
  // 视频地址是带签名的临时链接，过期后会加载失败：自动刷新一次列表拿到新链接。
  if (!retriedExpiredLink && videoId) {
    retriedExpiredLink = true;
    await loadLibrary();
    const refreshed = episodes.value.flatMap((episode) => episode.videos).find((video) => video.id === videoId);
    if (refreshed?.playable && refreshed.src !== previewUrl.value) {
      previewUrl.value = refreshed.src;
      videoError.value = "";
      await nextTick();
      handlePreviewOpened();
      return;
    }
  }
  videoError.value = window.$t("workbench.videoLibrary.playFailed");
}

async function togglePlayback() {
  const player = playerRef.value;
  if (!player || videoError.value) return;
  if (!player.paused) {
    player.pause();
    return;
  }
  if (player.ended) {
    player.currentTime = 0;
    currentTime.value = 0;
  }
  player.muted = muted.value;
  try {
    await player.play();
  } catch {
    window.$message.warning(window.$t("workbench.videoLibrary.play"));
  }
}

function seek(event: Event) {
  const player = playerRef.value;
  if (!player) return;
  const value = Number((event.target as HTMLInputElement).value);
  if (!Number.isFinite(value)) return;
  player.currentTime = value;
  currentTime.value = value;
}

function toggleMute() {
  const player = playerRef.value;
  if (!player) return;
  if (player.muted || player.volume === 0) {
    if (player.volume === 0) player.volume = 0.8;
    player.muted = false;
  } else {
    player.muted = true;
  }
  syncVolumeState();
}

function syncVolumeState() {
  const player = playerRef.value;
  if (!player) return;
  muted.value = player.muted || player.volume === 0;
}

async function requestFullscreen() {
  const player = playerRef.value as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
  try {
    if (player?.requestFullscreen) {
      await player.requestFullscreen();
    } else {
      player?.webkitEnterFullscreen?.();
    }
  } catch {
    window.$message.warning(window.$t("workbench.videoLibrary.playFailed"));
  }
}

function closePreview() {
  playerRef.value?.pause();
  playing.value = false;
  previewVisible.value = false;
}

onMounted(loadLibrary);
watch(() => project.value?.id, loadLibrary);
onUnmounted(() => playerRef.value?.pause());
</script>

<style lang="scss" scoped>
.videoLibrary {
  height: 100%;
  display: flex;
  flex-direction: column;
  .header {
    padding-top: 32px;
    margin-bottom: 24px;
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
  }
  .content {
    flex: 1;
    overflow-y: auto;
    padding-bottom: 32px;
  }
  .placeholder {
    gap: 10px;
    padding: 120px 0;
    opacity: 0.5;
    span {
      font-size: 14px;
    }
    .tip {
      font-size: 12px;
      opacity: 0.8;
    }
  }
  .episodeList {
    .episodeCard {
      background-color: #f8f9fb;
      border-radius: 16px;
      padding: 16px;
      margin-bottom: 20px;
      .episodeHeader {
        margin-bottom: 12px;
        .episodeBadge {
          background-color: #2563eb;
          color: #fff;
          font-size: 13px;
          font-weight: 600;
          padding: 3px 12px;
          border-radius: 999px;
        }
        .episodeName {
          margin-left: 10px;
          font-size: 14px;
          font-weight: 600;
          color: #333;
        }
        .episodeCount {
          margin-left: auto;
          font-size: 12px;
          opacity: 0.45;
        }
      }
      .videoGrid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
        gap: 12px;
      }
    }
  }
  .videoCard {
    position: relative;
    aspect-ratio: 16 / 9;
    border-radius: 12px;
    overflow: hidden;
    background-color: #0f172a;
    cursor: pointer;
    transition:
      transform 0.15s ease,
      box-shadow 0.15s ease;
    video {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    &:hover {
      transform: translateY(-2px);
      box-shadow: 0 10px 22px rgba(15, 23, 42, 0.18);
      .cardMask {
        opacity: 1;
      }
    }
    &.disabled {
      cursor: not-allowed;
      &:hover {
        transform: none;
        box-shadow: none;
      }
    }
    .cardMask {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
      background-color: rgba(15, 23, 42, 0.32);
      opacity: 0;
      transition: opacity 0.15s ease;
    }
    .cardState {
      position: absolute;
      inset: 0;
      gap: 6px;
      color: #d6dff0;
      font-size: 12px;
      background-color: rgba(15, 23, 42, 0.85);
      &.failed {
        color: #fca5a5;
      }
    }
    .episodeTag {
      position: absolute;
      top: 8px;
      left: 8px;
      background-color: rgba(37, 99, 235, 0.92);
      color: #fff;
      font-size: 12px;
      padding: 2px 8px;
      border-radius: 8px;
    }
    .cardMeta {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      padding: 18px 8px 6px;
      background: linear-gradient(transparent, rgba(15, 23, 42, 0.78));
      color: #fff;
      font-size: 12px;
      pointer-events: none;
    }
  }
  .previewDialog {
    .previewStage {
      position: relative;
      background-color: #000;
      border-radius: 12px;
      overflow: hidden;
      video {
        width: 100%;
        max-height: 66vh;
        display: block;
      }
      .centerPlay {
        position: absolute;
        inset: 0;
        margin: auto;
        width: 72px;
        height: 72px;
        border: none;
        border-radius: 50%;
        background-color: rgba(15, 23, 42, 0.55);
        color: #fff;
        cursor: pointer;
      }
      .previewError {
        position: absolute;
        inset: 0;
        gap: 8px;
        color: #fca5a5;
        font-size: 13px;
        background-color: rgba(15, 23, 42, 0.9);
      }
    }
    .controlBar {
      margin-top: 12px;
      gap: 10px;
      .iconBtn {
        border: none;
        background-color: transparent;
        width: 32px;
        height: 32px;
        border-radius: 8px;
        cursor: pointer;
        color: #333;
        &:hover {
          background-color: #ecedef;
        }
      }
      .mediaTime {
        font-size: 12px;
        color: #666;
        min-width: 96px;
        text-align: center;
      }
      .progress {
        flex: 1;
        accent-color: #2563eb;
        cursor: pointer;
      }
    }
  }
}
</style>
