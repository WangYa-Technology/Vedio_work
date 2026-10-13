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
import useBaseAssetTools from "@/agents/productionAgent/baseAssetTools";
import { parseStoryboardTableAssetBindings, saveProductionFlowArtifact } from "@/utils/productionFlow";
import { isLatestAgentTask } from "@/utils/agentTaskGuard";
import {
  CONTENT_SAFETY_SETTING_KEY,
  DEFAULT_CONTENT_SAFETY_CONSTRAINT,
} from "@/constants/contentSafety";
import { resolveProjectImageModel } from "@/services/imageGeneration";
import { resolveProjectVideoModel } from "@/services/videoGeneration";
import {
  buildBlockingRepairChecklist,
  checkStoryboardTable,
  loadStoryboardAssets,
  loadStoryboardCheckContext,
  loadStoryboardTable,
  parseStoryboardTable,
  runStoryboardChecks,
  storyboardReportToMarkdown,
  type StoryboardCheckReport,
} from "@/agents/productionAgent/storyboardChecks";
import {
  mergeStoryboardRepair,
  storyboardChangesToMarkdown,
  summarizeStoryboardChanges,
  type RepairScope,
} from "@/agents/productionAgent/storyboardDoc";
import {
  appendStoryboardSupervisionRound,
  buildRepairScopesFromHistory,
  buildStoryboardSupervisionInjection,
  buildSupervisionVerdict,
  consumeSupervisionStream,
  createSupervisionStreamState,
  extendRepairScopes,
  flushSupervisionStream,
  parseStoryboardSupervisionMeta,
  readStoryboardSupervisionHistory,
  stripSupervisionMeta,
} from "@/agents/productionAgent/supervisionLog";

/** 分镜表定点修复上下文：守卫合并（旧表 + 授权范围） */
interface StoryboardRepairContext {
  oldTable: string;
  scopes: RepairScope[];
}

/** 分镜表机器校验阻塞项的自动回喂修复上限（用户设定：最多 3 轮） */
const MACHINE_REPAIR_MAX_ROUNDS = 3;

