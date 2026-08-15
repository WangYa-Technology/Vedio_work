import { tool } from "ai";
import { z } from "zod";
import { Socket } from "socket.io";
import * as fs from "fs";
import path from "path";
import u from "@/utils";
import Memory from "@/utils/agent/memory";
import ResTool from "@/socket/resTool";
import useTools from "@/agents/productionAgent/tools";
import { CONTENT_SAFETY_SETTING_KEY, DEFAULT_CONTENT_SAFETY_CONSTRAINT } from "@/constants/contentSafety";

export interface AgentContext {
  socket: Socket;
  isolationKey: string;
  text: string;
  userMessageTime?: number;
  abortSignal?: AbortSignal;
  resTool: ResTool;
  msg: ReturnType<ResTool["newMessage"]>;
  thinkConfig: { think: boolean; thinlLevel: number };
}

function removeAllXmlTags(text: string) {
  return text
    .replace(/<([a-zA-Z][\w-]*)(\s+[^>]*)?>([\s\S]*?)<\/\1>/g, "")
    .replace(/<([a-zA-Z][\w-]*)(\s+[^>]*)?\/>/g, "")
    .replace(/<\/?[a-zA-Z][\w-]*(\s+[^>]*)?>/g, "")
    .trim();
}

function buildMemPrompt(mem: Awaited<ReturnType<Memory["get"]>>) {
  const sections: string[] = [];
  if (mem.rag.length) sections.push(`[相关记忆]\n${mem.rag.map((item) => item.content).join("\n")}`);
  if (mem.summaries.length) sections.push(`[历史摘要]\n${mem.summaries.map((item, index) => `${index + 1}. ${item.content}`).join("\n")}`);
  if (mem.shortTerm.length) sections.push(`[近期对话]\n${mem.shortTerm.map((item) => `${item.role}: ${item.content}`).join("\n")}`);
  return `## Memory\n以下是你对用户的记忆，可作为参考但不要主动提及：\n${sections.join("\n\n")}`;
}

async function getContentSafetyConstraint() {
  const setting = await u.db("o_setting").where("key", CONTENT_SAFETY_SETTING_KEY).first();
  return String(setting?.value ?? DEFAULT_CONTENT_SAFETY_CONSTRAINT).trim();
}

function withContentSafety(system: string, constraint: string) {
  return constraint ? `${system}\n\n## 内容安全约束（用户设置）\n${constraint}` : system;
}

async function readSkill(name: string) {
  return fs.promises.readFile(path.join(u.getPath("skills"), name), "utf-8");
}

async function readOptional(filePath: string) {
  try {
    return await fs.promises.readFile(filePath, "utf-8");
  } catch {
    return "";
  }
}

async function buildTechniqueContext(project: any, phase: "directorPlan" | "storyboardTable" | "storyboardPanel") {
  const fileName =
    phase === "directorPlan" ? "director_planning_style.md" : phase === "storyboardTable" ? "director_storyboard_table_style.md" : "director_storyboard.md";
  const root = u.getPath("skills");
  const files = [
    path.join(root, "art_skills", String(project.artStyle || ""), "driector_skills", fileName),
    path.join(root, "story_skills", String(project.directorManual || ""), "driector_skills", fileName),
  ];
  if (phase === "storyboardPanel") files.unshift(path.join(root, "production_skills", "storyboard_prompt_techniques.md"));
  const contents = (await Promise.all(files.map(readOptional))).filter(Boolean);
  return contents.length ? `\n\n## 已加载的项目技法\n${contents.join("\n\n---\n\n")}` : "";
}

function projectModelInfo(project: any) {
  const imageModel = String(project.imageModel || "未配置").split(/:(.+)/)[1] || String(project.imageModel || "未配置");
  const videoModel = String(project.videoModel || "未配置").split(/:(.+)/)[1] || String(project.videoModel || "未配置");
  let videoMode: unknown = project.mode;
  try {
    videoMode = JSON.parse(project.mode || "null");
  } catch {}
  return [
    "项目使用的模型如下：",
    `图像模型：${imageModel}`,
    `视频模型：${videoModel}`,
    `多参：${Array.isArray(videoMode) ? "是" : "否"}`,
  ].join("\n");
}

export async function decisionAI(ctx: AgentContext) {
  const { isolationKey, text, userMessageTime, abortSignal, resTool } = ctx;
  const memory = new Memory("productionAgent", isolationKey);
  await memory.add("user", text, { createTime: userMessageTime });

  const project = await u.db("o_project").where("id", resTool.data.projectId).first();
  if (!project) throw new Error(`项目不存在，ID: ${resTool.data.projectId}`);
  const prompt = await readSkill("production_agent_decision.md");
  const safety = await getContentSafetyConstraint();
  const mem = buildMemPrompt(await memory.get(text));

  const { textStream } = await u.Ai.Text("productionAgent:decisionAgent").stream({
    messages: [
      { role: "system", content: withContentSafety(prompt, safety) },
      { role: "assistant", content: `${mem}\n\n${projectModelInfo(project)}` },
      { role: "user", content: text },
    ],
    abortSignal,
    tools: {
      ...memory.getTools(),
      ...useTools({ resTool, msg: ctx.msg }),
      ...(await createSubAgents(ctx, project, safety)),
    },
    onFinish: async (completion) => {
      const content = removeAllXmlTags(completion.text);
      if (content) await memory.add("assistant:decision", content);
    },
  });
  return textStream;
}

