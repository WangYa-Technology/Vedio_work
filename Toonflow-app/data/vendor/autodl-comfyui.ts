/**
 * AutoDL.Art ComfyUI API provider.
 *
 * AutoDL 把平台上的 ComfyUI 工作流包装成异步任务 API：modelName 即工作流 ID，
 * 请求体只接受该工作流声明过的公开参数，且参数名随工作流而异：
 * - 多图/多音频：ref_image_0..ref_image_8、ref_audio_0..ref_audio_2、prompt、duration、resolution、seed
 * - 首尾帧：first_frame、last_frame、prompt、duration、resolution、seed
 * - 对口型：ref_image_0、ref_audio_0、audio_duration、resolution
 * 提交未声明的参数会被平台以“存在未定义的参数”拒绝；工作流 ID 在平台不存在或被下线
 * 时返回“工作流不可用”。因此模型列表的 modelName 必须与 AutoDL.Art 工作流页面中的 ID 完全一致。
 */

interface VideoModel {
  name: string;
  modelName: string;
  type: "video";
  mode: any[];
  audio: "optional" | false | true;
  durationResolutionMap: { duration: number[]; resolution: string[] }[];
}

interface VideoConfig {
  prompt: string;
  duration: number;
  resolution: string;
  aspectRatio: "16:9" | "9:16";
  imageBase64?: string[];
  referenceList?: Array<{ type: "image" | "video" | "audio"; base64: string }>;
  audio?: boolean;
  mode?: string | string[];
  parameters?: Record<string, string | number | boolean>;
}

interface PollResult {
  completed: boolean;
  data?: string;
  error?: string;
}

declare const axios: any;
declare const pollTask: (fn: () => Promise<PollResult>, interval?: number, timeout?: number) => Promise<PollResult>;
declare const urlToBase64: (url: string) => Promise<string>;
declare const logger: (message: string) => void;
declare const exports: any;

const DEFAULT_BASE_URL = "https://autodl.art";
const MAX_REFERENCE_IMAGES = 9;
const MAX_REFERENCE_AUDIOS = 3;

// 时长档位与分辨率档位都来自各工作流的公开参数定义，超出范围的取值会被平台拒绝。
const DURATION_UP_TO_10 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const DURATION_UP_TO_15 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
const RESOLUTION_HV_480_768_1080 = ["480p竖", "768p竖", "1080p竖", "480p横", "768p横", "1080p横"];
const RESOLUTION_HV_480_768 = ["480p竖", "768p竖", "480p横", "768p横"];
const RESOLUTION_HV_SQUARE_480_768 = ["480p竖", "768p竖", "480p横", "768p横", "480p(1:1)", "768p(1:1)"];
const RESOLUTION_HV_SQUARE_480_768_1080 = [
  "480p竖",
  "768p竖",
  "1080p竖",
  "480p横",
  "768p横",
  "1080p横",
  "480p(1:1)",
  "768p(1:1)",
  "1080p(1:1)",
];

// 工作流家族决定提交哪些参数：平台只接受工作流自己声明过的入参。
type WorkflowKind = "multimodal" | "multiImage" | "startEnd" | "text" | "lipsync";

const WORKFLOW_KINDS: Record<string, WorkflowKind> = {
  minimax_h3_image_audio_to_video_v2: "multimodal",
  minimax_h3_image_audio_to_video_v2_15s: "multimodal",
  minimax_h3_zm_u24: "multimodal",
  minimax_h3_zm_u08: "multimodal",
  minimax_h3_lightx2v_v5: "multiImage",
  minimax_h3_lightx2v_v5_15s: "multiImage",
  minimax_h3_lightx2v: "startEnd",
  minimax_h3_lightx2v_no_pic: "text",
  minimax_h3_image_audio_to_video: "lipsync",
};

const DEFAULT_WORKFLOW_KIND: WorkflowKind = "multimodal";

