<template>
  <div class="cornerScape f">
    <div class="left">
      <t-card shadow :title="$t('workbench.cornerScape.batchSettings')" class="card">
        <t-form labelAlign="top">
          <t-form-item :label="$t('workbench.cornerScape.quickActions')">
            <div class="quickActions">
              <t-button theme="primary" variant="outline" @click="selectByState('')">{{ $t("workbench.cornerScape.selectUngenerated") }}</t-button>
              <t-button theme="primary" variant="outline" @click="selectByState('已完成')">
                {{ $t("workbench.cornerScape.selectGenerated") }}
              </t-button>
              <t-button theme="primary" variant="outline" @click="selectByState('生成失败')">{{ $t("workbench.cornerScape.selectFailed") }}</t-button>
              <t-button theme="primary" variant="outline" @click="toggleSelectAll">{{ $t("workbench.cornerScape.invertSelection") }}</t-button>
              <t-button theme="primary" variant="outline" @click="clearSelection">{{ $t("workbench.cornerScape.clearSelection") }}</t-button>
              <t-image-viewer :images="previewImages" :closeOnEscKeydown="true" :closeOnOverlay="true">
                <template #trigger="{ open }">
                  <t-button theme="primary" variant="outline" :disabled="!hasPreviewImages" @click="hasPreviewImages && open()">
                    {{ $t("workbench.cornerScape.batchPreview") }}
                  </t-button>
                </template>
              </t-image-viewer>
            </div>
          </t-form-item>
          <t-form-item :label="$t('workbench.cornerScape.assetTypeFilter')">
            <t-checkbox-group @change="onChangeFn" v-model="checkboxValue" :options="translatedOptions" class="filterGroup" />
          </t-form-item>
          <t-form-item :label="$t('workbench.cornerScape.genModel')">
            <modelSelect v-model="selectValue" :type="`image`" />
          </t-form-item>
          <t-form-item :label="$t('workbench.cornerScape.resolution')">
            <t-select
              v-model="resolution"
              :placeholder="$t('workbench.cornerScape.resolutionPh')"
              :options="[
                { label: '1K', value: '1K' },
                { label: '2K', value: '2K' },
                { label: '4K', value: '4K' },
              ]"></t-select>
          </t-form-item>
          <t-form-item label="项目风格">
            <div class="styleControl">
              <t-popup v-model="stylePickerVisible" trigger="click" placement="bottom-left" :overlay-inner-style="{ padding: '0' }">
                <button type="button" class="styleTrigger" :disabled="artStyleLoading">
                  <img v-if="selectedArtStyleCover" :src="selectedArtStyleCover" alt="" @error="onArtStyleImageError" />
                  <span v-else class="styleTriggerPlaceholder"><t-icon name="image" /></span>
                  <span class="styleTriggerText">
                    <strong>{{ selectedArtStyleItem?.name || selectedArtStyle || "选择项目风格" }}</strong>
                    <small>{{ selectedArtStyleItem?.summary || "从风格库中选择" }}</small>
                  </span>
                  <t-icon name="chevron-down" />
                </button>
                <template #content>
                  <div class="stylePickerPanel" @click.stop>
                    <div class="stylePickerToolbar">
                      <t-input v-model="styleSearch" clearable placeholder="搜索名称、路径或提示词">
                        <template #prefix-icon><t-icon name="search" /></template>
                      </t-input>
                      <t-radio-group v-model="styleFilter" variant="default-filled" size="small">
                        <t-radio-button value="all">全部</t-radio-button>
                        <t-radio-button value="favorite">收藏</t-radio-button>
                        <t-radio-button value="recent">最近</t-radio-button>
                      </t-radio-group>
                    </div>
                    <div class="styleGrid">
                      <button
                        v-for="item in filteredArtStyles"
                        :key="item.stylePath"
                        type="button"
                        class="styleCard"
                        :class="{ active: selectedArtStyle === item.stylePath }"
                        @click="selectArtStyle(item)">
                        <span class="styleCover">
                          <img v-if="getArtStyleCover(item)" :src="getArtStyleCover(item)" :alt="item.name" loading="lazy" @error="onArtStyleImageError" />
                          <t-icon v-else name="image" size="24px" />
                          <span
                            class="favoriteButton"
                            :class="{ active: favoriteArtStyles.includes(item.stylePath) }"
                            title="收藏风格"
                            @click.stop="toggleFavoriteArtStyle(item.stylePath)">
                            <t-icon :name="favoriteArtStyles.includes(item.stylePath) ? 'star-filled' : 'star'" />
                          </span>
                        </span>
                        <strong>{{ item.name }}</strong>
                        <small>{{ item.summary }}</small>
                      </button>
                      <t-empty v-if="filteredArtStyles.length === 0" title="没有匹配的风格" />
                    </div>
                  </div>
                </template>
              </t-popup>
              <t-button
                theme="primary"
                variant="outline"
                shape="square"
                :loading="artStyleSaving"
                :disabled="!artStyleDirty"
                title="保存项目风格"
                @click="saveArtStyle">
                <template #icon><t-icon name="save" /></template>
              </t-button>
            </div>
          </t-form-item>
          <!-- <t-form-item :label="$t('workbench.cornerScape.concurrency')">
            <t-input-number
              v-model="concurrentCount"
              :min="1"
              :allowInputOverLimit="false"
              autoWidth
              :placeholder="$t('workbench.cornerScape.concurrencyPh')"></t-input-number>
          </t-form-item> -->
          <t-form-item>
            <t-button theme="primary" block @click="batchGenerationPrompt">{{ $t("workbench.cornerScape.batchGenerationPrompt") }}</t-button>
            <t-button theme="primary" block @click="batchGenerationImage" style="margin-left: 10px">
              {{ $t("workbench.cornerScape.startBatch") }}
            </t-button>
          </t-form-item>
        </t-form>
      </t-card>
    </div>
    <div class="content">
      <t-card v-show="dataList.length > 0" shadow class="card" v-for="item in dataList" :key="item.id" @click="openDrawer(item)">
        <div class="imageBox">
          <t-checkbox class="selectBox" :checked="selectedIds.includes(item.id)" @click.stop @change="toggleSelect(item.id)" />
          <t-empty v-if="!item.state && item.promptState !== '生成中'" type="maintenance" :title="$t('workbench.cornerScape.waitingGen')" />
          <div v-else-if="item.state === '生成中' || item.promptState === '生成中'" class="generatingBox">
            <t-loading />
            <span class="generatingText">
              {{ item.promptState === "生成中" ? $t("workbench.cornerScape.generatingPrompt") : $t("workbench.cornerScape.generating") }}
            </span>
          </div>
          <t-popup :content="item.errorReason" v-else-if="item.state === '生成失败'">
            <t-empty type="fail" :title="$t('workbench.cornerScape.genFailed')" />
          </t-popup>
          <t-image
            v-else
            :key="item.filePath || item.id"
            class="image"
            :src="item.filePath ?? undefined"
            fit="contain"
            :preview="true"
            :lazy="true"
            @load="markAssetImageLoaded(item.id)"
            @error="refreshAssetImageUrl(item)">
            <template #error>
              <t-empty type="fail" :title="$t('workbench.cornerScape.imageError')" />
            </template>
            <template #overlayContent>
              <div class="imageToolsWrap">
                <ImageTools :src="item.filePath!" position="br" />
              </div>
            </template>
          </t-image>
        </div>
        <div class="infoBox">
          <div class="title">{{ item.name }}</div>
          <div class="meta">
            <t-tag size="small" variant="light-outline" theme="warning" class="typeTag">
              {{
                item.type === "role"
                  ? $t("workbench.cornerScape.typeRole")
                  : item.type === "scene"
                    ? $t("workbench.cornerScape.typeScene")
                    : item.type === "tool"
                      ? $t("workbench.cornerScape.typeTool")
                      : $t("workbench.cornerScape.typeUnknown")
              }}
            </t-tag>
            <t-tag size="small" variant="outline" class="stateTag" v-if="item.model">
              {{ item.model }}
            </t-tag>
            <t-tag size="small" variant="outline" v-if="item.resolution">
              {{ item.resolution }}
            </t-tag>
          </div>
          <div class="prompt" v-if="item.describe">
            {{
              item.type === "role"
                ? $t("workbench.cornerScape.typeRole")
                : item.type === "scene"
                  ? $t("workbench.cornerScape.typeScene")
                  : item.type === "tool"
                    ? $t("workbench.cornerScape.typeTool")
                    : $t("workbench.cornerScape.typeUnknown")
            }}{{ $t("workbench.cornerScape.descriptionSuffix") }}{{ item.describe }}
          </div>
        </div>
      </t-card>
      <t-empty v-if="dataList.length === 0" type="empty" :title="$t('workbench.cornerScape.operateScriptFirst')" />
      <t-drawer :closeBtn="true" closeOnEscKeydown :showOverlay="false" :footer="false" v-model:visible="drawerVisible" size="480px">
        <template #header>
          <div class="drawerHeader">
            <span>{{ currentItem?.name }} - {{ $t("workbench.cornerScape.individualConfig") }}</span>
            <t-tag size="medium" variant="light-outline" theme="warning">
              {{
                currentItem?.type === "role"
                  ? $t("workbench.cornerScape.typeRole")
                  : currentItem?.type === "scene"
                    ? $t("workbench.cornerScape.typeScene")
                    : currentItem?.type === "tool"
                      ? $t("workbench.cornerScape.typeTool")
                      : $t("workbench.cornerScape.typeUnknown")
              }}
            </t-tag>
          </div>
        </template>
        <div v-if="currentItem" class="drawerImageBox">
          <t-image-viewer
            v-if="drawerPreviewImage && (selectedHistoryId || currentItem.state !== '生成中')"
            :images="[drawerPreviewImage]"
            :closeOnEscKeydown="true"
            :closeOnOverlay="true"
            :showOverlay="true">
            <template #trigger="{ open }">
              <div class="drawerPreviewTrigger" @click="open">
                <t-image
                  :key="drawerPreviewImage"
                  class="image"
                  :src="drawerPreviewImage"
                  fit="contain"
                  :preview="false"
                  @load="markAssetImageLoaded(currentItem.id)"
                  @error="refreshAssetImageUrl(currentItem)">
                  <template #error>
                    <t-empty type="fail" :title="$t('workbench.cornerScape.imageError')" />
                  </template>
                  <template #overlayContent>
                    <div class="imageToolsWrap show">
                      <ImageTools :src="drawerPreviewImage" position="br" />
                    </div>
                  </template>
                </t-image>
              </div>
            </template>
          </t-image-viewer>
          <t-empty v-else-if="!currentItem.state" type="maintenance" :title="$t('workbench.cornerScape.waitingGen')" />
          <div v-else-if="currentItem.state === '生成中'" class="generatingBox">
            <t-loading />
            <span class="generatingText">{{ $t("workbench.cornerScape.generating") }}</span>
          </div>
          <t-empty v-else-if="currentItem.state === '生成失败'" type="fail" :title="$t('workbench.cornerScape.genFailed')" />
          <t-empty v-else type="maintenance" :title="$t('workbench.cornerScape.noImage')" />
        </div>
        <t-form v-if="currentItem" labelAlign="top">
          <t-form-item :label="$t('workbench.cornerScape.history')">
            <div class="historySection">
              <div class="historyImageList">
                <div
                  v-for="item in currentItem.historyImages"
                  :key="item.id"
                  class="historyImageItem"
                  :class="{ selected: selectedHistoryId === item.id }"
                  @click.stop="toggleHistorySelect(item.id)">
                  <t-image
                    :key="item.filePath || item.id"
                    :src="item.filePath"
                    :style="{ width: '100px', minWidth: '100px', height: '100px' }"
                    :lazy="true"
                    fit="contain"
                    @load="markAssetImageLoaded(currentItem.id)"
                    @error="refreshAssetImageUrl(currentItem)" />
                </div>
              </div>
              <div class="historyActions">
                <t-button size="small" variant="outline" :disabled="!selectedHistoryId" :loading="replacingImage" @click="replaceWithSelectedHistory">
                  <template #icon><t-icon name="check" /></template>
                  设为当前图
                </t-button>
                <t-button size="small" variant="outline" :disabled="!selectedHistoryId" @click="useSelectedHistoryAsReference">
                  <template #icon><t-icon name="link" /></template>
                  作为参考图
                </t-button>
                <t-button size="small" variant="outline" :loading="replacingImage" @click="openReplacementFilePicker">
                  <template #icon><t-icon name="upload" /></template>
                  上传替换
                </t-button>
                <input ref="replacementFileInput" type="file" accept="image/*" hidden @change="handleReplacementFile" />
              </div>
            </div>
          </t-form-item>
          <t-form-item v-if="currentItem.type === 'role'" label="角色声音参考">
            <div class="voiceReferenceControl">
              <audio v-if="currentItem.voicePath" :src="currentItem.voicePath" controls preload="metadata" />
              <div v-else class="voiceReferenceEmpty">尚未上传声音参考素材</div>
              <div class="voiceReferenceActions">
                <span v-if="currentItem.voiceName" class="voiceReferenceName" :title="currentItem.voiceName">
                  {{ currentItem.voiceName }}
                </span>
                <t-button size="small" variant="outline" :loading="voiceUploading" @click="openVoiceFilePicker">
                  <template #icon><t-icon name="upload" /></template>
                  {{ currentItem.voicePath ? "替换声音" : "上传声音" }}
                </t-button>
                <t-button v-if="currentItem.voicePath" size="small" variant="text" :loading="voiceRemoving" @click="removeVoiceReference">
                  清除
                </t-button>
                <input ref="voiceFileInput" type="file" accept="audio/*" hidden @change="handleVoiceFile" />
              </div>
            </div>
          </t-form-item>
          <t-form-item label="参考图生图">
            <div class="referenceControl">
              <div class="referenceToggle">
                <span>{{ useReferenceImage ? "已启用" : "未启用" }}</span>
                <t-switch v-model="useReferenceImage" />
              </div>
              <div v-if="useReferenceImage" class="referenceSource">
                <div class="referencePreview">
                  <img v-if="referenceImagePreview" :src="referenceImagePreview" alt="参考图" />
                  <t-empty v-else type="maintenance" title="请选择参考图" />
                </div>
                <div class="referenceActions">
                  <t-button size="small" variant="outline" :disabled="!currentItem.imageId" @click="useCurrentImageAsReference">使用当前图</t-button>
                  <t-button size="small" variant="outline" @click="openReferenceFilePicker">
                    <template #icon><t-icon name="image-add" /></template>
                    上传参考图
                  </t-button>
                  <t-button v-if="referenceImageId || referenceUploadBase64" size="small" variant="text" @click="clearReferenceImage">清除</t-button>
                  <input ref="referenceFileInput" type="file" accept="image/*" hidden @change="handleReferenceFile" />
                </div>
              </div>
            </div>
          </t-form-item>
          <t-form-item :label="$t('workbench.cornerScape.genModel')">
            <modelSelect v-model="selectValue" :type="`image`" />
          </t-form-item>
          <t-form-item :label="$t('workbench.cornerScape.resolution')">
            <t-select v-model="editForm.resolution" :placeholder="$t('workbench.cornerScape.resolutionPh')" :options="resolutionOptions" />
          </t-form-item>
          <t-form-item label="推理模版">
            <div class="promptReasoningBar">
              <div class="promptReasoningSelect">
                <t-select
                  v-model="selectedReasoningTemplateId"
                  :loading="reasoningTemplateLoading"
                  :options="reasoningTemplateOptions"
                  clearable
                  @focus="loadReasoningTemplates"
                  placeholder="选择推理模版" />
              </div>
              <t-button
                theme="default"
                variant="outline"
                :loading="currentItem ? isReasoningRunning(currentItem.id) : false"
                :disabled="!selectedReasoningTemplateId || (currentItem ? isReasoningRunning(currentItem.id) || currentItem.promptState == '生成中' : true)"
                @click="runReasoningTemplate">
                <template #icon><t-icon name="play" /></template>
                推理
              </t-button>
              <t-button size="small" variant="text" @click="openTemplateLibrary">
                <template #icon><t-icon name="setting" /></template>
                模板库
              </t-button>
            </div>
          </t-form-item>
          <t-form-item label="原始提示词">
            <t-textarea
              v-model="editForm.originalPrompt"
              placeholder="批量生成提示词后显示在这里"
              :autosize="{ minRows: 3, maxRows: 8 }"
              :disabled="polishing"
              @blur="saveOriginalPromptOnBlur" />
          </t-form-item>
          <t-form-item label="当前提示词（模板推理结果）">
            <t-loading style="width: 100%" :loading="currentItem.promptState == '生成中'">
              <t-textarea
                v-model="editForm.prompt"
                :placeholder="$t('workbench.cornerScape.promptPh')"
                :autosize="{ minRows: 4, maxRows: 10 }"
                :disabled="polishing"
                @blur="savePromptOnBlur" />
            </t-loading>
          </t-form-item>
          <t-form-item>
            <div class="drawerActions">
              <t-button
                theme="default"
                variant="outline"
                :loading="polishing"
                @click="polishPrompts"
                :disabled="currentItem.promptState == '生成中' ? true : false">
                <template #icon><t-icon name="edit" /></template>
                {{ $t("workbench.cornerScape.aiPolish") }}
              </t-button>
              <t-button theme="primary" :loading="currentItem ? isRegenerating(currentItem.id) : false" @click="regenerateItem" :disabled="currentItem.state == '生成中' || (currentItem ? isRegenerating(currentItem.id) : true)">
                <template v-if="!(currentItem && isRegenerating(currentItem.id))" #icon><t-icon name="refresh" /></template>
                {{ useReferenceImage ? "参考图生成" : $t("workbench.cornerScape.regenerate") }}
              </t-button>
            </div>
          </t-form-item>
        </t-form>
      </t-drawer>
      <t-dialog
        v-model:visible="templateLibraryVisible"
        header="图片推理模板库"
        width="760px"
        height="80vh"
        top="6vh"
        placement="center"
        :footer="false"
        destroyOnClose>
        <div class="templateLibrary">
          <div class="templateLibraryIntro">模板只抽取版式、视图和视觉要素；推理时会优先保留当前剧本事实，并读取当前资产参考图中的可见元素。</div>
          <div class="templateLibraryList">
            <button
              v-for="item in reasoningTemplates"
              :key="item.id"
              type="button"
              class="templateLibraryItem"
              :class="{ active: selectedReasoningTemplateId === item.id }"
              @click="selectReasoningTemplate(item.id)">
              <strong>{{ item.name }}</strong>
              <span>{{ item.summary || item.group || "可用于当前资产的结构化图片推理" }}</span>
              <small v-if="item.template">{{ item.template.canvas?.aspectRatio }} · {{ item.template.layout?.mode }} · {{ item.template.layout?.panels?.length }} 个面板</small>
            </button>
          </div>
          <div class="caseTemplateForm">
            <div class="caseTemplateTitle">新增案例入口</div>
            <t-input v-model="caseTemplateName" placeholder="可选：模板名称" />
            <t-textarea
              v-model="caseTemplateText"
              placeholder="粘贴新的案例提示词、图片说明或版式要求，系统会自动总结为可选择的模板。"
              :autosize="{ minRows: 6, maxRows: 12 }" />
            <div class="caseTemplateActions">
              <t-button theme="primary" :loading="caseTemplateAnalyzing" :disabled="caseTemplateText.trim().length < 20" @click="analyzeCaseTemplate">
                <template #icon><t-icon name="lightbulb" /></template>
                分析并保存案例
              </t-button>
              <t-button variant="text" @click="templateLibraryVisible = false">关闭</t-button>
            </div>
          </div>
        </div>
      </t-dialog>
    </div>
  </div>
