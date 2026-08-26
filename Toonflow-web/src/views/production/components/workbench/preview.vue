<template>
  <div class="shotWorkspace">
    <section class="shotListPanel">
      <div class="panelHeader">
        <div>
          <h2>分镜列表</h2>
          <span class="panelHint">选择分镜查看对应的完整分镜表内容</span>
        </div>
        <div class="panelActions">
          <t-checkbox v-model="selectAll" @change="handleSelectAll">全选</t-checkbox>
          <t-button theme="default" variant="text" size="small" @click="confirmRestoreSort">
            <template #icon><i-undo theme="outline" size="16" /></template>
            恢复排序
          </t-button>
          <t-button theme="default" variant="text" size="small" @click="exportImage">
            <template #icon><i-download theme="outline" size="16" /></template>
            导出
          </t-button>
        </div>
      </div>

      <div v-if="shotList.length" ref="shotListWrapperRef" class="shotListWrapper">
        <VueDraggable
          v-model="shotList"
          :animation="150"
          ghost-class="shotGhost"
          drag-class="shotDrag"
          :scroll="shotListWrapperRef"
          :scroll-sensitivity="80"
          :scroll-speed="10"
          :force-fallback="true"
          @start="isDragging = true"
          @end="onDragEnd">
          <TransitionGroup type="transition" tag="div" :name="!isDragging ? 'shot-flip' : undefined" class="shotList">
            <article
              v-for="(shot, index) in shotList"
              :key="shot.id"
              class="shotRow"
              :class="{ active: currentShotIndex === index }"
              @click="selectShot(index)">
              <t-checkbox v-model="shot.selected" class="shotCheckbox" @click.stop />
              <div class="shotRowIndex">{{ shot.shotNumber ?? index + 1 }}</div>
              <div class="shotRowBody">
                <div class="shotRowTitle">{{ getShotTitle(shot, index) }}</div>
                <div class="shotRowMeta">
                  <t-tag v-if="shot.duration != null" size="small" variant="outline">{{ shot.duration }} 秒</t-tag>
                  <t-tag v-if="shot.scale" size="small" variant="light">{{ shot.scale }}</t-tag>
                  <t-tag v-if="shot.cameraMovement" size="small" variant="light">{{ shot.cameraMovement }}</t-tag>
                  <t-tag v-if="shot.state" size="small" :theme="stateTheme(shot.state)">{{ shot.state }}</t-tag>
                </div>
                <div v-if="shot.content || shot.description || shot.videoDesc" class="shotRowSummary">
                  {{ shot.content || shot.description || shot.videoDesc }}
                </div>
              </div>
            </article>
          </TransitionGroup>
        </VueDraggable>
      </div>
      <t-empty v-else class="emptyShots" description="暂无分镜数据" />
    </section>

    <section v-if="currentShot" class="shotDetailPanel">
      <div class="detailHeader">
        <div>
          <span class="detailKicker">分镜 {{ currentShot.shotNumber ?? currentShotIndex + 1 }}</span>
          <h2>{{ getShotTitle(currentShot, currentShotIndex) }}</h2>
        </div>
        <t-tag v-if="currentShot.state" :theme="stateTheme(currentShot.state)">{{ currentShot.state }}</t-tag>
      </div>

      <div class="detailStoryboard" v-if="currentShot.storyboard?.src">
        <img :src="currentShot.storyboard.src" alt="分镜图" />
        <div>
          <span>分镜预览图</span>
          <strong>{{ currentShot.excludesStoryboard ? "仅用于核对，不提交给视频模型" : "将作为视频参考" }}</strong>
        </div>
      </div>

      <div class="detailMeta">
        <div class="metaItem"><span>时长</span><strong>{{ currentShot.duration ?? "—" }}{{ currentShot.duration != null ? " 秒" : "" }}</strong></div>
        <div class="metaItem"><span>景别</span><strong>{{ currentShot.scale || "—" }}</strong></div>
        <div class="metaItem"><span>运镜</span><strong>{{ currentShot.cameraMovement || "—" }}</strong></div>
        <div class="metaItem"><span>轨道</span><strong>{{ currentShot.track || currentShot.trackId || "—" }}</strong></div>
      </div>

      <div class="detailScroll">
        <div class="modelReadyBar">
          <div><span>视频模型</span><strong>{{ projectConfig.modelName || "未配置" }}</strong></div>
          <div><span>画面规格</span><strong>{{ preferredResolution }} · {{ currentShot.duration || "—" }}s</strong></div>
          <div><span>提交状态</span><strong>{{ currentShot.readiness?.ready ? "参数已就绪" : "待补充" }}</strong></div>
        </div>
        <div v-if="currentShot.segmentRows?.length" class="shotBreakdown">
          <div class="shotBreakdownTitle">片段内镜头</div>
          <div class="shotBreakdownRow" v-for="row in currentShot.segmentRows" :key="row.serial">
            <span>{{ row.serial }}</span>
            <span>{{ row.description }}</span>
            <span>{{ row.duration }}s</span>
            <span>{{ row.scale || "—" }} / {{ row.cameraMovement || "—" }}</span>
          </div>
        </div>
        <div v-if="currentShot.referenceAssets?.length" class="referenceSection">
          <div class="detailLabel">自动对应的参考资产（{{ currentShot.referenceAssets.length }}）</div>
          <div class="referenceGrid">
            <div v-for="asset in currentShot.referenceAssets" :key="asset.id" class="referenceItem" :class="{ missing: !asset.src }">
              <img v-if="asset.src" :src="asset.src" :alt="asset.name" />
              <div v-else class="referenceMissing">无图</div>
              <span>{{ asset.name }}</span>
              <small>{{ assetTypeLabel(asset.type) }}</small>
            </div>
          </div>
        </div>
        <DetailSection label="画面描述" :value="currentShot.content || currentShot.description || currentShot.videoDesc" />
        <DetailSection label="叙事目的" :value="currentShot.narrativePurpose" />
        <DetailSection label="台词" :value="currentShot.dialogue" />
        <DetailSection label="音效" :value="currentShot.sound" />
        <DetailSection label="图片提示词" :value="currentShot.imagePrompt" />
        <DetailSection label="片段视频描述" :value="currentShot.videoDesc" />
        <DetailSection label="提交给模型的视频提示词" :value="currentShot.videoPrompt || currentShot.prompt" />
        <DetailSection label="参考资产" :value="formatAssetNames(currentShot)" />
        <DetailSection v-if="currentShot.readiness?.messages?.length" label="参数检查" :value="currentShot.readiness.messages.join('；')" tone="danger" />
        <DetailSection v-if="currentShot.reason" label="失败原因" :value="currentShot.reason" tone="danger" />
      </div>
    </section>
    <t-empty v-else class="detailEmpty" description="选择左侧分镜查看详细内容" />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch, type Ref } from "vue";
