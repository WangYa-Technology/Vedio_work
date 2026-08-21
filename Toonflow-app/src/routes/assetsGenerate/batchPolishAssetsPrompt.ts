import express from "express";
import u from "@/utils";
import pLimit from "p-limit";
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
function mergeNovelText(novelData: NovelChapter[]): string {
  if (!Array.isArray(novelData)) return "";
  return novelData
    .map((chap) => {
      return `${chap.chapter.trim()}\n\n${chap.chapterData.trim().replace(/\r?\n/g, "\n")}\n`;
    })
    .join("\n");
}
//润色提示词
export default router.post(
  "/",
  validateFields({
    items: zod.array(
      zod.object({
        assetsId: zod.number(),
        type: zod.string(),
        name: zod.string(),
        describe: zod.string(),
      }),
    ),
    projectId: zod.number(),
    concurrentCount: zod.number().int().min(1).optional(),
    templateId: zod.number().optional(),
  }),
  async (req, res) => {
    const { projectId, items, concurrentCount, templateId } = req.body;
    //获取风格
    const project = await u
      .db("o_project")
      .where("id", projectId)
      .select("artStyle", "type", "intro")
      .first();
    //如果没有找到对应的项目，返回错误
    if (!project) return res.status(500).send(success({ message: "项目为空" }));
    const inferenceTemplate = templateId
      ? await u.db("o_prompt").where({ id: templateId }).select("data", "useData").first()
      : null;
    const structuredTemplate = parseAssetInferenceTemplate(inferenceTemplate?.useData || inferenceTemplate?.data);

    // 预加载公共数据
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
    const assetsIds = items.map((item: { assetsId: number }) => item.assetsId);
    //查询所有资产，用于判断每个资产是否是衍生资产
    const assetsDataList = await u
      .db("o_assets")
      .where({ projectId })
      .whereIn("id", assetsIds)
      .select("id", "assetsId", "name", "describe", "type");
    if (structuredTemplate) {
      const invalidAsset = assetsDataList.find((asset) => !isAssetInferenceTemplateApplicable(structuredTemplate, asset.type as "role" | "scene" | "tool"));
      if (invalidAsset) {
        return res.status(400).send(error(`推理模板“${structuredTemplate.name}”不适用于当前资产类型`));
      }
    }
    const requestedAssetIds = [...new Set(assetsIds.map(Number))];
    if (assetsDataList.length !== requestedAssetIds.length)
      return res
        .status(400)
        .send(error("待生成提示词的资产不存在或不属于当前项目"));
    const assetsDataMap = new Map(assetsDataList.map((a: any) => [a.id, a]));
    // 所有前置检测通过后，再批量更新状态为生成中
    await u
      .db("o_assets")
      .where({ projectId })
      .whereIn("id", assetsIds)
      .update({ promptState: "生成中" });

    const getTypeConfig = (
      isDerivative: boolean,
    ): Record<
      string,
      {
        promptKey: string;
        itemType: ItemType;
        label: string;
        nameLabel: string;
        visualManual: string;
      }
    > => ({
      role: {
        promptKey: "role-polish",
        itemType: "characters",
        label: "角色标准四视图",
        nameLabel: "角色",
        visualManual: isDerivative
          ? "art_character_derivative"
          : "art_character",
      },
      scene: {
        promptKey: "scene-polish",
        itemType: "scenes",
        label: "场景图",
        nameLabel: "场景",
        visualManual: isDerivative ? "art_scene_derivative" : "art_scene",
      },
      tool: {
        promptKey: "tool-polish",
        itemType: "props",
        label: "道具图",
        nameLabel: "道具",
        visualManual: isDerivative ? "art_prop_derivative" : "art_prop",
      },
    });

    // 后台异步并发生成，不阻塞响应
    const limit = pLimit(concurrentCount ?? 1);
    const tasks = items.map(
      (item: {
        assetsId: number;
        type: string;
        name: string;
        describe: string;
      }) =>
        limit(async () => {
          const assetData = assetsDataMap.get(item.assetsId);
          if (!assetData) return;
          if (assetData.type !== item.type) {
            await u.db("o_assets").where("id", item.assetsId).update({
              promptState: "生成失败",
              promptErrorReason: "资产类型不匹配",
            });
            return;
          }
          const typeConfig = getTypeConfig(!!assetData.assetsId);
          const config = typeConfig[item.type];
          if (!config) return;
          //获取到视觉手册
          const visualManual = await u.getArtPrompt(
            project.artStyle as string,
            "art_skills",
            config.visualManual,
          );
          if (!visualManual) {
            await u.db("o_assets").where("id", item.assetsId).update({
              promptState: "生成失败",
              promptErrorReason: "视觉手册未定义",
            });
            return;
          }
          const assetName = String(assetData.name || item.name);
          const assetDescription = String(
            assetData.describe || item.describe || "",
          );
          findItemByName(result, assetName, config.itemType);
          const templatePrompt = structuredTemplate ? buildAssetInferenceTemplatePrompt(structuredTemplate) : "";
          const effectiveVisualManual = hasPhotorealisticDirection(templatePrompt)
            ? "当前图片推理模板明确要求真人写实/实拍/超写实媒介。项目视觉手册只能提供非冲突的构图、色彩和光影参考，禁止引入动漫、卡通、二次元、赛璐珞、手绘平涂或动画渲染媒介。"
            : visualManual;
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

            if (!_output) {
              await u
                .db("o_assets")
                .where("id", item.assetsId)
                .update({ promptState: "生成失败" });
              return;
            }

            await u.db("o_assets").where("id", item.assetsId).update({
              originalPrompt: _output,
              prompt: _output,
              promptState: "已完成",
            });
          } catch (e: any) {
            await u
              .db("o_assets")
              .where("id", item.assetsId)
              .update({
                promptState: "失败",
                promptErrorReason: u.error(e).message,
              });
          }
        }),
    );

    // 后台执行，不等待结果
    Promise.all(tasks).catch((err: any) => {
      res.status(500).send(error(err));
    });

    return res.status(200).send(success({ total: items.length }));
  },
);
