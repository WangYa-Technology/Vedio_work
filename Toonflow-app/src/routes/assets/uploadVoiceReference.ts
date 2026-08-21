import express from "express";
import { z } from "zod";
import { v4 as uuid } from "uuid";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";

const router = express.Router();

const AUDIO_EXTENSIONS: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/ogg": "ogg",
  "audio/aac": "aac",
  "audio/flac": "flac",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
};

function parseAudioBase64(value: string) {
  const match = value.match(/^data:([^;]+);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw new Error("声音参考素材格式无效");
  const mime = match[1].toLowerCase();
  const extension = AUDIO_EXTENSIONS[mime] || (mime.startsWith("audio/") ? mime.split("/")[1] : "");
  if (!extension || !/^[a-z0-9]+$/i.test(extension)) throw new Error("只支持音频格式的声音参考素材");
  return { extension, buffer: Buffer.from(match[2], "base64") };
}

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    roleAssetId: z.number(),
    base64Data: z.string().min(1),
    name: z.string().optional(),
  }),
  async (req, res) => {
    const { projectId, roleAssetId, base64Data, name } = req.body;
    const { extension, buffer } = parseAudioBase64(base64Data);
    const role = await u
      .db("o_assets")
      .where({ id: roleAssetId, projectId, type: "role" })
      .select("id", "name")
      .first();
    if (!role) return res.status(404).send({ message: "角色资产不存在或不属于当前项目" });

    const filePath = `/${projectId}/assets/voice/${uuid()}.${extension}`;
    await u.oss.writeFile(filePath, buffer);

    let oldFilePath = "";
    let voiceReference: Record<string, unknown> | null = null;
    try {
      await u.db.transaction(async (trx) => {
        const oldBinding = await trx("o_assetsRole2Audio")
          .where({ assetsRoleId: roleAssetId })
          .first();
        const oldAudioId = Number(oldBinding?.assetsAudioId || 0);
        if (oldAudioId) {
          const oldAudio = await trx("o_assets as audioAsset")
            .leftJoin("o_image as audioImage", "audioAsset.imageId", "audioImage.id")
            .where({ "audioAsset.id": oldAudioId, "audioAsset.projectId": projectId, "audioAsset.type": "clip" })
            .select("audioAsset.id", "audioAsset.imageId", "audioImage.filePath")
            .first();
          oldFilePath = oldAudio?.filePath || "";
          await trx("o_assetsRole2Audio").where({ assetsRoleId: roleAssetId }).delete();
          if (oldAudio) {
            await trx("o_assets").where({ id: oldAudio.id, projectId }).delete();
            if (oldAudio.imageId) await trx("o_image").where({ id: oldAudio.imageId, assetsId: oldAudio.id }).delete();
          }
        }

        const [audioAssetId] = await trx("o_assets").insert({
          name: name?.trim() || `${role.name || "角色"}声音参考`,
          describe: `角色 ${role.name || roleAssetId} 的声音参考素材`,
          type: "clip",
          projectId,
          startTime: Date.now(),
        });
        const [audioImageId] = await trx("o_image").insert({
          filePath,
          type: "audio",
          assetsId: audioAssetId,
          state: "已完成",
        });
        await trx("o_assets").where({ id: audioAssetId, projectId }).update({ imageId: audioImageId });
        await trx("o_assetsRole2Audio").insert({ assetsRoleId: roleAssetId, assetsAudioId: audioAssetId });
        await trx("o_assets").where({ id: roleAssetId, projectId, type: "role" }).update({ audioBindState: 1 });

        voiceReference = {
          assetId: Number(audioAssetId),
          imageId: Number(audioImageId),
          name: name?.trim() || `${role.name || "角色"}声音参考`,
          type: "audio",
          state: "已完成",
          filePath: await u.oss.getFileUrl(filePath),
        };
      });
    } catch (error) {
      await u.oss.deleteFile(filePath).catch(() => undefined);
      throw error;
    }

    if (oldFilePath && oldFilePath !== filePath) await u.oss.deleteFile(oldFilePath).catch(() => undefined);
    res.status(200).send(success({ roleAssetId, voiceReference }));
  },
);
