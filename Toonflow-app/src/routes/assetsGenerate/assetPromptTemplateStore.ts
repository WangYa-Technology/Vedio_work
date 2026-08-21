import u from "@/utils";
import { isUserPromptId, USER_PROMPT_ID_FLOOR } from "@/utils/promptTemplate";
import {
  DEFAULT_ASSET_INFERENCE_TEMPLATES,
  parseAssetInferenceTemplate,
  type AssetInferenceTemplate,
  type StoredAssetInferenceTemplate,
} from "@/utils/assetInferenceTemplate";

function nextPromptId() {
  return Math.max(Date.now(), USER_PROMPT_ID_FLOOR);
}

export async function ensureDefaultAssetInferenceTemplates() {
  const existing = await u
    .db("o_prompt")
    .where("type", "assetInferenceTemplate")
    .select("id", "name", "data", "useData");
  const names = new Set(existing.map((item) => String(item.name || "")));
  let id = nextPromptId();
  for (const template of DEFAULT_ASSET_INFERENCE_TEMPLATES) {
    if (names.has(template.name)) continue;
    while (await u.db("o_prompt").where({ id }).first()) id += 1;
    const data = JSON.stringify(template);
    await u.db("o_prompt").insert({ id, name: template.name, type: "assetInferenceTemplate", data, useData: data });
    id += 1;
  }
}

export async function getAssetInferenceTemplates(): Promise<StoredAssetInferenceTemplate[]> {
  await ensureDefaultAssetInferenceTemplates();
  const rows = await u
    .db("o_prompt")
    .whereIn("type", ["assetInferenceTemplate", "imagePromptGeneration"])
    .select("id", "name", "type", "data", "useData");
  return rows
    .map((item) => {
      const rawData = String(item.useData || item.data || "");
      const template = parseAssetInferenceTemplate(rawData);
      if (!template && item.type !== "imagePromptGeneration") return null;
      return {
        id: Number(item.id),
        name: String(item.name || template?.name || "未命名模版"),
        type: item.type === "imagePromptGeneration" ? "imagePromptGeneration" : "assetInferenceTemplate",
        data: template ? JSON.stringify(template) : rawData,
        source: isUserPromptId(item.id) ? ("user" as const) : ("official" as const),
        template: template || undefined,
      };
    })
    .filter((item): item is StoredAssetInferenceTemplate => Boolean(item));
}

export async function saveAssetInferenceTemplate(template: AssetInferenceTemplate, source: "official" | "user" = "user") {
  const data = JSON.stringify(template);
  let id = nextPromptId();
  while (await u.db("o_prompt").where({ id }).first()) id += 1;
  await u.db("o_prompt").insert({ id, name: template.name, type: "assetInferenceTemplate", data, useData: data });
  return {
    id,
    name: template.name,
    type: "assetInferenceTemplate" as const,
    data,
    source,
    template,
  };
}
