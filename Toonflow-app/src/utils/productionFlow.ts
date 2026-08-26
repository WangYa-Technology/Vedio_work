import u from "@/utils";

type AnyObject = Record<string, any>;

export function parseStoryboardTableAssetBindings(markdown: string): number[][] {
  return [...String(markdown || "").matchAll(/\*\*引用资产ID\*\*\s*[：:]\s*(?:\[|［)([^\]］]*)(?:\]|］)/g)].map((match) =>
    [...new Set((match[1].match(/\d+/g) || []).map(Number).filter(Number.isFinite))],
  );
}

function safeJsonParse<T>(value: any, fallback: T): T {
  if (value == null || value === "") return fallback;
  if (typeof value === "object") return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

async function withSrc<T extends AnyObject>(row: T & { filePath?: string | null; imageFilePath?: string | null }) {
  const filePath = row.filePath || row.imageFilePath;
  const src = filePath ? await u.oss.getFileUrl(filePath) : "";
  return { ...row, src };
}

async function loadAssets(projectId: number, scriptId: number) {
  const linkedAssetIds = (await u.db("o_scriptAssets").where({ scriptId }).pluck("assetId")).map(Number);
  const baseRows = await u
    .db("o_assets")
    .leftJoin("o_image", "o_assets.imageId", "o_image.id")
    .select(
      "o_assets.*",
      "o_image.filePath as imageFilePath",
      "o_image.state as imageState",
      "o_image.errorReason as imageErrorReason",
    )
    .where("o_assets.projectId", projectId);

  const linkedSet = new Set(linkedAssetIds);
  const derivedParentIds = new Set(
    baseRows.filter((row) => row.assetsId != null && linkedSet.has(Number(row.id))).map((row) => Number(row.assetsId)),
  );
  const rows = baseRows.filter(
    (row) => linkedSet.has(Number(row.id)) || linkedSet.has(Number(row.assetsId)) || derivedParentIds.has(Number(row.id)),
  );

  const roleIds = rows.filter((item) => item.type === "role").map((item) => Number(item.id)).filter(Number.isFinite);
  const voiceMap = new Map<number, AnyObject>();
  if (roleIds.length) {
    const voiceRows = await u
      .db("o_assetsRole2Audio")
      .join("o_assets as audioAsset", "o_assetsRole2Audio.assetsAudioId", "audioAsset.id")
      .leftJoin("o_image as audioImage", "audioAsset.imageId", "audioImage.id")
      .whereIn("o_assetsRole2Audio.assetsRoleId", roleIds)
      .andWhere("audioAsset.projectId", projectId)
      .andWhere("audioAsset.type", "clip")
      .select(
        "o_assetsRole2Audio.assetsRoleId",
        "audioAsset.id as assetId",
        "audioAsset.name",
        "audioImage.id as imageId",
        "audioImage.filePath",
        "audioImage.state",
      );
    await Promise.all(
      voiceRows.map(async (voice) => {
        const src = voice.filePath ? await u.oss.getFileUrl(voice.filePath) : "";
        if (!src) return;
        voiceMap.set(Number(voice.assetsRoleId), {
          id: Number(voice.assetId),
          assetId: Number(voice.assetId),
          imageId: Number(voice.imageId),
          name: voice.name || "声音参考",
          type: "audio",
          fileType: "audio",
          sources: "assets",
          src,
          state: voice.state || "已完成",
        });
      }),
    );
  }

  const childMap = new Map<number, AnyObject[]>();
  const parents = rows.filter((item) => item.assetsId == null);
  const children = rows.filter((item) => item.assetsId != null);

  await Promise.all(
    children.map(async (child) => {
      const normalized: AnyObject = await withSrc({
        id: child.id,
        name: child.name || "",
        desc: child.describe || "",
        prompt: child.prompt || "",
        imageFilePath: child.imageFilePath,
        src: "",
        state: child.imageState || (child.imageFilePath ? "已完成" : "未生成"),
        imageState: child.imageState || (child.imageFilePath ? "已完成" : "未生成"),
        type: child.type || "scene",
        flowId: child.flowId ?? undefined,
        errorReason: child.promptErrorReason || child.imageErrorReason || "",
      });
      normalized.state = normalized.src ? child.imageState || "已完成" : "未生成";
      normalized.imageState = normalized.state;
      if (child.type === "role") {
        const voiceReference = voiceMap.get(Number(child.id)) || null;
        normalized.voiceReference = voiceReference;
        normalized.voicePath = voiceReference?.src || "";
        normalized.voiceAssetId = voiceReference?.assetId || null;
        normalized.voiceImageId = voiceReference?.imageId || null;
        normalized.voiceName = voiceReference?.name || "";
        normalized.voiceState = voiceReference?.state || "未绑定";
      }
      const parentId = Number(child.assetsId);
      const list = childMap.get(parentId) || [];
      list.push(normalized);
      childMap.set(parentId, list);
    }),
  );

  return Promise.all(
    parents.map(async (parent) => {
      const normalized: AnyObject = await withSrc({
        id: parent.id,
        name: parent.name || "",
        desc: parent.describe || "",
        prompt: parent.prompt || "",
        imageFilePath: parent.imageFilePath,
        src: "",
        state: parent.imageState || (parent.imageFilePath ? "已完成" : "未生成"),
        imageState: parent.imageState || (parent.imageFilePath ? "已完成" : "未生成"),
        type: parent.type || "scene",
        flowId: parent.flowId ?? undefined,
        errorReason: parent.promptErrorReason || parent.imageErrorReason || "",
        derive: childMap.get(parent.id) || [],
      });
      normalized.state = normalized.src ? parent.imageState || "已完成" : "未生成";
      normalized.imageState = normalized.state;
      if (parent.type === "role") {
        const voiceReference = voiceMap.get(Number(parent.id)) || null;
        normalized.voiceReference = voiceReference;
        normalized.voicePath = voiceReference?.src || "";
        normalized.voiceAssetId = voiceReference?.assetId || null;
        normalized.voiceImageId = voiceReference?.imageId || null;
        normalized.voiceName = voiceReference?.name || "";
        normalized.voiceState = voiceReference?.state || "未绑定";
      }
      return normalized;
    }),
  );
}

async function loadStoryboard(projectId: number, scriptId: number) {
  const script = await u.db("o_script").where({ id: scriptId, projectId }).first();
  if (!script) return [];

  const formalRows = await u
    .db("o_storyboard")
    .where({ projectId, scriptId })
    .orderByRaw('COALESCE("index", 2147483647), id');
  const relations = await u
    .db("o_assets2Storyboard")
    .whereIn(
      "storyboardId",
      formalRows.map((row) => row.id),
    )
    .orderBy("storyboardId", "asc")
    .orderBy("sort", "asc")
    .orderBy("assetId", "asc");
  const relationMap = new Map<number, number[]>();
  for (const relation of relations) {
    const storyboardId = Number(relation.storyboardId);
    const assetId = Number(relation.assetId);
    const list = relationMap.get(storyboardId) || [];
    list.push(assetId);
    relationMap.set(storyboardId, list);
  }
  return Promise.all(
    formalRows.map(async (row) => {
      const src = row.filePath ? await u.oss.getFileUrl(row.filePath) : "";
      return {
        id: Number(row.id),
        prompt: row.prompt || "",
        src: src || null,
        state: src ? row.state || "未生成" : "未生成",
        duration: Number(row.duration) || 0,
        trackId: row.trackId == null ? undefined : Number(row.trackId),
        track: row.track || "",
        index: row.index == null ? null : Number(row.index),
        associateAssetsIds: relationMap.get(Number(row.id)) || [],
        videoDesc: row.videoDesc || "",
        shouldGenerateImage: Number(row.shouldGenerateImage) || 0,
        flowId: row.flowId == null ? undefined : Number(row.flowId),
        reason: row.reason || "",
      };
    }),
  );
}

export async function buildProductionFlowData(projectId: number, scriptId: number) {
  const script = await u.db("o_script").where({ projectId, id: scriptId }).first();
  const scriptAgent = await u.db("o_agentWorkData").where({ projectId, episodesId: scriptId, key: "scriptAgent" }).first();
  const savedFlow = await u.db("o_agentWorkData").where({ projectId, episodesId: scriptId, key: "productionFlowData" }).first();
  const flowData = safeJsonParse<AnyObject>(savedFlow?.data, {});
  const storyboard = await loadStoryboard(projectId, scriptId);
  const assets = await loadAssets(projectId, scriptId);

  return {
    script: flowData.script || script?.content || "",
    scriptPlan: flowData.scriptPlan || "",
    storyboardTable: flowData.storyboardTable || "",
    assets,
    storyboard,
    workbench: flowData.workbench || { videoList: [] },
  };
}

export async function saveProductionFlowData(projectId: number, scriptId: number, data: AnyObject) {
  if (!Number.isSafeInteger(projectId) || projectId <= 0 || !Number.isSafeInteger(scriptId) || scriptId <= 0) {
    throw new Error("生产工作区缺少有效的项目或剧本上下文");
  }
  const payload = JSON.stringify(data ?? {});
  let rowId = 0;
  await u.db.transaction(async (trx) => {
    const existing = await trx("o_agentWorkData").where({ projectId, episodesId: scriptId, key: "productionFlowData" }).first();
    const now = Date.now();
    if (existing) {
      rowId = Number(existing.id);
      await trx("o_agentWorkData").where({ id: existing.id, projectId, episodesId: scriptId }).update({ data: payload, updateTime: now });
      return;
    }
    const maxRow = await trx("o_agentWorkData").max("id as id").first();
    rowId = Number((maxRow as any)?.id || 0) + 1;
    await trx("o_agentWorkData").insert({
      id: rowId,
      projectId,
      episodesId: scriptId,
      key: "productionFlowData",
      data: payload,
      createTime: now,
      updateTime: now,
    });
  });
  const saved = await u.db("o_agentWorkData").where({ id: rowId, projectId, episodesId: scriptId, key: "productionFlowData" }).select("data").first();
  if (saved?.data !== payload) throw new Error("生产工作区写入后回读校验失败");
  return rowId;
}

export async function saveProductionFlowArtifact(
  projectId: number,
  scriptId: number,
  key: "scriptPlan" | "storyboardTable",
  content: string,
) {
  if (!Number.isSafeInteger(projectId) || projectId <= 0 || !Number.isSafeInteger(scriptId) || scriptId <= 0) {
    throw new Error("生产工作区缺少有效的项目或剧本上下文");
  }
  if (!content.trim()) throw new Error("生产工作区产出物不能为空");

  await u.db.transaction(async (trx) => {
    const existing = await trx("o_agentWorkData").where({ projectId, episodesId: scriptId, key: "productionFlowData" }).first();
    let current: AnyObject = {};
    try {
      current = existing?.data ? JSON.parse(existing.data) : {};
    } catch {
      throw new Error("现有生产工作区数据格式无效，已阻止覆盖");
    }
    const pendingBaseAssetIds = Array.isArray(current.pendingBaseAssetIds)
      ? current.pendingBaseAssetIds.map(Number).filter(Number.isSafeInteger)
      : [];
    const referencedIds = key === "storyboardTable"
      ? new Set(parseStoryboardTableAssetBindings(content).flat())
      : new Set<number>();
    const remainingPendingIds = key === "storyboardTable"
      ? pendingBaseAssetIds.filter((id: number) => !referencedIds.has(id))
      : pendingBaseAssetIds;
    const next = { ...current, [key]: content };
    if (remainingPendingIds.length) next.pendingBaseAssetIds = remainingPendingIds;
    else delete next.pendingBaseAssetIds;
    const payload = JSON.stringify(next);
    const now = Date.now();

    if (existing) {
      await trx("o_agentWorkData").where({ id: existing.id, projectId, episodesId: scriptId }).update({ data: payload, updateTime: now });
      return;
    }

    const maxRow = await trx("o_agentWorkData").max("id as id").first();
    await trx("o_agentWorkData").insert({
      id: Number((maxRow as any)?.id || 0) + 1,
      projectId,
      episodesId: scriptId,
      key: "productionFlowData",
      data: payload,
      createTime: now,
      updateTime: now,
    });
  });

  const saved = await u.db("o_agentWorkData").where({ projectId, episodesId: scriptId, key: "productionFlowData" }).select("data").first();
  const savedData = safeJsonParse<AnyObject>(saved?.data, {});
  if (savedData[key] !== content) throw new Error(`${key === "scriptPlan" ? "导演规划" : "分镜表"}写入后回读校验失败`);
}
