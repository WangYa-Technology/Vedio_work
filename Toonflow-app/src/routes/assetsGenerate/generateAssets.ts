import express from "express";
import u from "@/utils";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { parseModelReference } from "@/utils/modelRef";
import {
  appendNegativePrompt,
  buildAssetGenerationPrompt,
} from "@/utils/imagePrompt";
import {
  buildAssetInferenceTemplatePrompt,
  isAssetInferenceTemplateApplicable,
  parseAssetInferenceTemplate,
} from "@/utils/assetInferenceTemplate";

const router = express.Router();

type AssetType = "role" | "scene" | "tool";

interface AssetTypeConfig {
  label: string;
  taskClass: string;
  dir: string;
  promptTitle: string;
  promptEnd: string;
  promptGuidance?: string[];
}

const assetTypeConfig: Record<AssetType, AssetTypeConfig> = {
  role: {
    label: "角色",
    taskClass: "角色图生成",
    dir: "role",
    promptTitle: "角色标准四视图",
    promptEnd: "人物角色四视图",
    promptGuidance: [
      "角色图必须是横向角色设计板：左侧大幅正脸面部特写，右侧依次为同一角色正面全身、标准侧面全身、背面全身。",
      "若提示词包含3D半写实国漫、BJD、成年少女、甜美纯欲、梦幻偶像、轻哥特、Y2K、洛丽塔、甜酷Coquette、精灵、猫系杏仁眼、御姐、女团、轻奢穿搭、高级黑、冷感美少年、痞帅校园、暗黑街头、精英西装、ai男主、建模脸cos、少年偶像、韩系高街、静奢、轻Y2K、学院休闲、潮流针织、牛仔、机能、轻朋克、国漫古风美男、古风cos、华服、仙侠男性等线索，必须保留脸型或骨相、玻璃感瞳孔或猫系杏仁眼、深邃眼神、鼻唇、CG人偶肤质、发丝层次、身高头身比、服饰材质、配饰细节与16:9横向四视图版式。",
      "成年少女风必须明确为成年年轻女性，保留甜美、甜酷和梦幻感；若指定1.8米/九头身，必须保留小头、窄肩、细腰、修长双腿和完整鞋履，避免幼童感、大头娃娃、身体过短、腿短、廉价Cos感、单一配色、厚重服饰和过度暴露。",
      "甜酷Coquette风可保留齐刘海、空气刘海、长卷发、双马尾、半扎公主头、编发、猫耳发饰、大型蝴蝶结，服饰优先轻盈修身上衣、丝光针织、薄纱泡泡袖、抽褶绑带、毛绒细节、荷叶边百褶短裙裤、珍珠水晶猫系首饰、玛丽珍鞋或精致复古运动鞋；避免塑料假人感、球形关节和视图缺失。",
      "少年偶像/韩系高街风必须明确年轻成年男性，保留清冷高级偶像气质、220cm九头身、小头长颈窄腰、蓬松分层碎发和宽松但有结构的高街服装；可用静奢、轻Y2K、学院休闲、轻机能或轻朋克元素，但避免普通运动服、老气商务装、廉价塑料面料、胡须油腻皮肤和女性化首饰。",
      "现代高级黑男性风必须保留年轻成年男性身份、冷冽攻击感、220cm或用户指定高挑九头身比例、小头长颈窄腰超长腿、黑/深棕蓬松碎发、当代都市轻奢高定男装材质；避免真人感、紧身裤、廉价基础款、未来制服、奇幻礼服、过度女性化和耳饰。",
      "浅灰色无缝影棚背景，柔和商业棚拍光，细腻轮廓光；全身从头顶到脚底完整展示，不裁切；不要文字、水印、标签或尺标。",
    ],
  },
  scene: {
    label: "场景",
    taskClass: "场景图生成",
    dir: "scene",
    promptTitle: "标准场景图",
    promptEnd: "标准场景图",
  },
  tool: {
    label: "道具",
    taskClass: "道具图生成",
    dir: "props",
    promptTitle: "标准道具图",
    promptEnd: "标准道具图",
  },
};

// ─── 构建生成提示词 ──────────────────────────────────────────

// ─── 生成资产图片 ────────────────────────────────────────────

const requestSchema = {
  projectId: z.number(),
  model: z.string(),
  resolution: z.string(),
  id: z.number(),
  type: z.enum(["role", "scene", "tool", "storyboard"]),
  name: z.string(),
  prompt: z.string(),
  base64: z.string().optional().nullable(),
  referenceImageId: z.number().optional().nullable(),
  templateId: z.number().optional().nullable(),
};