async function createSubAgents(parentCtx: AgentContext, project: any, safety: string) {
  const { resTool, abortSignal } = parentCtx;
  const memory = new Memory("productionAgent", parentCtx.isolationKey);

  async function runAgent(config: {
    key: `${string}:${string}`;
    prompt: string;
    skill: string;
    name: string;
    memoryKey: string;
    phase?: "directorPlan" | "storyboardTable" | "storyboardPanel";
    format?: string;
  }) {
    parentCtx.msg.complete();
    const subMsg = resTool.newMessage("assistant", config.name);
    const systemBase = await readSkill(config.skill);
    const techniqueContext = config.phase ? await buildTechniqueContext(project, config.phase) : "";
    const system = withContentSafety(`${systemBase}${techniqueContext}${config.format || ""}`, safety);
    const { textStream } = await u.Ai.Text(config.key).stream({
      system,
      messages: [
        { role: "assistant", content: projectModelInfo(project) },
        { role: "user", content: `${config.prompt}${config.format || ""}` },
      ],
      abortSignal,
      tools: useTools({ resTool, msg: subMsg }),
    });

    const stream = subMsg.text();
    let fullResponse = "";
    try {
      for await (const chunk of textStream) {
        stream.append(chunk);
        fullResponse += chunk;
      }
      stream.complete();
      subMsg.complete();
    } catch (error) {
      stream.complete();
      subMsg.error(u.error(error).message);
      throw error;
    }
    const memoryContent = removeAllXmlTags(fullResponse);
    if (memoryContent) {
      await memory.add(config.memoryKey, memoryContent, {
        name: config.name,
        createTime: new Date(subMsg.datetime).getTime(),
      });
    }
    parentCtx.msg = resTool.newMessage("assistant", "视频策划");
    return fullResponse;
  }

  const promptInput = z.object({ prompt: z.string().describe("交给执行层的具体任务") });
  return {
    run_sub_agent_derive_assets: tool({
      description: "派发衍生资产分析与写入任务",
      inputSchema: promptInput,
      execute: ({ prompt }) =>
        runAgent({ key: "productionAgent:deriveAssetsAgent", prompt, skill: "production_execution_derive_assets.md", name: "执行导演", memoryKey: "assistant:execution" }),
    }),
    run_sub_agent_generate_assets: tool({
      description: "派发资产图片生成任务",
      inputSchema: promptInput,
      execute: ({ prompt }) =>
        runAgent({ key: "productionAgent:generateAssetsAgent", prompt, skill: "production_execution_generate_assets.md", name: "执行导演", memoryKey: "assistant:execution" }),
    }),
    run_sub_agent_director_plan: tool({
      description: "派发导演规划任务",
      inputSchema: promptInput,
      execute: ({ prompt }) =>
        runAgent({
          key: "productionAgent:directorPlanAgent",
          prompt,
          skill: "production_execution_director_plan.md",
          name: "执行导演",
          memoryKey: "assistant:execution",
          phase: "directorPlan",
          format: "\n你必须一次性使用 <scriptPlan>内容</scriptPlan> 写入工作区。",
        }),
    }),
    run_sub_agent_storyboard_table: tool({
      description: "派发正式分镜表构建任务",
      inputSchema: promptInput,
      execute: ({ prompt }) =>
        runAgent({
          key: "productionAgent:storyboardTableAgent",
          prompt,
          skill: "production_execution_storyboard_table.md",
          name: "执行导演",
          memoryKey: "assistant:execution",
          phase: "storyboardTable",
          format: "\n你必须一次性使用 <storyboardTable>内容</storyboardTable> 写入工作区。",
        }),
    }),
    run_sub_agent_storyboard_panel: tool({
      description: "派发正式分镜面板写入或定点修复任务",
      inputSchema: promptInput,
      execute: ({ prompt }) =>
        runAgent({
          key: "productionAgent:storyboardPanelAgent",
          prompt,
          skill: "production_execution_storyboard_panel.md",
          name: "执行导演",
          memoryKey: "assistant:execution",
          phase: "storyboardPanel",
        }),
    }),
    run_sub_agent_storyboard_gen: tool({
      description: "派发分镜图片生成、状态跟踪或失败检查任务",
      inputSchema: promptInput,
      execute: ({ prompt }) =>
        runAgent({ key: "productionAgent:storyboardGenAgent", prompt, skill: "production_execution_storyboard_gen.md", name: "执行导演", memoryKey: "assistant:execution" }),
    }),
    run_sub_agent_supervision: tool({
      description: "派发独立质量审核任务",
      inputSchema: promptInput,
      execute: ({ prompt }) =>
        runAgent({ key: "productionAgent:supervisionAgent", prompt, skill: "production_agent_supervision.md", name: "监制", memoryKey: "assistant:supervision" }),
    }),
  };
}
