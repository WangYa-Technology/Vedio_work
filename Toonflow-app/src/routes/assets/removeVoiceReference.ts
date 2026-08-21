import express from "express";
import { z } from "zod";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";

const router = express.Router();

export default router.post(
  "/",
  validateFields({ projectId: z.number(), roleAssetId: z.number() }),
  async (req, res) => {
    const { projectId, roleAssetId } = req.body;
    const role = await u.db("o_assets").where({ id: roleAssetId, projectId, type: "role" }).select("id").first();
    if (!role) return res.status(404).send({ message: "角色资产不存在或不属于当前项目" });

    let filePath = "";
    await u.db.transaction(async (trx) => {
      const binding = await trx("o_assetsRole2Audio").where({ assetsRoleId: roleAssetId }).first();
      const audioId = Number(binding?.assetsAudioId || 0);
      if (audioId) {
        const audio = await trx("o_assets as audioAsset")
          .leftJoin("o_image as audioImage", "audioAsset.imageId", "audioImage.id")
          .where({ "audioAsset.id": audioId, "audioAsset.projectId": projectId, "audioAsset.type": "clip" })
          .select("audioAsset.id", "audioAsset.imageId", "audioImage.filePath")
          .first();
        filePath = audio?.filePath || "";
        await trx("o_assetsRole2Audio").where({ assetsRoleId: roleAssetId }).delete();
        if (audio) {
          await trx("o_assets").where({ id: audio.id, projectId }).delete();
          if (audio.imageId) await trx("o_image").where({ id: audio.imageId, assetsId: audio.id }).delete();
        }
      }
      await trx("o_assets").where({ id: roleAssetId, projectId, type: "role" }).update({ audioBindState: 0 });
    });
    if (filePath) await u.oss.deleteFile(filePath).catch(() => undefined);
    res.status(200).send(success({ roleAssetId, removed: Boolean(filePath) }));
  },
);
