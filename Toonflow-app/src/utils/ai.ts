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
import { normalizeGeneratedImage } from "@/utils/imageNormalize";
import {
  describeAiError,
  isForcedToolChoice,
  isToolChoiceNeedsNoThinking,
  isToolChoiceRejected,
  isToolChoiceRelaxed,
  markToolChoiceNeedsNoThinking,
  markToolChoiceRelaxed,
  resultHasToolCall,
} from "@/utils/toolChoiceCompat";

type AiType = "scriptAgent" | "productionAgent" | "universalAi";
type FnName = "textRequest" | "imageRequest" | "videoRequest" | "ttsRequest";

// 前端已移除「思考级别」档位控件：文本请求统一按「开启思考 + 最高档」发起。
// 供应商模板自行决定如何把该意图映射到各自接口（不支持思考参数的模板会忽略这两个参数）。
const TEXT_THINK_DEFAULT = { think: true, thinkLevel: 3 as 0 | 1 | 2 | 3 };

const AiTypeValues: AiType[] = ["scriptAgent", "productionAgent", "universalAi"];
async function resolveModelName(value: AiType | `${string}:${string}`): Promise<`${string}:${string}`> {
  // Agent 子层级也使用冒号（例如 productionAgent:decisionAgent），不能把它
  // 误判为供应商模型名。先按部署 key 查找，找不到时才按 vendor:model 处理。
  const agentDeployData = await u.db("o_agentDeploy").where("key", value).first();
  if (agentDeployData) {
    if (!agentDeployData.modelName) throw new Error(`${value}模型未配置`);
    return agentDeployData.modelName as `${string}:${string}`;
  }
  // 子层级未单独部署时回退到父级 Agent 的模型配置（如 productionAgent:baseAssetsAgent → productionAgent），
  // 避免新增子 Agent 未同步部署行时抛“未找到供应商配置”。
  const parentKey = String(value).split(":")[0];
  if (parentKey !== value && AiTypeValues.includes(parentKey as AiType)) {
    const parentDeployData = await u.db("o_agentDeploy").where("key", parentKey).first();
    if (parentDeployData) {
      if (!parentDeployData.modelName) throw new Error(`${value}模型未配置（父级 ${parentKey} 未配置模型）`);
      return parentDeployData.modelName as `${string}:${string}`;
    }
  }
  if (AiTypeValues.includes(value as AiType)) throw new Error(`${value}模型未配置`);
  return value as `${number}:${string}`;
}

