/**
 * AutoDL.Art ComfyUI API provider.
 *
 * AutoDL exposes a workflow as an asynchronous task API rather than a
 * regular ComfyUI /prompt endpoint. The modelName is therefore the workflow
 * id shown by AutoDL and the request body contains the workflow's public
 * parameters.
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

const vendor = {
  id: "autodl-comfyui",
  version: "1.0.0",
  author: "Toonflow",
  name: "AutoDL.Art · ComfyUI 云端 API",
  description: [
    "通过 AutoDL.Art ComfyUI API 调用云端工作流。",
    "请在 AutoDL.Art 令牌管理中创建 ComfyUI 分组 Token，并填入工作流 ID。",
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
      modelName: "minimax_h3_image_audio_to_video",
      type: "video",
      mode: [["imageReference:9", "audioReference:3", "textReference"]],
      audio: "optional",
      durationResolutionMap: [{ duration: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480p横", "480p竖", "720p横", "720p竖"] }],
    },
    {
      name: "H3多图生视频 15 秒",
      modelName: "minimax_h3_lightx2v_v5_15s",
      type: "video",
      mode: [["imageReference:9"]],
      audio: false,
      durationResolutionMap: [{ duration: [15], resolution: ["480p横", "480p竖", "720p横", "720p竖"] }],
    },
    {
      name: "H3多图多音频生视频",
      modelName: "minimax_h3_image_audio_to_video_v5",
      type: "video",
      mode: [["imageReference:9", "audioReference:3", "textReference"]],
      audio: "optional",
      durationResolutionMap: [{ duration: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480p横", "480p竖", "720p横", "720p竖"] }],
    },
    {
      name: "H3图生视频·音频同步",
      modelName: "minimax_h3_image_audio_to_video_sync",
      type: "video",
      mode: ["singleImage", "startEndRequired"],
      audio: "optional",
      durationResolutionMap: [{ duration: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480p横", "480p竖", "720p横", "720p竖"] }],
    },
    {
      name: "H3多图参考生视频",
      modelName: "minimax_h3_lightx2v_v5",
      type: "video",
      mode: [["imageReference:9"]],
      audio: false,
      durationResolutionMap: [{ duration: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480p横", "480p竖", "720p横", "720p竖"] }],
    },
    {
      name: "H3文生视频",
      modelName: "minimax_h3_lightx2v_no_pic",
      type: "video",
      mode: ["text"],
      audio: false,
      durationResolutionMap: [{ duration: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480p横", "480p竖", "720p横", "720p竖"] }],
    },
    {
      name: "H3首尾帧生视频",
      modelName: "minimax_h3_lightx2v",
      type: "video",
      mode: ["startEndRequired", "endFrameOptional", "startFrameOptional"],
      audio: false,
      durationResolutionMap: [{ duration: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480p横", "480p竖", "720p横", "720p竖"] }],
    },
    {
      name: "indexxts2",
      modelName: "indexxts2-v1",
      type: "video",
      mode: ["text"],
      audio: false,
      durationResolutionMap: [{ duration: [1, 2, 3, 4, 5], resolution: ["480p横", "480p竖"] }],
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

const readResponseError = (data: any) =>
  data?.msg || data?.message || data?.data?.message || data?.data?.error || "AutoDL ComfyUI 请求失败";

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

const buildBody = (config: VideoConfig) => {
  const parameters = { ...(config.parameters || {}) };
  const body: Record<string, any> = {
    prompt: String(config.prompt || "").trim(),
    duration: Math.max(1, Math.round(Number(config.duration) || 5)),
    resolution: config.resolution || (config.aspectRatio === "9:16" ? "480p竖" : "480p横"),
  };
  if (typeof config.audio === "boolean") body.generate_audio = config.audio;
  // AutoDL 工作流参数会随工作流变化；只在有素材时传递常见字段，
  // 其余字段由模型设置中的 parameters 透传，方便用户按在线调用示例补充。
  const typedReferences = (config.referenceList || []).filter((item) => item.base64);
  const referenceImages = typedReferences.filter((item) => item.type === "image").map((item) => item.base64);
  const referenceAudio = typedReferences.filter((item) => item.type === "audio").map((item) => item.base64);
  const referenceVideo = typedReferences.filter((item) => item.type === "video").map((item) => item.base64);
  const images = (config.imageBase64 || []).filter(Boolean);
  const allImages = referenceImages.length ? referenceImages : images;
  if (allImages.length) body.images = allImages;
  if (referenceAudio.length) body.audios = referenceAudio;
  if (referenceVideo.length) body.videos = referenceVideo;
  Object.assign(body, parameters);
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
  if (!String(config.prompt || "").trim()) throw new Error("请先填写视频提示词");
  const taskId = await submitTask(model.modelName, buildBody(config));
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
