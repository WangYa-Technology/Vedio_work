import { generateText, streamText, wrapLanguageModel, stepCountIs } from "ai";
import { devToolsMiddleware } from "@ai-sdk/devtools";
import axios from "axios";
import u from "@/utils";
import compileVendorCode from "@/utils/compileVendorCode";
import { parseModelReference } from "@/utils/modelRef";
import type { VmRuntimeHooks } from "@/utils/vm";
import {
  configuredMirrorUrls,
  type MirrorAttempt,
  runWithMirrorFailover,
} from "@/utils/vendorMirrorPool";

type AiType = "scriptAgent" | "productionAgent" | "universalAi";
type FnName = "textRequest" | "imageRequest" | "videoRequest" | "ttsRequest";

const AiTypeValues: AiType[] = ["scriptAgent", "productionAgent", "universalAi"];
async function resolveModelName(value: AiType | `${string}:${string}`): Promise<`${string}:${string}`> {
  // Agent 子层级也使用冒号（例如 productionAgent:decisionAgent），不能把它
  // 误判为供应商模型名。先按部署 key 查找，找不到时才按 vendor:model 处理。
  const agentDeployData = await u.db("o_agentDeploy").where("key", value).first();
  if (agentDeployData) {
    if (!agentDeployData.modelName) throw new Error(`${value}模型未配置`);
    return agentDeployData.modelName as `${string}:${string}`;
  }
  if (AiTypeValues.includes(value as AiType)) throw new Error(`${value}模型未配置`);
  return value as `${number}:${string}`;
}

async function getVendorTemplateFn(
  fnName: FnName,
  modelName: `${string}:${string}`,
  runtimeHooks?: VmRuntimeHooks,
) {
  const { vendorId, modelName: name } = parseModelReference(modelName);
  const vendorConfigData = await u.db("o_vendorConfig").where("id", vendorId).first();
  if (!vendorConfigData) throw new Error(`未找到供应商配置 id=${vendorId}`);
  const modelList = JSON.parse(vendorConfigData.models ?? "[]");
  const selectedModel = modelList.find((i: any) => i.modelName == name);
  if (!selectedModel) throw new Error(`未找到模型 ${name} id=${vendorId}`);
  const jsCode = compileVendorCode(vendorConfigData.code!);
  let activeMirrorAttempt: MirrorAttempt | undefined;
  const trackedRuntimeHooks: VmRuntimeHooks | undefined = fnName === "videoRequest" && vendorId.toLowerCase().includes("comfyui")
    ? {
        ...runtimeHooks,
        onAxiosResponse: async (response) => {
          if (
            activeMirrorAttempt &&
            response.method === "POST" &&
            (response.data as any)?.prompt_id &&
            /\/prompt(?:\?|$)/i.test(response.url)
          ) {
            activeMirrorAttempt.promptSubmitted = true;
          }
          await runtimeHooks?.onAxiosResponse?.(response);
        },
      }
    : runtimeHooks;
  const running = u.vm(jsCode, undefined, trackedRuntimeHooks);
  if (running.vendor) {
    Object.assign(running.vendor.inputValues, JSON.parse(vendorConfigData.inputValues ?? "{}"));
    running.vendor.models = modelList;
  }
  const fn = running[fnName];
  if (!fn) throw new Error(`未找到供应商配置中的函数 ${fnName} id=${vendorId}`);
  if (fnName == "textRequest") return fn(selectedModel);
  if (fnName === "videoRequest" && vendorId.toLowerCase().includes("comfyui")) {
    return <T>(input: T) => {
      return (async () => {
        const inputValues = running.vendor?.inputValues || {};
        const urls = configuredMirrorUrls(inputValues);
        if (urls.length <= 1) return fn(input, selectedModel);
        const originalBaseUrl = inputValues.baseUrl;
        return runWithMirrorFailover({
          vendorId,
          urls,
          run: async (attempt) => {
            inputValues.baseUrl = attempt.url;
            activeMirrorAttempt = attempt;
            try {
              return await fn(input, selectedModel);
            } finally {
              activeMirrorAttempt = undefined;
              inputValues.baseUrl = originalBaseUrl;
            }
          },
          onRetry: (failure) => console.warn(`[ComfyUI 镜像] ${failure}，自动尝试下一台`),
        });
      })();
    };
  }
  return <T>(input: T) => fn(input, selectedModel);
}