import { VueDraggable } from "vue-draggable-plus";
import { DialogPlugin } from "tdesign-vue-next";
import axios from "@/utils/axios";
import projectStore from "@/stores/project";
import settingStore from "@/stores/setting";
import { resolveBackendAssetUrl } from "@/utils/backendUrl";

interface Shot {
  id: string | number;
  shotNumber?: number | string;
  title?: string;
  content?: string;
  description?: string;
  duration?: number;
  filePath?: string;
  prompt?: string;
  imagePrompt?: string;
  videoPrompt?: string;
  videoDesc?: string;
  narrativePurpose?: string;
  dialogue?: string;
  sound?: string;
  scale?: string;
  cameraMovement?: string;
  track?: string;
  trackId?: number;
  associateAssetsIds?: Array<number | string>;
  characters?: Array<{ name?: string; type?: string; avatar?: string }>;
  state?: string;
  reason?: string;
  selected?: boolean;
  excludesStoryboard?: boolean;
  storyboard?: { src?: string; state?: string };
  referenceAssets?: Array<{ id: number; name: string; type: string; src?: string }>;
  readiness?: { ready: boolean; messages: string[]; referenceCount?: number };
  segmentRows?: Array<{ serial: string; description: string; duration: number; scale: string; cameraMovement: string; dialogue: string; sound: string }>;
}

