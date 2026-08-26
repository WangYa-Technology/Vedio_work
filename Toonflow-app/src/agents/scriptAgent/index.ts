import { Socket } from "socket.io";
import { tool } from "ai";
import type { ModelMessage } from "ai";
import { z } from "zod";
import u from "@/utils";
import Memory from "@/utils/agent/memory";
import useTools from "@/agents/scriptAgent/tools";
import ResTool from "@/socket/resTool";
import * as fs from "fs";
import path from "path";
import { CONTENT_SAFETY_SETTING_KEY, DEFAULT_CONTENT_SAFETY_CONSTRAINT } from "@/constants/contentSafety";

export interface AgentContext {
  socket: Socket;
  isolationKey: string;
  text: string;
  userMessageTime?: number;
  abortSignal?: AbortSignal;
  resTool: ResTool;
  msg: ReturnType<ResTool["newMessage"]>;
}

const SUB_AGENT_MAX_ATTEMPTS = 3;
const TRANSIENT_AI_ERROR =
  /(?:upstream_error|temporarily unavailable|service unavailable|overloaded|rate.?limit|too many requests|timeout|timed out|econnreset|etimedout|eai_again|\b(?:429|502|503|504)\b)/i;

function collectErrorText(error: unknown, depth = 0): string {
  if (depth > 3 || error == null) return "";
  if (typeof error === "string") return error;
  if (typeof error !== "object") return String(error);

  const value = error as Record<string, unknown>;
  const directValues = ["name", "message", "type", "code", "status", "statusCode", "responseBody"]
    .map((key) => value[key])
    .filter((item): item is string | number => typeof item === "string" || typeof item === "number")
    .map(String);
  const nestedValues = [value.cause, value.lastError, ...(Array.isArray(value.errors) ? value.errors : [])]
    .map((item) => collectErrorText(item, depth + 1))
    .filter(Boolean);
  return [...directValues, ...nestedValues].join(" ");
}

export function isTransientAiError(error: unknown): boolean {
  return TRANSIENT_AI_ERROR.test(collectErrorText(error));
}

function createAbortError() {
  const error = new Error("生成已停止");
  error.name = "AbortError";
  return error;
}