async function getVendorTemplateFn(
  fnName: FnName,
  modelName: `${string}:${string}`,
  runtimeHooks?: VmRuntimeHooks,
  textThink?: { think: boolean; thinkLevel?: 0 | 1 | 2 | 3 },
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
  if (fnName == "textRequest") {
    return fn(
      selectedModel,
      textThink?.think ?? TEXT_THINK_DEFAULT.think,
      textThink?.thinkLevel ?? TEXT_THINK_DEFAULT.thinkLevel,
    );
  }
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
  private async buildTextOptions(
    input: Omit<Parameters<typeof generateText>[0], "model">,
    controls: {
      modelName?: `${string}:${string}`;
      disableThinking?: boolean;
      relaxToolChoice?: boolean;
    } = {},
  ) {
    const switchAiDevTool = await u.db("o_setting").where("key", "switchAiDevTool").first();
    const modelName = controls.modelName || (await resolveModelName(this.AiType));
    const model = await getVendorTemplateFn(
      "textRequest",
      modelName,
      undefined,
      controls.disableThinking ? { think: false } : undefined,
    );
    const relaxed =
      controls.relaxToolChoice && isForcedToolChoice(input.toolChoice)
        ? { toolChoice: "auto" }
        : {};
    return {
      modelName,
      options: {
        ...(input.tools && { stopWhen: stepCountIs(Object.keys(input.tools).length * 50) }),
        ...input,
        ...relaxed,
        model:
          switchAiDevTool?.value === "1"
            ? wrapLanguageModel({ model, middleware: devToolsMiddleware() })
            : model,
      } as Parameters<typeof generateText>[0],
    };
  }
  /**
   * 文本请求。调用方显式强制工具选择（toolChoice: required 等）时，必须拿到工具结果，
   * 因此这里按实测结论组织降级链（见 `toolChoiceCompat.ts`）：
   *   1. 思考 + 强制（作者意图）；
   *   2. 供应商在思考模式下拒绝 → 思考 + auto（保留思考，工具调用靠提示词强制）；
   *   3. 仍没有工具调用 → 关思考 + 强制（实测稳定返回工具调用）。
   * 每次命中的策略会记在进程内，后续同模型请求直接从可用形态发起。
   */
  async invoke(input: Omit<Parameters<typeof generateText>[0], "model">) {
    if (!isForcedToolChoice(input.toolChoice)) {
      const { options } = await this.buildTextOptions(input);
      return await generateText(options);
    }

    const modelName = await resolveModelName(this.AiType);
    const runAttempt = async (
      controls: { disableThinking?: boolean; relaxToolChoice?: boolean },
    ) => {
      const { options } = await this.buildTextOptions(input, { modelName, ...controls });
      try {
        return { options, result: await generateText(options) };
      } catch (error) {
        return { options, error };
      }
    };

    if (
      !isToolChoiceNeedsNoThinking(modelName) &&
      !isToolChoiceRelaxed(modelName)
    ) {
      const first = await runAttempt({});
      if (!first.error) {
        if (resultHasToolCall(first.result)) return first.result;
        markToolChoiceNeedsNoThinking(modelName);
      } else if (isToolChoiceRejected(first.error)) {
        markToolChoiceRelaxed(modelName);
        console.warn(
          `[ai] ${this.AiType}（${modelName}）在思考模式下拒绝强制工具选择，已降级为 toolChoice: auto：${describeAiError(first.error)}`,
        );
      } else {
        throw first.error;
      }
    }

    if (!isToolChoiceNeedsNoThinking(modelName)) {
      const relaxed = await runAttempt({ relaxToolChoice: true });
      if (!relaxed.error) {
        if (resultHasToolCall(relaxed.result)) return relaxed.result;
        markToolChoiceNeedsNoThinking(modelName);
        console.warn(
          `[ai] ${this.AiType}（${modelName}）在 auto 下未调用工具，已改用"关闭思考 + 强制工具选择"重试`,
        );
      } else if (!isToolChoiceRejected(relaxed.error)) {
        throw relaxed.error;
      }
    }

    const finalAttempt = await runAttempt({ disableThinking: true });
    if (finalAttempt.error) throw finalAttempt.error;
    return finalAttempt.result;
  }
  async stream(input: Omit<Parameters<typeof streamText>[0], "model">) {
    // 选项构建与 invoke 共用；streamText 与 generateText 的差异只在 onStepFinish 等回调
    // 的签名上，运行时结构一致，这里显式收窄回 streamText 的入参类型。
    const { options } = await this.buildTextOptions(
      input as Omit<Parameters<typeof generateText>[0], "model">,
    );
    return streamText(options as Parameters<typeof streamText>[0]);
  }
}

interface ImageConfig {
  prompt: string; //图片提示词
  imageBase64: string[]; //输入的图片提示词
  referenceList?: Array<{
    type: "image";
    base64: string;
  }>;
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
    // 统一为不透明 JPEG，避免透明通道导致同批图片背景不一致
    const buffer = await normalizeGeneratedImage(this.result);
    await u.oss.writeFile(path, buffer);
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
          if (method !== "POST") return;
          const payload = data as any;
          // 原生 ComfyUI：POST /prompt → prompt_id
          const comfyTaskId = payload?.prompt_id;
          if (comfyTaskId && /\/prompt(?:\?|$)/i.test(url)) {
            const baseUrl = url.replace(/\/prompt(?:\?.*)?$/i, "").replace(/\/$/, "");
            await taskRecord?.onProviderTask?.({
              provider,
              taskId: String(comfyTaskId),
              baseUrl,
              submittedAt: Date.now(),
            });
            return;
          }
          // AutoDL.Art ComfyUI 工作流：POST /api/v1/comfyui/comfyui_workflow/{workflowId} → data.data.task_id
          // 上报后才能续查/恢复；否则服务重启时这些任务只能被判失败。
          const workflowMatch = url.match(
            /^(.*)\/api\/v1\/comfyui\/comfyui_workflow\/[^/?#]+(?:\?.*)?$/i,
          );
          const workflowTaskId = payload?.data?.task_id ?? payload?.task_id;
          if (workflowMatch && workflowTaskId) {
            await taskRecord?.onProviderTask?.({
              provider,
              taskId: String(workflowTaskId),
              baseUrl: workflowMatch[1].replace(/\/$/, ""),
              submittedAt: Date.now(),
            });
          }
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
