import u from "@/utils";

type AnyObject = Record<string, any>;

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
  let baseRows = await u
    .db("o_assets")
    .leftJoin("o_image", "o_assets.imageId", "o_image.id")
    .select(
      "o_assets.*",
      "o_image.filePath as imageFilePath",
      "o_image.state as imageState",
      "o_image.errorReason as imageErrorReason",
    )
    .where("o_assets.projectId", projectId);

  if (linkedAssetIds.length) {
    const linkedSet = new Set(linkedAssetIds);
    const derivedParentIds = new Set(
      baseRows.filter((row) => row.assetsId != null && linkedSet.has(Number(row.id))).map((row) => Number(row.assetsId)),
    );
    baseRows = baseRows.filter(
      (row) => linkedSet.has(Number(row.id)) || linkedSet.has(Number(row.assetsId)) || derivedParentIds.has(Number(row.id)),
    );
  }
  const rows = baseRows;

  const childMap = new Map<number, AnyObject[]>();
  const parents = rows.filter((item) => item.assetsId == null);
  const children = rows.filter((item) => item.assetsId != null);

  await Promise.all(
    children.map(async (child) => {
      const normalized = await withSrc({
        id: child.id,
        name: child.name || "",
        desc: child.describe || "",
        prompt: child.prompt || "",
        imageFilePath: child.imageFilePath,
        src: "",
        state: child.promptState || child.imageState || "未生成",
        type: child.type || "scene",
        flowId: child.flowId ?? undefined,
        errorReason: child.promptErrorReason || child.imageErrorReason || "",
      });
      const parentId = Number(child.assetsId);
      const list = childMap.get(parentId) || [];
      list.push(normalized);
      childMap.set(parentId, list);
    }),
  );

  return Promise.all(
    parents.map(async (parent) => {
      const normalized = await withSrc({
        id: parent.id,
        name: parent.name || "",
        desc: parent.describe || "",
        prompt: parent.prompt || "",
        imageFilePath: parent.imageFilePath,
        src: "",
        state: parent.promptState || parent.imageState || "未生成",
        type: parent.type || "scene",
        flowId: parent.flowId ?? undefined,
        errorReason: parent.promptErrorReason || parent.imageErrorReason || "",
        derive: childMap.get(parent.id) || [],
      });
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
    formalRows.map(async (row) => ({
      id: Number(row.id),
      prompt: row.prompt || "",
      src: row.filePath ? await u.oss.getFileUrl(row.filePath) : null,
      state: row.state || "未生成",
      duration: Number(row.duration) || 0,
      trackId: row.trackId == null ? undefined : Number(row.trackId),
      track: row.track || "",
      index: row.index == null ? null : Number(row.index),
      associateAssetsIds: relationMap.get(Number(row.id)) || [],
      videoDesc: row.videoDesc || "",
      shouldGenerateImage: Number(row.shouldGenerateImage) || 0,
      flowId: row.flowId == null ? undefined : Number(row.flowId),
      reason: row.reason || "",
    })),
  );
}

export async function buildProductionFlowData(projectId: number, scriptId: number) {
  const script = await u.db("o_script").where({ projectId, id: scriptId }).first();
  const scriptAgent = await u.db("o_agentWorkData").where({ projectId, episodesId: scriptId, key: "scriptAgent" }).first();
  const scriptAgentFallback = scriptAgent || (await u.db("o_agentWorkData").where({ projectId, key: "scriptAgent" }).first());
  const savedFlow = await u.db("o_agentWorkData").where({ projectId, episodesId: scriptId, key: "productionFlowData" }).first();
  const scriptAgentData = safeJsonParse<AnyObject>(scriptAgentFallback?.data, {});
  const flowData = safeJsonParse<AnyObject>(savedFlow?.data, {});
  const storyboard = await loadStoryboard(projectId, scriptId);
  const assets = await loadAssets(projectId, scriptId);

  return {
    script: flowData.script || script?.content || "",
    scriptPlan: flowData.scriptPlan || scriptAgentData.adaptationStrategy || "",
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
    const payload = JSON.stringify({ ...current, [key]: content });
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