async function withTaskRecord<T>(
  modelKey: AiType | `${string}:${string}`,
  taskClass: string,
  describe: string,
  relatedObjects: string,
  projectId: number,
  fn: (modelName: `${string}:${string}`) => Promise<T>,
): Promise<T> {
  const modelName = await resolveModelName(modelKey);
  const { modelName: model } = parseModelReference(modelName);
  const taskRecord = await u.task(projectId, taskClass, model, { describe: describe, content: relatedObjects });
  try {
    const result = await fn(modelName);
    taskRecord(1);
    return result;
  } catch (e) {
    taskRecord(-1, u.error(e).message);
    throw e;
  }
}

async function urlToBase64(url: string, retries = 3, delay = 1000): Promise<string> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await axios.get(url, { responseType: "arraybuffer" });
      const base64 = Buffer.from(res.data).toString("base64");
      return `${base64}`;
    } catch (e) {
      if (attempt === retries) throw e;
      await new Promise((resolve) => setTimeout(resolve, delay * attempt));
    }
  }
  throw new Error("urlToBase64 failed");
}
class AiText {
  private AiType: AiType | `${string}:${string}`;
  constructor(AiType: AiType | `${string}:${string}`) {
    this.AiType = AiType;
  }
  async invoke(input: Omit<Parameters<typeof generateText>[0], "model">) {
    const switchAiDevTool = await u.db("o_setting").where("key", "switchAiDevTool").first();
    const modelName = await resolveModelName(this.AiType);
    return generateText({
      ...(input.tools && { stopWhen: stepCountIs(Object.keys(input.tools).length * 50) }),
      ...input,
      model:
        switchAiDevTool?.value === "1"
          ? wrapLanguageModel({
              model: await getVendorTemplateFn("textRequest", modelName),
              middleware: devToolsMiddleware(),
            })
          : await getVendorTemplateFn("textRequest", modelName),
    } as Parameters<typeof generateText>[0]);
  }
  async stream(input: Omit<Parameters<typeof streamText>[0], "model">) {
    const switchAiDevTool = await u.db("o_setting").where("key", "switchAiDevTool").first();
    const modelName = await resolveModelName(this.AiType);
    return streamText({
      ...(input.tools && { stopWhen: stepCountIs(Object.keys(input.tools).length * 50) }),
      ...input,
      model:
        switchAiDevTool?.value == "1"
          ? wrapLanguageModel({
              model: await getVendorTemplateFn("textRequest", modelName),
              middleware: devToolsMiddleware(),
            })
          : await getVendorTemplateFn("textRequest", modelName),
    } as Parameters<typeof streamText>[0]);
  }
}

interface ImageConfig {
  prompt: string; //图片提示词
  imageBase64: string[]; //输入的图片提示词
  size: "1K" | "2K" | "4K"; // 图片尺寸
  aspectRatio: `${number}:${number}`; // 长宽比
}

interface TaskRecord {
  taskClass: string; // 任务分类
  describe: string; // 任务描述
  relatedObjects: string; // 相关对象信息，便于后续分析和追踪
  projectId: number; // 项目ID
  onProviderTask?: (task: ProviderTaskInfo) => void | Promise<void>;
}

export interface ProviderTaskInfo {
  provider: string;
  taskId: string;
  baseUrl: string;
  submittedAt: number;
}

