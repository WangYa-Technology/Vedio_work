import { z } from "zod";

export const ProjectGlobalMaterialSchema = z.object({
  content: z.string().default("").describe("资料正文"),
  sourceName: z.string().default("").describe("资料来源文件名"),
  updatedAt: z.number().optional().describe("最后更新时间"),
  canonStatus: z.enum(["approved", "proposed", "unresolved"]).default("approved").describe("设定状态"),
});

export const ProjectGlobalContextSchema = z.object({
  plot: ProjectGlobalMaterialSchema.default({ content: "", sourceName: "", canonStatus: "approved" }),
  character: ProjectGlobalMaterialSchema.default({ content: "", sourceName: "", canonStatus: "approved" }),
  world: ProjectGlobalMaterialSchema.default({ content: "", sourceName: "", canonStatus: "approved" }),
});

export const EMPTY_PROJECT_GLOBAL_CONTEXT = {
  plot: { content: "", sourceName: "", canonStatus: "approved" as const },
  character: { content: "", sourceName: "", canonStatus: "approved" as const },
  world: { content: "", sourceName: "", canonStatus: "approved" as const },
};
