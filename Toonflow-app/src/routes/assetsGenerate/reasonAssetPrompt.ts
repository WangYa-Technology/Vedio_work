import express from "express";
import { z } from "zod";
import u from "@/utils";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { resolveStylePromptReasoning } from "@/utils/stylePromptReasoning";

const router = express.Router();

function renderTemplate(source: string, asset: { name?: string; type?: string; describe?: string; prompt?: string }) {
  const name = asset.name || "未命名";
  const type = asset.type || "未标注";
  const describe = asset.describe || "无";
  const input = [`资产名称：${name}`, `资产类型：${type}`, `资产描述：${describe}`].join("\n");
  return source
    .replace(/\{\{(?:输入文本|文本|测试文本|输入内容|提示词)\}\}/g, input)
    .replace(/\{\{名称\}\}/g, name)
    .replace(/\{\{类型\}\}/g, type)
    .replace(/\{\{描述\}\}/g, describe)
    .replace(/\{\{当前提示词\}\}/g, asset.prompt || "无");
}

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    assetsId: z.number(),
    templateId: z.number(),
  }),
  async (req, res) => {
    const { projectId, assetsId, templateId } = req.body;
    const asset = await u
      .db("o_assets")
      .where({ id: assetsId, projectId })
      .select("id", "type", "name", "describe", "originalPrompt", "prompt")
      .first();
    if (!asset) return res.status(404).send(error("资产不存在或不属于当前项目"));

    const template = await u
      .db("o_prompt")
      .where({ id: templateId, type: "imagePromptGeneration" })
      .select("id", "name", "data")
      .first();
    if (!template || !String(template.data || "").trim()) {
      return res.status(400).send(error("请选择有效且非空的图片推理模版"));
    }

    try {
      const renderedTemplate = renderTemplate(String(template.data), asset);
      const project = await u
        .db("o_project")
        .where({ id: projectId })
        .select("artStyle")
        .first();
      const visualStyleManual = project?.artStyle
        ? u.getArtPromptFile(project.artStyle, "art_skills", "art_storyboard_video")
        : "";
      const styleReasoning = resolveStylePromptReasoning(
        project?.artStyle || "",
        visualStyleManual,
      );
      const result = (await u.Ai.Text("universalAi").invoke({
        system: [
          "你是图片提示词推理执行器。下面的推理模板是本次生成的最高优先规则，必须严格遵守其角色、结构、版式、风格和输出要求。",
          "不要沿用、润色或复述数据库中的旧提示词；必须根据本次资产信息从头推理。",
          "<推理模板>",
          renderedTemplate,
          "</推理模板>",
          "<风格推理规则>",
          styleReasoning,
          "</风格推理规则>",
        ].join("\n"),
        messages: [
          {
            role: "user",
            content: [
              `资产名称：${asset.name || "未命名"}`,
              `资产类型：${asset.type || "未标注"}`,
              `资产描述：${asset.describe || "无"}`,
              "请严格按照推理模板处理以上输入。只输出模板要求的最终结果，不要解释，不要复述输入。",
            ].join("\n"),
          },
        ],
        maxRetries: 0,
        maxOutputTokens: 4096,
      })) as any;
      const prompt = String(result.text || result._output || "").trim();
      if (!prompt) return res.status(502).send(error("图片推理未返回有效提示词"));

      const originalPrompt = String(asset.originalPrompt || asset.prompt || "").trim();
      await u.db("o_assets").where({ id: assetsId, projectId }).update({ originalPrompt, prompt });
      return res.status(200).send(success({ originalPrompt, prompt, assetsId, templateId }));
    } catch (caught) {
      return res.status(502).send(error(`图片提示词推理失败：${u.error(caught).message}`));
    }
  },
);
