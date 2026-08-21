import pLimit from "p-limit";
import { v4 as uuidv4 } from "uuid";
import u from "@/utils";
import { parseModelReference } from "@/utils/modelRef";
import {
  appendNegativePrompt,
  buildAssetGenerationPrompt,
} from "@/utils/imagePrompt";
import {
  buildAssetInferenceTemplatePrompt,
  isAssetInferenceTemplateApplicable,
  parseAssetInferenceTemplate,
  type AssetInferenceTemplate,
} from "@/utils/assetInferenceTemplate";

type AssetType = "role" | "scene" | "tool";
type ImageResolution = "1K" | "2K" | "4K";

interface AssetImageItem {
  id: number;
  type: AssetType;
  name: string;
  prompt: string;
  describe?: string | null;
  base64?: string | null;
  referenceImageId?: number | null;
}

interface QueueAssetImagesInput {
  projectId: number;
  model: string;
  resolution: ImageResolution;
  concurrentCount?: number;
  templateId?: number | null;
  items: AssetImageItem[];
  selectedTemplateRaw?: string;
  selectedStructuredTemplate?: AssetInferenceTemplate | null;
}

interface QueueStoryboardImagesInput {
  projectId: number;
  scriptId: number;
  storyboardIds: number[];
  model?: string;
  resolution?: ImageResolution;
  concurrentCount?: number;
  compulsory?: boolean;
}

interface ConfiguredImageModel {
  modelName?: unknown;
  type?: unknown;
}

const assetTypeConfig: Record<
  AssetType,
  {
    label: string;
    taskClass: string;
    dir: string;
    promptTitle: string;
    promptGuidance?: string[];
  }
> = {
  role: {
    label: "角色",
    taskClass: "角色图生成",
    dir: "role",
    promptTitle: "角色标准四视图",
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
  },
  tool: {
    label: "道具",
    taskClass: "道具图生成",
    dir: "props",
    promptTitle: "标准道具图",
  },
};

function buildAssetPrompt(
  type: AssetType,
  artStyle: string,
  name: string,
  description: string | null | undefined,
  prompt: string,
  hasReference: boolean,
  templateRaw?: string,
  structuredTemplate?: AssetInferenceTemplate | null,
) {
  const config = assetTypeConfig[type];
  const hasCustomTemplate = Boolean(templateRaw?.trim());
  return buildAssetGenerationPrompt({
    promptTitle: hasCustomTemplate ? "自定义模板资产图" : config.promptTitle,
    promptEnd: hasCustomTemplate ? "符合所选模板版式的资产图" : config.promptTitle,
    assetLabel: config.label,
    artStyle,
    name,
    description,
    prompt,
    hasReference,
    guidance: hasCustomTemplate
      ? [
          structuredTemplate
            ? buildAssetInferenceTemplatePrompt(structuredTemplate)
            : "严格遵循当前图片提示词中明确的画布比例、视图数量、细节面板和版式，不得追加角色标准四视图或道具四宫格规则。",
          "当前已选择自定义图片推理模板；模板版式优先于默认资产类型版式。",
        ]
      : config.promptGuidance,
    customTemplate: hasCustomTemplate,
  });
}

function resolveAspectRatio(prompt: string, templateRaw?: string, structuredTemplate?: AssetInferenceTemplate | null) {
  return structuredTemplate?.canvas.aspectRatio || templateRaw?.match(/\b(?:9:16|16:9|1:1|4:3)\b/)?.[0] || prompt.match(/\b(?:9:16|16:9|1:1|4:3)\b/)?.[0] || "16:9";
}

function normalizeIds(ids: number[]) {
  return [...new Set(ids.map(Number).filter(Number.isFinite))];
}