</template>

<script setup lang="ts">
import axios from "@/utils/axios";
import projectStore from "@/stores/project";
import modelSelect from "@/components/modelSelect.vue";
import settingStore from "@/stores/setting";
import { resolveBackendAssetUrl } from "@/utils/backendUrl";
const settings = settingStore();
const { otherSetting } = storeToRefs(settings);
interface Image {
  filePath: string;
  id: number;
}
interface DataItem {
  id: number;
  type: string;
  name: string;
  prompt: string;
  originalPrompt?: string | null;
  filePath: string | null;
  state: string;
  model: string;
  resolution: string;
  describe: string;
  promptState: string;
  historyImages: Image[];
  errorReason: string;
  promptErrorReason: string;
  imageId?: number | null;
  voiceAssetId?: number | null;
  voiceImageId?: number | null;
  voiceName?: string;
  voicePath?: string;
  voiceState?: string;
  voiceReference?: Record<string, any> | null;
}

interface ReasoningTemplateItem {
  id: number;
  name: string;
  type: string;
  data: string;
  group?: string;
  source?: string;
  summary?: string;
  template?: any;
}

interface ArtStyleItem {
  name: string;
  stylePath: string;
  images: string[];
  summary: string;
  searchText: string;
}

const checkboxValue = ref<string[]>([]);
const { project } = storeToRefs(projectStore());
const selectValue = ref(project.value?.imageModel ?? "");
const resolution = ref("1K");
const resolutionOptions = [
  { label: "1K", value: "1K" },
  { label: "2K", value: "2K" },
  { label: "4K", value: "4K" },
];
const reasoningTemplates = ref<ReasoningTemplateItem[]>([]);
const reasoningTemplateLoading = ref(false);
const selectedReasoningTemplateId = ref<number | undefined>(undefined);
const reasoningRunningIds = ref<number[]>([]);
// This ref is consumed by reasoningTemplateOptions below; initialize it before
// any computed getter or watcher can evaluate during drawer/workbench mount.
const currentItem = ref<DataItem | null>(null);
const templateLibraryVisible = ref(false);
const caseTemplateName = ref("");
const caseTemplateText = ref("");
const caseTemplateAnalyzing = ref(false);
const selectedArtStyle = ref(project.value?.artStyle || "");
const artStyleLoading = ref(false);
const artStyleSaving = ref(false);
const artStyles = ref<ArtStyleItem[]>([]);
const stylePickerVisible = ref(false);
const styleSearch = ref("");
const styleFilter = ref<"all" | "favorite" | "recent">("all");
const favoriteArtStyles = ref<string[]>(readStringList("cornerScape.favoriteArtStyles"));
const recentArtStyles = ref<string[]>(readStringList("cornerScape.recentArtStyles"));
const failedArtStyleImages = ref(new Set<string>());
const retriedAssetImageIds = new Set<number>();
const artStyleDirty = computed(() => selectedArtStyle.value !== (project.value?.artStyle || ""));
const selectedArtStyleItem = computed(() => artStyles.value.find((item) => item.stylePath === selectedArtStyle.value) ?? null);
const selectedArtStyleCover = computed(() => (selectedArtStyleItem.value ? getArtStyleCover(selectedArtStyleItem.value) : undefined));
const filteredArtStyles = computed(() => {
  const keyword = styleSearch.value.trim().toLocaleLowerCase();
  const source = artStyles.value.filter((item) => {
    if (styleFilter.value === "favorite" && !favoriteArtStyles.value.includes(item.stylePath)) return false;
    if (styleFilter.value === "recent" && !recentArtStyles.value.includes(item.stylePath)) return false;
    return !keyword || item.searchText.includes(keyword);
  });
  if (styleFilter.value !== "recent") return source;
  return [...source].sort((a, b) => recentArtStyles.value.indexOf(a.stylePath) - recentArtStyles.value.indexOf(b.stylePath));
});
const reasoningTemplateOptions = computed(() =>
  reasoningTemplates.value
    .filter((item) => {
      const assetType = currentItem.value?.type;
      if (!assetType || !item.template?.applicableTypes?.length) return true;
      return item.template.applicableTypes.includes(assetType);
    })
    .map((item) => ({
      label: `${item.name}${item.group ? ` · ${item.group}` : ""}`,
      value: item.id,
    })),
);
const options = ref([
  { labelKey: "workbench.cornerScape.filterRole", value: "role" },
  { labelKey: "workbench.cornerScape.filterScene", value: "scene" },
  { labelKey: "workbench.cornerScape.filterTool", value: "tool" },
]);

