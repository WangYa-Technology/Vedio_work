import u from "@/utils";
import { resolveStylePromptReasoning } from "@/utils/stylePromptReasoning";
import {
  ASSET_FACTS_PRIORITY_RULES,
  buildAssetPromptFactsMessage,
  hasPhotorealisticDirection,
} from "@/utils/imagePrompt";
import {
  buildAssetInferenceTemplatePrompt,
  isAssetInferenceTemplateApplicable,
  parseAssetInferenceTemplate,
} from "@/utils/assetInferenceTemplate";

type AssetType = "role" | "scene" | "tool";

export class AssetPromptReasoningError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 502,
    public readonly disposition: "failed" | "skipped" = "failed",
  ) {
    super(message);
    this.name = "AssetPromptReasoningError";
  }
}

function renderTemplate(
  source: string,
  asset: { name?: string; type?: string; describe?: string; prompt?: string },
) {
  const name = asset.name || "未命名";
  const type = asset.type || "未标注";
  const describe = asset.describe || "无";
  const input = [
    `资产名称：${name}`,
    `资产类型：${type}`,
    `资产描述：${describe}`,
  ].join("\n");
  return source
    .replace(/\{\{(?:输入文本|文本|测试文本|输入内容|提示词)\}\}/g, input)
    .replace(/\{\{名称\}\}/g, name)
    .replace(/\{\{类型\}\}/g, type)
    .replace(/\{\{描述\}\}/g, describe)
    .replace(/\{\{当前提示词\}\}/g, asset.prompt || "无");
}

export async function getReasoningTemplate(templateId: number) {
  const template = await u
    .db("o_prompt")
    .where({ id: templateId })
    .whereIn("type", ["assetInferenceTemplate", "imagePromptGeneration"])
    .select("id", "name", "data", "useData")
    .first();
  const source = String(template?.useData || template?.data || "").trim();
  if (!template || !source) {
    throw new AssetPromptReasoningError("请选择有效且非空的图片推理模版", 400);
  }
  return { ...template, source };
}

