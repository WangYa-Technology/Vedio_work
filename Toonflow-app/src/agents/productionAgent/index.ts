import { tool } from "ai";
import { z } from "zod";
import { Socket } from "socket.io";
import * as fs from "fs";
import path from "path";
import { parseModelReference } from "@/utils/modelRef";
import u from "@/utils";
import Memory from "@/utils/agent/memory";
import ResTool from "@/socket/resTool";
import useTools from "@/agents/productionAgent/tools";
import { parseStoryboardTableAssetBindings, saveProductionFlowArtifact } from "@/utils/productionFlow";
import {
  CONTENT_SAFETY_SETTING_KEY,
  DEFAULT_CONTENT_SAFETY_CONSTRAINT,
} from "@/constants/contentSafety";
import { resolveProjectImageModel } from "@/services/imageGeneration";
import { resolveProjectVideoModel } from "@/services/videoGeneration";

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

const SUB_AGENT_MAX_ATTEMPTS = 3;
const TRANSIENT_AI_ERROR =
  /(?:upstream_error|temporarily unavailable|service unavailable|overloaded|rate.?limit|too many requests|timeout|timed out|econnreset|etimedout|eai_again|\b(?:429|502|503|504)\b)/i;

function collectErrorText(error: unknown, depth = 0): string {
  if (depth > 3 || error == null) return "";
  if (typeof error === "string") return error;
  if (typeof error !== "object") return String(error);

  const value = error as Record<string, unknown>;
  const directValues = [
    "name",
    "message",
    "type",
    "code",
    "status",
    "statusCode",
    "responseBody",
  ]
    .map((key) => value[key])
    .filter(
      (item): item is string | number =>
        typeof item === "string" || typeof item === "number",
    )
    .map(String);
  const nestedValues = [
    value.cause,
    value.lastError,
    ...(Array.isArray(value.errors) ? value.errors : []),
  ]
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

function removeAllXmlTags(text: string) {
  return text
    .replace(/<([a-zA-Z][\w-]*)(\s+[^>]*)?>([\s\S]*?)<\/\1>/g, "")
    .replace(/<([a-zA-Z][\w-]*)(\s+[^>]*)?\/>/g, "")
    .replace(/<\/?[a-zA-Z][\w-]*(\s+[^>]*)?>/g, "")
    .trim();
}

function buildMemPrompt(mem: Awaited<ReturnType<Memory["get"]>>) {
  const sections: string[] = [];
  if (mem.rag.length)
    sections.push(
      `[相关记忆]\n${mem.rag.map((item) => item.content).join("\n")}`,
    );
  if (mem.summaries.length)
    sections.push(
      `[历史摘要]\n${mem.summaries.map((item, index) => `${index + 1}. ${item.content}`).join("\n")}`,
    );
  if (mem.shortTerm.length)
    sections.push(
      `[近期对话]\n${mem.shortTerm.map((item) => `${item.role}: ${item.content}`).join("\n")}`,
    );
  return `## Memory\n以下是你对用户的记忆，可作为参考但不要主动提及：\n${sections.join("\n\n")}`;
}

async function getContentSafetyConstraint() {
  const setting = await u
    .db("o_setting")
    .where("key", CONTENT_SAFETY_SETTING_KEY)
    .first();
  return String(setting?.value ?? DEFAULT_CONTENT_SAFETY_CONSTRAINT).trim();
}

async function getWorkflowContext(projectId: number, scriptId: number) {
  const workData = await u
    .db("o_agentWorkData")
    .where({ projectId, episodesId: scriptId, key: "productionFlowData" })
    .first();
  let flowData: Record<string, unknown> = {};
  try {
    flowData = JSON.parse(workData?.data ?? "{}");
  } catch {
    flowData = {};
  }
  const storyboardCount = await u.db("o_storyboard").where({ projectId, scriptId }).count("id as count").first();
  const panelCount = Number((storyboardCount as any)?.count ?? 0);
  const hasScriptPlan = typeof flowData.scriptPlan === "string" && flowData.scriptPlan.trim().length > 0;
  const hasStoryboardTable = typeof flowData.storyboardTable === "string" && flowData.storyboardTable.trim().length > 0;
  const formalStoryboardIds = panelCount
    ? await u.db("o_storyboard").where({ projectId, scriptId }).pluck("id")
    : [];
  const referencedAssetIds = panelCount
    ? (
        await u
          .db("o_assets2Storyboard")
          .whereIn("storyboardId", formalStoryboardIds)
          .pluck("assetId")
      ).map(Number)
    : parseStoryboardTableAssetBindings(String(flowData.storyboardTable || "")).flat();
  const uniqueReferencedAssetIds = [...new Set(referencedAssetIds)];
  const requiredAssets = uniqueReferencedAssetIds.length
    ? await u
        .db("o_assets")
        .leftJoin("o_image", "o_assets.imageId", "o_image.id")
        .where("o_assets.projectId", projectId)
        .whereIn("o_assets.id", uniqueReferencedAssetIds)
        .select("o_assets.id", "o_assets.name", "o_image.filePath", "o_image.state")
    : [];
  const missingAssets = requiredAssets.filter((asset) => !asset.filePath);
  const missingAssetLabel = missingAssets.map((asset) => `${asset.id}（${asset.name || "未命名素材"}）`).join("、");
  const suggestedNext = !hasScriptPlan
    ? "先执行导演规划"
    : !hasStoryboardTable
      ? "直接构建正式分镜表"
      : missingAssets.length
        ? `先生成分镜明确引用但尚无图片的素材：${missingAssetLabel}；素材就绪前不得进入分镜面板或视频生成`
      : panelCount === 0
        ? "直接把已保存的分镜表写入正式分镜面板，不要重新询问前置阶段"
        : "正式分镜面板已存在，继续执行分镜图生成或处理当前失败项";

  return [
    "## 宿主制作工作流快照（可信）",
    `导演规划：${hasScriptPlan ? "已保存" : "未生成"}`,
    `分镜表：${hasStoryboardTable ? "已保存" : "未生成"}`,
    `正式分镜面板：${panelCount}条`,
    `分镜引用素材：${uniqueReferencedAssetIds.length}项；缺少可用图片：${missingAssets.length ? missingAssetLabel : "无"}`,
    `建议下一步：${suggestedNext}`,
    "用户说“继续”“确认”“重试”时，必须按此快照推进；缺少引用素材图片时必须先派发素材生成，不得写入分镜面板或进入视频生成；不要重复询问已经保存的阶段，也不要把执行层的自然语言失败说明当作成功结果。",
  ].join("\n");
}

function withContentSafety(system: string, constraint: string) {
  return constraint
    ? `${system}\n\n## 内容安全约束（用户设置）\n${constraint}`
    : system;
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

async function buildTechniqueContext(
  project: any,
  phase: "directorPlan" | "storyboardTable" | "storyboardPanel",
) {
  const artFileName =
    phase === "directorPlan"
      ? "director_planning_style.md"
      : phase === "storyboardTable"
        ? "director_storyboard_table_style.md"
        : "director_storyboard.md";
  const narrativeFileName =
    phase === "directorPlan"
      ? "director_planning_narrative.md"
      : phase === "storyboardTable"
        ? "director_storyboard_table_narrative.md"
        : "director_storyboard.md";
  const root = u.getPath("skills");
  const files = [
    path.join(
      root,
      "art_skills",
      String(project.artStyle || ""),
      "driector_skills",
      artFileName,
    ),
    path.join(
      root,
      "story_skills",
      String(project.directorManual || ""),
      "driector_skills",
      narrativeFileName,
    ),
  ];
  if (phase === "storyboardPanel")
    files.unshift(
      path.join(root, "production_skills", "storyboard_prompt_techniques.md"),
    );
  const contents = (await Promise.all(files.map(readOptional))).filter(Boolean);
  return contents.length
    ? `\n\n## 已加载的项目技法\n${contents.join("\n\n---\n\n")}`
    : "";
}

function projectModelInfo(project: any) {
  const imageModelRef = parseModelReference(project.imageModel || "未配置");
  const videoModelRef = parseModelReference(project.videoModel || "未配置");
  const imageModel = imageModelRef.modelName || imageModelRef.vendorId;
  const videoModel = videoModelRef.modelName || videoModelRef.vendorId;
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

function buildChoiceDirective(text: string) {
  const choice = String(text || "").trim();
  if (!/^(?:(?:\d+\s*)?[A-C](?:\s*\+?\s*(?:\d+\s*)?[A-C])*)$/i.test(choice)) return "";
  return [
    "[系统执行约束] 用户正在回复上一条审核报告中的选项。必须按用户选择逐项执行，不得只复述选择或再次提出同一问题。",
    "涉及分镜时长的 A/B/C：必须调用分镜表执行层，按对应方案修改并保存 storyboardTable，回读确认保存成功后才能再次审核；如果未发生实际保存，必须明确报告未完成。",
    "涉及资产的 A/B：若资产已存在，必须用真实资产 ID 修改片段引用并保存；若不存在，必须明确引导用户到资产库新增并生成图片，禁止虚构 ID。",
    "涉及字段结构的 3A：必须输出标准七列表（序号、画面描述、时长、景别、运镜、台词、音效），并删除额外字段审核；不要把 3A 当作保留扩展字段。",
  ].join("\n");
}

export async function decisionAI(ctx: AgentContext) {
  const { isolationKey, text, userMessageTime, abortSignal, resTool } = ctx;
  const memory = new Memory("productionAgent", isolationKey);
  await memory.add("user", text, { createTime: userMessageTime });

  const project = await u
    .db("o_project")
    .where("id", resTool.data.projectId)
    .first();
  if (!project) throw new Error(`项目不存在，ID: ${resTool.data.projectId}`);
  if (!project.imageModel) {
    try {
      await resolveProjectImageModel(project);
    } catch {
      // 规划阶段不因模型缺失或多选而中断，真正提交生图时会返回明确错误。
    }
  }
  if (!project.videoModel) {
    try {
      await resolveProjectVideoModel(project);
    } catch {
      // 视频工作台仍允许用户临时选模型，规划阶段只补全可唯一确定的配置。
    }
  }
  const prompt = await readSkill("production_agent_decision.md");
  const safety = await getContentSafetyConstraint();
  const mem = buildMemPrompt(await memory.get(text));
  const workflowContext = await getWorkflowContext(Number(resTool.data.projectId), Number(resTool.data.scriptId));
  const choiceDirective = buildChoiceDirective(text);

  const { textStream } = await u.Ai.Text(
    "productionAgent:decisionAgent",
  ).stream({
    messages: [
      { role: "system", content: withContentSafety(prompt, safety) },
      { role: "assistant", content: `${workflowContext}\n\n${mem}\n\n${projectModelInfo(project)}` },
      { role: "user", content: choiceDirective ? `${text}\n\n${choiceDirective}` : text },
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

async function createSubAgents(
  parentCtx: AgentContext,
  project: any,
  safety: string,
) {
  const { resTool, abortSignal } = parentCtx;
  const memory = new Memory("productionAgent", parentCtx.isolationKey);
  let supervisionStarted = false;
  let supervisionCompleted = false;

  async function runAgent(config: {
    key: `${string}:${string}`;
    prompt: string;
    skill: string;
    name: string;
    memoryKey: string;
    phase?: "directorPlan" | "storyboardTable" | "storyboardPanel";
    format?: string;
    requiredArtifact?: "scriptPlan" | "storyboardTable";
    isSupervision?: boolean;
  }) {
    if (supervisionStarted || supervisionCompleted) {
      return "审核已开始或完成。本轮必须立即停止并等待用户下一条消息，不能继续执行或再次审核。";
    }
    if (config.isSupervision) supervisionStarted = true;
    const workflowLabel = config.phase === "directorPlan"
      ? "正在制定导演规划"
      : config.phase === "storyboardTable"
        ? "正在构建分镜表"
        : config.phase === "storyboardPanel"
          ? "正在写入分镜面板"
          : config.isSupervision
            ? "正在审核制作结果"
            : "正在执行制作任务";
    resTool.workflowStatus("working", workflowLabel, config.phase ?? "production");
    parentCtx.msg.complete();
    const subMsg = resTool.newMessage("assistant", config.name);
    const systemBase = await readSkill(config.skill);
    const techniqueContext = config.phase
      ? await buildTechniqueContext(project, config.phase)
      : "";
    const system = withContentSafety(
      `${systemBase}${techniqueContext}${config.format || ""}`,
      safety,
    );
    const stream = subMsg.text();
    let fullResponse = "";
    let attemptMessages: { role: "user" | "assistant" | "system"; content: string }[] = [
      { role: "assistant", content: projectModelInfo(project) },
      { role: "user", content: `${config.prompt}${config.format || ""}` },
    ];
    for (let attempt = 1; attempt <= SUB_AGENT_MAX_ATTEMPTS; attempt++) {
      let attemptResponse = "";
      try {
        const { textStream } = await u.Ai.Text(config.key).stream({
          system,
          messages: attemptMessages,
          abortSignal,
          tools: useTools({ resTool, msg: subMsg }),
        });

        for await (const chunk of textStream) {
          stream.append(chunk);
          attemptResponse += chunk;
        }
        if (
          !attemptResponse.trim() &&
          (config.isSupervision || config.requiredArtifact)
        )
          throw new Error("模型服务未返回有效内容");
        if (config.requiredArtifact) {
          try {
            const artifact = getLastXmlElement(attemptResponse, config.requiredArtifact);
            if (!artifact) {
              throw new Error(`${config.requiredArtifact === "scriptPlan" ? "导演规划" : "分镜表"}任务未输出完整 XML 产出物`);
            }
          } catch (error) {
            if (attempt === SUB_AGENT_MAX_ATTEMPTS) throw error;
            const errorMessage = u.error(error).message;
            console.warn(`[productionAgent] ${config.key} 产出格式无效，准备第 ${attempt + 1}/${SUB_AGENT_MAX_ATTEMPTS} 次尝试:`, errorMessage);
            const retryState = subMsg.thinking("产出格式未通过校验，正在自动重新生成...");
            retryState.appendText(`第 ${attempt + 1}/${SUB_AGENT_MAX_ATTEMPTS} 次尝试`);
            retryState.complete();
            resTool.workflowStatus("retrying", `${workflowLabel}，正在修复输出格式（${attempt + 1}/${SUB_AGENT_MAX_ATTEMPTS}）`, config.phase ?? "production");
            attemptMessages = [
              ...attemptMessages,
              {
                role: "user",
                content: "上一轮输出未通过宿主校验。请忽略上一轮结果，重新完成任务，只输出一个完整且可解析的 XML 产出物，不要输出解释、Markdown 代码围栏或保存说明。",
              },
            ];
            await waitBeforeRetry(750 * attempt, abortSignal);
            continue;
          }
        }
        fullResponse = attemptResponse;
        break;
      } catch (error: any) {
        const canRetry =
          !attemptResponse.trim() &&
          (config.isSupervision === true || config.requiredArtifact != null) &&
          (isTransientAiError(error) ||
            /未返回有效内容/.test(collectErrorText(error)));
        if (
          error?.name === "AbortError" ||
          abortSignal?.aborted ||
          !canRetry ||
          attempt === SUB_AGENT_MAX_ATTEMPTS
        ) {
          stream.complete();
          subMsg.error(u.error(error).message);
          throw error;
        }

        console.warn(
          `[productionAgent] ${config.key} 调用失败，准备第 ${attempt + 1}/${SUB_AGENT_MAX_ATTEMPTS} 次尝试:`,
          u.error(error).message,
        );
        const retryState = subMsg.thinking(
          "模型服务暂时不可用，正在自动重试...",
        );
        retryState.appendText(
          `第 ${attempt + 1}/${SUB_AGENT_MAX_ATTEMPTS} 次尝试`,
        );
        retryState.complete();
        await waitBeforeRetry(750 * attempt, abortSignal);
      }
    }

    let result = fullResponse;
    try {
      if (config.requiredArtifact) {
        const artifact = getLastXmlElement(
          fullResponse,
          config.requiredArtifact,
        );
        if (!artifact)
          throw new Error(
            `${config.requiredArtifact === "scriptPlan" ? "导演规划" : "分镜表"}任务未输出完整 XML 产出物`,
          );
        await saveProductionFlowArtifact(
          Number(resTool.data.projectId),
          Number(resTool.data.scriptId),
          config.requiredArtifact,
          artifact,
        );
        result = `${config.requiredArtifact === "scriptPlan" ? "导演规划" : "分镜表"}已保存到工作区（${artifact.length}字）`;
        resTool.socket.emit("flowDataUpdated", {
          reason: config.requiredArtifact,
        });
      }
      stream.complete();
      subMsg.complete();
      resTool.workflowStatus("complete", `${workflowLabel}完成`, config.phase ?? "production");
    } catch (error) {
      stream.complete();
      subMsg.error(u.error(error).message);
      resTool.workflowStatus("error", `${workflowLabel}失败：${u.error(error).message}`, config.phase ?? "production");
      throw error;
    }

    try {
      const memoryContent = config.requiredArtifact
        ? result
        : removeAllXmlTags(fullResponse);
      if (memoryContent) {
        await memory.add(config.memoryKey, memoryContent, {
          name: config.name,
          createTime: new Date(subMsg.datetime).getTime(),
        });
      }
    } catch (error) {
      console.warn(
        `[productionAgent] ${config.memoryKey} 记忆写入失败，正式产出不受影响:`,
        u.error(error).message,
      );
    }
    parentCtx.msg = resTool.newMessage("assistant", "视频策划");
    if (config.isSupervision) supervisionCompleted = true;
    return result;
  }

  function getLastXmlElement(
    text: string,
    tag: "scriptPlan" | "storyboardTable",
  ) {
    const openPattern = new RegExp(`<${tag}(?:\\s[^>]*)?>`, "g");
    let lastOpen: RegExpExecArray | null = null;
    let match: RegExpExecArray | null;
    while ((match = openPattern.exec(text)) !== null) lastOpen = match;
    if (!lastOpen) return undefined;
    const contentStart = lastOpen.index + lastOpen[0].length;
    const closeIndex = text.indexOf(`</${tag}>`, contentStart);
    if (closeIndex === -1) return undefined;
    return text.slice(contentStart, closeIndex).trim() || undefined;
  }

  const promptInput = z.object({
    prompt: z.string().describe("交给执行层的具体任务"),
  });
  return {
    run_sub_agent_derive_assets: tool({
      description: "派发衍生资产分析与写入任务",
      inputSchema: promptInput,
      execute: ({ prompt }) =>
        runAgent({
          key: "productionAgent:deriveAssetsAgent",
          prompt,
          skill: "production_execution_derive_assets.md",
          name: "执行导演",
          memoryKey: "assistant:execution",
        }),
    }),
    run_sub_agent_generate_assets: tool({
      description: "派发资产图片生成任务",
      inputSchema: promptInput,
      execute: ({ prompt }) =>
        runAgent({
          key: "productionAgent:generateAssetsAgent",
          prompt,
          skill: "production_execution_generate_assets.md",
          name: "执行导演",
          memoryKey: "assistant:execution",
        }),
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
          requiredArtifact: "scriptPlan",
          format:
            "\n你必须输出一个完整的 <scriptPlan>内容</scriptPlan>。该 XML 是唯一产出协议，宿主会自动事务保存并回读校验；无需寻找写入工具。闭合 XML 后立即结束输出。",
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
          requiredArtifact: "storyboardTable",
          format:
            "\n你必须输出一个完整的 <storyboardTable>内容</storyboardTable>。该 XML 是唯一产出协议，宿主会自动事务保存并回读校验；无需寻找写入工具。闭合 XML 后立即结束输出。",
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
        runAgent({
          key: "productionAgent:storyboardGenAgent",
          prompt,
          skill: "production_execution_storyboard_gen.md",
          name: "执行导演",
          memoryKey: "assistant:execution",
        }),
    }),
    run_sub_agent_supervision: tool({
      description: "派发独立质量审核任务",
      inputSchema: promptInput,
      execute: ({ prompt }) =>
        runAgent({
          key: "productionAgent:supervisionAgent",
          prompt,
          skill: "production_agent_supervision.md",
          name: "监制",
          memoryKey: "assistant:supervision",
          isSupervision: true,
        }),
    }),
  };
}