const translatedOptions = computed(() =>
  options.value.map((opt) => ({
    ...opt,
    label: $t(opt.labelKey),
  })),
);
const dataList = ref<DataItem[]>([]);
const loading = ref(false);

// 用于取消进行中的生成请求
onMounted(() => {
  loadReasoningTemplates();
  loadArtStyles();
  getFilteredData();
});

onUnmounted(() => {
  stopPolling();
  stopImagePolling();
  // 将所有"生成中"的项重置为空状态
  dataList.value.forEach((item) => {
    if (item.state === "生成中") item.state = "";
  });
});
function onChangeFn() {
  getFilteredData();
}
async function getFilteredData() {
  try {
    loading.value = true;
    const { data } = await axios.post("/cornerScape/getAllAssets", {
      projectId: project.value?.id,
      type: checkboxValue.value,
    });
    retriedAssetImageIds.clear();
    dataList.value = (Array.isArray(data) ? data : []).map(normalizeAssetMedia);
  } catch (error) {
    console.error("加载资产数据失败:", error);
    dataList.value = [];
  } finally {
    loading.value = false;
  }
}

async function loadArtStyles() {
  artStyleLoading.value = true;
  try {
    const { data } = await axios.post("/project/getVisualManual");
    const options = (Array.isArray(data) ? data : []).filter((item: any) => item?.stylePath).map(toArtStyleItem);
    if (project.value?.artStyle && !options.some((item) => item.stylePath === project.value?.artStyle)) {
      options.unshift({
        name: project.value.artStyle,
        stylePath: project.value.artStyle,
        images: [],
        summary: "当前项目风格",
        searchText: project.value.artStyle.toLocaleLowerCase(),
      });
    }
    artStyles.value = options;
  } catch (error) {
    console.error("加载项目风格失败:", error);
    if (project.value?.artStyle) {
      artStyles.value = [
        {
          name: project.value.artStyle,
          stylePath: project.value.artStyle,
          images: [],
          summary: "当前项目风格",
          searchText: project.value.artStyle.toLocaleLowerCase(),
        },
      ];
    }
  } finally {
    artStyleLoading.value = false;
  }
}

