/**
 * Toonflow AI供应商模板
 * @version 2.2
 * 说明：文本请求默认按「开启思考 + 最高档」处理。按模型族注入思考参数：
 * OpenAI 系（gpt-5+/o 系）→ reasoning_effort；GLM 系 → thinking:{type:"enabled"}；
 * DeepSeek 系 → thinking + reasoning_effort(max)。上游因参数不支持返回 400/422 时自动回退原样请求。
 */
// ============================================================
// 类型定义
// ============================================================
type VideoMode =
  | "singleImage"
  | "startEndRequired"
  | "endFrameOptional"
  | "startFrameOptional"
  | "text"
  | (`videoReference:${number}` | `imageReference:${number}` | `audioReference:${number}`)[];
interface TextModel {
  name: string;
  modelName: string;
  type: "text";
  think: boolean;
}
interface ImageModel {
  name: string;
  modelName: string;
  type: "image";
  mode: ("text" | "singleImage" | "multiReference")[];
  associationSkills?: string;
}
interface VideoModel {
  name: string;
  modelName: string;
  type: "video";
  mode: VideoMode[];
  associationSkills?: string;
  audio: "optional" | false | true;
  durationResolutionMap: { duration: number[]; resolution: string[] }[];
}
interface TTSModel {
  name: string;
  modelName: string;
  type: "tts";
  voices: { title: string; voice: string }[];
}
interface VendorConfig {
  id: string;
  version: string;
  name: string;
  author: string;
  description?: string;
  icon?: string;
  inputs: { key: string; label: string; type: "text" | "password" | "url"; required: boolean; placeholder?: string }[];
  inputValues: Record<string, string>;
  models: (TextModel | ImageModel | VideoModel | TTSModel)[];
}
interface ImageConfig {
  prompt: string;
  imageBase64: string[];
  size: "1K" | "2K" | "4K";
  aspectRatio: `${number}:${number}`;
}
interface VideoConfig {
  duration: number;
  resolution: string;
  aspectRatio: "16:9" | "9:16";
  prompt: string;
  imageBase64?: string[];
  audio?: boolean;
  mode: VideoMode[];
}
interface TTSConfig {
  text: string;
  voice: string;
  speechRate: number;
  pitchRate: number;
  volume: number;
}
interface PollResult {
  completed: boolean;
  data?: string;
  error?: string;
}
// ============================================================
// 全局声明
// ============================================================
declare const axios: any;
declare const logger: (msg: string) => void;
declare const jsonwebtoken: any;
declare const zipImage: (base64: string, size: number) => Promise<string>;
declare const zipImageResolution: (base64: string, w: number, h: number) => Promise<string>;
declare const mergeImages: (base64Arr: string[], maxSize?: string) => Promise<string>;
declare const urlToBase64: (url: string) => Promise<string>;
declare const pollTask: (fn: () => Promise<PollResult>, interval?: number, timeout?: number) => Promise<PollResult>;
declare const createOpenAI: any;
declare const createDeepSeek: any;
declare const createZhipu: any;
declare const createQwen: any;
declare const createAnthropic: any;
declare const createOpenAICompatible: any;
declare const createXai: any;
declare const createMinimax: any;
declare const createGoogleGenerativeAI: any;
declare const exports: {
  vendor: VendorConfig;
  textRequest: (m: TextModel, t?: boolean, tl?: 0 | 1 | 2 | 3) => any;
  imageRequest: (c: ImageConfig, m: ImageModel) => Promise<string>;
  videoRequest: (c: VideoConfig, m: VideoModel) => Promise<string>;
  ttsRequest: (c: TTSConfig, m: TTSModel) => Promise<string>;
  checkForUpdates?: () => Promise<{ hasUpdate: boolean; latestVersion: string; notice: string }>;
  updateVendor?: () => Promise<string>;
};
// ============================================================
// 供应商配置
// ============================================================
const vendor: VendorConfig = {
  id: "openai",
  version: "2.2",
  author: "Toonflow",
  name: "OpenAI标准接口",
  description: "OpenAI标准格式接口，可修改请求地址并手动添加模型。",
  icon: "",
  inputs: [
    { key: "apiKey", label: "API密钥", type: "password", required: true },
    { key: "baseUrl", label: "请求地址", type: "url", required: true, placeholder: "以v1结束，示例：https://api.openai.com/v1" },
  ],
  inputValues: {
    apiKey: "",
    baseUrl: "https://api.openai.com/v1",
  },
  models: [
    { name: "GPT-4o", modelName: "gpt-4o", type: "text", think: false },
    { name: "GPT-4.1", modelName: "gpt-4.1", type: "text", think: false },
    { name: "GPT-5.1", modelName: "gpt-5.1", type: "text", think: false },
    { name: "GPT-5.2", modelName: "gpt-5.2", type: "text", think: false },
    { name: "GPT-5.4", modelName: "gpt-5.4", type: "text", think: false },
  ],
};
// ============================================================
// 适配器函数
// ============================================================

