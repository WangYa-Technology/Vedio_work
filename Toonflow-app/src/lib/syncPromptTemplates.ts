import type { Knex } from "knex";
import {
  H3_VIDEO_PROMPT_TEMPLATE_CONTENT,
  H3_VIDEO_PROMPT_TEMPLATE_ID,
  H3_VIDEO_PROMPT_TEMPLATE_NAME,
} from "@/constants/h3VideoPromptTemplate";
import {
  ASSET_IMAGE_PROMPT_TEMPLATE_CONTENT,
  ASSET_IMAGE_PROMPT_TEMPLATE_ID,
  ASSET_IMAGE_PROMPT_TEMPLATE_NAME,
} from "@/constants/assetImagePromptTemplate";
import { ASSET_EXTRACTION_TEMPLATE_CONTENT } from "@/constants/assetExtractionPromptTemplate";

/**
 * 幂等同步 MinimaxH3 移植模板：
 * 1. 新增「H3 3D仿真人短剧推理」（videoPromptGeneration）与
 *    「H3仿真人资产生图规范（角色/场景/道具）」（imagePromptGeneration）：仅当 id 不存在时插入，
 *    已存在则跳过，避免覆盖用户在设置页的修改；
 * 2. 内置「剧本资产提取」模板：仅当 useData 为空时写入合并版提取规则（不覆盖已有数据）。
 * 每次启动调用，可安全重复执行。
 */
export async function syncPromptTemplates(knex: Knex) {
  const seeds = [
    {
      id: H3_VIDEO_PROMPT_TEMPLATE_ID,
      name: H3_VIDEO_PROMPT_TEMPLATE_NAME,
      type: "videoPromptGeneration",
      content: H3_VIDEO_PROMPT_TEMPLATE_CONTENT,
    },
    {
      id: ASSET_IMAGE_PROMPT_TEMPLATE_ID,
      name: ASSET_IMAGE_PROMPT_TEMPLATE_NAME,
      type: "imagePromptGeneration",
      content: ASSET_IMAGE_PROMPT_TEMPLATE_CONTENT,
    },
  ];

  for (const seed of seeds) {
    const existing = await knex("o_prompt").where({ id: seed.id }).select("id").first();
    if (existing) continue;
    await knex("o_prompt").insert({
      id: seed.id,
      name: seed.name,
      type: seed.type,
      data: seed.content,
      useData: seed.content,
    });
    console.log(`[模板同步] 已写入新模板: ${seed.name} (${seed.type})`);
  }

  const extraction = await knex("o_prompt")
    .where({ type: "scriptAssetExtraction" })
    .select("id", "useData")
    .first();
  if (extraction && !String(extraction.useData || "").trim()) {
    await knex("o_prompt").where({ id: extraction.id }).update({
      data: ASSET_EXTRACTION_TEMPLATE_CONTENT,
      useData: ASSET_EXTRACTION_TEMPLATE_CONTENT,
    });
    console.log("[模板同步] 已写入合并版剧本资产提取规则（useData 原为空）");
  }
}