function readStringList(key: string) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function persistStringList(key: string, value: string[]) {
  localStorage.setItem(key, JSON.stringify(value));
}

function summarizeStyleData(data: any[]) {
  const preferred = ["prefix", "README", "prompt_reasoning"];
  const content = preferred.map((key) => data.find((item) => item?.value === key)?.data).find((item) => String(item || "").trim());
  const plain = String(content || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`|\[\]()-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return plain ? `${plain.slice(0, 86)}${plain.length > 86 ? "..." : ""}` : "暂无提示词摘要";
}

function toArtStyleItem(item: any): ArtStyleItem {
  const name = String(item.name || item.stylePath);
  const stylePath = String(item.stylePath);
  const imageValues = Array.isArray(item.images) ? item.images : Array.isArray(item.image) ? item.image : item.image ? [item.image] : [];
  const images = imageValues.map((value: string) => resolveBackendAssetUrl(value, settings.baseUrl));
  const styleData = Array.isArray(item.data) ? item.data : [];
  const summary = summarizeStyleData(styleData);
  const searchText = [name, stylePath, summary, ...styleData.map((entry: any) => entry?.data || "")].join(" ").toLocaleLowerCase();
  return { name, stylePath, images, summary, searchText };
}

function resolveAssetMediaUrl(value?: string | null) {
  return value ? resolveBackendAssetUrl(value, settings.baseUrl) : "";
}

function normalizeAssetMedia(item: DataItem): DataItem {
  const voicePath = resolveAssetMediaUrl(item.voicePath);
  return {
    ...item,
    filePath: resolveAssetMediaUrl(item.filePath) || null,
    historyImages: Array.isArray(item.historyImages)
      ? item.historyImages.map((image) => ({ ...image, filePath: resolveAssetMediaUrl(image.filePath) }))
      : [],
    voicePath,
    voiceReference: item.voiceReference
      ? {
          ...item.voiceReference,
          src: resolveAssetMediaUrl(String(item.voiceReference.src || voicePath)),
        }
      : null,
  };
}

async function refreshAssetImageUrl(item: DataItem) {
  if (retriedAssetImageIds.has(item.id)) return;
  retriedAssetImageIds.add(item.id);
  try {
    const { data } = await axios.post("/assets/getImage", { assetsId: item.id });
    const images = Array.isArray(data?.tempAssets) ? data.tempAssets : [];
    const selectedImage = images.find((image: any) => image.selected) || images.find((image: any) => Number(image.id) === Number(item.imageId));
    const refreshedUrl = resolveAssetMediaUrl(selectedImage?.filePath);
    const refreshedHistory = images
      .filter((image: any) => image.state === "已完成" && image.filePath)
      .map((image: any) => ({ id: Number(image.id), filePath: resolveAssetMediaUrl(image.filePath) }));
    const targets = [item, dataList.value.find((target) => target.id === item.id), currentItem.value?.id === item.id ? currentItem.value : null].filter(
      (target): target is DataItem => Boolean(target),
    );
    targets.forEach((target) => {
      if (refreshedUrl) target.filePath = refreshedUrl;
      if (refreshedHistory.length) target.historyImages = refreshedHistory;
    });
  } catch (error) {
    console.error("刷新资产图片地址失败:", error);
  }
}

function markAssetImageLoaded(assetId: number) {
  retriedAssetImageIds.delete(assetId);
}

function getArtStyleCover(item: ArtStyleItem) {
  return item.images.find((image) => !failedArtStyleImages.value.has(image));
}

function onArtStyleImageError(event: Event) {
  const image = event.currentTarget as HTMLImageElement | null;
  if (!image?.src) return;
  failedArtStyleImages.value = new Set([...failedArtStyleImages.value, image.src]);
}

function selectArtStyle(item: ArtStyleItem) {
  selectedArtStyle.value = item.stylePath;
  recentArtStyles.value = [item.stylePath, ...recentArtStyles.value.filter((path) => path !== item.stylePath)].slice(0, 12);
  persistStringList("cornerScape.recentArtStyles", recentArtStyles.value);
  stylePickerVisible.value = false;
}

function toggleFavoriteArtStyle(stylePath: string) {
  favoriteArtStyles.value = favoriteArtStyles.value.includes(stylePath)
    ? favoriteArtStyles.value.filter((path) => path !== stylePath)
    : [stylePath, ...favoriteArtStyles.value];
  persistStringList("cornerScape.favoriteArtStyles", favoriteArtStyles.value);
}

async function saveArtStyle() {
  const projectId = Number(project.value?.id);
  if (!Number.isFinite(projectId) || !selectedArtStyle.value) {
    window.$message.warning("请选择项目风格");
    return;
  }
  artStyleSaving.value = true;
  try {
    await axios.post("/project/updateArtStyle", { projectId, artStyle: selectedArtStyle.value });
    if (project.value) project.value.artStyle = selectedArtStyle.value;
    window.$message.success("项目风格已保存");
  } catch (error: any) {
    window.$message.error(error?.message || "项目风格保存失败");
  } finally {
    artStyleSaving.value = false;
  }
}

const selectedIds = ref<number[]>([]);

const previewImages = computed((): string[] => {
  const selectedImageList = dataList.value
    .filter((item) => selectedIds.value.includes(item.id) && item.filePath)
    .map((item) => item.filePath as string);

  if (selectedImageList.length > 0) {
    return selectedImageList;
  }

  return dataList.value.filter((item) => item.filePath).map((item) => item.filePath as string);
});

const hasPreviewImages = computed(() => previewImages.value.length > 0);

const toggleSelect = (id: number) => {
  const idx = selectedIds.value.indexOf(id);
  if (idx === -1) selectedIds.value.push(id);
  else selectedIds.value.splice(idx, 1);
};

const selectByState = (state: string) => {
  selectedIds.value = dataList.value.filter((item) => (state === "" ? !item.state : item.state === state)).map((item) => item.id);
};

function toggleSelectAll() {
  if (selectedIds.value.length === dataList.value.length) {
    selectedIds.value = [];
  } else {
    selectedIds.value = dataList.value.map((item) => item.id);
  }
}
function clearSelection() {
  selectedIds.value = [];
}

const selectedReasoningTemplate = computed(() => reasoningTemplates.value.find((item) => item.id === selectedReasoningTemplateId.value) ?? null);

watch(
  () => currentItem.value?.type,
  () => {
    if (!reasoningTemplateOptions.value.some((item) => item.value === selectedReasoningTemplateId.value)) {
      selectedReasoningTemplateId.value = reasoningTemplateOptions.value[0]?.value;
    }
  },
);

function openTemplateLibrary() {
  templateLibraryVisible.value = true;
  loadReasoningTemplates();
}

function selectReasoningTemplate(id: number) {
  selectedReasoningTemplateId.value = id;
  templateLibraryVisible.value = false;
}

function isReasoningRunning(id: number) {
  return reasoningRunningIds.value.includes(id);
}

function setReasoningRunning(id: number, running: boolean) {
  reasoningRunningIds.value = running
    ? [...new Set([...reasoningRunningIds.value, id])]
    : reasoningRunningIds.value.filter((item) => item !== id);
}

function setPromptState(id: number, state: string) {
  const target = dataList.value.find((item) => item.id === id);
  if (target) target.promptState = state;
  if (currentItem.value?.id === id) currentItem.value.promptState = state;
}

function runReasoningTemplate() {
  if (!currentItem.value) return;
  if (!selectedReasoningTemplate.value) {
    window.$message.warning("请选择推理模版");
    return;
  }
  const item = currentItem.value;
  const assetId = item.id;
  if (isReasoningRunning(assetId)) return;
  setReasoningRunning(assetId, true);
  setPromptState(assetId, "生成中");
  // 不等待模型响应；当前资产进入轮询状态后，用户可以立即切换并提交其他资产。
  void axios.post("/assetsGenerate/reasonAssetPrompt", {
      projectId: project.value?.id,
      assetsId: assetId,
      templateId: selectedReasoningTemplate.value.id,
      referenceImageId: useReferenceImage.value ? referenceImageId.value : undefined,
    }).then(({ data }) => {
    const output = String(data?.prompt || "").trim();
    if (!output) throw new Error("图片推理未返回有效提示词");
    const target = dataList.value.find((row) => row.id === assetId);
    if (target) {
      target.originalPrompt = String(data?.originalPrompt || target.originalPrompt || target.prompt || "");
      target.prompt = output;
      target.promptState = "已完成";
    }
    if (currentItem.value?.id === assetId) {
      editForm.originalPrompt = String(data?.originalPrompt || editForm.originalPrompt || item.prompt || "");
      editForm.prompt = output;
      currentItem.value.originalPrompt = editForm.originalPrompt;
      currentItem.value.prompt = output;
      currentItem.value.promptState = "已完成";
    }
    window.$message.success("推理完成，结果已写入提示词");
    }).catch((error: any) => {
    setPromptState(assetId, "失败");
    window.$message.error(error?.message || "推理失败");
    }).finally(() => setReasoningRunning(assetId, false));
}

async function loadReasoningTemplates() {
  reasoningTemplateLoading.value = true;
  try {
    const { data } = await axios.post("/assetsGenerate/getAssetPromptTemplates");
    const templates = Array.isArray(data) ? data : [];
    reasoningTemplates.value = templates
      .map((item: any) => ({
        id: Number(item.id),
        name: item.name || "未命名模版",
        type: item.type || "",
        data: item.data || "",
        group: item.group || "",
        source: item.source || "",
        summary: item.template?.summary || "",
        template: item.template || null,
      }));
    if (!reasoningTemplates.value.some((item) => item.id === selectedReasoningTemplateId.value)) {
      selectedReasoningTemplateId.value = reasoningTemplates.value[0]?.id;
    }
  } catch (error) {
    console.error("加载推理模版失败:", error);
    reasoningTemplates.value = [];
  } finally {
    reasoningTemplateLoading.value = false;
  }
}

async function analyzeCaseTemplate() {
  const caseText = caseTemplateText.value.trim();
  if (caseText.length < 20) {
    window.$message.warning("案例内容至少需要 20 个字符");
    return;
  }
  caseTemplateAnalyzing.value = true;
  try {
    const { data } = await axios.post("/assetsGenerate/analyzeAssetPromptCase", {
      name: caseTemplateName.value.trim() || undefined,
      caseText,
      save: true,
    });
    await loadReasoningTemplates();
    if (data?.id) selectedReasoningTemplateId.value = Number(data.id);
    caseTemplateName.value = "";
    caseTemplateText.value = "";
    window.$message.success("案例已分析并加入模板库");
  } catch (error: any) {
    window.$message.error(error?.message || "案例分析失败");
  } finally {
    caseTemplateAnalyzing.value = false;
  }
}

// Drawer
const drawerVisible = ref(false);
const selectedHistoryId = ref<number | null>(null);
const regeneratingIds = ref<number[]>([]);
const replacingImage = ref(false);
const useReferenceImage = ref(false);
const referenceImageId = ref<number | null>(null);
const referenceUploadBase64 = ref("");
const referenceUploadName = ref("");
const replacementFileInput = ref<HTMLInputElement>();
const referenceFileInput = ref<HTMLInputElement>();
const voiceFileInput = ref<HTMLInputElement>();
const voiceUploading = ref(false);
const voiceRemoving = ref(false);
const drawerPreviewImage = computed(() => {
  if (!currentItem.value) return "";
  if (selectedHistoryId.value) {
    return currentItem.value.historyImages.find((image) => image.id === selectedHistoryId.value)?.filePath || currentItem.value.filePath || "";
  }
  return currentItem.value.filePath || "";
});
const referenceImagePreview = computed(() => {
  if (referenceUploadBase64.value) return referenceUploadBase64.value;
  return currentItem.value?.historyImages.find((image) => image.id === referenceImageId.value)?.filePath || "";
});

function toggleHistorySelect(id: number) {
  selectedHistoryId.value = selectedHistoryId.value === id ? null : id;
}

async function replaceWithSelectedHistory() {
  if (!currentItem.value || !selectedHistoryId.value) return;
  replacingImage.value = true;
  try {
    const { data } = await axios.post("/assets/saveAssets", {
      id: currentItem.value.id,
      type: currentItem.value.type,
      projectId: project.value?.id,
      prompt: currentItem.value.prompt,
      imageId: selectedHistoryId.value,
    });
    currentItem.value.imageId = Number(data?.imageId || selectedHistoryId.value);
    currentItem.value.filePath = resolveAssetMediaUrl(data?.filePath) || referenceImagePreview.value || currentItem.value.filePath;
    currentItem.value.state = "已完成";
    selectedHistoryId.value = null;
    await refreshCurrentItem();
    window.$message.success($t("workbench.cornerScape.msg.replaceSuccess"));
  } catch (e) {
    window.$message.error($t("workbench.cornerScape.msg.replaceFailed"));
  } finally {
    replacingImage.value = false;
  }
}

function useSelectedHistoryAsReference() {
  if (!selectedHistoryId.value) return;
  referenceImageId.value = selectedHistoryId.value;
  referenceUploadBase64.value = "";
  referenceUploadName.value = "";
  useReferenceImage.value = true;
}

function useCurrentImageAsReference() {
  if (!currentItem.value?.imageId) return;
  referenceImageId.value = currentItem.value.imageId;
  referenceUploadBase64.value = "";
  referenceUploadName.value = "";
}

function clearReferenceImage() {
  referenceImageId.value = null;
  referenceUploadBase64.value = "";
  referenceUploadName.value = "";
}

function openReplacementFilePicker() {
  replacementFileInput.value?.click();
}

function openReferenceFilePicker() {
  referenceFileInput.value?.click();
}

function openVoiceFilePicker() {
  voiceFileInput.value?.click();
}

function readImageFile(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
}

function readAudioFile(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("声音参考素材读取失败"));
    reader.readAsDataURL(file);
  });
}

async function handleVoiceFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || !currentItem.value || currentItem.value.type !== "role") return;
  if (!file.type.startsWith("audio/")) {
    window.$message.warning("请选择音频文件");
    return;
  }
  voiceUploading.value = true;
  try {
    const base64Data = await readAudioFile(file);
    await axios.post("/assets/uploadVoiceReference", {
      projectId: project.value?.id,
      roleAssetId: currentItem.value.id,
      base64Data,
      name: file.name,
    });
    await refreshCurrentItem();
    window.$message.success("角色声音参考素材已保存，并已绑定到角色资产");
  } catch (error: any) {
    window.$message.error(error?.message || "声音参考素材上传失败");
  } finally {
    voiceUploading.value = false;
  }
}

async function removeVoiceReference() {
  if (!currentItem.value || currentItem.value.type !== "role" || !currentItem.value.voicePath) return;
  voiceRemoving.value = true;
  try {
    await axios.post("/assets/removeVoiceReference", {
      projectId: project.value?.id,
      roleAssetId: currentItem.value.id,
    });
    await refreshCurrentItem();
    window.$message.success("角色声音参考素材已清除");
  } catch (error: any) {
    window.$message.error(error?.message || "清除声音参考素材失败");
  } finally {
    voiceRemoving.value = false;
  }
}

async function handleReplacementFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || !currentItem.value) return;
  replacingImage.value = true;
  try {
    const base64 = await readImageFile(file);
    await axios.post("/assets/saveAssets", {
      id: currentItem.value.id,
      type: currentItem.value.type,
      projectId: project.value?.id,
      prompt: currentItem.value.prompt,
      base64,
    });
    await refreshCurrentItem();
    window.$message.success("原图已替换，资产绑定保持不变");
  } catch (error: any) {
    window.$message.error(error?.message || "上传替换失败");
  } finally {
    replacingImage.value = false;
  }
}

async function handleReferenceFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  try {
    referenceUploadBase64.value = await readImageFile(file);
    referenceUploadName.value = file.name;
    referenceImageId.value = null;
    useReferenceImage.value = true;
  } catch (error: any) {
    window.$message.error(error?.message || "参考图读取失败");
  }
}

const editForm = reactive({
  assetsId: 0,
  model: "",
  type: "",
  resolution: "",
  originalPrompt: "",
  prompt: "",
  name: "",
  describe: "",
  promptState: "",
});

async function openDrawer(item: DataItem) {
  selectedHistoryId.value = null;
  useReferenceImage.value = false;
  clearReferenceImage();
  // 先用当前数据打开抽屉
  editForm.assetsId = item.id;
  editForm.name = item.name || "";
  editForm.type = item.type || "";
  editForm.model = item.model || "";
  currentItem.value = item;
  editForm.resolution = item.resolution || "";
  editForm.originalPrompt = item.originalPrompt || item.prompt || "";
  editForm.prompt = item.prompt || "";
  editForm.describe = item.describe || "";
  editForm.promptState = item.promptState;
  drawerVisible.value = true;
  await refreshCurrentItem();
}

async function refreshCurrentItem() {
  if (!currentItem.value) return;
  const currentId = currentItem.value.id;
  try {
    const { data } = await axios.post("/cornerScape/getAllAssets", {
      projectId: project.value?.id,
      type: checkboxValue.value,
    });
    const freshList = (Array.isArray(data) ? data : []).map(normalizeAssetMedia);
    dataList.value = freshList;
    const freshItem = freshList.find((d) => d.id === currentId);
    if (freshItem) {
      currentItem.value = freshItem;
      editForm.originalPrompt = freshItem.originalPrompt || editForm.originalPrompt;
      editForm.prompt = freshItem.prompt || editForm.prompt;
      editForm.resolution = freshItem.resolution || editForm.resolution;
    }
  } catch (e) {
    console.error("刷新资产详情失败:", e);
  }
}

function setItemState(id: number, state: string) {
  const item = dataList.value.find((i) => i.id === id);
  if (item) item.state = state;
  if (currentItem.value?.id === id) currentItem.value.state = state;
}

function isRegenerating(id: number) {
  return regeneratingIds.value.includes(id);
}

function setRegenerating(id: number, running: boolean) {
  regeneratingIds.value = running
    ? [...new Set([...regeneratingIds.value, id])]
    : regeneratingIds.value.filter((item) => item !== id);
}

function regenerateItem() {
  if (!currentItem.value) return;
  if (!selectValue.value) {
    window.$message.warning($t("workbench.cornerScape.msg.selectModel"));
    return;
  }
  if (!editForm.resolution) {
    window.$message.warning($t("workbench.cornerScape.msg.selectResolution"));
    return;
  }
  if (!editForm.prompt.trim()) {
    window.$message.warning($t("workbench.cornerScape.msg.enterPrompt"));
    return;
  }
  if (useReferenceImage.value && !referenceImageId.value && !referenceUploadBase64.value) {
    window.$message.warning("请选择参考图");
    return;
  }
  const item = currentItem.value;
  if (isRegenerating(item.id)) return;
  setItemState(item.id, "生成中");
  setRegenerating(item.id, true);
  // 图片生成在服务端异步执行；提交成功后立即释放当前按钮，状态由图片轮询更新。
  void axios.post("/assetsGenerate/generateAssets", {
        type: item.type ?? "props",
        projectId: project.value?.id,
        name: item.name ?? $t("workbench.cornerScape.unnamed"),
        base64: useReferenceImage.value ? referenceUploadBase64.value || null : null,
        referenceImageId: useReferenceImage.value ? referenceImageId.value : null,
        prompt: editForm.prompt,
        model: selectValue.value,
        id: item.id,
        resolution: editForm.resolution,
        concurrentCount: 1,
        templateId: selectedReasoningTemplateId.value,
      }).then(async () => {
    window.$message.success($t("workbench.cornerScape.msg.genSuccess", { name: item.name }));
    await getFilteredData();
    if (currentItem.value?.id === item.id) await refreshCurrentItem();
    }).catch((e: any) => {
    window.$message.error(e.message ?? $t("workbench.cornerScape.msg.genFailed", { name: item.name }));
    setItemState(item.id, "生成失败");
    }).finally(() => setRegenerating(item.id, false));
}

// 提示词失焦保存
async function savePromptOnBlur() {
  if (!currentItem.value) return;
  // 内容没有变化则不保存
  if (editForm.prompt === currentItem.value.prompt) return;
  try {
    await axios.post("/assets/saveAssets", {
      id: currentItem.value.id,
      type: currentItem.value.type,
      projectId: project.value?.id,
      prompt: editForm.prompt,
    });
    // 同步更新本地数据
    currentItem.value.prompt = editForm.prompt;
    const target = dataList.value.find((d) => d.id === currentItem.value!.id);
    if (target) target.prompt = editForm.prompt;
    window.$message.success($t("workbench.cornerScape.msg.saveSuccess"));
  } catch (e) {
    window.$message.error($t("workbench.cornerScape.msg.saveFailed"));
  }
}

async function saveOriginalPromptOnBlur() {
  if (!currentItem.value) return;
  const nextValue = editForm.originalPrompt || "";
  if (nextValue === (currentItem.value.originalPrompt || "")) return;
  try {
    await axios.post("/assets/saveAssets", {
      id: currentItem.value.id,
      type: currentItem.value.type,
      projectId: project.value?.id,
      originalPrompt: nextValue,
    });
    currentItem.value.originalPrompt = nextValue;
    const target = dataList.value.find((item) => item.id === currentItem.value!.id);
    if (target) target.originalPrompt = nextValue;
    window.$message.success("原始提示词已保存");
  } catch (error) {
    console.error("保存原始提示词失败:", error);
    window.$message.error("原始提示词保存失败");
  }
}

// AI 润色
const polishing = ref(false);
async function polishPrompts() {
  if (!editForm.prompt.trim()) {
    window.$message.warning($t("workbench.cornerScape.msg.enterPromptFirst"));
    return;
  }
  polishing.value = true;
  try {
    const { data } = await axios.post("/assetsGenerate/polishAssetsPrompt", {
      projectId: project.value?.id,
      assetsId: editForm.assetsId,
      type: editForm.type ?? "props",
      name: editForm.name,
      describe: editForm.describe,
      templateId: selectedReasoningTemplateId.value,
    });
    window.$message.success($t("workbench.cornerScape.msg.promptGenSuccess"));
    if (data.assetsId === editForm.assetsId) {
      editForm.originalPrompt = data.originalPrompt || data.prompt || "";
      editForm.prompt = data.prompt;
      if (currentItem.value) {
        currentItem.value.originalPrompt = editForm.originalPrompt;
        currentItem.value.prompt = data.prompt;
      }
    }
    await getFilteredData();
  } catch {
    window.$message.error($t("workbench.cornerScape.msg.polishFailed"));
  } finally {
    polishing.value = false;
  }
}
//批量生成提示词
async function batchGenerationPrompt() {
  if (selectedIds.value.length === 0) {
    window.$message.warning($t("workbench.cornerScape.msg.selectAtLeastOne"));
    return;
  }

  const items = dataList.value.filter((item) => selectedIds.value.includes(item.id));

  // 前端先将所有选中项的 promptState 标记为"生成中"，让轮询自动接管状态跟踪
  items.forEach((item) => {
    item.promptState = "生成中";
  });

  // 清除已选中的项
  selectedIds.value = [];

  try {
    await axios.post("/assetsGenerate/batchPolishAssetsPrompt", {
      projectId: project.value?.id,
      items: items.map((item) => ({
        assetsId: item.id,
        type: item.type ?? "props",
        name: item.name,
        describe: item.describe,
      })),
      concurrentCount: otherSetting.value.assetsBatchGenereateSize,
      templateId: selectedReasoningTemplateId.value,
    });
  } catch (e: any) {
    window.$message.error(e.message ?? $t("workbench.cornerScape.msg.promptGenFail"));
    // 生成失败时重置 promptState
    items.forEach((item) => {
      const target = dataList.value.find((row) => row.id === item.id);
      if (target) target.promptState = "";
    });
  }
}
// 批量生成图片
async function batchGenerationImage() {
  if (selectedIds.value.length === 0) {
    window.$message.warning($t("workbench.cornerScape.msg.selectAtLeastOne"));
    return;
  }
  if (!selectValue.value) {
    window.$message.warning($t("workbench.cornerScape.msg.selectModel"));
    return;
  }
  if (!resolution.value) {
    window.$message.warning($t("workbench.cornerScape.msg.selectResolution"));
    return;
  }

  const items = dataList.value.filter((item) => selectedIds.value.includes(item.id));
  //检查如果勾选的数据prompt有空的，提示用户勾选的哪一个提示词未生成，然后终止批量生成
  const emptyPrompts = items.filter((item) => !item.prompt);
  if (emptyPrompts.length > 0) {
    const emptyPromptNames = emptyPrompts.map((item) => item.name).join(", ");
    window.$message.warning(
      $t("workbench.cornerScape.msg.emptyPrompt", {
        emptyPromptNames,
      }),
    );
    return;
  }

  // 前端先将所有选中项标记为"生成中"
  items.forEach((item) => setItemState(item.id, "生成中"));

  window.$message.success(
    $t("workbench.cornerScape.msg.batchStarted", { count: items.length, concurrent: otherSetting.value.assetsBatchGenereateSize }),
  );

  try {
    await axios.post("/assetsGenerate/batchGenerateImageAssets", {
      projectId: project.value?.id,
      model: selectValue.value,
      resolution: resolution.value,
      concurrentCount: otherSetting.value.assetsBatchGenereateSize,
      templateId: selectedReasoningTemplateId.value,
      items: items.map((item) => ({
        id: item.id,
        type: item.type ?? "props",
        name: item.name ?? $t("workbench.cornerScape.unnamed"),
        prompt: item.prompt,
      })),
    });
  } catch (e: any) {
    if (e.name === "CanceledError" || e.code === "ERR_CANCELED") return;
    window.$message.error(e.message ?? $t("workbench.cornerScape.msg.batchFailed"));
  }
}
//轮询
const notCompultedData = computed(() => {
  return dataList.value.filter((item) => item.promptState == "生成中");
});
const generatingData = computed(() => {
  return dataList.value.filter((item) => item.state === "生成中");
});
// 轮询相关
let pollingTimer: ReturnType<typeof setInterval> | null = null;
let imagePollingTimer: ReturnType<typeof setInterval> | null = null;
//轮询提示词生成
async function pollingPromptAssets() {
  if (notCompultedData.value.length === 0) return;
  const ids = notCompultedData.value.map((item) => item.id);
  try {
    const { data } = await axios.post("/assets/pollingPromptAssets", { ids });
    let hasCompleted = false;
    if (Array.isArray(data) && data.length) {
      data.forEach((item: { id: number; promptState: string; originalPrompt?: string; prompt: string }) => {
        const target = dataList.value.find((row) => row.id === item.id);
        if (target) {
          if (target.promptState === "生成中" && item.promptState !== "生成中") hasCompleted = true;
          target.promptState = item.promptState;
          if (item.originalPrompt !== undefined) target.originalPrompt = item.originalPrompt;
          if (item.prompt !== undefined) target.prompt = item.prompt;
        }
      });
    }
    // 有提示词生成完成时，重新获取完整数据以刷新 historyImages
    if (hasCompleted) {
      try {
        const { data: freshData } = await axios.post("/cornerScape/getAllAssets", {
          projectId: project.value?.id,
          type: checkboxValue.value,
        });
        const normalizedFreshData = (freshData as DataItem[]).map(normalizeAssetMedia);
        normalizedFreshData.forEach((fresh) => {
          const target = dataList.value.find((row) => row.id === fresh.id);
          if (target) Object.assign(target, fresh);
        });
        // 同步更新抽屉中的当前项
        if (currentItem.value) {
          const freshCurrent = normalizedFreshData.find((d) => d.id === currentItem.value!.id);
          if (freshCurrent) {
            currentItem.value = freshCurrent;
            editForm.originalPrompt = freshCurrent.originalPrompt || freshCurrent.prompt || "";
            editForm.prompt = freshCurrent.prompt || "";
          }
        }
      } catch (e) {
        console.error("刷新历史图片失败:", e);
      }
    }
  } catch (e) {
    console.error("轮询提示词状态失败:", e);
  }
}
//轮询图片生成
async function pollingImageAssets() {
  if (generatingData.value.length === 0) return;
  const ids = generatingData.value.map((item) => item.id);
  try {
    const { data } = await axios.post("/assets/pollingImageAssets", { ids });
    let hasCompleted = false;
    if (Array.isArray(data) && data.length) {
      data.forEach((item: { id: number; state: string; filePath: string }) => {
        const target = dataList.value.find((row) => row.id === item.id);
        if (target) {
          if (target.state === "生成中" && item.state !== "生成中") hasCompleted = true;
          target.state = item.state;
          if (item.filePath !== undefined) target.filePath = resolveAssetMediaUrl(item.filePath) || null;
        }
      });
    }
    // 有图片生成完成时，重新获取完整数据以刷新 historyImages
    if (hasCompleted) {
      try {
        const { data: freshData } = await axios.post("/cornerScape/getAllAssets", {
          projectId: project.value?.id,
          type: checkboxValue.value,
        });
        const normalizedFreshData = (freshData as DataItem[]).map(normalizeAssetMedia);
        normalizedFreshData.forEach((fresh) => {
          const target = dataList.value.find((row) => row.id === fresh.id);
          if (target) target.historyImages = fresh.historyImages;
        });
        // 同步更新抽屉中的当前项
        if (currentItem.value) {
          const freshCurrent = normalizedFreshData.find((d) => d.id === currentItem.value!.id);
          if (freshCurrent) currentItem.value.historyImages = freshCurrent.historyImages;
        }
      } catch (e) {
        console.error("刷新历史图片失败:", e);
      }
    }
  } catch (e) {
    console.error("轮询图片生成状态失败:", e);
  }
}
function startPolling() {
  if (pollingTimer) return;
  pollingTimer = setInterval(async () => {
    if (notCompultedData.value.length === 0) {
      stopPolling();
      return;
    }
    await pollingPromptAssets();
  }, 3000);
}

function stopPolling() {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }
}

function startImagePolling() {
  if (imagePollingTimer) return;
  imagePollingTimer = setInterval(async () => {
    if (generatingData.value.length === 0) {
      stopImagePolling();
      return;
    }
    await pollingImageAssets();
  }, 3000);
}

function stopImagePolling() {
  if (imagePollingTimer) {
    clearInterval(imagePollingTimer);
    imagePollingTimer = null;
  }
}

watch(notCompultedData, (val) => {
  if (val.length > 0) {
    startPolling();
  } else {
    stopPolling();
  }
});

watch(generatingData, (val) => {
  if (val.length > 0) {
    startImagePolling();
  } else {
    stopImagePolling();
  }
});

watch(useReferenceImage, (enabled) => {
  if (enabled && !referenceImageId.value && !referenceUploadBase64.value && currentItem.value?.imageId) {
    useCurrentImageAsReference();
  }
});
</script>

<style lang="scss" scoped>
.cornerScape {
  width: 100%;
  height: 100%;
  min-height: 0;
  align-items: flex-start;
  .left {
    overflow: hidden;
    width: clamp(240px, 22vw, 320px);
    height: fit-content;
    min-height: 0;
    flex-shrink: 0;
    margin-right: 16px;
    margin-bottom: 16px;
    display: flex;
    flex-direction: column;
    .card {
      height: 100%;
      min-height: 0;
      display: flex;
      flex-direction: column;
      :deep(.t-card__body) {
        flex: 1;
        min-height: 0;
        overflow: auto;
      }
    }
    :deep(.t-form) {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    :deep(.t-form__item) {
      margin-bottom: 0;
    }
    .quickActions {
      display: flex;
      flex-direction: column;
      gap: 10px;
      width: 100%;
      :deep(.t-button) {
        width: 100%;
      }
    }
    .filterGroup {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
  }
  .content {
    overflow: auto;
    height: 100%;
    width: 100%;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(270px, 1fr));
    align-items: start;
    align-content: start;
    gap: 16px;
    .card {
      cursor: pointer;
      width: 100%;
      height: 100%;
      display: flex;
      flex-direction: column;
      :deep(.t-card__body) {
        flex: 1;
        min-height: 0;
        display: flex;
        flex-direction: column;
      }
      .imageBox {
        position: relative;
        width: 100%;
        height: 160px;
        background-color: #f5f7fa;
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        .selectBox {
          position: absolute;
          top: 8px;
          left: 8px;
          z-index: 10;
        }
        .generatingBox {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 12px;
          width: 100%;
          height: 100%;
          background: linear-gradient(135deg, #f0f4ff 0%, #e8f0fe 100%);
          .generatingText {
            font-size: 13px;
            color: var(--td-brand-color);
            letter-spacing: 0.05em;
          }
        }
        .image {
          width: 100%;
          height: 100%;
          :deep(.t-image__img) {
            width: 100%;
            height: 100%;
            object-fit: contain;
          }
        }
        .imageToolsWrap {
          opacity: 0;
          pointer-events: none;
          transition: opacity 0.2s ease;
        }
        :deep(.t-empty) {
          width: 100%;
        }
      }
      &:hover {
        .imageToolsWrap {
          opacity: 1;
          pointer-events: auto;
        }
      }
      .infoBox {
        flex: 1;
        padding: 8px 0;
        overflow: hidden;
        cursor: pointer;
        .title {
          font-size: 14px;
          font-weight: 600;
          line-height: 1.5;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .meta {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          margin-top: 4px;
          .typeTag {
            flex-shrink: 0;
          }
          .stateTag {
            flex-shrink: 0;
          }
          .modelTag {
            min-width: 0;
            max-width: 100%;
            overflow: hidden;
            :deep(.t-tag__text) {
              overflow: hidden;
              text-overflow: ellipsis;
              white-space: nowrap;
            }
          }
        }
        .prompt {
          margin-top: 4px;
          font-size: 12px;
          color: var(--td-text-color-secondary);
          line-height: 1.5;
          overflow: hidden;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          line-clamp: 2;
          -webkit-box-orient: vertical;
        }
      }
    }
  }
}

.styleControl {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;

  :deep(.t-popup) {
    flex: 1;
    min-width: 0;
  }
}

.styleTrigger {
  width: 100%;
  height: 54px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid var(--td-component-border);
  border-radius: 4px;
  background: var(--td-bg-color-container);
  color: var(--td-text-color-primary);
  cursor: pointer;
  text-align: left;

  &:hover {
    border-color: var(--td-brand-color);
  }

  img,
  .styleTriggerPlaceholder {
    width: 40px;
    height: 40px;
    flex: 0 0 40px;
    border-radius: 4px;
    object-fit: cover;
  }

  .styleTriggerPlaceholder {
    display: grid;
    place-items: center;
    background: var(--td-bg-color-secondarycontainer);
    color: var(--td-text-color-placeholder);
  }

  .styleTriggerText {
    min-width: 0;
    flex: 1;
    display: flex;
    flex-direction: column;

    strong,
    small {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    strong {
      font-size: 13px;
      line-height: 20px;
    }

    small {
      color: var(--td-text-color-secondary);
      font-size: 11px;
      line-height: 16px;
    }
  }
}

.stylePickerPanel {
  width: min(620px, calc(100vw - 32px));
  max-height: min(620px, calc(100vh - 120px));
  padding: 12px;
  overflow: hidden;
  background: var(--td-bg-color-container);
}

.stylePickerToolbar {
  display: grid;
  grid-template-columns: minmax(220px, 1fr) auto;
  gap: 10px;
  margin-bottom: 12px;
}

.styleGrid {
  max-height: 500px;
  overflow: auto;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.styleCard {
  min-width: 0;
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 5px;
  border: 1px solid var(--td-component-border);
  border-radius: 6px;
  background: var(--td-bg-color-container);
  color: var(--td-text-color-primary);
  cursor: pointer;
  text-align: left;

  &:hover,
  &.active {
    border-color: var(--td-brand-color);
  }

  &.active {
    box-shadow: 0 0 0 1px var(--td-brand-color) inset;
  }

  strong {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
    line-height: 20px;
  }

  small {
    height: 34px;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    color: var(--td-text-color-secondary);
    font-size: 11px;
    line-height: 17px;
  }
}

.styleCover {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  display: grid;
  place-items: center;
  overflow: hidden;
  border-radius: 4px;
  background: var(--td-bg-color-secondarycontainer);
  color: var(--td-text-color-placeholder);

  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
}

.favoriteButton {
  position: absolute;
  top: 5px;
  right: 5px;
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.9);
  color: #5f6368;

  &.active {
    color: #d88700;
  }
}

.drawerHeader {
  display: flex;
  align-items: center;
  gap: 8px;
}

.drawerImageBox {
  width: 100%;
  min-height: 120px;
  max-height: 400px;
  background-color: #f5f7fa;
  border-radius: 6px;
  margin-bottom: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  position: relative;
  .drawerPreviewTrigger {
    width: 100%;
    height: 100%;
    min-height: 120px;
    cursor: zoom-in;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .image {
    width: 100%;
    height: auto;
    :deep(.t-image__img) {
      max-height: 400px;
      object-fit: contain;
    }
  }
  .generatingBox {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    .generatingText {
      font-size: 13px;
      color: var(--td-brand-color);
    }
  }
  .imageToolsWrap {
    opacity: 1;
    pointer-events: auto;
  }
}

.historySection {
  width: 100%;
  min-width: 0;
}

.historyImageList {
  display: flex;
  gap: 10px;
  overflow-x: auto;
  overflow-y: hidden;
  max-width: 100%;
  width: 100%;
  min-width: 0;
  flex-shrink: 1;
  padding-bottom: 4px;

  &::-webkit-scrollbar {
    height: 6px;
  }
  &::-webkit-scrollbar-thumb {
    background: #c1c1c1;
    border-radius: 4px;
  }
  &::-webkit-scrollbar-track {
    background: transparent;
  }
}

.historyActions,
.referenceActions {
  width: 100%;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}

.historyImageItem {
  border-radius: 4px;
  border: 3px solid transparent;
  cursor: pointer;
  transition: border-color 0.2s;
  flex-shrink: 0;
  overflow: hidden;

  &:hover {
    border-color: var(--td-brand-color-light);
  }
  &.selected {
    border-color: var(--td-brand-color);
  }
}

.referenceControl {
  width: 100%;
  padding: 10px;
  border: 1px solid var(--td-component-border);
  border-radius: 6px;
}

.voiceReferenceControl {
  width: 100%;
  padding: 10px;
  border: 1px solid var(--td-component-border);
  border-radius: 6px;
  background: var(--td-bg-color-container);

  audio {
    display: block;
    width: 100%;
    height: 36px;
  }
}

.voiceReferenceEmpty {
  min-height: 36px;
  display: flex;
  align-items: center;
  color: var(--td-text-color-secondary);
  font-size: 12px;
}

.voiceReferenceActions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}

.voiceReferenceName {
  min-width: 0;
  max-width: 210px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--td-text-color-secondary);
  font-size: 12px;
  margin-right: auto;
}

.referenceToggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 24px;
}

.referenceSource {
  margin-top: 10px;
}

.referencePreview {
  width: 100%;
  height: 150px;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-radius: 4px;
  background: var(--td-bg-color-secondarycontainer);

  img {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
}

.promptReasoningBar {
  display: flex;
  align-items: end;
  gap: 10px;
  width: 100%;
  margin-bottom: 10px;
  .promptReasoningSelect {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
    span {
      color: var(--td-text-color-secondary);
      font-size: 12px;
      line-height: 1.2;
    }
    :deep(.t-select) {
      width: 100%;
    }
  }
  :deep(.t-button) {
    flex: 0 0 auto;
    white-space: nowrap;
  }
}

.drawerActions {
  display: flex;
  gap: 8px;
  width: 100%;
  :deep(.t-button) {
    flex: 1;
  }
}

.templateLibraryIntro {
  color: var(--td-text-color-secondary);
  font-size: 13px;
  line-height: 1.6;
  margin-bottom: 14px;
}

.templateLibraryList {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  max-height: 230px;
  overflow-y: auto;
  margin-bottom: 18px;
}

.templateLibraryItem {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 5px;
  min-height: 94px;
  padding: 12px;
  border: 1px solid var(--td-component-border);
  border-radius: 6px;
  background: var(--td-bg-color-container);
  text-align: left;
  cursor: pointer;
  transition: border-color 0.2s, background-color 0.2s;

  &:hover,
  &.active {
    border-color: var(--td-brand-color);
    background: var(--td-brand-color-light);
  }

  strong {
    color: var(--td-text-color-primary);
  }

  span,
  small {
    color: var(--td-text-color-secondary);
    font-size: 12px;
    line-height: 1.45;
  }
}

.caseTemplateForm {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 14px;
  border-top: 1px solid var(--td-component-border);
}

.caseTemplateTitle {
  color: var(--td-text-color-primary);
  font-weight: 600;
}

.caseTemplateActions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  position: sticky;
  bottom: 0;
  padding: 10px 0 2px;
  background: var(--td-bg-color-container);
}

@media (max-width: 720px) {
  .stylePickerToolbar {
    grid-template-columns: 1fr;
  }

  .styleGrid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .templateLibraryList {
    grid-template-columns: 1fr;
  }
}
</style>