export function buildDerivedAssetPrompt(input: {
  type: AssetType;
  parentName: string;
  parentDescribe?: string | null;
  name: string;
  describe: string;
  prompt?: string | null;
}) {
  const consistencyRules: Record<AssetType, string> = {
    role: "保持参考图角色的身份、五官、体型比例、姿态、视角和构图一致，只改变衍生目标明确要求的整体造型或形态。",
    scene:
      "保持参考图的空间结构、建筑布局、材质、镜头机位和构图一致，只改变衍生目标明确要求的时段与相应光影；画面中不要出现人物。",
    tool: "保持参考图主体的结构、比例、材质、视角和构图一致，只改变衍生目标明确要求的视觉状态。",
  };
  const details = String(input.prompt || input.describe || "").trim();

  return [
    `以输入的父资产“${input.parentName}”图片为唯一视觉基准生成衍生资产“${input.name}”。`,
    input.parentDescribe ? `父资产设定：${input.parentDescribe}` : "",
    `衍生目标：${input.describe}`,
    details && details !== input.describe ? `目标提示词：${details}` : "",
    consistencyRules[input.type],
    "输出单张完整画面，不要拼图、分屏、文字、水印或说明标注。",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function resolveProjectImageModel(project: Record<string, any>) {
  const selectedModel = String(project.imageModel || "").trim();
  if (selectedModel) return selectedModel;

  const vendors = await u
    .db("o_vendorConfig")
    .select("id", "models")
    .where("enable", 1);
  const availableModels = vendors.flatMap((vendor) => {
    try {
      const models = JSON.parse(String(vendor.models || "[]"));
      if (!Array.isArray(models)) return [];
      return models
        .filter(
          (model: ConfiguredImageModel) =>
            model.type === "image" &&
            typeof model.modelName === "string" &&
            model.modelName.trim(),
        )
        .map(
          (model: ConfiguredImageModel) => `${vendor.id}:${model.modelName}`,
        );
    } catch {
      return [];
    }
  });

  if (availableModels.length === 0)
    throw new Error(
      "没有已启用的图片模型，请先在供应商设置中配置并启用图片模型",
    );
  if (availableModels.length > 1)
    throw new Error("项目未选择图片模型，请在项目编辑中选择图片模型");

  const model = availableModels[0];
  await u
    .db("o_project")
    .where({ id: project.id })
    .update({ imageModel: model });
  project.imageModel = model;
  return model;
}

async function runAssetImageTask(
  project: Record<string, any>,
  input: QueueAssetImagesInput,
  item: AssetImageItem,
  imageId: number,
) {
  const config = assetTypeConfig[item.type];
  const filePath = `${input.projectId}/${config.dir}/${uuidv4()}.jpg`;
  try {
    const aiImage = u.Ai.Image(input.model as `${string}:${string}`);
    await aiImage.run(
      {
        prompt: appendNegativePrompt(
          buildAssetPrompt(
            item.type,
            project.artStyle || "",
            item.name,
            item.describe,
            item.prompt,
            Boolean(item.base64),
            input.selectedTemplateRaw,
            input.selectedStructuredTemplate,
          ),
          project.negativePrompt,
        ),
        imageBase64: item.base64 ? [item.base64] : [],
        referenceList: item.base64
          ? [{ type: "image", base64: item.base64 }]
          : [],
        size: input.resolution,
        aspectRatio: resolveAspectRatio(item.prompt, input.selectedTemplateRaw, input.selectedStructuredTemplate) as `${number}:${number}`,
      },
      {
        taskClass: config.taskClass,
        describe: `生成${config.label}图：${item.name}`,
        projectId: input.projectId,
        relatedObjects: JSON.stringify({
          id: item.id,
          projectId: input.projectId,
          type: config.label,
          templateId: input.templateId ?? null,
        }),
      },
    );
    await aiImage.save(filePath);
    const image = await u.db("o_image").where({ id: imageId }).first();
    if (!image || image.state === "生成失败") return;
    await u
      .db("o_image")
      .where({ id: imageId })
      .update({
        state: "已完成",
        filePath,
        type: item.type,
        model: parseModelReference(input.model).modelName || input.model,
        resolution: input.resolution,
        errorReason: "",
      });
  } catch (caught) {
    await u
      .db("o_image")
      .where({ id: imageId })
      .update({
        state: "生成失败",
        errorReason: u.error(caught).message,
      });
  }
}

export async function queueAssetImages(input: QueueAssetImagesInput) {
  const project = await u
    .db("o_project")
    .where({ id: input.projectId })
    .first();
  if (!project) throw new Error("项目不存在");
  const model = String(
    input.model || (await resolveProjectImageModel(project)),
  ).trim();
  if (!model) throw new Error("项目未配置图片模型");
  if (!input.items.length) throw new Error("没有可生成的资产");
  const selectedTemplate = input.templateId
    ? await u.db("o_prompt").where({ id: input.templateId }).select("data", "useData").first()
    : null;
  const selectedTemplateRaw = String(selectedTemplate?.useData || selectedTemplate?.data || "");
  const selectedStructuredTemplate = parseAssetInferenceTemplate(selectedTemplateRaw);
  const assetRows = await u
    .db("o_assets")
    .where({ projectId: input.projectId })
    .whereIn(
      "id",
      input.items.map((item) => item.id),
    )
    .select("id", "type", "name", "describe");
  const assetMap = new Map(assetRows.map((asset) => [Number(asset.id), asset]));
  const invalidTemplateAsset = selectedStructuredTemplate
    ? input.items.find((item) => !isAssetInferenceTemplateApplicable(selectedStructuredTemplate, item.type))
    : null;
  if (invalidTemplateAsset) {
    throw new Error(`推理模板“${selectedStructuredTemplate!.name}”不适用于${assetTypeConfig[invalidTemplateAsset.type].label}资产`);
  }
  const taskItems: AssetImageItem[] = [];

  const imageIds: number[] = [];
  for (const item of input.items) {
    if (!assetTypeConfig[item.type])
      throw new Error(`不支持的资产类型：${item.type}`);
    if (!item.prompt.trim())
      throw new Error(`资产“${item.name}”缺少图片提示词`);
    const asset = assetMap.get(Number(item.id));
    if (!asset) throw new Error(`资产不存在：${item.id}`);
    if (asset.type !== item.type)
      throw new Error(`资产“${asset.name || item.name}”类型不匹配`);
    let referenceBase64 = item.base64 || null;
    if (!referenceBase64 && item.referenceImageId != null) {
      const referenceImage = await u
        .db("o_image")
        .where({
          id: item.referenceImageId,
          assetsId: item.id,
          state: "已完成",
        })
        .whereNotNull("filePath")
        .select("filePath")
        .first();
      if (!referenceImage)
        throw new Error(`资产“${asset.name || item.name}”的参考图不可用`);
      referenceBase64 = await u.oss.getImageBase64(referenceImage.filePath);
    }
    taskItems.push({
      ...item,
      name: String(asset.name || item.name),
      describe: asset.describe,
      base64: referenceBase64,
    });
    const [imageId] = await u.db("o_image").insert({
      type: item.type,
      state: "生成中",
      assetsId: item.id,
      model: parseModelReference(model).modelName || model,
      resolution: input.resolution,
      errorReason: "",
    });
    await u
      .db("o_assets")
      .where({ id: item.id, projectId: input.projectId })
      .update({ imageId });
    imageIds.push(Number(imageId));
  }

  const limit = pLimit(Math.max(1, input.concurrentCount || 1));
  const taskInput = { ...input, model, items: taskItems, selectedTemplateRaw, selectedStructuredTemplate };
  const tasks = taskItems.map((item, index) =>
    limit(() => runAssetImageTask(project, taskInput, item, imageIds[index])),
  );
  void Promise.allSettled(tasks);
  return {
    total: input.items.length,
    assetIds: input.items.map((item) => item.id),
    imageIds,
  };
}

export async function queueAssetImagesById(
  projectId: number,
  assetIds: number[],
  concurrentCount = 1,
) {
  const ids = normalizeIds(assetIds);
  const project = await u.db("o_project").where({ id: projectId }).first();
  if (!project) throw new Error("项目不存在");
  const rows = ids.length
    ? await u.db("o_assets").where({ projectId }).whereIn("id", ids)
    : [];
  if (rows.length !== ids.length)
    throw new Error("待生成资产中包含不存在的 ID");

  const items = await Promise.all(
    rows.map(async (row) => {
      let prompt = String(row.prompt || "").trim();
      let base64: string | null = null;

      if (row.assetsId != null) {
        const parent = await u
          .db("o_assets")
          .leftJoin("o_image", "o_assets.imageId", "o_image.id")
          .where({
            "o_assets.id": row.assetsId,
            "o_assets.projectId": projectId,
          })
          .select(
            "o_assets.id",
            "o_assets.name",
            "o_assets.describe",
            "o_image.filePath as imageFilePath",
          )
          .first();
        if (!parent) throw new Error(`衍生资产“${row.name}”的父资产不存在`);
        if (!parent.imageFilePath)
          throw new Error(
            `衍生资产“${row.name}”的父资产“${parent.name}”还没有可用图片，请先生成父资产图片`,
          );

        if (!prompt) {
          prompt = buildDerivedAssetPrompt({
            type: row.type as AssetType,
            parentName: String(parent.name || `资产 ${parent.id}`),
            parentDescribe: parent.describe,
            name: String(row.name || `资产 ${row.id}`),
            describe: String(row.describe || row.name || "衍生状态"),
          });
          await u.db("o_assets").where({ id: row.id, projectId }).update({
            prompt,
            promptState: "已完成",
            promptErrorReason: "",
          });
        }
        base64 = await u.oss.getImageBase64(parent.imageFilePath);
      }

      return {
        id: Number(row.id),
        type: row.type as AssetType,
        name: String(row.name || `资产 ${row.id}`),
        prompt,
        base64,
      };
    }),
  );

  return queueAssetImages({
    projectId,
    model: await resolveProjectImageModel(project),
    resolution: "2K",
    concurrentCount,
    items,
  });
}

async function storyboardReferenceBase64(storyboardId: number) {
  const rows = await u
    .db("o_assets2Storyboard")
    .leftJoin("o_assets", "o_assets2Storyboard.assetId", "o_assets.id")
    .leftJoin("o_image", "o_assets.imageId", "o_image.id")
    .where("o_assets2Storyboard.storyboardId", storyboardId)
    .whereNotNull("o_image.filePath")
    .orderBy("o_assets2Storyboard.sort", "asc")
    .orderBy("o_assets2Storyboard.assetId", "asc")
    .select("o_image.filePath");
  return Promise.all(rows.map((row) => u.oss.getImageBase64(row.filePath)));
}

async function runStoryboardImageTask(
  project: Record<string, any>,
  row: Record<string, any>,
  model: string,
  resolution: ImageResolution,
) {
  const filePath = `${row.projectId}/storyboard/${row.scriptId}/${uuidv4()}.jpg`;
  try {
    const referenceImages = await storyboardReferenceBase64(Number(row.id));
    const aiImage = u.Ai.Image(model as `${string}:${string}`);
    await aiImage.run(
      {
        prompt: appendNegativePrompt(
          String(row.prompt),
          project.negativePrompt,
        ),
        imageBase64: referenceImages,
        referenceList: referenceImages.map((base64) => ({
          type: "image" as const,
          base64,
        })),
        size: resolution,
        aspectRatio: String(
          project.videoRatio || "16:9",
        ) as `${number}:${number}`,
      },
      {
        taskClass: "分镜图生成",
        describe: `生成分镜图 ${row.id}`,
        projectId: Number(row.projectId),
        relatedObjects: JSON.stringify({
          storyboardId: row.id,
          scriptId: row.scriptId,
        }),
      },
    );
    await aiImage.save(filePath);
    await u
      .db("o_storyboard")
      .where({ id: row.id, projectId: row.projectId, scriptId: row.scriptId })
      .update({
        state: "已完成",
        filePath,
        reason: "",
      });
  } catch (caught) {
    await u
      .db("o_storyboard")
      .where({ id: row.id, projectId: row.projectId, scriptId: row.scriptId })
      .update({
        state: "生成失败",
        reason: u.error(caught).message,
      });
  }
}

export async function queueStoryboardImages(input: QueueStoryboardImagesInput) {
  const ids = normalizeIds(input.storyboardIds);
  if (!ids.length) throw new Error("没有可生成的分镜");
  const project = await u
    .db("o_project")
    .where({ id: input.projectId })
    .first();
  if (!project) throw new Error("项目不存在");
  const model = String(
    input.model || (await resolveProjectImageModel(project)),
  ).trim();
  if (!model) throw new Error("项目未配置图片模型");
  const rows = await u
    .db("o_storyboard")
    .where({ projectId: input.projectId, scriptId: input.scriptId })
    .whereIn("id", ids)
    .orderByRaw('COALESCE("index", 2147483647), id');
  if (rows.length !== ids.length)
    throw new Error("待生成分镜中包含不存在的 ID");

  const skipped: Array<{ id: number; reason: string }> = [];
  const queued = rows.filter((row) => {
    if (!String(row.prompt || "").trim()) {
      skipped.push({ id: Number(row.id), reason: "图片提示词为空" });
      return false;
    }
    if (!input.compulsory && row.state === "已完成" && row.filePath) {
      skipped.push({ id: Number(row.id), reason: "已有可用分镜图" });
      return false;
    }
    return true;
  });
  if (!queued.length) return { total: 0, queuedIds: [], skipped };

  await u
    .db("o_storyboard")
    .whereIn(
      "id",
      queued.map((row) => row.id),
    )
    .update({ state: "生成中", reason: "" });
  const resolution = input.resolution || "2K";
  const limit = pLimit(Math.max(1, input.concurrentCount || 1));
  const tasks = queued.map((row) =>
    limit(() => runStoryboardImageTask(project, row, model, resolution)),
  );
  void Promise.allSettled(tasks);
  return {
    total: queued.length,
    queuedIds: queued.map((row) => Number(row.id)),
    skipped,
  };
}