export async function reasonAssetPrompt(input: {
  projectId: number;
  assetsId: number;
  templateId: number;
  referenceImageId?: number | null;
}) {
  const { projectId, assetsId, templateId, referenceImageId } = input;
  const asset = await u
    .db("o_assets")
    .where({ id: assetsId, projectId })
    .select("id", "type", "name", "describe", "originalPrompt", "prompt", "imageId")
    .first();
  if (!asset) {
    throw new AssetPromptReasoningError("资产不存在或不属于当前项目", 404);
  }

  try {
    const template = await getReasoningTemplate(templateId);
    await u
      .db("o_assets")
      .where({ id: assetsId, projectId })
      .update({ promptState: "生成中", promptErrorReason: null });

    const structuredTemplate = parseAssetInferenceTemplate(template.source);
    if (
      structuredTemplate &&
      !isAssetInferenceTemplateApplicable(structuredTemplate, asset.type as AssetType)
    ) {
      const message = `推理模板“${structuredTemplate.name}”不适用于当前资产类型`;
      await u
        .db("o_assets")
        .where({ id: assetsId, projectId })
        .update({ promptState: "已跳过", promptErrorReason: message });
      throw new AssetPromptReasoningError(message, 400, "skipped");
    }

    const renderedTemplate = structuredTemplate
      ? buildAssetInferenceTemplatePrompt(structuredTemplate)
      : renderTemplate(template.source, asset);
    const project = await u
      .db("o_project")
      .where({ id: projectId })
      .select("artStyle", "intro")
      .first();
    const visualStyleManual = project?.artStyle
      ? u.getArtPromptFile(project.artStyle, "art_skills", "art_storyboard_video")
      : "";
    const styleReasoning = resolveStylePromptReasoning(
      project?.artStyle || "",
      visualStyleManual,
    );
    const effectiveStyleReasoning = hasPhotorealisticDirection(renderedTemplate)
      ? "当前图片推理模板明确要求真人写实/实拍/超写实媒介。项目全局风格只能提供非冲突的构图、色彩和光影参考，禁止引入动漫、卡通、二次元、赛璐珞、手绘平涂或动画渲染媒介。"
      : styleReasoning;

    let referenceImage: string | null = null;
    let referenceImageBytes: Uint8Array | null = null;
    const selectedReferenceId = referenceImageId || asset.imageId;
    if (selectedReferenceId) {
      const image = await u
        .db("o_image")
        .where({ id: selectedReferenceId, assetsId: asset.id })
        .select("filePath")
        .first();
      if (image?.filePath) {
        try {
          referenceImage = await u.oss.getImageBase64(image.filePath);
          const encoded = referenceImage.split(",")[1];
          if (encoded) referenceImageBytes = Buffer.from(encoded, "base64");
        } catch {
          referenceImage = null;
          referenceImageBytes = null;
        }
      }
    }

    const system = [
      "你是图片提示词推理执行器。剧本资产事实是本次生成的最高优先规则；推理模板只定义结构、版式和视觉表达。",
      ASSET_FACTS_PRIORITY_RULES,
      "不要沿用、润色或复述数据库中的旧提示词；必须根据本次资产信息从头推理。",
      referenceImage
        ? "参考图只用于提取可见的主体特征、轮廓、材质、色彩和构图元素；若与剧本事实冲突，必须服从剧本事实。"
        : "当前没有可读取的参考图，只能依据剧本资产事实和模板规则推理。",
      "<推理模板>",
      renderedTemplate,
      "</推理模板>",
      "<风格推理规则>",
      effectiveStyleReasoning,
      "</风格推理规则>",
      ASSET_FACTS_PRIORITY_RULES,
    ].join("\n");
    const factsMessage = {
      role: "user" as const,
      content: [
        {
          type: "text" as const,
          text: [
            buildAssetPromptFactsMessage({
              assetLabel: asset.type || "资产",
              name: asset.name || "未命名",
              description: asset.describe,
              projectIntro: project?.intro,
            }),
            "\n【任务】结合剧本事实、模板规则和参考图中可见元素，生成一条适用于当前资产的完整图片提示词。只输出提示词正文。",
          ].join("\n"),
        },
        ...(referenceImageBytes
          ? [{ type: "image" as const, image: referenceImageBytes }]
          : []),
      ],
    };

    let result: any;
    try {
      result = await u.Ai.Text("universalAi").invoke({
        system,
        messages: [factsMessage],
        maxRetries: 0,
        maxOutputTokens: 4096,
      });
    } catch (visionError) {
      if (!referenceImageBytes) throw visionError;
      result = await u.Ai.Text("universalAi").invoke({
        system: `${system}\n参考图视觉输入不可用，请仅依据剧本资产事实和模板规则完成推理。`,
        messages: [
          {
            role: "user",
            content: factsMessage.content.filter((part) => part.type === "text"),
          },
        ],
        maxRetries: 0,
        maxOutputTokens: 4096,
      });
    }

    const prompt = String(result.text || result._output || "").trim();
    if (!prompt) {
      throw new AssetPromptReasoningError("图片推理未返回有效提示词");
    }
    const originalPrompt = String(asset.originalPrompt || asset.prompt || "").trim();
    await u
      .db("o_assets")
      .where({ id: assetsId, projectId })
      .update({
        originalPrompt,
        prompt,
        promptState: "已完成",
        promptErrorReason: null,
      });
    return { originalPrompt, prompt, assetsId, templateId };
  } catch (caught) {
    if (caught instanceof AssetPromptReasoningError && caught.disposition === "skipped") {
      throw caught;
    }
    const reason = u.error(caught).message;
    await u
      .db("o_assets")
      .where({ id: assetsId, projectId })
      .update({ promptState: "失败", promptErrorReason: reason });
    if (caught instanceof AssetPromptReasoningError) throw caught;
    throw new AssetPromptReasoningError(reason);
  }
}
