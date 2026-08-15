/**
 * HC 异步生图供应商
 * 通过任务 ID 轮询方式支持 Toonflow 的批量图片生成。
 */

interface ImageModel {
  name: string;
  modelName: string;
  type: "image";
  mode: ("text" | "singleImage" | "multiReference")[];
}

interface ImageConfig {
  prompt: string;
  referenceList?: { type: "image"; base64: string }[];
  size: "1K" | "2K" | "4K";
  aspectRatio: `${number}:${number}`;
}

interface PollResult {
  completed: boolean;
  data?: string;
  error?: string;
}

declare const axios: any;
declare const Buffer: any;
declare const FormData: any;
declare const logger: (msg: string) => void;
declare const pollTask: (fn: () => Promise<PollResult>, interval?: number, timeout?: number) => Promise<PollResult>;
declare const urlToBase64: (url: string) => Promise<string>;
declare const prepareImageForUpload: (dataUrl: string, options?: { maxBytes?: number; maxDimension?: number }) => Promise<string>;
declare const exports: any;

const vendor = {
  id: "hc-image",
  version: "2.0",
  author: "HC",
  name: "HC 异步生图",
  description: "使用 gpt-image-2 异步任务接口。批量生成会按设置的并发数提交任务并轮询结果。",
  icon: "",
  inputs: [
    { key: "apiKey", label: "HC API 密钥", type: "password", required: true, placeholder: "HC_IMAGE_API_KEY" },
    { key: "baseUrl", label: "请求地址", type: "url", required: true, placeholder: "https://api.hctopup.com/v1" },
  ],
  inputValues: {
    apiKey: "",
    baseUrl: "https://api.hctopup.com/v1",
  },
  models: [
    {
      name: "GPT Image 2（异步）",
      modelName: "gpt-image-2",
      type: "image",
      mode: ["text", "singleImage", "multiReference"],
    },
  ],
};

const unsupported = (feature: string) => {
  throw new Error(`HC 异步生图供应商不支持${feature}`);
};

const textRequest = () => unsupported("文本模型");
const videoRequest = () => unsupported("视频模型");
const ttsRequest = () => unsupported("语音模型");

const parseReferenceImage = (dataUrl: string, index: number) => {
  const matched = /^data:([^;]+);base64,(.+)$/i.exec(dataUrl);
  const mimeType = matched?.[1] || "image/png";
  const base64 = matched?.[2] || dataUrl;
  const extensionMap: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
  };
  return {
    buffer: Buffer.from(base64, "base64"),
    mimeType,
    filename: `toonflow-hc-reference-${Date.now()}-${index}.${extensionMap[mimeType] || "png"}`,
  };
};

/**
 * 将 HC/axios 的结构化错误转换成可直接展示给用户的文本。
 * 不要只使用 AxiosError.message（通常只有“Request failed with status code 400”），
 * 否则内容安全拦截、上游错误码等关键信息会丢失。
 */
const formatHcError = (error: any, fallback = "HC 异步生图请求失败") => {
  const responseData = error?.response?.data;
  const payload = responseData?.error || responseData?.data?.error || responseData;
  const code = payload?.code || payload?.type || responseData?.code || error?.code;
  const message = payload?.message || payload?.error?.message || responseData?.message || error?.message;
  if (code && message && String(message) !== String(code)) return `${code}: ${message}`;
  if (message) return String(message);
  if (code) return String(code);
  if (typeof responseData === "string" && responseData.trim()) return responseData;
  return fallback;
};

const formatHcTaskError = (data: any, fallback = "异步图片任务失败") => {
  const payload = data?.error || data?.data?.error || data?.result?.error || data?.data?.result?.error;
  const code = payload?.code || payload?.type || data?.error_code || data?.data?.error_code;
  const message = payload?.message || payload?.error?.message || data?.message || data?.data?.message;
  if (code && message && String(message) !== String(code)) return `${code}: ${message}`;
  if (message) return String(message);
  if (code) return String(code);
  return fallback;
};

// 只重试尚未收到响应的瞬时传输错误。HC 的接口没有声明幂等键，
// 因此最多补发一次，避免连接异常时无限创建重复任务。
const isRetryableSubmitError = (error: any) => {
  const code = String(error?.code || "").toUpperCase();
  const message = String(error?.message || "").toUpperCase();
  return ["ECONNRESET", "EPIPE", "ETIMEDOUT", "ECONNABORTED", "EAI_AGAIN"].includes(code) ||
    message.includes("ECONNRESET") ||
    message.includes("EPIPE") ||
    message.includes("BAD RECORD MAC");
};

const waitBeforeRetry = async (delay: number) => {
  let waiting = true;
  await pollTask(
    async () => {
      if (waiting) {
        waiting = false;
        return { completed: false };
      }
      return { completed: true };
    },
    delay,
    delay * 2,
  );
};

