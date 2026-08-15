import { Socket } from "socket.io";
import { tool } from "ai";
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

function withContentSafetyConstraint(systemPrompt: string, constraint: string): string {
  if (!constraint) return systemPrompt;
  return `${systemPrompt}\n\n## 内容安全约束（用户设置）\n${constraint}`;
}

function getLastXmlValue(text: string, tag: string): string | undefined {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "g");
  let value: string | undefined;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) value = match[1].trim();
  return value;
}

function getScriptItems(text: string) {
  const items: Array<{ name: string; content: string }> = [];
  const pattern = /<scriptItem\b([^>]*)>([\s\S]*?)<\/scriptItem>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const nameMatch = match[1].match(/\bname\s*=\s*(?:"([^"]*)"|'([^']*)')/);
    const name = (nameMatch?.[1] ?? nameMatch?.[2] ?? "").trim();
    if (name) items.push({ name, content: match[2].trim() });
  }
  return items;
}

async function persistPlanXml(projectIdValue: unknown, text: string) {
  const projectId = Number(projectIdValue);
  if (!Number.isSafeInteger(projectId) || projectId <= 0 || !text.trim()) return;

  const storySkeleton = getLastXmlValue(text, "storySkeleton");
  const adaptationStrategy = getLastXmlValue(text, "adaptationStrategy");
  const scripts = getScriptItems(text);
  if (storySkeleton === undefined && adaptationStrategy === undefined && scripts.length === 0) return;

  const now = Date.now();
  await u.db.transaction(async (trx) => {
    const workData = await trx("o_agentWorkData").where({ projectId, key: "scriptAgent" }).first();
    let currentData: Record<string, unknown> = {};
    try {
      currentData = JSON.parse(workData?.data ?? "{}");
    } catch {
      currentData = {};
    }
    const persistedData = {
      storySkeleton:
        storySkeleton !== undefined
          ? storySkeleton
          : typeof currentData.storySkeleton === "string"
            ? currentData.storySkeleton
            : "",
      adaptationStrategy:
        adaptationStrategy !== undefined
          ? adaptationStrategy
          : typeof currentData.adaptationStrategy === "string"
            ? currentData.adaptationStrategy
            : "",
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

    for (const script of scripts) {
      const existing = await trx("o_script").where({ projectId, name: script.name }).first();
      if (existing) {
        await trx("o_script").where({ id: existing.id, projectId }).update({ content: script.content });
      } else {
        await trx("o_script").insert({ projectId, name: script.name, content: script.content, createTime: now });
      }
    }
  });
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

  const { textStream } = await u.Ai.Text("scriptAgent:decisionAgent").stream({
    messages: [
      { role: "system", content: withContentSafetyConstraint(prompt, contentSafetyConstraint) },
      { role: "assistant", content: projectInfo + "\n" + mem },
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

  async function runAgent({
    modelKey,
    prompt,
    system,
    name,
    memoryKey,
    tools: extraTools,
    messages,
  }: {
    modelKey: `scriptAgent:${string}`;
    prompt: string;
    system: string;
    name: string;
    memoryKey: string;
    tools?: Record<string, any>;
    messages?: { role: "user" | "assistant" | "system"; content: string }[];
  }) {
    parentCtx.msg.complete();
    const subMsg = resTool.newMessage("assistant", name);
    const text = subMsg.text();
    let fullResponse = "";

    for (let attempt = 1; attempt <= SUB_AGENT_MAX_ATTEMPTS; attempt++) {
      let attemptResponse = "";
      try {
        const { textStream } = await u.Ai.Text(modelKey).stream({
          system: withContentSafetyConstraint(system, contentSafetyConstraint),
          messages: messages ?? [{ role: "user", content: prompt }],
          abortSignal,
          tools: { ...extraTools, ...useTools({ resTool, msg: subMsg }) },
        });

        for await (const chunk of textStream) {
          await new Promise<void>((resolve) => setTimeout(() => resolve(), 1));
          text.append(chunk);
          attemptResponse += chunk;
        }
        if (!attemptResponse.trim()) {
          throw new Error("模型服务未返回有效内容");
        }
        fullResponse = attemptResponse;
        break;
      } catch (err: any) {
        const canRetry = !attemptResponse.trim() && (isTransientAiError(err) || /未返回有效内容/.test(collectErrorText(err)));
        if (err?.name === "AbortError" || abortSignal?.aborted || !canRetry || attempt === SUB_AGENT_MAX_ATTEMPTS) {
          text.complete();
          subMsg.error(u.error(err).message);
          throw err;
        }

        console.warn(`[scriptAgent] ${modelKey} 调用失败，准备第 ${attempt + 1}/${SUB_AGENT_MAX_ATTEMPTS} 次尝试:`, u.error(err).message);
        const retryState = subMsg.thinking("模型服务暂时不可用，正在自动重试...");
        retryState.appendText(`第 ${attempt + 1}/${SUB_AGENT_MAX_ATTEMPTS} 次尝试`);
        retryState.complete();
        await waitBeforeRetry(750 * attempt, abortSignal);
      }
    }

    text.complete();
    subMsg.complete();

    if (fullResponse.trim()) {
      await persistPlanXml(resTool.data.projectId, fullResponse);
      await memory.add(memoryKey, removeAllXmlTags(fullResponse), {
        name,
        createTime: new Date(subMsg.datetime).getTime(),
      });
    }

    parentCtx.msg = resTool.newMessage("assistant", "视频策划");
    return fullResponse;
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

      const formatPrompt = "\n你必须使用如下XML格式写入工作区：\n<storySkeleton>故事骨架内容</storySkeleton>";

      return runAgent({
        modelKey: "scriptAgent:storySkeletonAgent",
        prompt,
        system: systemPrompt + formatPrompt,
        name: "编剧",
        memoryKey: "assistant:execution:storySkeleton",
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

      const formatPrompt = "\n你必须使用如下XML格式写入工作区：\n<adaptationStrategy>改编策略内容</adaptationStrategy>";

      return runAgent({
        modelKey: "scriptAgent:adaptationStrategyAgent",
        prompt,
        system: systemPrompt + formatPrompt,
        name: "编剧",
        memoryKey: "assistant:execution:adaptationStrategy",
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

      const formatPrompt = `\n你必须使用如下XML格式写入工作区：\nXML不得添加任何额外标签<scriptItem name="剧本名称">剧本内容</scriptItem><scriptItem name="剧本名称">剧本内容</scriptItem><scriptItem name="剧本名称">剧本内容</scriptItem>`;

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