// 需要注入思考参数的模型族（gpt-4o/gpt-4.1 等非思考模型不注入）：
// - OpenAI 系（gpt-5+/o 系）：注入 reasoning_effort（0/1/2/3 → minimal/low/medium/high）
// - GLM 系（glm-4.5+/5.x，含 glm-5.3）：OpenAI 兼容接口用 thinking:{type:"enabled"} 开启思考（无 effort 档位）
// - DeepSeek 系：thinking:{type:"enabled"} + reasoning_effort（0/1/2 → high，3 → max）
const THINKING_MODEL_PATTERN = /^(gpt-[5-9]|o[3-9]|glm-[45]|deepseek-v[3-9]|kimi-k[2-9]|minimax-m2)/i;

function buildThinkingAttrs(modelName: string, thinkLevel: 0 | 1 | 2 | 3): Record<string, any> {
  const lowerName = String(modelName || "").toLowerCase();
  if (/^glm-/.test(lowerName)) {
    return { thinking: { type: "enabled" } };
  }
  if (/^deepseek-/.test(lowerName)) {
    const deepseekEffortMap: Record<number, string> = { 0: "high", 1: "high", 2: "high", 3: "max" };
    return { thinking: { type: "enabled" }, reasoning_effort: deepseekEffortMap[thinkLevel] ?? "max" };
  }
  const effortMap: Record<number, string> = { 0: "minimal", 1: "low", 2: "medium", 3: "high" };
  return { reasoning_effort: effortMap[thinkLevel] ?? "high" };
}

const textRequest = (model: TextModel, think: boolean = true, thinkLevel: 0 | 1 | 2 | 3 = 3) => {
  if (!vendor.inputValues.apiKey) throw new Error("缺少API Key");
  const apiKey = vendor.inputValues.apiKey.replace(/^Bearer\s+/i, "");
  const enableThinking = THINKING_MODEL_PATTERN.test(String(model.modelName || "")) && think !== false;
  const thinkingAttrs = enableThinking ? buildThinkingAttrs(model.modelName, thinkLevel) : null;

  return createOpenAI({
    baseURL: vendor.inputValues.baseUrl,
    apiKey,
    fetch: async (url: string, options?: RequestInit) => {
      if (!thinkingAttrs) return await fetch(url, options as RequestInit);
      const rawBody = JSON.parse((options?.body as string) ?? "{}");
      // 调用方已给出的同名字段优先（不覆盖）
      const modifiedBody = { ...thinkingAttrs, ...rawBody };
      const first = await fetch(url, { ...options, body: JSON.stringify(modifiedBody) });
      // 自愈回退：上游不认识思考参数时（400/422）用原始请求体重试一次，保证网关可用性
      if (first.status === 400 || first.status === 422) {
        logger(`[openai] 上游拒绝思考参数，已回退原样请求: ${model.modelName}`);
        return await fetch(url, options as RequestInit);
      }
      return first;
    },
  }).chat(model.modelName);
};
const imageRequest = async (config: ImageConfig, model: ImageModel): Promise<string> => {
  return "";
};
const videoRequest = async (config: VideoConfig, model: VideoModel): Promise<string> => {
  return "";
};
const ttsRequest = async (config: TTSConfig, model: TTSModel): Promise<string> => {
  return "";
};
const checkForUpdates = async (): Promise<{ hasUpdate: boolean; latestVersion: string; notice: string }> => {
  return { hasUpdate: false, latestVersion: "2.2", notice: "" };
};
const updateVendor = async (): Promise<string> => {
  return "";
};
// ============================================================
// 导出
// ============================================================
exports.vendor = vendor;
exports.textRequest = textRequest;
exports.imageRequest = imageRequest;
exports.videoRequest = videoRequest;
exports.ttsRequest = ttsRequest;
exports.checkForUpdates = checkForUpdates;
exports.updateVendor = updateVendor;
export {};
