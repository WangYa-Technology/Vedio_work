import u from "@/utils";

type AnyRow = Record<string, any>;

export interface AssetDeletionSet {
  /** 待删除的全部资产 ID（目标资产 + 衍生资产 + 角色绑定的声音资产） */
  assetIds: number[];
  /** 待删除的资产行（含 name / promptState，用于生成中拦截提示） */
  rows: AnyRow[];
}

const assetColumns = ["id", "name", "type", "promptState", "assetsId"];

/**
 * 收集级联删除集合：
 * 1. 目标资产本身；
 * 2. 其衍生资产（o_assets.assetsId 指向目标资产）；
 * 3. 目标角色绑定的声音（clip）资产及其衍生。
 */
export async function collectAssetDeletionSet(ids: number[]): Promise<AssetDeletionSet> {
  const normalized = [...new Set(ids.map(Number).filter(Number.isSafeInteger))];
  if (!normalized.length) return { assetIds: [], rows: [] };

  const targets: AnyRow[] = await u.db("o_assets").whereIn("id", normalized).select(assetColumns);
  const derived: AnyRow[] = await u
    .db("o_assets")
    .whereIn("assetsId", normalized)
    .select(assetColumns);

  const roleIds = [
    ...new Set(
      [...targets, ...derived]
        .filter((row) => String(row.type) === "role")
        .map((row) => Number(row.id))
        .filter(Number.isSafeInteger),
    ),
  ];
  const voiceRows: AnyRow[] = roleIds.length
    ? await u.db("o_assetsRole2Audio").whereIn("assetsRoleId", roleIds).select("assetsAudioId")
    : [];
  const voiceIds = [
    ...new Set(voiceRows.map((row) => Number(row.assetsAudioId)).filter(Number.isSafeInteger)),
  ];
  const voices: AnyRow[] = voiceIds.length
    ? await u.db("o_assets").whereIn("id", voiceIds).select(assetColumns)
    : [];
  const voiceDerived: AnyRow[] = voiceIds.length
    ? await u.db("o_assets").whereIn("assetsId", voiceIds).select(assetColumns)
    : [];

  const rows: AnyRow[] = [];
  const seen = new Set<number>();
  for (const row of [...targets, ...derived, ...voices, ...voiceDerived]) {
    const id = Number(row.id);
    if (!Number.isSafeInteger(id) || seen.has(id)) continue;
    seen.add(id);
    rows.push(row);
  }
  return { assetIds: [...seen], rows };
}

/** 生成中的资产（提示词或图片）禁止删除，避免破坏进行中的生成任务 */
export function assertAssetsNotGenerating(assets: AnyRow[], images: AnyRow[] = []) {
  const generatingAsset = assets.find((row) =>
    String(row?.promptState || "").includes("生成中"),
  );
  if (generatingAsset) {
    throw new Error(`资产「${generatingAsset.name || generatingAsset.id}」正在生成提示词，请等待完成或停止后再删除`);
  }
  const generatingImage = images.find((row) => String(row?.state || "").includes("生成中"));
  if (generatingImage) {
    const owner = assets.find((row) => Number(row.id) === Number(generatingImage.assetsId));
    throw new Error(`资产「${owner?.name || generatingImage.assetsId}」正在生成图片，请等待完成或停止后再删除`);
  }
}

/**
 * 级联删除资产：衍生资产、图片记录与 OSS 文件、分镜引用绑定、剧本关联、
 * 角色声音关联（含绑定角色的 audioBindState 回写）。
 * 数据库写入放在事务中，OSS 文件在事务提交后 best-effort 清理。
 */
export async function removeAssetsCascade(ids: number[]) {
  const set = await collectAssetDeletionSet(ids);
  if (!set.assetIds.length) {
    return { removedAssetIds: [], removedImageCount: 0 };
  }

  const images: AnyRow[] = await u.db("o_image").whereIn("assetsId", set.assetIds);
  assertAssetsNotGenerating(set.rows, images);
  const imageIds = images.map((row) => Number(row.id)).filter(Number.isSafeInteger);

  // 删除声音资产时，绑定该音频但本次保留的角色需要把 audioBindState 复位。
  const voiceRows: AnyRow[] = await u
    .db("o_assetsRole2Audio")
    .whereIn("assetsAudioId", set.assetIds)
    .select("assetsRoleId");
  const boundRoleIds = [
    ...new Set(
      voiceRows.map((row) => Number(row.assetsRoleId)).filter(Number.isSafeInteger),
    ),
  ].filter((id) => !set.assetIds.includes(id));

  await u.db.transaction(async (trx) => {
    // 先解除 o_assets.imageId 对 o_image 的引用，再删除图片与资产。
    if (imageIds.length) {
      await trx("o_assets").whereIn("imageId", imageIds).update({ imageId: null });
    }
    await trx("o_image").whereIn("assetsId", set.assetIds).delete();
    await trx("o_assets2Storyboard").whereIn("assetId", set.assetIds).delete();
    await trx("o_scriptAssets").whereIn("assetId", set.assetIds).delete();
    await trx("o_assetsRole2Audio").whereIn("assetsRoleId", set.assetIds).delete();
    await trx("o_assetsRole2Audio").whereIn("assetsAudioId", set.assetIds).delete();
    await trx("o_assets").whereIn("id", set.assetIds).delete();
    if (boundRoleIds.length) {
      await trx("o_assets").whereIn("id", boundRoleIds).update({ audioBindState: 0 });
    }
  });

  for (const image of images) {
    if (!image.filePath) continue;
    try {
      await u.oss.deleteFile(image.filePath);
    } catch {
      // 文件可能已被手动删除或路径失效：数据一致性优先，不因单个文件缺失中断。
    }
  }

  const left = await u.db("o_assets").whereIn("id", set.assetIds).first();
  if (left) throw new Error("资产删除后回读校验失败");

  return { removedAssetIds: set.assetIds, removedImageCount: images.length };
}