const vendor = {
  id: "autodl-comfyui",
  version: "1.1.0",
  author: "Toonflow",
  name: "AutoDL.Art · ComfyUI 云端 API",
  description: [
    "通过 AutoDL.Art ComfyUI API 调用云端工作流。",
    "请在 AutoDL.Art 令牌管理中创建 ComfyUI 分组 Token（分组必须选 ComfyUI）。",
    "模型列表中的工作流 ID 必须与 AutoDL.Art「ComfyUI 工作流」页面右侧抽屉里显示的 ID 完全一致；工作流被作者下线或改名后，提交会返回“工作流不可用”。",
    "[查看 ComfyUI API 文档](https://autodl.art/docs/comfyui_api/)",
  ].join("\n\n"),
  inputs: [
    {
      key: "apiKey",
      label: "AutoDL ComfyUI Token",
      type: "password",
      required: true,
      placeholder: "在 AutoDL.Art 令牌管理中创建 ComfyUI Token",
    },
    {
      key: "baseUrl",
      label: "AutoDL API 地址",
      type: "url",
      required: true,
      placeholder: "https://autodl.art",
    },
  ],
  inputValues: {
    apiKey: "",
    baseUrl: DEFAULT_BASE_URL,
  },
  models: [
    {
      name: "H3多图多音频生视频",
      modelName: "minimax_h3_image_audio_to_video_v2",
      type: "video",
      mode: [["imageReference:9", "audioReference:3", "textReference"]],
      audio: "optional",
      durationResolutionMap: [{ duration: DURATION_UP_TO_10, resolution: RESOLUTION_HV_480_768_1080 }],
    },
    {
      name: "H3多图多音频生视频 15 秒",
      modelName: "minimax_h3_image_audio_to_video_v2_15s",
      type: "video",
      mode: [["imageReference:9", "audioReference:3", "textReference"]],
      audio: "optional",
      durationResolutionMap: [{ duration: DURATION_UP_TO_15, resolution: RESOLUTION_HV_480_768 }],
    },
    {
      name: "H3多图多音频生视频 · 升级画质",
      modelName: "minimax_h3_zm_u24",
      type: "video",
      mode: [["imageReference:9", "audioReference:3", "textReference"]],
      audio: "optional",
      durationResolutionMap: [{ duration: DURATION_UP_TO_15, resolution: RESOLUTION_HV_SQUARE_480_768 }],
    },
    {
      name: "H3多图多音频生视频 · 高速版",
      modelName: "minimax_h3_zm_u08",
      type: "video",
      mode: [["imageReference:9", "audioReference:3", "textReference"]],
      audio: "optional",
      durationResolutionMap: [{ duration: DURATION_UP_TO_15, resolution: RESOLUTION_HV_SQUARE_480_768 }],
    },
    {
      name: "H3多图参考生视频",
      modelName: "minimax_h3_lightx2v_v5",
      type: "video",
      mode: [["imageReference:9"]],
      audio: false,
      durationResolutionMap: [{ duration: DURATION_UP_TO_10, resolution: RESOLUTION_HV_SQUARE_480_768_1080 }],
    },
    {
      name: "H3多图生视频 15 秒",
      modelName: "minimax_h3_lightx2v_v5_15s",
      type: "video",
      mode: [["imageReference:9"]],
      audio: false,
      durationResolutionMap: [{ duration: DURATION_UP_TO_15, resolution: RESOLUTION_HV_SQUARE_480_768 }],
    },
    {
      name: "H3首尾帧生视频",
      modelName: "minimax_h3_lightx2v",
      type: "video",
      mode: ["startEndRequired"],
      audio: false,
      durationResolutionMap: [{ duration: DURATION_UP_TO_15, resolution: RESOLUTION_HV_SQUARE_480_768 }],
    },
    {
      name: "H3文生视频",
      modelName: "minimax_h3_lightx2v_no_pic",
      type: "video",
      mode: ["text"],
      audio: false,
      durationResolutionMap: [{ duration: DURATION_UP_TO_15, resolution: RESOLUTION_HV_SQUARE_480_768 }],
    },
    {
      name: "H3图生视频 · 音频同步（自动对口型）",
      modelName: "minimax_h3_image_audio_to_video",
      type: "video",
      mode: ["singleImage", "audioReference:1"],
      audio: "optional",
      durationResolutionMap: [{ duration: DURATION_UP_TO_15, resolution: RESOLUTION_HV_480_768_1080 }],
    },
  ] as VideoModel[],
};

const getApiKey = () => {
  const key = String(vendor.inputValues.apiKey || "").trim();
  if (!key) throw new Error("请先填写 AutoDL ComfyUI Token");
  return key;
};