export interface AgentContext {
  socket: Socket;
  isolationKey: string;
  text: string;
  userMessageTime?: number;
  abortSignal?: AbortSignal;
  resTool: ResTool;
  msg: ReturnType<ResTool["newMessage"]>;
  /** 本会话任务代际，用于写入守卫拦截被新任务取代的旧任务产出。 */
  taskGeneration?: number;
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
  const pendingBaseAssetIds = Array.isArray(flowData.pendingBaseAssetIds)
    ? [...new Set(flowData.pendingBaseAssetIds.map(Number).filter(Number.isSafeInteger))]
    : [];
  const pendingBaseAssets = pendingBaseAssetIds.length
    ? await u
        .db("o_assets")
        .leftJoin("o_image", "o_assets.imageId", "o_image.id")
        .where("o_assets.projectId", projectId)
        .whereIn("o_assets.id", pendingBaseAssetIds)
        .select(
          "o_assets.id",
          "o_assets.name",
          "o_image.filePath",
          "o_image.state",
          "o_image.errorReason",
        )
    : [];
  const pendingBaseAssetStatus = await Promise.all(
    pendingBaseAssets.map(async (asset) => ({
      ...asset,
      available:
        /^https?:\/\//i.test(String(asset.filePath || "")) ||
        (Boolean(asset.filePath) && await u.oss.fileExists(String(asset.filePath))),
    })),
  );
  const unavailablePendingBaseAssets = pendingBaseAssetStatus.filter((asset) => !asset.available);
  const pendingBaseAssetLabel = pendingBaseAssetStatus
    .map((asset) => `${asset.id}（${asset.name || "未命名素材"}）`)
    .join("、");
  const generatingPendingBaseAssets = unavailablePendingBaseAssets.filter((asset) => asset.state === "生成中");
  const retryablePendingBaseAssets = unavailablePendingBaseAssets.filter((asset) => asset.state !== "生成中");
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
  const assetAvailability = await Promise.all(
    requiredAssets.map(async (asset) => ({
      ...asset,
      available:
        /^https?:\/\//i.test(String(asset.filePath || "")) ||
        (Boolean(asset.filePath) && await u.oss.fileExists(String(asset.filePath))),
    })),
  );
  const missingAssets = assetAvailability.filter((asset) => !asset.available);
  const missingAssetLabel = missingAssets.map((asset) => `${asset.id}（${asset.name || "未命名素材"}）`).join("、");
  const suggestedNext = !hasScriptPlan
    ? "先执行导演规划"
    : !hasStoryboardTable
      ? "直接构建正式分镜表"
      : pendingBaseAssetIds.length && pendingBaseAssets.length !== pendingBaseAssetIds.length
        ? "待补建基础资产记录不完整，先重新读取资产并报告缺失 ID，不得进入分镜面板"
      : retryablePendingBaseAssets.length
        ? `先重新生成补建资产图片：${retryablePendingBaseAssets.map((asset) => `${asset.id}（${asset.name || "未命名素材"}）`).join("、")}`
      : generatingPendingBaseAssets.length
        ? `补建资产图片仍在生成中：${generatingPendingBaseAssets.map((asset) => `${asset.id}（${asset.name || "未命名素材"}）`).join("、")}；等待就绪后再修复分镜表`
      : pendingBaseAssetIds.length
        ? `补建资产图片已就绪；先用真实资产 ID ${pendingBaseAssetLabel} 修复分镜表对应片段引用并重新审核`
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
    `待写入分镜表的补建基础资产：${pendingBaseAssetIds.length ? pendingBaseAssetLabel || pendingBaseAssetIds.join("、") : "无"}`,
    `建议下一步：${suggestedNext}`,
    "用户说“继续”“确认”“重试”时，必须按此快照推进；存在待写入分镜表的补建基础资产时，必须先等待或生成其图片，再用真实 ID 修复分镜表并重新审核；缺少引用素材图片时必须先派发素材生成，不得写入分镜面板或进入视频生成；不要重复询问已经保存的阶段，也不要把执行层的自然语言失败说明当作成功结果。",
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
    "涉及资产的 A：若缺少基础资产，必须调用 run_sub_agent_base_assets，按审核报告中的名称和类型补建、关联当前剧本并提交图片生成；图片就绪后才能用真实资产 ID 修改片段引用。涉及资产的 B：按审核报告将其改为不可辨识背景元素并保存。禁止虚构 ID。",
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
    includeBaseAssetTools?: boolean;
    /** 分镜表定点修复：仅授权范围内的场允许变化，范围外强制保留旧文 */
    repairContext?: StoryboardRepairContext | null;
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
    /**
     * 保存前稳定化分镜表产物：
     * 1) 定点修复模式下先按授权范围合并（未授权场强制保留旧文，逐行不变）；
     * 2) 跑确定性机器校验，阻塞项自动回喂模型修复（≤ MACHINE_REPAIR_MAX_ROUNDS 轮）。
     * 返回的 artifact 即最终保存内容。
     */
    async function stabilizeStoryboardArtifact(): Promise<{
      artifact: string;
      report: StoryboardCheckReport;
      rounds: number;
      mergeApplied: boolean;
      mergeWarnings: string[];
    }> {
      const [assets, checkContext] = await Promise.all([
        loadStoryboardAssets(Number(resTool.data.projectId)),
        loadStoryboardCheckContext(Number(resTool.data.projectId), Number(resTool.data.scriptId)),
      ]);
      let response = fullResponse;
      let artifact = getLastXmlElement(response, "storyboardTable") ?? "";
      let mergeWarnings: string[] = [];
      let mergeApplied = false;
      let scopes: RepairScope[] | null = config.repairContext?.scopes ?? null;
      const oldTable = config.repairContext?.oldTable ?? "";

      const applyGuard = (): string => {
        if (!scopes || !oldTable.trim()) return artifact;
        const result = mergeStoryboardRepair(oldTable, artifact, scopes);
        mergeWarnings = result.warnings;
        mergeApplied = true;
        return result.merged;
      };

      let mergedArtifact = applyGuard();
      let report = checkStoryboardTable(mergedArtifact, {
        assets,
        script: checkContext.script,
        waivers: checkContext.waivers,
      });
      let rounds = 0;

      while (report.blockingCount > 0 && rounds < MACHINE_REPAIR_MAX_ROUNDS) {
        rounds += 1;
        // 阻塞项所在场并入授权范围，保证自动修复能覆盖新暴露的阻塞场
        if (scopes) {
          const parsedMerged = parseStoryboardTable(mergedArtifact);
          const blockingSceneNos = [
            ...new Set(
              report.issues
                .filter((issue) => issue.severity === "阻塞" && issue.sceneNo != null)
                .map((issue) => issue.sceneNo as number),
            ),
          ];
          scopes = extendRepairScopes(scopes, parsedMerged, blockingSceneNos);
        }

        stream.append(
          `\n\n—— 机器校验发现 ${report.blockingCount} 项阻塞，自动修复中（第 ${rounds}/${MACHINE_REPAIR_MAX_ROUNDS} 轮）——\n\n`,
        );
        resTool.workflowStatus(
          "retrying",
          `正在构建分镜表，机器校验修复（${rounds}/${MACHINE_REPAIR_MAX_ROUNDS}）`,
          config.phase ?? "storyboardTable",
        );

        const checklist = buildBlockingRepairChecklist(report);
        const repairMessages: { role: "user" | "assistant" | "system"; content: string }[] = [
          ...attemptMessages,
          { role: "assistant", content: response },
          {
            role: "user",
            content: `【宿主机器校验】你上一轮输出的分镜表未通过确定性检查，发现 ${report.blockingCount} 项阻塞项：\n${checklist}\n\n请修复以上全部阻塞项（可调整时长、拆镜、调整描述用词、补引用），并保持其余内容不变；修完后只输出一个完整且可解析的 <storyboardTable>...</storyboardTable>，不要输出解释或代码围栏。`,
          },
        ];
        const { textStream } = await u.Ai.Text(config.key).stream({
          system,
          messages: repairMessages,
          abortSignal,
          tools: {
            ...useTools({ resTool, msg: subMsg }),
            ...(config.includeBaseAssetTools
              ? useBaseAssetTools({ resTool, msg: subMsg })
              : {}),
          },
        });
        let roundResponse = "";
        for await (const chunk of textStream) {
          stream.append(chunk);
          roundResponse += chunk;
        }
        if (!roundResponse.trim()) {
          console.warn("[productionAgent] 机器校验修复轮未返回内容，保留当前版本");
          break;
        }
        const candidate = getLastXmlElement(roundResponse, "storyboardTable");
        if (!candidate) {
          console.warn("[productionAgent] 机器校验修复轮未输出完整 XML，保留当前版本");
          break;
        }
        response = roundResponse;
        artifact = candidate;
        mergedArtifact = applyGuard();
        report = checkStoryboardTable(mergedArtifact, {
          assets,
          script: checkContext.script,
          waivers: checkContext.waivers,
        });
      }

      fullResponse = response;
      return { artifact: mergedArtifact, report, rounds, mergeApplied, mergeWarnings };
    }

