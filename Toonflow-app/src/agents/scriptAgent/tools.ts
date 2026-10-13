import { tool, Tool } from "ai";
import u from "@/utils";
import { z } from "zod";
import _ from "lodash";
import ResTool from "@/socket/resTool";
import { EMPTY_PROJECT_GLOBAL_CONTEXT, ProjectGlobalContextSchema } from "@/schemas/projectGlobalContext";
import { reportToMarkdown, runScriptChecks } from "@/agents/scriptAgent/scriptChecks";
import { runSkeletonChecks, skeletonReportToMarkdown } from "@/agents/scriptAgent/skeletonChecks";

export const ScriptSchema = z.object({
  name: z.string().describe("剧本名称"),
  content: z.string().describe("剧本内容"),
});
export const planData = z.object({
  storySkeleton: z.string().describe("故事骨架"),
  adaptationStrategy: z.string().describe("改编策略"),
  script: z.array(ScriptSchema).describe("剧本内容"),
  projectGlobalContext: ProjectGlobalContextSchema.describe("项目级剧情、人物与世界观资料"),
});

export type planData = z.infer<typeof planData>;

const keySchema = z.enum(Object.keys(planData.shape) as [keyof planData, ...Array<keyof planData>]);
const planDataKeyLabels = Object.fromEntries(
  Object.entries(planData.shape).map(([key, schema]) => [key, (schema as z.ZodTypeAny).description ?? key]),
) as Record<keyof planData, string>;

interface ToolConfig {
  resTool: ResTool;
  toolsNames?: string[];
  msg: ReturnType<ResTool["newMessage"]>;
}

type GlobalContextType = keyof z.infer<typeof ProjectGlobalContextSchema>;

const GLOBAL_CONTEXT_LABELS: Record<GlobalContextType, string> = {
  plot: "剧情数据库",
  character: "人物数据库",
  world: "世界观数据库",
};