const episodesId = inject<Ref<number>>("episodesId");
const { project } = storeToRefs(projectStore());
const { baseUrl } = storeToRefs(settingStore());
const shotList = ref<Shot[]>([]);
const currentShotIndex = ref(0);
const selectAll = ref(false);
const isDragging = ref(false);
const shotListWrapperRef = ref<HTMLElement>();
const initialOrder = ref<Array<string | number>>([]);
const projectConfig = ref<Record<string, any>>({});

const currentShot = computed(() => shotList.value[currentShotIndex.value] || null);
const preferredResolution = computed(() => projectConfig.value.durationResolutionMap?.[0]?.resolution?.[0] || projectConfig.value.videoRatio || "—");

watch(
  [() => project.value?.id, () => episodesId?.value],
  ([projectId, episodeId]) => {
    if (projectId && episodeId) getShotList();
  },
  { immediate: true },
);

async function getShotList() {
  try {
    const { data } = await axios.post("/production/workbench/getGenerateData", {
      scriptId: episodesId?.value,
      projectId: project.value?.id != null ? Number(project.value.id) : undefined,
    });
    projectConfig.value = data?.projectConfig || {};
    const rows = Array.isArray(data?.trackList) ? data.trackList : [];
    shotList.value = rows.map((item: any, index: number) => ({
      id: item.id ?? index,
      shotNumber: item.shotNumber ?? index + 1,
      title: item.title || item.segmentTitle || `片段 ${index + 1}`,
      content: item.summary || item.videoDesc || "",
      duration: item.duration,
      imagePrompt: item.imagePrompt || "",
      videoDesc: item.videoDesc || "",
      videoPrompt: item.prompt || "",
      dialogue: item.dialogue || "",
      sound: item.sound || "",
      state: item.state ?? item.status ?? "未生成",
      reason: item.reason || "",
      trackId: item.id,
      segmentRows: item.segmentRows || [],
      storyboard: item.storyboard
        ? {
            ...item.storyboard,
            src: item.storyboard.src
              ? resolveBackendAssetUrl(item.storyboard.src, baseUrl.value)
              : "",
          }
        : undefined,
      referenceAssets: (item.referenceAssets || []).map((asset: any) => ({
        ...asset,
        src: asset.src ? resolveBackendAssetUrl(asset.src, baseUrl.value) : "",
      })),
      associateAssetsIds: (item.referenceAssets || []).map((asset: any) => asset.id),
      excludesStoryboard: item.excludesStoryboard,
      readiness: item.readiness,
      selected: false,
    }));
    initialOrder.value = shotList.value.map((shot) => shot.id);
    currentShotIndex.value = 0;
  } catch (error) {
    console.error("加载分镜列表失败:", error);
    shotList.value = [];
  }
}

function getShotTitle(shot: Shot, index: number) {
  return shot.title || `第 ${shot.shotNumber ?? index + 1} 镜`;
}

function stateTheme(state?: string) {
  if (state === "已完成") return "success";
  if (state === "生成中") return "warning";
  if (state === "生成失败") return "danger";
  return "default";
}

function formatAssets(ids?: Array<number | string>) {
  return ids?.length ? ids.map((id) => `#${id}`).join("、") : "暂无绑定参考资产";
}