const submitWithRetry = async (request: () => Promise<any>) => {
  const maxAttempts = 2;
  let lastError: any;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      lastError = error;
      if (!isRetryableSubmitError(error) || attempt === maxAttempts) {
        throw new Error(formatHcError(error, "异步图片任务提交失败"));
      }
      const delay = 2_000 * attempt;
      logger(`[HC 异步生图] 提交连接异常，${delay / 1000} 秒后重试（${attempt + 1}/${maxAttempts}）`);
      await waitBeforeRetry(delay);
    }
  }
  throw lastError;
};

const getRequestContext = () => {
  if (!vendor.inputValues.apiKey) throw new Error("请先在 HC 异步生图配置中填写 API 密钥");

  const apiKey = vendor.inputValues.apiKey.replace(/^Bearer\s+/i, "");
  const baseUrl = vendor.inputValues.baseUrl.replace(/\/+$/, "");
  const sizeByAspectRatio: Record<string, string> = {
    "16:9": "1536x1024",
    "9:16": "1024x1536",
    "1:1": "1024x1024",
  };
  return { apiKey, baseUrl, sizeByAspectRatio };
};

// 只负责提交：返回 HC task_id 后立即结束，供批量任务先完成低频串行入队。
const imageSubmitRequest = async (config: ImageConfig, model: ImageModel): Promise<string> => {
  const { apiKey, baseUrl, sizeByAspectRatio } = getRequestContext();
  const size = sizeByAspectRatio[config.aspectRatio] || "1536x1024";
  const references = (config.referenceList || []).filter((item) => item.type === "image" && item.base64);
  const headers = { Authorization: `Bearer ${apiKey}` };
  let submit: any;

  if (references.length > 0) {
    // HC 的异步编辑接口是 multipart；多参考图时按 OpenAI 兼容格式重复提交 image 字段。
    const form = new FormData();
    form.append("model", model.modelName);
    form.append("prompt", config.prompt);
    form.append("size", size);
    // 参考图预处理彼此独立，使用 Promise.all 并行执行；重复图片由
    // prepareImageForUpload 内部按哈希复用转换结果，避免重复压缩。
    const uploadImages = await Promise.all(references.map(async (reference, index) => {
      // 只转换本次上传的临时 payload，数据库/磁盘中的原始参考图不会被修改。
      const uploadData = await prepareImageForUpload(reference.base64, { maxBytes: 1_200_000, maxDimension: 2048 });
      return parseReferenceImage(uploadData, index);
    }));
    for (const image of uploadImages) {
      form.append("image", image.buffer, { filename: image.filename, contentType: image.mimeType });
    }
    submit = await submitWithRetry(() => axios.post(`${baseUrl}/images/edits/async`, form, {
      headers: { ...headers, ...form.getHeaders() },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    }));
  } else {
    submit = await submitWithRetry(() => axios.post(
      `${baseUrl}/images/generations/async`,
      { model: model.modelName, prompt: config.prompt, size },
      { headers: { ...headers, "Content-Type": "application/json" } },
    ));
  }
  const taskId = submit.data?.task_id || submit.data?.data?.task_id;
  if (!taskId) throw new Error(formatHcTaskError(submit.data, "异步生图任务提交失败：未返回 task_id"));
  logger(`[HC 异步生图] 任务已提交: ${taskId}`);
  return taskId;
};

// 独立轮询已提交的任务。调用方可以并行执行本函数，不阻塞后续提交。
const imagePollRequest = async (taskId: string): Promise<string> => {
  const { apiKey, baseUrl } = getRequestContext();
  const headers = { Authorization: `Bearer ${apiKey}` };
  const result = await pollTask(
    async () => {
      const data = (await axios.get(`${baseUrl}/images/tasks/${encodeURIComponent(taskId)}`, { headers })).data || {};
      const status = String(data.status || data.data?.status || "").toLowerCase();
      if (status === "completed") {
        const imageUrl = data.image_url || data.result?.data?.[0]?.url || data.data?.image_url || data.data?.result?.data?.[0]?.url;
        return imageUrl ? { completed: true, data: imageUrl } : { completed: true, error: "任务已完成，但未返回图片地址" };
      }
      if (status === "failed" || status === "failure" || status === "error") {
        return { completed: true, error: formatHcTaskError(data) };
      }
      return { completed: false };
    },
    10_000,
    10 * 60_000,
  );

  if (result.error) throw new Error(result.error);
  if (!result.data) throw new Error("异步图片任务未返回图片地址");
  return result.data.startsWith("data:") ? result.data : await urlToBase64(result.data);
};

const imageRequest = async (config: ImageConfig, model: ImageModel): Promise<string> => {
  const taskId = await imageSubmitRequest(config, model);
  return imagePollRequest(taskId);
};

exports.vendor = vendor;
exports.textRequest = textRequest;
exports.imageRequest = imageRequest;
exports.imageSubmitRequest = imageSubmitRequest;
exports.imagePollRequest = imagePollRequest;
exports.videoRequest = videoRequest;
exports.ttsRequest = ttsRequest;