class AiImage {
  private key: `${string}:${string}`;
  private result: string = "";
  constructor(key: `${string}:${string}`) {
    this.key = key;
  }
  async run(input: ImageConfig, taskRecord?: TaskRecord) {
    const modelName = await resolveModelName(this.key);
    const exec = async (mn: `${string}:${string}`) => {
      const fn = await getVendorTemplateFn("imageRequest", mn);
      this.result = await fn(input);
      if (typeof this.result !== "string" || !this.result.trim()) {
        throw new Error("图片生成未返回有效图像数据");
      }
      if (this.result.startsWith("http")) this.result = await urlToBase64(this.result);
      return this;
    };
    if (taskRecord) {
      return withTaskRecord(this.key, taskRecord.taskClass, taskRecord.describe, taskRecord.relatedObjects, taskRecord.projectId, exec);
    }
    return exec(modelName);
  }
  async save(path: string) {
    if (!this.result.trim()) {
      throw new Error("图片生成未返回有效图像数据");
    }
    await u.oss.writeFile(path, this.result);
    return this;
  }
}
interface VideoConfig {
  prompt: string; //视频提示词
  imageBase64: string[]; //输入的图片提示词
  referenceList?: Array<{
    type: "image" | "video" | "audio";
    sourceType: "base64";
    base64: string;
  }>;
  aspectRatio: `${number}:${number}`; // 长宽比
  mode: string | string[]; //模式
  duration: number; // 视频时长，单位秒
  resolution: string; // 视频分辨率
  audio: boolean; // 是否需要配音
  parameters?: Record<string, string | number | boolean>; // 供应商工作流的安全可调参数
}

class AiVideo {
  private key: `${string}:${string}`;
  private result: string = "";
  constructor(key: `${string}:${string}`) {
    this.key = key;
  }
  async run(input: VideoConfig, taskRecord?: TaskRecord) {
    const modelName = await resolveModelName(this.key);
    const exec = async (mn: `${string}:${string}`) => {
      const provider = parseModelReference(mn).vendorId;
      const fn = await getVendorTemplateFn("videoRequest", mn, {
        onAxiosResponse: async ({ url, method, data }) => {
          const taskId = (data as any)?.prompt_id;
          if (method !== "POST" || !taskId || !/\/prompt(?:\?|$)/i.test(url)) return;
          const baseUrl = url.replace(/\/prompt(?:\?.*)?$/i, "").replace(/\/$/, "");
          await taskRecord?.onProviderTask?.({
            provider,
            taskId: String(taskId),
            baseUrl,
            submittedAt: Date.now(),
          });
        },
      });
      this.result = await fn(input);
      if (this.result.startsWith("http")) this.result = await urlToBase64(this.result);
      return this;
    };
    if (taskRecord) {
      return withTaskRecord(this.key, taskRecord.taskClass, taskRecord.describe, taskRecord.relatedObjects, taskRecord.projectId, exec);
    }
    return exec(modelName);
  }
  async save(path: string) {
    await u.oss.writeFile(path, this.result);
    return this;
  }
}
class AiAudio {
  private key: `${string}:${string}`;
  private result: string = "";
  constructor(key: `${string}:${string}`) {
    this.key = key;
  }
  async run(input: VideoConfig, taskRecord?: TaskRecord) {
    const modelName = await resolveModelName(this.key);
    const exec = async (mn: `${string}:${string}`) => {
      const fn = await getVendorTemplateFn("ttsRequest", mn);
      this.result = await fn(input);
      if (this.result.startsWith("http")) this.result = await urlToBase64(this.result);
      return this;
    };
    if (taskRecord) {
      return withTaskRecord(this.key, taskRecord.taskClass, taskRecord.describe, taskRecord.relatedObjects, taskRecord.projectId, exec);
    }
    return exec(modelName);
  }
  async save(path: string) {
    await u.oss.writeFile(path, this.result);
    return this;
  }
}

export default {
  Text: (AiType: AiType | `${string}:${string}`) => new AiText(AiType),
  Image: (key: `${string}:${string}`) => new AiImage(key),
  Video: (key: `${string}:${string}`) => new AiVideo(key),
  Audio: (key: `${string}:${string}`) => new AiAudio(key),
};