function formatAssetNames(shot: Shot) {
  if (shot.referenceAssets?.length) return shot.referenceAssets.map((item) => `${item.name}（${assetTypeLabel(item.type)}）`).join("、");
  if (shot.associateAssetsIds?.length) return formatAssets(shot.associateAssetsIds);
  if (shot.characters?.length) {
    return shot.characters.map((item) => item.name || item.type).filter(Boolean).join("、");
  }
  return "暂无绑定参考资产";
}

function assetTypeLabel(type?: string) {
  if (type === "role") return "角色";
  if (type === "scene") return "场景";
  if (type === "tool") return "道具";
  return "资产";
}

function selectShot(index: number) {
  currentShotIndex.value = index;
  nextTick(() => {
    const item = shotListWrapperRef.value?.querySelectorAll(".shotRow")?.[index] as HTMLElement | undefined;
    item?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  });
}

function handleSelectAll(checked: boolean | string[]) {
  const value = Array.isArray(checked) ? checked.length > 0 : checked;
  shotList.value.forEach((shot) => (shot.selected = value));
}

watch(
  () => shotList.value.map((shot) => shot.selected),
  (values) => {
    selectAll.value = values.length > 0 && values.every(Boolean);
  },
  { deep: true },
);

function confirmRestoreSort() {
  const dialog = DialogPlugin.confirm({
    header: "恢复排序",
    body: "确定恢复分镜表原始顺序吗？",
    onConfirm: () => {
      shotList.value.sort((a, b) => initialOrder.value.indexOf(a.id) - initialOrder.value.indexOf(b.id));
      currentShotIndex.value = 0;
      dialog.destroy();
    },
    onClose: () => dialog.destroy(),
  });
}

function onDragEnd() {
  isDragging.value = false;
  const activeId = currentShot.value?.id;
  if (activeId != null) {
    const nextIndex = shotList.value.findIndex((shot) => shot.id === activeId);
    if (nextIndex >= 0) currentShotIndex.value = nextIndex;
  }
}

function drawWrappedText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth: number, lineHeight: number, maxLines: number) {
  const chars = Array.from(text);
  let line = "";
  let lineCount = 0;
  for (const char of chars) {
    const next = line + char;
    if (ctx.measureText(next).width <= maxWidth) {
      line = next;
      continue;
    }
    ctx.fillText(line, x, y + lineCount * lineHeight);
    lineCount += 1;
    if (lineCount >= maxLines) return;
    line = char;
  }
  if (line && lineCount < maxLines) ctx.fillText(line, x, y + lineCount * lineHeight);
}

async function exportImage() {
  const selectedShots = shotList.value.filter((shot) => shot.selected);
  if (!selectedShots.length) {
    DialogPlugin.alert({ header: "提示", body: "请至少选择一个分镜" });
    return;
  }
  try {
    const width = 1600;
    const headerHeight = 120;
    const cardHeight = 330;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = headerHeight + selectedShots.length * cardHeight + 40;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("浏览器不支持图片导出");

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#111111";
    ctx.font = "700 42px sans-serif";
    ctx.fillText(`${project.value?.name || "项目"} · 分镜清单`, 48, 66);
    ctx.fillStyle = "#777777";
    ctx.font = "22px sans-serif";
    ctx.fillText(`共 ${selectedShots.length} 个片段`, 48, 100);

    selectedShots.forEach((shot, index) => {
      const top = headerHeight + index * cardHeight;
      ctx.fillStyle = index % 2 === 0 ? "#f6f6f6" : "#ffffff";
      ctx.fillRect(32, top, width - 64, cardHeight - 16);
      ctx.fillStyle = "#111111";
      ctx.font = "700 28px sans-serif";
      ctx.fillText(`#${shot.shotNumber ?? index + 1}  ${getShotTitle(shot, index)}`, 64, top + 52);
      ctx.fillStyle = "#555555";
      ctx.font = "22px sans-serif";
      ctx.fillText(`时长 ${shot.duration ?? "—"}s  ·  状态 ${shot.state || "未生成"}`, 64, top + 92);
      ctx.fillStyle = "#222222";
      ctx.font = "24px sans-serif";
      drawWrappedText(ctx, shot.content || shot.description || shot.videoDesc || "暂无画面描述", 64, top + 142, width - 128, 36, 4);
      ctx.fillStyle = "#666666";
      ctx.font = "20px sans-serif";
      drawWrappedText(ctx, `参考资产：${formatAssetNames(shot)}`, 64, top + 292, width - 128, 28, 1);
    });

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((value) => value ? resolve(value) : reject(new Error("图片生成失败")), "image/png");
    });
    const url = URL.createObjectURL(blob);
    try {
      const link = document.createElement("a");
      link.href = url;
      link.download = `storyboard-${Date.now()}.png`;
      link.click();
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch (error) {
    console.error("导出分镜失败:", error);
    window.$message.error((error as Error).message || "导出分镜失败");
  }
}
</script>

