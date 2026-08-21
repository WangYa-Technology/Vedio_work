import express from "express";
import u from "@/utils";
import * as zod from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
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
const router = express.Router();
interface OutlineItem {
  description: string;
  name: string;
}

interface OutlineData {
  chapterRange: number[];
  characters?: OutlineItem[];
  props?: OutlineItem[];
  scenes?: OutlineItem[];
}

interface NovelChapter {
  id: number;
  reel: string;
  chapter: string;
  chapterData: string;
  projectId: number;
}

type ItemType = "characters" | "props" | "scenes";

interface ResultItem {
  type: ItemType;
  name: string;
  chapterRange: number[];
}
function findItemByName(
  items: ResultItem[],
  name: string,
  type?: ItemType,
): ResultItem | undefined {
  return items.find(
    (item) => (!type || item.type === type) && item.name === name,
  );
}
//润色提示词
export default router.post(
  "/",
  validateFields({
    assetsId: zod.number(),
    projectId: zod.number(),
    type: zod.string(),
    name: zod.string(),
    describe: zod.string(),
    templateId: zod.number().optional(),
  }),
  async (req, res) => {
    const { assetsId, projectId, type, templateId } = req.body;
    //获取风格
    const project = await u
      .db("o_project")
      .where("id", projectId)
      .select("artStyle", "type", "intro")
      .first();
    //如果没有找到对应的项目，返回错误
    if (!project) return res.status(500).send(success({ message: "项目为空" }));

    const allOutlineDataList: { data: string }[] = await u
      .db("o_outline")
      .where("projectId", projectId)
      .select("data");
    const itemMap: Record<string, ResultItem> = {};

    if (allOutlineDataList.length > 0)
      allOutlineDataList.forEach((row) => {
        const data: OutlineData = JSON.parse(row?.data || "{}");
        (["characters", "props", "scenes"] as ItemType[]).forEach((type) => {
          (data[type] || []).forEach((item) => {
            const key = `${type}-${item.name}`;
            if (!itemMap[key]) {
              itemMap[key] = {
                type,
                name: item.name,
                chapterRange: [...(data.chapterRange || [])],
              };
            } else {
              itemMap[key].chapterRange = Array.from(
                new Set([
                  ...itemMap[key].chapterRange,
                  ...(data.chapterRange || []),
                ]),
              );
            }
          });
        });
      });

    const result: ResultItem[] = Object.values(itemMap);
    //查询资产是否是衍生资产
    const assetsData = await u
      .db("o_assets")
      .where({ id: assetsId, projectId })
      .select("assetsId", "name", "describe", "type")
      .first();
    if (!assetsData) return res.status(404).send(error("资产不存在"));
    if (assetsData.type !== type)
      return res.status(400).send(error("资产类型不匹配"));
    await u
      .db("o_assets")
      .where({ id: assetsId, projectId })
      .update({ promptState: "生成中" });
    const typeConfig: Record<
      string,
      {
        promptKey: string;
        itemType: ItemType;
        label: string;
        nameLabel: string;
        visualManual: string;
      }
    > = {
      role: {
        promptKey: "role-polish",
        itemType: "characters",
        label: "角色标准四视图",
        nameLabel: "角色",
        visualManual: assetsData.assetsId
          ? "art_character_derivative"
          : "art_character",
      },
      scene: {
        promptKey: "scene-polish",
        itemType: "scenes",
        label: "场景图",
        nameLabel: "场景",
        visualManual: assetsData.assetsId
          ? "art_scene_derivative"
          : "art_scene",
      },
      tool: {
        promptKey: "tool-polish",
        itemType: "props",
        label: "道具图",
        nameLabel: "道具",
        visualManual: assetsData.assetsId ? "art_prop_derivative" : "art_prop",
      },
    };

    const config = typeConfig[type];
    if (!config) return res.status(500).send(error("不支持的类型"));
    if (!config.visualManual)
      return res.status(500).send(error("视觉手册未定义"));
    //获取到视觉手册
    const visualManual = await u.getArtPrompt(
      project.artStyle as string,
      "art_skills",
      config.visualManual,
    );
    if (!visualManual) return res.status(500).send(error("视觉手册未定义"));
    const inferenceTemplate = templateId
      ? await u.db("o_prompt").where({ id: templateId }).select("data", "useData").first()
      : null;
    const structuredTemplate = parseAssetInferenceTemplate(inferenceTemplate?.useData || inferenceTemplate?.data);
    if (structuredTemplate && !isAssetInferenceTemplateApplicable(structuredTemplate, assetsData.type as "role" | "scene" | "tool")) {
        return res.status(400).send(error(`推理模板“${structuredTemplate.name}”不适用于当前资产类型`));
    }
    const templatePrompt = structuredTemplate ? buildAssetInferenceTemplatePrompt(structuredTemplate) : "";
    const effectiveVisualManual = hasPhotorealisticDirection(templatePrompt)
      ? "当前图片推理模板明确要求真人写实/实拍/超写实媒介。项目视觉手册只能提供非冲突的构图、色彩和光影参考，禁止引入动漫、卡通、二次元、赛璐珞、手绘平涂或动画渲染媒介。"
      : visualManual;
    const assetName = String(assetsData.name || req.body.name);
    const assetDescription = String(
      assetsData.describe || req.body.describe || "",
    );
    findItemByName(result, assetName, config.itemType);
    const systemPrompt = [
      ASSET_FACTS_PRIORITY_RULES,
      templatePrompt,
      effectiveVisualManual,
      ASSET_FACTS_PRIORITY_RULES,
    ].join("\n\n");
    try {
      const { _output } = (await u.Ai.Text("universalAi").invoke({
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: buildAssetPromptFactsMessage({
              assetLabel: config.nameLabel,
              name: assetName,
              description: assetDescription,
              projectIntro: project.intro,
            }),
          },
        ],
      })) as any;

      if (!_output) return res.status(500).send("失败");
      await u.db("o_assets").where("id", assetsId).update({
        originalPrompt: _output,
        prompt: _output,
        promptState: "已完成",
      });

      res
        .status(200)
        .send(success({ originalPrompt: _output, prompt: _output, assetsId }));
    } catch (e: any) {
      await u
        .db("o_assets")
        .where("id", assetsId)
        .update({ promptState: "失败", promptErrorReason: u.error(e).message });
      return res
        .status(500)
        .send(error(e?.data?.error?.message ?? e?.message ?? "生成失败"));
    }
  },
);