export default router.post(
  "/",
  validateFields(requestSchema),
  async (req, res) => {
    const {
      projectId,
      model,
      resolution,
      id,
      type,
      name,
      prompt,
      base64,
      referenceImageId,
      templateId,
    } = req.body;

    // 1. 查询项目 & 获取类型配置
    const project = await u
      .db("o_project")
      .where("id", projectId)
      .select("artStyle", "negativePrompt", "type", "intro")
      .first();
    if (!project) return res.status(500).send(success({ message: "项目为空" }));

    const cfg = assetTypeConfig[type as AssetType];
    if (!cfg) return res.status(400).send(error("不支持的类型"));

    const asset = await u
      .db("o_assets")
      .where({ id, projectId })
      .select("id", "type", "name", "describe")
      .first();
    if (!asset) return res.status(404).send(error("资产不存在"));
    if (asset.type !== type)
      return res.status(400).send(error("资产类型不匹配"));

    const selectedTemplate = templateId
      ? await u.db("o_prompt").where({ id: templateId }).select("data", "useData").first()
      : null;
    const selectedTemplateRaw = String(selectedTemplate?.useData || selectedTemplate?.data || "");
    const selectedStructuredTemplate = parseAssetInferenceTemplate(selectedTemplateRaw);
    if (selectedStructuredTemplate && !isAssetInferenceTemplateApplicable(selectedStructuredTemplate, type)) {
      return res.status(400).send(error(`推理模板“${selectedStructuredTemplate.name}”不适用于${cfg.label}资产`));
    }
    const selectedAspectRatio = selectedStructuredTemplate?.canvas.aspectRatio || selectedTemplateRaw.match(/\b(?:9:16|16:9|1:1|4:3)\b/)?.[0] || prompt.match(/\b(?:9:16|16:9|1:1|4:3)\b/)?.[0] || "16:9";
    const customTemplateGuidance = templateId
      ? [
          selectedStructuredTemplate
            ? buildAssetInferenceTemplatePrompt(selectedStructuredTemplate)
            : "严格遵循当前图片提示词中明确的画布比例、视图数量、细节面板和版式，不得追加角色标准四视图或道具四宫格规则。",
          "当前已选择自定义图片推理模板；模板版式优先于默认资产类型版式。",
        ]
      : cfg.promptGuidance;

    let referenceBase64 = base64 || "";
    if (!referenceBase64 && referenceImageId != null) {
      const referenceImage = await u
        .db("o_image")
        .where({ id: referenceImageId, assetsId: id, state: "已完成" })
        .whereNotNull("filePath")
        .select("filePath")
        .first();
      if (!referenceImage)
        return res.status(400).send(error("所选参考图不属于当前资产或不可用"));
      referenceBase64 = await u.oss.getImageBase64(referenceImage.filePath);
    }

    // 2. 创建图片占位记录
    const [imageId] = await u.db("o_image").insert({
      type,
      state: "生成中",
      assetsId: id,
    });
    await u.db("o_assets").where("id", id).update({ imageId });

    // 3. 准备生成参数
    const imagePath = `/${projectId}/${cfg.dir}/${uuidv4()}.jpg`;
    const userPrompt = appendNegativePrompt(
      buildAssetGenerationPrompt({
        promptTitle: selectedTemplateRaw ? "自定义模板资产图" : cfg.promptTitle,
        promptEnd: selectedTemplateRaw ? "符合所选模板版式的资产图" : cfg.promptEnd,
        assetLabel: cfg.label,
        artStyle: project.artStyle,
        name: String(asset.name || name),
        description: asset.describe,
        prompt,
        hasReference: Boolean(referenceBase64),
        guidance: customTemplateGuidance,
        customTemplate: Boolean(selectedTemplateRaw),
      }),
      project.negativePrompt,
    );
    const describe = `生成${cfg.label}图，名称：${name}，提示词：${prompt}`;
    const relatedObjects = {
      id,
      projectId,
      type: cfg.label,
      templateId: templateId ?? null,
    };

    try {
      const aiImage = u.Ai.Image(model);
      await aiImage.run(
        {
          prompt: userPrompt,
          imageBase64: referenceBase64 ? [referenceBase64] : [],
          referenceList: referenceBase64
            ? [{ type: "image", base64: referenceBase64 }]
            : [],
          size: resolution,
          aspectRatio: selectedAspectRatio as `${number}:${number}`,
        },
        {
          taskClass: cfg.taskClass,
          describe,
          projectId,
          relatedObjects: JSON.stringify(relatedObjects),
        },
      );
      await aiImage.save(imagePath);
      // 5. 更新记录 & 返回结果
      const imageData = await u
        .db("o_image")
        .where("id", imageId)
        .select("*")
        .first();
      if (!imageData) return res.status(500).send("资产已被删除");
      if (imageData.state === "生成失败") return;
      await u
        .db("o_image")
        .where("id", imageId)
        .update({
          state: "已完成",
          filePath: imagePath,
          type,
          model: parseModelReference(model).modelName || model,
          resolution,
        });

      const path = await u.oss.getFileUrl(imagePath);
      await u.db("o_assets").where("id", id).update({ imageId });

      return res.status(200).send(success({ path, assetsId: id }));
    } catch (e) {
      await u
        .db("o_image")
        .where("id", imageId)
        .update({ state: "生成失败", errorReason: u.error(e).message });
      return res.status(400).send(error(u.error(e).message || "图片生成失败"));
    }
  },
);