const getBaseUrl = () => String(vendor.inputValues.baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");

const getHeaders = () => ({
  Authorization: getApiKey(),
  "Content-Type": "application/json",
});

// 平台错误体形如 { code: "InternalError", msg: "工作流不可用" }；
// 带上 code 便于区分“参数不合法”和“工作流不可用”这两类失败。
const readResponseError = (data: any) => {
  const message = data?.msg || data?.message || data?.data?.message || data?.data?.error || "AutoDL ComfyUI 请求失败";
  const code = String(data?.code || "").trim();
  return code && code !== "Success" ? `${message}（${code}）` : message;
};

const normalizeResultUrl = (value: any): string | undefined => {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return undefined;
  return value.url || value.uri || value.file_url || value.fileUrl || value.download_url || value.result_url || value.video_url || value.image_url;
};

const submitTask = async (workflowId: string, body: Record<string, any>) => {
  const response = await axios.post(
    `${getBaseUrl()}/api/v1/comfyui/comfyui_workflow/${encodeURIComponent(workflowId)}`,
    body,
    { headers: getHeaders(), timeout: 120000 },
  );
  const data = response.data;
  const taskId = data?.data?.task_id || data?.task_id;
  if (!taskId) throw new Error(`AutoDL 任务提交失败：${readResponseError(data)}`);
  logger(`[AutoDL ComfyUI] 已提交 ${workflowId}，task_id=${taskId}`);
  return String(taskId);
};

const queryTask = async (taskId: string): Promise<PollResult> => {
  const response = await axios.get(
    `${getBaseUrl()}/api/v1/comfyui/comfyui_workflow/result/${encodeURIComponent(taskId)}`,
    { headers: getHeaders(), timeout: 120000 },
  );
  const data = response.data;
  const task = data?.data || data;
  const status = String(task?.status || "").toUpperCase();
  if (["FAILED", "ERROR", "CANCELED", "CANCELLED"].includes(status)) {
    return { completed: true, error: `AutoDL 工作流执行失败：${readResponseError(data)}` };
  }
  if (status !== "SUCCESS" && status !== "SUCCEEDED" && status !== "COMPLETED") return { completed: false };
  const resultItems = Array.isArray(task?.results)
    ? task.results
    : task?.results
      ? [task.results]
      : [];
  const result = resultItems
    .map(normalizeResultUrl)
    .find(Boolean);
  if (!result) return { completed: true, error: "AutoDL 工作流成功但未返回结果 URL" };
  return { completed: true, data: result };
};

const resolveWorkflowKind = (model: VideoModel): WorkflowKind =>
  WORKFLOW_KINDS[model?.modelName] || DEFAULT_WORKFLOW_KIND;

// 参考素材统一在这里取值：优先使用带类型的 referenceList，退回旧的 imageBase64。
const collectReferences = (config: VideoConfig) => {
  const typedReferences = (config.referenceList || []).filter((item) => item?.base64);
  const typedImages = typedReferences.filter((item) => item.type === "image").map((item) => item.base64);
  const audios = typedReferences.filter((item) => item.type === "audio").map((item) => item.base64);
  const images = typedImages.length ? typedImages : (config.imageBase64 || []).filter(Boolean);
  return { images, audios };
};

const buildBody = (config: VideoConfig, model: VideoModel) => {
  const kind = resolveWorkflowKind(model);
  const { images, audios } = collectReferences(config);
  const duration = Math.max(1, Math.round(Number(config.duration) || 5));
  const resolution = config.resolution || (config.aspectRatio === "9:16" ? "480p竖" : "480p横");
  const body: Record<string, any> = {};

  if (kind === "lipsync") {
    // 对口型工作流没有 prompt/duration 参数：音频时长即生成时长。
    if (!images.length) throw new Error("“H3图生视频 · 音频同步”需要 1 张参考图片，请先在参考素材中选择图片");
    if (!audios.length) throw new Error("“H3图生视频 · 音频同步”需要 1 段参考音频，请先在参考素材中选择音频");
    body.ref_image_0 = images[0];
    body.ref_audio_0 = audios[0];
    body.audio_duration = duration;
    body.resolution = resolution;
  } else {
    body.prompt = String(config.prompt || "").trim();
    body.duration = duration;
    body.resolution = resolution;

    if (kind === "startEnd") {
      if (images.length < 2) throw new Error("“H3首尾帧生视频”需要首帧与尾帧两张参考图片，请先在参考素材中选择两张图片");
      body.first_frame = images[0];
      body.last_frame = images[1];
    } else if (kind !== "text") {
      images
        .slice(0, MAX_REFERENCE_IMAGES)
        .forEach((value, index) => {
          body[`ref_image_${index}`] = value;
        });
      if (kind === "multimodal") {
        audios
          .slice(0, MAX_REFERENCE_AUDIOS)
          .forEach((value, index) => {
            body[`ref_audio_${index}`] = value;
          });
      }
    }
  }

  // 模型设置中的 parameters 作为安全可调项透传（例如 seed），放在最后以允许覆盖默认值。
  Object.assign(body, config.parameters || {});
  return body;
};

const textRequest = () => {
  throw new Error("AutoDL ComfyUI API 仅支持工作流图像/视频模型");
};

const imageRequest = async (config: any, model: any) => {
  const taskId = await submitTask(model.modelName, {
    prompt: String(config.prompt || "").trim(),
    resolution: config.size || "1K",
    ...(config.imageBase64?.length ? { images: config.imageBase64 } : {}),
  });
  const result = await pollTask(() => queryTask(taskId), 2000, 90 * 60 * 1000);
  if (result.error) throw new Error(result.error);
  if (!result.data) throw new Error("AutoDL 图片工作流未返回结果");
  return result.data;
};

const videoRequest = async (config: VideoConfig, model: VideoModel) => {
  const kind = resolveWorkflowKind(model);
  if (kind !== "lipsync" && !String(config.prompt || "").trim()) throw new Error("请先填写视频提示词");
  const taskId = await submitTask(model.modelName, buildBody(config, model));
  const result = await pollTask(() => queryTask(taskId), 2000, 90 * 60 * 1000);
  if (result.error) throw new Error(result.error);
  if (!result.data) throw new Error("AutoDL 视频工作流未返回结果");
  return result.data;
};

const ttsRequest = () => {
  throw new Error("AutoDL ComfyUI API 不支持语音模型");
};

exports.vendor = vendor;
exports.textRequest = textRequest;
exports.imageRequest = imageRequest;
exports.videoRequest = videoRequest;
exports.ttsRequest = ttsRequest;
