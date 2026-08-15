import u from "@/utils";

interface ConfiguredVideoModel {
  modelName?: string;
  type?: string;
}

interface AvailableVideoModel {
  id: string;
  modelName: string;
}

export function pickDefaultVideoModel(models: AvailableVideoModel[]) {
  return models.length === 1 ? models[0] : null;
}

export async function resolveProjectVideoModel(project: Record<string, any>) {
  const selectedModel = String(project.videoModel || "").trim();
  if (selectedModel) return selectedModel;

  const vendors = await u
    .db("o_vendorConfig")
    .select("id", "models")
    .where("enable", 1);
  const availableModels: AvailableVideoModel[] = vendors.flatMap((vendor) => {
    try {
      const models = JSON.parse(String(vendor.models || "[]"));
      if (!Array.isArray(models)) return [];
      return models
        .filter(
          (model: ConfiguredVideoModel) =>
            model.type === "video" &&
            typeof model.modelName === "string" &&
            model.modelName.trim(),
        )
        .map((model: ConfiguredVideoModel) => ({
          id: String(vendor.id),
          modelName: String(model.modelName),
        }));
    } catch {
      return [];
    }
  });

  if (!availableModels.length)
    throw new Error(
      "没有已启用的视频模型，请先在供应商设置中配置并启用视频模型",
    );

  const model = pickDefaultVideoModel(availableModels);
  if (!model)
    throw new Error("项目未选择视频模型，请在项目编辑中选择视频模型");

  const modelId = `${model.id}:${model.modelName}`;
  await u
    .db("o_project")
    .where({ id: project.id })
    .update({ videoModel: modelId });
  project.videoModel = modelId;
  return modelId;
}