    for (let attempt = 1; attempt <= SUB_AGENT_MAX_ATTEMPTS; attempt++) {
      let attemptResponse = "";
      // 审核层：拦截 <supervisionMeta> 块（只用于宿主持久化，不推送给前端）
      const supervisionStreamState = config.isSupervision ? createSupervisionStreamState() : undefined;
      try {
        const { textStream } = await u.Ai.Text(config.key).stream({
          system,
          messages: attemptMessages,
          abortSignal,
          tools: {
            ...useTools({ resTool, msg: subMsg }),
            ...(config.includeBaseAssetTools
              ? useBaseAssetTools({ resTool, msg: subMsg })
              : {}),
          },
        });

        for await (const chunk of textStream) {
          attemptResponse += chunk;
          if (supervisionStreamState) {
            const visible = consumeSupervisionStream(chunk, supervisionStreamState);
            if (visible) stream.append(visible);
          } else {
            stream.append(chunk);
          }
        }
        if (supervisionStreamState) {
          const tail = flushSupervisionStream(supervisionStreamState);
          if (tail) stream.append(tail);
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

    // ---- 分镜表：保存前跑确定性机器校验；有阻塞自动回喂修复（≤ MACHINE_REPAIR_MAX_ROUNDS 轮），
    // 并在定点修复模式下按授权范围合并（未授权场强制保留旧文）----
    let storyboardStabilized: Awaited<ReturnType<typeof stabilizeStoryboardArtifact>> | null = null;
    if (config.requiredArtifact === "storyboardTable") {
      try {
        storyboardStabilized = await stabilizeStoryboardArtifact();
      } catch (error) {
        console.warn("[productionAgent] 分镜表机器校验执行失败，跳过自动修复:", u.error(error).message);
      }
    }

    let result = fullResponse;
    let superseded = false;
    try {
      if (config.requiredArtifact) {
        const artifact =
          config.requiredArtifact === "storyboardTable" && storyboardStabilized
            ? storyboardStabilized.artifact
            : getLastXmlElement(fullResponse, config.requiredArtifact);
        if (!artifact)
          throw new Error(
            `${config.requiredArtifact === "scriptPlan" ? "导演规划" : "分镜表"}任务未输出完整 XML 产出物`,
          );
        const artifactLabel = config.requiredArtifact === "scriptPlan" ? "导演规划" : "分镜表";
        // 活跃任务校验：断连后在后台继续运行的旧任务若晚于新任务完成，拒绝写入，
        // 防止过期产物覆盖最新任务已保存的工作区数据。
        superseded =
          parentCtx.taskGeneration != null &&
          !isLatestAgentTask(parentCtx.isolationKey, parentCtx.taskGeneration);
        if (superseded) {
          console.warn(`[productionAgent] ${artifactLabel}产出属于已被取代的旧任务，已阻止写入以避免覆盖新产物`);
          result = `${artifactLabel}结果已被更新的制作任务取代，本次未保存`;
        } else {
          await saveProductionFlowArtifact(
            Number(resTool.data.projectId),
            Number(resTool.data.scriptId),
            config.requiredArtifact,
            artifact,
          );
          result = `${artifactLabel}已保存到工作区（${artifact.length}字）`;
          const stabilized = storyboardStabilized;
          if (config.requiredArtifact === "storyboardTable" && stabilized) {
            const parts: string[] = [
              `## 机器校验结论\n- 阻塞 ${stabilized.report.blockingCount} 项 / 骑线 ${stabilized.report.borderlineCount} 项 / 提示 ${stabilized.report.noticeCount} 项${stabilized.rounds ? `（已自动修复 ${stabilized.rounds} 轮）` : ""}`,
            ];
            if (stabilized.mergeApplied && config.repairContext) {
              parts.push(
                storyboardChangesToMarkdown(
                  summarizeStoryboardChanges(config.repairContext.oldTable, stabilized.artifact),
                ),
              );
            }
            if (stabilized.mergeWarnings.length) {
              parts.push(`### 合并守卫提示\n${stabilized.mergeWarnings.map((item) => `- ${item}`).join("\n")}`);
            }
            if (stabilized.report.blockingCount > 0) {
              const blockingList = stabilized.report.issues
                .filter((issue) => issue.severity === "阻塞")
                .slice(0, 12)
                .map((issue, index) => `${index + 1}. ${issue.location}｜${issue.problem}（${issue.target ?? ""}）`)
                .join("\n");
              parts.push(
                `⚠️ 自动修复 ${MACHINE_REPAIR_MAX_ROUNDS} 轮后仍有 ${stabilized.report.blockingCount} 项阻塞未闭环，需继续修复：\n${blockingList}`,
              );
            }
            result += `\n\n${parts.join("\n\n")}`;
          }
          resTool.socket.emit("flowDataUpdated", {
            reason: config.requiredArtifact,
          });
        }
      } else if (config.isSupervision) {
        // 审核层：解析 <supervisionMeta> → 持久化轮次记录 → 交给决策层的文本剥离 meta 并附宿主判定
        let record: ReturnType<typeof parseStoryboardSupervisionMeta>;
        try {
          record = parseStoryboardSupervisionMeta(fullResponse);
        } catch {
          record = undefined;
        }
        let machineBlockingCount = 0;
        try {
          const { report } = await runStoryboardChecks(
            Number(resTool.data.projectId),
            Number(resTool.data.scriptId),
          );
          machineBlockingCount = report.blockingCount;
        } catch (error) {
          console.warn("[productionAgent] 审核阶段机器校验读取失败:", u.error(error).message);
        }
        try {
          if (record) {
            await appendStoryboardSupervisionRound(
              Number(resTool.data.projectId),
              Number(resTool.data.scriptId),
              record,
            );
          }
        } catch (error) {
          console.warn("[productionAgent] 审核轮次记录写入失败，审核结果不受影响:", u.error(error).message);
        }
        result = `${stripSupervisionMeta(fullResponse)}\n\n${buildSupervisionVerdict(record, machineBlockingCount)}`;
      }
      stream.complete();
      subMsg.complete();
      resTool.workflowStatus(
        "complete",
        superseded ? `${workflowLabel}已结束：结果被更新的任务取代，未保存` : `${workflowLabel}完成`,
        config.phase ?? "production",
      );
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

  /**
   * 定点修复上下文：修复时仅允许修改授权范围内的场，其余场由宿主强制保留旧文。
   * - mode=repair：从上轮审核的严重问题位置推导授权场；
   * - mode 省略：存在未关闭严重问题时自动按修复处理（防决策层漏传参数导致守卫失效）；
   * - mode=build 或无旧表/无法推导问题位置：返回 null（全量重写，不设守卫）。
   */
  async function buildStoryboardRepairContext(
    mode?: "build" | "repair",
  ): Promise<StoryboardRepairContext | null> {
    try {
      const projectId = Number(resTool.data.projectId);
      const scriptId = Number(resTool.data.scriptId);
      const oldTable = await loadStoryboardTable(projectId, scriptId);
      if (!oldTable.trim()) return null;
      if (mode === "build") return null;
      const parsedOld = parseStoryboardTable(oldTable);
      const history = await readStoryboardSupervisionHistory(projectId, scriptId);
      const scopes = buildRepairScopesFromHistory(history, parsedOld);
      if (scopes?.length) return { oldTable, scopes };
      if (mode === "repair") {
        // 无法从历史定位问题范围：仍启用守卫管线（全表授权 = 不设内容约束），保证变更摘要对用户可见
        return { oldTable, scopes: parsedOld.scenes.map((scene) => ({ sceneOrder: scene.index })) };
      }
      return null;
    } catch (error) {
      console.warn("[productionAgent] 定点修复范围推导失败，按无守卫流程处理:", u.error(error).message);
      return null;
    }
  }

  const promptInput = z.object({
    prompt: z.string().describe("交给执行层的具体任务"),
  });
  return {
    run_sub_agent_base_assets: tool({
      description: "派发缺失基础资产补建、剧本关联与图片生成任务",
      inputSchema: promptInput,
      execute: ({ prompt }) =>
        runAgent({
          key: "productionAgent:baseAssetsAgent",
          prompt,
          skill: "production_execution_base_assets.md",
          name: "资产执行导演",
          memoryKey: "assistant:execution",
          includeBaseAssetTools: true,
        }),
    }),
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
      description: "派发正式分镜表构建或定点修复任务",
      inputSchema: z.object({
        prompt: z.string().describe("交给执行层的具体任务"),
        mode: z
          .enum(["build", "repair"])
          .optional()
          .describe(
            "build=构建或整表重做（默认）；repair=定点修复：仅允许修改审核/校验列出的问题场，其余场由宿主强制保留旧内容",
          ),
      }),
      execute: async ({ prompt, mode }) => {
        const repairContext = await buildStoryboardRepairContext(mode);
        return runAgent({
          key: "productionAgent:storyboardTableAgent",
          prompt,
          skill: "production_execution_storyboard_table.md",
          name: "执行导演",
          memoryKey: "assistant:execution",
          phase: "storyboardTable",
          requiredArtifact: "storyboardTable",
          repairContext,
          format:
            "\n你必须输出一个完整的 <storyboardTable>内容</storyboardTable>。该 XML 是唯一产出协议，宿主会自动事务保存并回读校验；无需寻找写入工具。闭合 XML 后立即结束输出。",
        });
      },
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
      execute: async ({ prompt }) => {
        // 审核前由宿主强制注入确定性检查结果与上一轮问题清单，不依赖模型自觉读取
        let injection = "";
        try {
          const [{ report }, history] = await Promise.all([
            runStoryboardChecks(Number(resTool.data.projectId), Number(resTool.data.scriptId)),
            readStoryboardSupervisionHistory(Number(resTool.data.projectId), Number(resTool.data.scriptId)),
          ]);
          injection = buildStoryboardSupervisionInjection(storyboardReportToMarkdown(report), history);
        } catch (error) {
          injection = `\n\n【宿主预注入：确定性检查与审核历史】\n- 确定性检查执行失败（${u.error(error).message}）；本轮审核需自行完成时长、禁词与资产核对，并在报告中标注确定性检查缺失。`;
        }
        return runAgent({
          key: "productionAgent:supervisionAgent",
          prompt: `${prompt}${injection}`,
          skill: "production_agent_supervision.md",
          name: "监制",
          memoryKey: "assistant:supervision",
          isSupervision: true,
        });
      },
    }),
  };
}