async function waitBeforeRetry(delayMs: number, signal?: AbortSignal) {
  if (signal?.aborted) throw createAbortError();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(createAbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function getWorkflowLabel(stage?: string) {
  switch (stage) {
    case "storySkeleton":
      return "正在生成故事骨架";
    case "adaptationStrategy":
      return "正在制定改编策略";
    case "script":
      return "正在编写剧本";
    case "supervision":
      return "正在审核当前产出";
    default:
      return "正在分析项目并规划下一步";
  }
}

function hasToolResults(messages: ModelMessage[]) {
  return messages.some((message) => message.role === "tool");
}

function buildMemPrompt(mem: Awaited<ReturnType<Memory["get"]>>): string {
  let memoryContext = "";
  if (mem.rag.length) {
    memoryContext += `[相关记忆]\n${mem.rag.map((r) => r.content).join("\n")}`;
  }
  if (mem.summaries.length) {
    if (memoryContext) memoryContext += "\n\n";
    memoryContext += `[历史摘要]\n${mem.summaries.map((s, i) => `${i + 1}. ${s.content}`).join("\n")}`;
  }
  if (mem.shortTerm.length) {
    if (memoryContext) memoryContext += "\n\n";
    memoryContext += `[近期对话]\n${mem.shortTerm.map((m) => `${m.role}: ${m.content}`).join("\n")}`;
  }
  return `## Memory\n以下是你对用户的记忆，可作为参考但不要主动提及：\n${memoryContext}`;
}

async function getContentSafetyConstraint(): Promise<string> {
  const setting = await u.db("o_setting").where("key", CONTENT_SAFETY_SETTING_KEY).first();
  return String(setting?.value ?? DEFAULT_CONTENT_SAFETY_CONSTRAINT).trim();
}

function getTargetEpisodeCount(...contents: unknown[]) {
  const text = contents.filter((content): content is string => typeof content === "string").join("\n");
  const taggedCount = text.match(/<集数>\s*(\d+)\s*集?\s*<\/集数>/)?.[1];
  const describedCount = text.match(/(?:总共|共|目标|拆分为|规划为)\s*(\d+)\s*集/)?.[1];
  const count = Number(taggedCount ?? describedCount);
  return Number.isSafeInteger(count) && count > 0 && count <= 100 ? count : undefined;
}

function withContentSafetyConstraint(systemPrompt: string, constraint: string): string {
  if (!constraint) return systemPrompt;
  return `${systemPrompt}\n\n## 内容安全约束（用户设置）\n${constraint}`;
}

async function getWorkflowContext(projectIdValue: unknown) {
  const projectId = Number(projectIdValue);
  if (!Number.isSafeInteger(projectId) || projectId <= 0) return "当前工作流状态未知。";

  const workData = await u.db("o_agentWorkData").where({ projectId, key: "scriptAgent" }).first();
  const scripts = await u.db("o_script").where({ projectId }).select("id", "name");
  let planData: Record<string, unknown> = {};
  try {
    planData = JSON.parse(workData?.data ?? "{}");
  } catch {
    planData = {};
  }

  const hasSkeleton = typeof planData.storySkeleton === "string" && planData.storySkeleton.trim().length > 0;
  const hasStrategy = typeof planData.adaptationStrategy === "string" && planData.adaptationStrategy.trim().length > 0;
  const globalContext = planData.projectGlobalContext as Record<string, { content?: unknown }> | undefined;
  const configuredGlobalMaterials = ["plot", "character", "world"].filter(
    (key) => typeof globalContext?.[key]?.content === "string" && String(globalContext[key].content).trim().length > 0,
  );
  const targetEpisodeCount = getTargetEpisodeCount(planData.adaptationStrategy, planData.storySkeleton);
  const remainingEpisodes = targetEpisodeCount === undefined ? undefined : Math.max(targetEpisodeCount - scripts.length, 0);
  const suggestedNext = !hasSkeleton
    ? "先生成故事骨架"
    : !hasStrategy
      ? "直接制定改编策略，不重复询问已确认项目参数"
        : scripts.length === 0
          ? targetEpisodeCount === undefined
          ? "进入剧本编写；根据原著事件密度和目标时长智能推算目标集数与本次生成批次，单次最多5集，不逐项询问用户配置"
          : `进入剧本编写；已确认目标${targetEpisodeCount}集，本次直接生成${Math.min(targetEpisodeCount, 5)}集，不再询问集数`
        : remainingEpisodes === undefined
          ? "剧本已存在，汇报已生成集数并引导用户继续生成后续剧本或进入制作流程"
          : remainingEpisodes > 0
            ? `已生成${scripts.length}集，继续生成剩余${remainingEpisodes}集；不再询问已确认集数`
            : "全部目标剧本已生成，直接引导进入制作流程";

  return [
    "## 宿主工作流快照（可信）",
    `故事骨架：${hasSkeleton ? "已保存" : "未生成"}`,
    `改编策略：${hasStrategy ? "已保存" : "未生成"}`,
    `目标集数：${targetEpisodeCount === undefined ? "未从已保存配置中识别" : `${targetEpisodeCount}集`}`,
    `项目全局资料：${configuredGlobalMaterials.length ? `已配置${configuredGlobalMaterials.length}/3类` : "未配置"}`,
    `已生成剧本：${scripts.length}集${scripts.length ? `（${scripts.map((item) => item.name).join("、")}）` : ""}`,
    `建议下一步：${suggestedNext}`,
    "当用户说“继续”“已经有了”“确认”或表达同意时，必须基于此快照推进，不得重新询问已保存阶段或已确认参数。",
  ].join("\n");
}

function getLastXmlElement(text: string, tag: string) {
  const openPattern = new RegExp(`<${tag}(?:\\s([^>]*))?>`, "g");
  let lastOpen: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  while ((match = openPattern.exec(text)) !== null) lastOpen = match;
  if (!lastOpen) return undefined;

  const contentStart = lastOpen.index + lastOpen[0].length;
  const closeIndex = text.indexOf(`</${tag}>`, contentStart);
  if (closeIndex === -1) return undefined;
  return { attrs: lastOpen[1] ?? "", content: text.slice(contentStart, closeIndex).trim() };
}

type RequiredArtifact = "storySkeleton" | "adaptationStrategy" | "scriptItem";

type ArtifactPayload =
  | { type: "storySkeleton"; content: string }
  | { type: "adaptationStrategy"; content: string }
  | { type: "scriptItem"; name: string; content: string };

function getRequiredArtifact(text: string, requiredArtifact: RequiredArtifact): ArtifactPayload {
  if (requiredArtifact === "storySkeleton" || requiredArtifact === "adaptationStrategy") {
    const element = getLastXmlElement(text, requiredArtifact);
    if (!element?.content) {
      const label = requiredArtifact === "storySkeleton" ? "故事骨架" : "改编策略";
      throw new Error(`${label}任务未输出完整的 <${requiredArtifact}> 产出物`);
    }
    return { type: requiredArtifact, content: element.content };
  }

  const element = getLastXmlElement(text, "scriptItem");
  const nameMatch = element?.attrs.match(/\bname\s*=\s*(?:"([^"]*)"|'([^']*)')/);
  const name = (nameMatch?.[1] ?? nameMatch?.[2] ?? "").trim();
  if (!element?.content || !name) throw new Error("剧本任务必须输出一个带名称的完整 <scriptItem> 产出物");
  return { type: "scriptItem", name, content: element.content };
}

function getArtifactSuccessMessage(artifact: ArtifactPayload) {
  if (artifact.type === "storySkeleton") return `故事骨架已保存到工作区（${artifact.content.length}字）`;
  if (artifact.type === "adaptationStrategy") return `改编策略已保存到工作区（${artifact.content.length}字）`;
  return `剧本《${artifact.name}》已保存到工作区（${artifact.content.length}字）`;
}

async function persistPlanXml(projectIdValue: unknown, artifact: ArtifactPayload) {
  const projectId = Number(projectIdValue);
  if (!Number.isSafeInteger(projectId) || projectId <= 0) throw new Error("无效的项目 ID，无法保存产出物");

  const now = Date.now();
  await u.db.transaction(async (trx) => {
    if (artifact.type === "scriptItem") {
      const existing = await trx("o_script").where({ projectId, name: artifact.name }).first();
      if (existing) {
        await trx("o_script").where({ id: existing.id, projectId }).update({ content: artifact.content });
      } else {
        await trx("o_script").insert({ projectId, name: artifact.name, content: artifact.content, createTime: now });
      }
      return;
    }

    const workData = await trx("o_agentWorkData").where({ projectId, key: "scriptAgent" }).first();
    let currentData: Record<string, unknown> = {};
    try {
      currentData = JSON.parse(workData?.data ?? "{}");
    } catch {
      throw new Error("现有剧本工作区数据格式无效，已阻止覆盖");
    }
    const persistedData = {
      ...currentData,
      storySkeleton: typeof currentData.storySkeleton === "string" ? currentData.storySkeleton : "",
      adaptationStrategy: typeof currentData.adaptationStrategy === "string" ? currentData.adaptationStrategy : "",
      [artifact.type]: artifact.content,
    };

    if (workData) {
      await trx("o_agentWorkData").where({ id: workData.id, projectId, key: "scriptAgent" }).update({
        data: JSON.stringify(persistedData),
        updateTime: now,
      });
    } else {
      await trx("o_agentWorkData").insert({
        projectId,
        key: "scriptAgent",
        data: JSON.stringify(persistedData),
        createTime: now,
        updateTime: now,
      });
    }
  });

  if (artifact.type === "scriptItem") {
    const saved = await u.db("o_script").where({ projectId, name: artifact.name }).select("content").first();
    if (saved?.content !== artifact.content) throw new Error("剧本写入后回读校验失败");
    return;
  }

  const saved = await u.db("o_agentWorkData").where({ projectId, key: "scriptAgent" }).select("data").first();
  let savedData: Record<string, unknown> = {};
  try {
    savedData = JSON.parse(saved?.data ?? "{}");
  } catch {
    throw new Error("工作区写入后回读数据格式无效");
  }
  if (savedData[artifact.type] !== artifact.content) throw new Error("工作区写入后回读校验失败");
}

export async function decisionAI(ctx: AgentContext) {
  const { isolationKey, text, userMessageTime, abortSignal, resTool } = ctx;

  const memory = new Memory("scriptAgent", isolationKey);
  await memory.add("user", text, { createTime: userMessageTime });

  const skill = path.join(u.getPath("skills"), "script_agent_decision.md");
  const prompt = await fs.promises.readFile(skill, "utf-8");
  const contentSafetyConstraint = await getContentSafetyConstraint();

  const mem = buildMemPrompt(await memory.get(text));

  const projectData = await u.db("o_project").where("id", resTool.data.projectId).first();

  const novelData = await u.db("o_novel").where("projectId", resTool.data.projectId).select("chapterIndex");

  const projectInfo = [
    "## 项目信息",
    `小说名称：${projectData?.name ?? "未知"}`,
    `小说类型：${projectData?.type ?? "未知"}`,
    `小说简介：${projectData?.intro ?? "无"}`,
    `目标改编影视视觉手册|画风：${projectData?.artStyle ?? "无"}`,
    `目标改编视频画幅：${projectData?.videoRatio ?? "16:9"}`,
    `章节数量：${novelData.length}章`,
  ].join("\n");
  const workflowContext = await getWorkflowContext(resTool.data.projectId);

  const { textStream } = await u.Ai.Text("scriptAgent:decisionAgent").stream({
    messages: [
      { role: "system", content: withContentSafetyConstraint(prompt, contentSafetyConstraint) },
      { role: "assistant", content: projectInfo + "\n\n" + workflowContext + "\n\n" + mem },
      { role: "user", content: text },
    ],
    abortSignal,
    tools: {
      ...memory.getTools(),
      ...useTools({ resTool: ctx.resTool, msg: ctx.msg }),
      ...createSubAgent(ctx, contentSafetyConstraint),
    },
    onFinish: async (completion) => {
      await memory.add("assistant:decision", removeAllXmlTags(completion.text));
    },
  });

  return textStream;
}

function createSubAgent(parentCtx: AgentContext, contentSafetyConstraint: string) {
  const { resTool, abortSignal } = parentCtx;
  const memory = new Memory("scriptAgent", parentCtx.isolationKey);
  let supervisionStarted = false;
  let supervisionCompleted = false;

  async function runAgent({
    modelKey,
    prompt,
    system,
    name,
    memoryKey,
    requiredArtifact,
    isSupervision,
    workflowStage,
    tools: extraTools,
    messages,
  }: {
    modelKey: `scriptAgent:${string}`;
    prompt: string;
    system: string;
    name: string;
    memoryKey: string;
    requiredArtifact?: RequiredArtifact;
    isSupervision?: boolean;
    workflowStage?: "storySkeleton" | "adaptationStrategy" | "script" | "supervision";
    tools?: Record<string, any>;
    messages?: ModelMessage[];
  }) {
    if (supervisionStarted || supervisionCompleted) {
      return "审核已开始或完成。本轮必须立即停止并等待用户下一条消息，不能继续执行或再次审核。";
    }
    if (isSupervision) supervisionStarted = true;
    resTool.workflowStatus("working", getWorkflowLabel(workflowStage), workflowStage);
    parentCtx.msg.complete();
    const subMsg = resTool.newMessage("assistant", name);
    const text = subMsg.text();
    let fullResponse = "";
    let attemptMessages: ModelMessage[] = messages ?? [{ role: "user", content: prompt }];

    for (let attempt = 1; attempt <= SUB_AGENT_MAX_ATTEMPTS; attempt++) {
      let attemptResponse = "";
      try {
        const streamResult = await u.Ai.Text(modelKey).stream({
          system: withContentSafetyConstraint(system, contentSafetyConstraint),
          messages: attemptMessages,
          abortSignal,
          tools: { ...extraTools, ...useTools({ resTool, msg: subMsg }) },
        });

        for await (const chunk of streamResult.textStream) {
          await new Promise<void>((resolve) => setTimeout(() => resolve(), 1));
          text.append(chunk);
          attemptResponse += chunk;
        }
        const responseMessages = (await streamResult.response).messages as ModelMessage[];
        if (!attemptResponse.trim()) {
          const toolsCompleted = hasToolResults(responseMessages);
          if (attempt === SUB_AGENT_MAX_ATTEMPTS) {
            throw new Error(toolsCompleted ? "资料读取完成，但模型未输出最终内容" : "模型未输出最终内容");
          }

          console.warn(
            `[scriptAgent] ${modelKey} ${toolsCompleted ? "工具调用后未输出正文" : "返回空内容"}，准备第 ${attempt + 1}/${SUB_AGENT_MAX_ATTEMPTS} 次尝试`,
          );
          const retryState = subMsg.thinking(toolsCompleted ? "资料已读取，正在补充最终结果..." : "模型未输出内容，正在重新生成...");
          retryState.appendText(`第 ${attempt + 1}/${SUB_AGENT_MAX_ATTEMPTS} 次尝试`);
          retryState.complete();
          resTool.workflowStatus(
            "retrying",
            `${getWorkflowLabel(workflowStage)}，${toolsCompleted ? "正在补充最终结果" : "正在重新生成空缺内容"}（${attempt + 1}/${SUB_AGENT_MAX_ATTEMPTS}）`,
            workflowStage,
          );
          attemptMessages = [
            ...attemptMessages,
            ...(toolsCompleted ? responseMessages : []),
            {
              role: "user",
              content: toolsCompleted
                ? "资料读取已完成。请直接基于以上工具结果输出最终结果，不要重复调用读取工具。"
                : "上一轮没有输出正文。请立即完成任务并输出最终结果，不要留空。",
            },
          ];
          await waitBeforeRetry(300 * attempt, abortSignal);
          continue;
        }
        if (requiredArtifact) {
          try {
            getRequiredArtifact(attemptResponse, requiredArtifact);
          } catch (err) {
            if (attempt === SUB_AGENT_MAX_ATTEMPTS) throw err;
            const errorMsg = u.error(err).message;
            console.warn(`[scriptAgent] ${modelKey} 产出格式无效，准备第 ${attempt + 1}/${SUB_AGENT_MAX_ATTEMPTS} 次尝试:`, errorMsg);
            const retryState = subMsg.thinking("产出格式未通过校验，正在自动重新生成...");
            retryState.appendText(`第 ${attempt + 1}/${SUB_AGENT_MAX_ATTEMPTS} 次尝试`);
            retryState.complete();
            resTool.workflowStatus("retrying", `${getWorkflowLabel(workflowStage)}，正在修复输出格式（${attempt + 1}/${SUB_AGENT_MAX_ATTEMPTS}）`, workflowStage);
            attemptMessages = [
              ...attemptMessages,
              ...responseMessages,
              {
                role: "user",
                content:
                  requiredArtifact === "scriptItem"
                    ? "上一轮产出未通过格式校验。请基于已有内容重新输出一个带 name 属性、开闭标签完整的 <scriptItem>；不要重复读取资料，不要输出解释、Markdown 代码围栏或保存说明。"
                    : `上一轮产出未通过格式校验。请基于已有内容重新输出一个开闭标签完整的 <${requiredArtifact}>；不要重复读取资料，不要输出解释、Markdown 代码围栏或保存说明。`,
              },
            ];
            await waitBeforeRetry(750 * attempt, abortSignal);
            continue;
          }
        }
        fullResponse = attemptResponse;
        break;
      } catch (err: any) {
        const canRetry = !attemptResponse.trim() && isTransientAiError(err);
        if (err?.name === "AbortError" || abortSignal?.aborted || !canRetry || attempt === SUB_AGENT_MAX_ATTEMPTS) {
          const errorMessage = u.error(err).message;
          text.complete();
          subMsg.error(errorMessage);
          resTool.workflowStatus("error", `${getWorkflowLabel(workflowStage)}失败：${errorMessage}`, workflowStage);
          throw err;
        }

        console.warn(`[scriptAgent] ${modelKey} 调用失败，准备第 ${attempt + 1}/${SUB_AGENT_MAX_ATTEMPTS} 次尝试:`, u.error(err).message);
        const retryState = subMsg.thinking("模型服务连接异常，正在自动重试...");
        retryState.appendText(`第 ${attempt + 1}/${SUB_AGENT_MAX_ATTEMPTS} 次尝试`);
        retryState.complete();
        resTool.workflowStatus("retrying", `${getWorkflowLabel(workflowStage)}，正在重连模型服务（${attempt + 1}/${SUB_AGENT_MAX_ATTEMPTS}）`, workflowStage);
        await waitBeforeRetry(750 * attempt, abortSignal);
      }
    }

    let result = fullResponse;
    try {
      if (requiredArtifact) {
        const artifact = getRequiredArtifact(fullResponse, requiredArtifact);
        await persistPlanXml(resTool.data.projectId, artifact);
        result = getArtifactSuccessMessage(artifact);
      }
      text.complete();
      subMsg.complete();
      resTool.workflowStatus("complete", `${getWorkflowLabel(workflowStage)}完成`, workflowStage);
    } catch (err) {
      text.complete();
      subMsg.error(u.error(err).message);
      resTool.workflowStatus("error", `${getWorkflowLabel(workflowStage)}失败：${u.error(err).message}`, workflowStage);
      throw err;
    }

    try {
      await memory.add(memoryKey, requiredArtifact ? result : removeAllXmlTags(fullResponse), {
        name,
        createTime: new Date(subMsg.datetime).getTime(),
      });
    } catch (err) {
      console.warn(`[scriptAgent] ${memoryKey} 记忆写入失败，正式产出不受影响:`, u.error(err).message);
    }

    parentCtx.msg = resTool.newMessage("assistant", "视频策划");
    if (isSupervision) supervisionCompleted = true;
    return result;
  }

  const promptInput = z.object({
    prompt: z.string().describe("交给子Agent的任务简约描述，100字以内"),
  });

  const run_sub_agent_storySkeleton = tool({
    description: "运行执行subAgent来完成故事骨架相关任务",
    inputSchema: promptInput,
    execute: async ({ prompt }) => {
      const skill = path.join(u.getPath("skills"), "script_execution_skeleton.md");
      const systemPrompt = await fs.promises.readFile(skill, "utf-8");

      const formatPrompt =
        "\n你必须输出一个完整的 <storySkeleton>故事骨架内容</storySkeleton>。该 XML 是唯一的写入协议，宿主会自动完成事务保存和回读校验；无需、也不得寻找额外写入工具。闭合 XML 后立即结束输出。";

      return runAgent({
        modelKey: "scriptAgent:storySkeletonAgent",
        prompt,
        system: systemPrompt + formatPrompt,
        name: "编剧",
        memoryKey: "assistant:execution:storySkeleton",
        requiredArtifact: "storySkeleton",
        workflowStage: "storySkeleton",
        messages: [{ role: "user", content: prompt + formatPrompt }],
      });
    },
  });

  const run_sub_agent_adaptationStrategy = tool({
    description: "运行执行subAgent来完成改编策略相关任务",
    inputSchema: promptInput,
    execute: async ({ prompt }) => {
      const skill = path.join(u.getPath("skills"), "script_execution_adaptation.md");
      const systemPrompt = await fs.promises.readFile(skill, "utf-8");

      const formatPrompt =
        "\n你必须输出一个完整的 <adaptationStrategy>改编策略内容</adaptationStrategy>。该 XML 是唯一的写入协议，宿主会自动完成事务保存和回读校验；无需、也不得寻找额外写入工具。闭合 XML 后立即结束输出。";

      return runAgent({
        modelKey: "scriptAgent:adaptationStrategyAgent",
        prompt,
        system: systemPrompt + formatPrompt,
        name: "编剧",
        memoryKey: "assistant:execution:adaptationStrategy",
        requiredArtifact: "adaptationStrategy",
        workflowStage: "adaptationStrategy",
        messages: [{ role: "user", content: prompt + formatPrompt }],
      });
    },
  });

  const run_sub_agent_script = tool({
    description: "运行执行subAgent来完成剧本相关任务",
    inputSchema: promptInput,
    execute: async ({ prompt }) => {
      const skill = path.join(u.getPath("skills"), "script_execution_script.md");
      const systemPrompt = await fs.promises.readFile(skill, "utf-8");

      const scriptList = await u.db("o_script").where("projectId", resTool.data.projectId).select("id", "name");
      const scriptPrompt = ["## 可用剧本(ID:名称)", scriptList.map((s: any) => `${s.id}:${(s.name || "").replace(/[,:]/g, "")}`).join(","), ""].join(
        "\n",
      );

      const novelData = await u.db("o_novel").where("projectId", resTool.data.projectId).select("chapterIndex");

      const formatPrompt =
        '\n你必须只输出一个完整的 <scriptItem name="剧本名称">剧本内容</scriptItem>。该 XML 是唯一的写入协议，宿主会自动完成事务保存和回读校验；无需、也不得寻找额外写入工具。闭合 XML 后立即结束输出。';

      return runAgent({
        modelKey: "scriptAgent:scriptAgent",
        prompt,
        system: systemPrompt + formatPrompt,
        messages: [
          { role: "assistant", content: scriptPrompt + `章节数量：${novelData.length}章` },
          { role: "user", content: prompt + formatPrompt },
        ],
        name: "编剧",
        memoryKey: "assistant:execution:script",
        requiredArtifact: "scriptItem",
        workflowStage: "script",
      });
    },
  });

  const run_supervision_agent = tool({
    description: "运行监督层subAgent执行独立任务，完成后返回结果",
    inputSchema: promptInput,
    execute: async ({ prompt }) => {
      const skill = path.join(u.getPath("skills"), "script_agent_supervision.md");
      const systemPrompt = await fs.promises.readFile(skill, "utf-8");

      return runAgent({
        modelKey: "scriptAgent:supervisionAgent",
        prompt,
        system: systemPrompt,
        name: "编辑",
        memoryKey: "assistant:supervision",
        isSupervision: true,
        workflowStage: "supervision",
      });
    },
  });

  return {
    run_sub_agent_storySkeleton,
    run_sub_agent_adaptationStrategy,
    run_sub_agent_script,
    run_supervision_agent,
  };
}

function removeAllXmlTags(text: string): string {
  text = text.replace(/<([a-zA-Z][\w-]*)(\s+[^>]*)?>([\s\S]*?)<\/\1>/g, "");
  text = text.replace(/<([a-zA-Z][\w-]*)(\s+[^>]*)?\/>/g, "");
  text = text.replace(/<\/?[a-zA-Z][\w-]*(\s+[^>]*)?>/g, "");
  return text.trim();
}
