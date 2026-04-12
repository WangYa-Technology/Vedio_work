import { Socket } from "socket.io";
import { tool } from "ai";
import { z } from "zod";
import u from "@/utils";
import Memory from "@/utils/agent/memory";
import useTools from "@/agents/storyboardAgent/tools";
import ResTool from "@/socket/resTool";
import * as fs from "fs";
import path from "path";

export interface AgentContext {
  socket: Socket;
  isolationKey: string;
  text: string;
  scriptId?: number;
  userMessageTime?: number;
  abortSignal?: AbortSignal;
  resTool: ResTool;
  msg: ReturnType<ResTool["newMessage"]>;
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

export async function decisionAI(ctx: AgentContext) {
  const { isolationKey, text, userMessageTime, abortSignal, resTool } = ctx;

  const memory = new Memory("storyboardAgent", isolationKey);
  await memory.add("user", text, { createTime: userMessageTime });

  const skill = path.join(u.getPath("skills"), "storyboard_agent_decision.md");
  const prompt = await fs.promises.readFile(skill, "utf-8");

  const mem = buildMemPrompt(await memory.get(text));

  const projectData = await u.db("o_project").where("id", resTool.data.projectId).first();

  const scriptList = await u.db("o_script").where("projectId", resTool.data.projectId).select("id", "name");

  const projectInfo = [
    "## 项目信息",
    `项目名称：${projectData?.name ?? "未知"}`,
    `项目类型：${projectData?.type ?? "未知"}`,
    `项目简介：${projectData?.intro ?? "无"}`,
    `视觉风格：${projectData?.artStyle ?? "无"}`,
    `视频画幅：${projectData?.videoRatio ?? "9:16"}`,
    `可用剧本：${scriptList.map((s: any) => `${s.id}:${s.name}`).join(", ") || "无"}`,
    `当前剧本ID：${ctx.scriptId ?? "未指定"}`,
  ].join("\n");

  const { textStream } = await u.Ai.Text("storyboardAgent").stream({
    messages: [
      { role: "system", content: prompt },
      { role: "assistant", content: projectInfo + "\n" + mem },
      { role: "user", content: text },
    ],
    abortSignal,
    tools: {
      ...memory.getTools(),
      ...useTools({ resTool: ctx.resTool, msg: ctx.msg }),
      ...createSubAgent(ctx),
    },
    onFinish: async (completion) => {
      await memory.add("assistant:decision", removeAllXmlTags(completion.text));
    },
  });

  return textStream;
}

function createSubAgent(parentCtx: AgentContext) {
  const { resTool, abortSignal } = parentCtx;
  const memory = new Memory("storyboardAgent", parentCtx.isolationKey);

  async function runAgent({
    prompt,
    system,
    name,
    memoryKey,
    tools: extraTools,
    messages,
  }: {
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

    const { textStream } = await u.Ai.Text("storyboardAgent").stream({
      system,
      messages: messages ?? [{ role: "user", content: prompt }],
      abortSignal,
      tools: { ...extraTools, ...useTools({ resTool, msg: subMsg }) },
    });

    try {
      for await (const chunk of textStream) {
        await new Promise<void>((resolve) => setTimeout(() => resolve(), 1));
        text.append(chunk);
        fullResponse += chunk;
      }
      text.complete();
      subMsg.complete();
    } catch (err: any) {
      text.complete();
      subMsg.stop();
      throw err;
    }

    if (fullResponse.trim()) {
      await memory.add(memoryKey, removeAllXmlTags(fullResponse), {
        name,
        createTime: new Date(subMsg.datetime).getTime(),
      });
    }

    parentCtx.msg = resTool.newMessage("assistant", "分镜师");
    return fullResponse;
  }

  const promptInput = z.object({
    prompt: z.string().describe("交给子Agent的任务简约描述，100字以内"),
  });

  const run_sub_agent_story_analysis = tool({
    description: "运行故事破题子Agent：分析剧本，建立Character Bible、视觉母题、故事大纲结构",
    inputSchema: promptInput,
    execute: async ({ prompt }) => {
      const skill = path.join(u.getPath("skills"), "storyboard_execution_story_analysis.md");
      const systemPrompt = await fs.promises.readFile(skill, "utf-8");
      const formatPrompt = "\n你必须使用如下XML格式输出：\n<characterBible>角色圣经内容，JSON格式</characterBible>";
      return runAgent({
        prompt,
        system: systemPrompt + formatPrompt,
        name: "故事破题",
        memoryKey: "assistant:execution:storyAnalysis",
        messages: [{ role: "user", content: prompt + formatPrompt }],
      });
    },
  });

  const run_sub_agent_director_alignment = tool({
    description: "运行导演定调子Agent：完成六维定调、色彩情绪规划、视觉意象体系、音响设计",
    inputSchema: promptInput,
    execute: async ({ prompt }) => {
      const skill = path.join(u.getPath("skills"), "storyboard_execution_director_alignment.md");
      const systemPrompt = await fs.promises.readFile(skill, "utf-8");
      const formatPrompt = "\n你必须使用如下XML格式输出：\n<directorAlignment>导演定调内容</directorAlignment>";
      return runAgent({
        prompt,
        system: systemPrompt + formatPrompt,
        name: "导演定调",
        memoryKey: "assistant:execution:directorAlignment",
        messages: [{ role: "user", content: prompt + formatPrompt }],
      });
    },
  });

  const run_sub_agent_storyboard_breakdown = tool({
    description: "运行分镜拆解子Agent：按△格式生成完整分镜脚本，支持Seedance首尾帧和巨日禄融生视频两种平台模式",
    inputSchema: z.object({
      prompt: z.string().describe("交给子Agent的任务描述"),
      platformMode: z.enum(["seedance", "jurilü", "generic"]).describe("目标平台模式"),
    }),
    execute: async ({ prompt, platformMode }) => {
      const skill = path.join(u.getPath("skills"), "storyboard_execution_storyboard_breakdown.md");
      const systemPrompt = await fs.promises.readFile(skill, "utf-8");
      const formatPrompt = `\n目标平台：${platformMode}\n你必须使用如下XML格式输出：\n<storyboardScript>完整△格式分镜脚本</storyboardScript>`;
      return runAgent({
        prompt,
        system: systemPrompt,
        name: "分镜拆解",
        memoryKey: "assistant:execution:storyboardBreakdown",
        messages: [{ role: "user", content: prompt + formatPrompt }],
      });
    },
  });

  const run_sub_agent_asset_prompts = tool({
    description: "运行资产提示词子Agent：生成C/S/P系列资产清单和AI生成提示词，含防崩约束",
    inputSchema: promptInput,
    execute: async ({ prompt }) => {
      const skill = path.join(u.getPath("skills"), "storyboard_execution_asset_prompts.md");
      const systemPrompt = await fs.promises.readFile(skill, "utf-8");
      const formatPrompt = "\n你必须使用如下XML格式输出：\n<assetPrompts>资产提示词列表，JSON格式</assetPrompts>";
      return runAgent({
        prompt,
        system: systemPrompt + formatPrompt,
        name: "资产清单",
        memoryKey: "assistant:execution:assetPrompts",
        messages: [{ role: "user", content: prompt + formatPrompt }],
      });
    },
  });

  const run_supervision_agent = tool({
    description: "运行监督层子Agent：独立质检分镜内容，检查叙事目的、70/30法则、防崩约束、角色一致性",
    inputSchema: promptInput,
    execute: async ({ prompt }) => {
      const skill = path.join(u.getPath("skills"), "storyboard_agent_supervision.md");
      const systemPrompt = await fs.promises.readFile(skill, "utf-8");
      return runAgent({
        prompt,
        system: systemPrompt,
        name: "质检",
        memoryKey: "assistant:supervision",
      });
    },
  });

  return {
    run_sub_agent_story_analysis,
    run_sub_agent_director_alignment,
    run_sub_agent_storyboard_breakdown,
    run_sub_agent_asset_prompts,
    run_supervision_agent,
  };
}

function removeAllXmlTags(text: string): string {
  text = text.replace(/<([a-zA-Z][\w-]*)(\s+[^>]*)?>([\s\S]*?)<\/\1>/g, "");
  text = text.replace(/<([a-zA-Z][\w-]*)(\s+[^>]*)?\/>/g, "");
  text = text.replace(/<\/?[a-zA-Z][\w-]*(\s+[^>]*)?>/g, "");
  return text.trim();
}
