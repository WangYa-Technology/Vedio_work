import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    type: z.array(z.string()).optional(),
  }),
  async (req, res) => {
    const { projectId, type } = req.body;
    const data = await u
      .db("o_assets")
      .leftJoin("o_image", "o_assets.imageId", "o_image.id")
      .select(
        "o_assets.*",
        "o_image.filePath",
        "o_image.state",
        "o_image.model",
        "o_image.resolution",
        "o_image.errorReason",
        "o_image.id as imageId",
      )
      .where("o_assets.projectId", projectId)
      .andWhere("o_assets.type", "<>", "clip")
      .andWhere("o_assets.assetsId", null)
      .modify((qb) => {
        if (type && type.length > 0) qb.whereIn("o_assets.type", type);
      })
      .orderByRaw(`CASE o_assets.type WHEN 'role' THEN 1 WHEN 'scene' THEN 2 WHEN 'tool' THEN 3 ELSE 4 END`);
    const result = await Promise.all(
      data.map(async (parent: any) => {
        const historyImages = await u.db("o_image").where("assetsId", parent.id).andWhere("state", "已完成").select("id", "filePath");
        const historyImagesWithUrl = await Promise.all(
          historyImages.map(async (img: any) => ({
            id: img.id,
            filePath: img.filePath && (await u.oss.getFileUrl(img.filePath)),
          })),
        );
        const voice =
          parent.type === "role"
            ? await u
                .db("o_assetsRole2Audio")
                .join("o_assets as audioAsset", "o_assetsRole2Audio.assetsAudioId", "audioAsset.id")
                .leftJoin("o_image as audioImage", "audioAsset.imageId", "audioImage.id")
                .where({
                  "o_assetsRole2Audio.assetsRoleId": parent.id,
                  "audioAsset.projectId": parent.projectId,
                  "audioAsset.type": "clip",
                })
                .select(
                  "audioAsset.id as assetId",
                  "audioAsset.name",
                  "audioAsset.imageId",
                  "audioImage.filePath",
                  "audioImage.state",
                )
                .first()
            : null;
        const voicePath = voice?.filePath ? await u.oss.getFileUrl(voice.filePath) : "";
        return {
          ...parent,
          filePath: parent.filePath && (await u.oss.getFileUrl(parent.filePath!)),
          historyImages: historyImagesWithUrl,
          voiceAssetId: voice?.assetId ? Number(voice.assetId) : null,
          voiceImageId: voice?.imageId ? Number(voice.imageId) : null,
          voiceName: voice?.name || "",
          voicePath,
          voiceState: voice?.state || "未绑定",
          voiceReference: voicePath
            ? {
                id: Number(voice.assetId),
                assetId: Number(voice.assetId),
                imageId: Number(voice.imageId),
                name: voice.name || "声音参考",
                type: "audio",
                fileType: "audio",
                sources: "assets",
                src: voicePath,
                state: voice.state || "已完成",
              }
            : null,
        };
      }),
    );
    res.status(200).send(success(result));
  },
);