function normalizeGlobalContext(value: unknown): z.infer<typeof ProjectGlobalContextSchema> {
  const parsed = ProjectGlobalContextSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  return ProjectGlobalContextSchema.parse(EMPTY_PROJECT_GLOBAL_CONTEXT);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function selectRelevantContext(content: string, keywords: string[], maxChars = 14000) {
  const normalized = content.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return "";
  if (!keywords.length) return normalized.length > maxChars ? `${normalized.slice(0, maxChars)}\n[资料过长，已截取]` : normalized;

  const lines = normalized.split("\n");
  const patterns = keywords.filter(Boolean).map((keyword) => new RegExp(escapeRegExp(keyword), "i"));
  const selected = new Set<number>();
  lines.forEach((line, index) => {
    if (!patterns.some((pattern) => pattern.test(line))) return;
    for (let offset = -2; offset <= 2; offset += 1) {
      const target = index + offset;
      if (target >= 0 && target < lines.length) selected.add(target);
    }
  });

  if (!selected.size) return "";
  const result = Array.from(selected)
    .sort((a, b) => a - b)
    .map((index) => lines[index])
    .join("\n")
    .trim();
  return result.length > maxChars ? `${result.slice(0, maxChars)}\n[筛选结果过长，已截取]` : result;
}

export default (toolCpnfig: ToolConfig) => {
  const { resTool, toolsNames, msg } = toolCpnfig;
  const tools: Record<string, Tool> = {
    get_novel_events: tool({
      description: "获取章节事件",
      inputSchema: z.object({
        ids: z.array(z.number()).describe("章节编号列表"),
      }),
      execute: async ({ ids }) => {
        console.log("[tools] get_novel_events", ids);
        const thinking = msg.thinking("正在查询章节事件...");
        const data = await u
          .db("o_novel")
          .where("projectId", resTool.data.projectId)
          .select("id", "chapterIndex as index", "reel", "chapter", "chapterData", "event", "eventState")
          .whereIn("chapterIndex", ids);
        thinking.appendText("正在查询章节编号: " + ids.join(","));
        const eventString = data.map((i: any) => [`第${i.index}章，标题：${i.chapter}，事件：${i.event}`].join("\n")).join("\n");
        thinking.appendText("查询结果:\n" + eventString);
        thinking.updateTitle("查询章节事件完成");
        thinking.complete();
        return eventString ?? "无数据";
      },
    }),
    get_planData: tool({
      description: "获取工作区数据",
      inputSchema: z.object({
        key: keySchema.describe("数据key"),
      }),
      execute: async ({ key }) => {
        console.log("[tools] get_planData", key);
        const thinking = msg.thinking(`正在获取${planDataKeyLabels[key]}工作区数据...`);
        const projectId = Number(resTool.data.projectId);
        const row = await u.db("o_agentWorkData").where({ projectId, key: "scriptAgent" }).first();
        let workData: Record<string, unknown> = {};
        try {
          workData = JSON.parse(row?.data ?? "{}");
        } catch {
          workData = {};
        }
        const scripts = await u.db("o_script").where({ projectId }).select("name", "content");
        const persistedPlanData: planData = {
          storySkeleton: typeof workData.storySkeleton === "string" ? workData.storySkeleton : "",
          adaptationStrategy: typeof workData.adaptationStrategy === "string" ? workData.adaptationStrategy : "",
          script: scripts.map((item) => ({ name: item.name || "", content: item.content || "" })),
          projectGlobalContext: normalizeGlobalContext(workData.projectGlobalContext),
        };
        const value = persistedPlanData[key];
        thinking.appendText(`获取到${planDataKeyLabels[key]}:\n` + (typeof value === "string" ? value : JSON.stringify(value)));
        thinking.updateTitle(`获取${planDataKeyLabels[key]}完成`);
        thinking.complete();
        return value ?? "无数据";
      },
    }),
    get_novel_text: tool({
      description: "获取小说章节原始文本内容",
      inputSchema: z.object({
        chapterIndex: z.string().describe("章节编号"),
      }),
      execute: async ({ chapterIndex }) => {
        console.log("[tools] get_novel_text", "[tools] get_novel_text", chapterIndex);
        const thinking = msg.thinking(`正在获取小说章节原文...`);
        const data = await u.db("o_novel").where("projectId", resTool.data.projectId).where({ chapterIndex }).select("chapterData").first();
        const text = data && data?.chapterData ? data.chapterData : "";
        thinking.appendText(`获取到原文:\n` + text);
        thinking.updateTitle(`获取小说章节原文完成`);
        thinking.complete();
        return text ?? "无数据";
      },
    }),
    get_project_global_context: tool({
      description: "按当前集、人物和地点筛选项目级剧情数据库、人物数据库与世界观数据库；这些资料不是章节原文",
      inputSchema: z.object({
        episode: z.number().int().positive().optional().describe("当前目标集数"),
        characterNames: z.array(z.string()).default([]).describe("本集涉及人物名"),
        locationNames: z.array(z.string()).default([]).describe("本集涉及地点名"),
        include: z.array(z.enum(["plot", "character", "world"])).default(["plot", "character", "world"]).describe("要读取的资料类型"),
      }),
      execute: async ({ episode, characterNames, locationNames, include }) => {
        console.log("[tools] get_project_global_context", { episode, characterNames, locationNames, include });
        const thinking = msg.thinking("正在读取项目全局资料...");
        const projectId = Number(resTool.data.projectId);
        const row = await u.db("o_agentWorkData").where({ projectId, key: "scriptAgent" }).first();
        let workData: Record<string, unknown> = {};
        try {
          workData = JSON.parse(row?.data ?? "{}");
        } catch {
          workData = {};
        }
        const context = normalizeGlobalContext(workData.projectGlobalContext);
        const episodeKeywords = episode
          ? [episode - 1, episode, episode + 1]
              .filter((value) => value > 0)
              .flatMap((value) => [`第${value}集`, `EP${String(value).padStart(2, "0")}`, `EP${value}`])
          : [];
        const sections = include.map((type) => {
          const material = context[type];
          const keywords =
            type === "plot"
              ? [...episodeKeywords, ...characterNames]
              : type === "character"
                ? characterNames
                : [...locationNames, ...characterNames, "时间线", "世界规则"];
          const selected = selectRelevantContext(material.content, keywords);
          const metadata = `来源：${material.sourceName || "未标注"}；设定状态：${material.canonStatus}；更新时间：${material.updatedAt ? new Date(material.updatedAt).toISOString() : "未标注"}`;
          const emptyState = material.content.trim() ? "未命中当前集筛选条件，正文未返回" : "未配置";
          return `## ${GLOBAL_CONTEXT_LABELS[type]}\n${metadata}\n${selected || emptyState}`;
        });
        const result = [
          "# 项目全局资料上下文",
          `项目ID：${projectId}${episode ? `；目标集：第${episode}集` : ""}`,
          "资料仅用于校验连续性、人物边界和世界规则；不得替代当前章节原文，不得提前泄露尚未到达的剧情或秘密。",
          ...sections,
        ].join("\n\n");
        thinking.appendText(`已读取：${include.map((type) => GLOBAL_CONTEXT_LABELS[type]).join("、")}`);
        thinking.updateTitle("读取项目全局资料完成");
        thinking.complete();
        return result;
      },
    }),
    get_script_content: tool({
      description: "获取剧本本内容",
      inputSchema: z.object({
        ids: z.array(z.string()).describe("脚本id"),
      }),
      execute: async ({ ids }) => {
        console.log("[tools] get_script_content", "[tools] get_script_content", ids);
        const thinking = msg.thinking(`正在获取脚本内容...`);
        const data = await u
          .db("o_script")
          .where("projectId", resTool.data.projectId)
          .whereIn("id", ids)
          .select("content", "name");
        const text = data && data.length ? data.map((d) => `<scriptItem name="${d.name}">${d.content}</scriptItem>`).join("\n") : "";
        thinking.appendText(`获取到脚本内容:\n` + text);
        thinking.updateTitle(`获取脚本内容完成`);
        thinking.complete();
        return text ?? "无数据";
      },
    }),
    run_script_checks: tool({
      description:
        "对已保存剧本执行确定性检查：单集时长折算、原文台词逐字比对、格式与红线关键词扫描、结构与场号校验。结果为事实层，审核报告中不得改写其结论",
      inputSchema: z.object({
        scriptNames: z.array(z.string()).optional().describe("只检查指定名称的剧本；不传则检查项目下全部剧本"),
      }),
      execute: async ({ scriptNames }) => {
        console.log("[tools] run_script_checks", scriptNames);
        const thinking = msg.thinking("正在执行剧本确定性检查...");
        try {
          const report = await runScriptChecks(
            Number(resTool.data.projectId),
            scriptNames?.length ? { scriptNames } : undefined,
          );
          const markdown = reportToMarkdown(report);
          thinking.appendText(
            `检查完成：${report.summary.episodeCount} 集；阻塞项 ${report.summary.blockingCount}，提示项 ${report.summary.noticeCount}`,
          );
          thinking.updateTitle("剧本确定性检查完成");
          thinking.complete();
          return markdown;
        } catch (err) {
          const message = u.error(err).message;
          thinking.appendText(`检查失败：${message}`);
          thinking.complete();
          return `确定性检查执行失败：${message}`;
        }
      },
    }),
    run_skeleton_checks: tool({
      description:
        "对已保存的故事骨架执行容量体检：逐集按原著台词素材的章份额核算刚性台词下限与预计时长（口径与剧本层/分镜层同一把尺子：逐字保留 + 每镜缓冲 + 标点停顿 + 动作预算；同一章在全剧分集中合计不超过100%，份额来自片段/场次/比例等显式标注，未标注时按场次或引用集数等比推断并在报告中标明来源），输出四级分级、制作侧三态（通过/可骑线/建议拆集/必拆/素材不足）、建议拆集数、授权删减反算字数、解析来源与全剧集数建议。结果为事实层，审核报告中不得改写其结论",
      inputSchema: z.object({}),
      execute: async () => {
        console.log("[tools] run_skeleton_checks");
        const thinking = msg.thinking("正在执行骨架容量体检...");
        try {
          const report = await runSkeletonChecks(Number(resTool.data.projectId));
          const markdown = skeletonReportToMarkdown(report);
          const severeCount = report.estimates.filter((item) => item.level === "severeOver").length;
          const splitCount = report.estimates.filter(
            (item) => item.capacityLevel === "splitRequired" || item.capacityLevel === "splitPressure",
          ).length;
          thinking.appendText(
            `体检完成：${report.estimates.length} 集；严重超载 ${severeCount} 集${splitCount ? `；建议/必须拆集 ${splitCount} 集` : ""}`,
          );
          thinking.updateTitle("骨架容量体检完成");
          thinking.complete();
          return markdown;
        } catch (err) {
          const message = u.error(err).message;
          thinking.appendText(`体检失败：${message}`);
          thinking.complete();
          return `骨架容量体检执行失败：${message}`;
        }
      },
    }),
  };
  return toolsNames ? Object.fromEntries(Object.entries(tools).filter(([n]) => toolsNames.includes(n))) : tools;
};