<script lang="ts">
import { defineComponent, h } from "vue";

export default defineComponent({
  components: {
    DetailSection: defineComponent({
      props: {
        label: { type: String, required: true },
        value: { type: String, default: "" },
        tone: { type: String, default: "" },
      },
      setup(props) {
        return () =>
          h("div", { class: ["detailSection", props.tone ? `tone-${props.tone}` : ""] }, [
            h("div", { class: "detailLabel" }, props.label),
            h("div", { class: "detailValue" }, props.value || "暂无内容"),
          ]);
      },
    }),
  },
});
</script>

<style lang="scss" scoped>
.shotWorkspace {
  display: grid;
  grid-template-columns: minmax(360px, 0.9fr) minmax(480px, 1.5fr);
  gap: 18px;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.shotListPanel,
.shotDetailPanel,
.detailEmpty {
  min-height: 0;
  border: 1px solid #e7e7e7;
  border-radius: 12px;
  background: #fff;
}

.shotListPanel {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.panelHeader,
.detailHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 18px 20px;
  border-bottom: 1px solid #eeeeee;
}

h2 {
  margin: 0;
  color: #202020;
  font-size: 18px;
}

.panelHint,
.detailKicker {
  display: block;
  margin-top: 5px;
  color: #8a8a8a;
  font-size: 12px;
}

.panelActions {
  display: flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}

.shotListWrapper {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
}

.shotList {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.shotRow {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px;
  border: 1px solid #ececec;
  border-radius: 9px;
  background: #fff;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;

  &:hover,
  &.active {
    border-color: var(--td-brand-color-10-10);
    background: var(--td-brand-color-1);
  }
}

.shotCheckbox {
  flex: 0 0 auto;
  margin-top: 2px;
}

.shotRowIndex {
  flex: 0 0 28px;
  color: var(--td-brand-color-10-10);
  font-size: 13px;
  font-weight: 700;
  line-height: 24px;
  text-align: center;
  border-radius: 5px;
  background: var(--td-brand-color-1);
}

.shotRowBody {
  min-width: 0;
  flex: 1;
}

.shotRowTitle {
  color: #292929;
  font-size: 14px;
  line-height: 1.5;
  font-weight: 600;
}

.shotRowMeta {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 6px;
}

.shotRowSummary {
  display: -webkit-box;
  margin-top: 7px;
  overflow: hidden;
  color: #777;
  font-size: 12px;
  line-height: 1.5;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.emptyShots,
.detailEmpty {
  display: flex;
  align-items: center;
  justify-content: center;
}

.shotDetailPanel {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.detailHeader h2 {
  margin-top: 5px;
}

.detailStoryboard {
  display: grid;
  grid-template-columns: 180px minmax(0, 1fr);
  gap: 14px;
  align-items: center;
  padding: 14px 20px;
  border-bottom: 1px solid #eeeeee;

  img {
    width: 180px;
    aspect-ratio: 16 / 9;
    object-fit: cover;
    border-radius: 5px;
    background: #f3f3f3;
  }

  span,
  strong {
    display: block;
  }

  span {
    color: #888;
    font-size: 12px;
  }

  strong {
    margin-top: 6px;
    color: #333;
    font-size: 13px;
    line-height: 1.5;
  }
}

.detailMeta {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  padding: 16px 20px;
  border-bottom: 1px solid #eeeeee;
  background: #fafafa;
}

.metaItem {
  min-width: 0;

  span,
  strong {
    display: block;
  }

  span {
    color: #999;
    font-size: 12px;
  }

  strong {
    margin-top: 5px;
    overflow: hidden;
    color: #333;
    font-size: 13px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.detailScroll {
  flex: 1;
  overflow-y: auto;
  padding: 18px 20px;
}

.modelReadyBar {
  display: grid;
  grid-template-columns: 1.4fr 1fr 0.8fr;
  gap: 8px;
  margin-bottom: 16px;

  div {
    min-width: 0;
    padding: 10px;
    border: 1px solid #e9e9e9;
    border-radius: 6px;
    background: #fafafa;
  }

  span,
  strong {
    display: block;
  }

  span {
    color: #999;
    font-size: 11px;
  }

  strong {
    margin-top: 4px;
    overflow: hidden;
    color: #333;
    font-size: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.shotBreakdown {
  margin-bottom: 16px;
  overflow: hidden;
  border: 1px solid #e8e8e8;
  border-radius: 6px;
}

.shotBreakdownTitle {
  padding: 9px 10px;
  color: #555;
  font-size: 12px;
  font-weight: 600;
  background: #fafafa;
}

.shotBreakdownRow {
  display: grid;
  grid-template-columns: 42px minmax(180px, 1fr) 48px minmax(110px, 0.35fr);
  border-top: 1px solid #eeeeee;

  span {
    padding: 8px;
    color: #666;
    font-size: 11px;
    line-height: 1.5;
  }
}

.referenceSection {
  margin-bottom: 18px;
}

.referenceGrid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(92px, 1fr));
  gap: 8px;
}

.referenceItem {
  min-width: 0;
  overflow: hidden;
  border: 1px solid #e8e8e8;
  border-radius: 5px;
  background: #fff;

  img,
  .referenceMissing {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    aspect-ratio: 16 / 10;
    object-fit: cover;
    color: #aaa;
    font-size: 11px;
    background: #f4f4f4;
  }

  span,
  small {
    display: block;
    padding: 0 7px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  span {
    margin-top: 6px;
    color: #333;
    font-size: 11px;
  }

  small {
    padding-bottom: 6px;
    color: #999;
    font-size: 10px;
  }

  &.missing {
    border-color: var(--td-warning-color-4);
  }
}

.detailSection {
  padding: 0 0 16px;
  margin-bottom: 16px;
  border-bottom: 1px solid #f0f0f0;

  &:last-child {
    margin-bottom: 0;
    border-bottom: 0;
  }
}

.detailLabel {
  margin-bottom: 7px;
  color: #555;
  font-size: 13px;
  font-weight: 600;
}

.detailValue {
  white-space: pre-wrap;
  word-break: break-word;
  color: #666;
  font-size: 13px;
  line-height: 1.7;
}

.tone-danger .detailLabel,
.tone-danger .detailValue {
  color: var(--td-error-color-6);
}

@media (max-width: 900px) {
  .shotWorkspace {
    grid-template-columns: 1fr;
    height: auto;
  }

  .shotListPanel {
    min-height: 360px;
  }

  .shotDetailPanel,
  .detailEmpty {
    min-height: 480px;
  }
}
</style>

<style lang="scss">
.shotGhost {
  opacity: 0.55;
  border: 2px dashed var(--td-brand-color-10-10) !important;
}

.shotDrag {
  opacity: 0.9;
  box-shadow: 0 4px 12px rgba(102, 126, 234, 0.25);
}

.shot-flip-move {
  transition: transform 0.35s ease;
}
</style>
