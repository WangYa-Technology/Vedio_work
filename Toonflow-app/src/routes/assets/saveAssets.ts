import express from "express";
import u from "@/utils";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

// 保存资产图片
export default router.post(
  "/",
  validateFields({
    id: z.number(),
    projectId: z.number(),
    base64: z.string().optional().nullable(),
    type: z.enum(["role", "scene", "tool"]),
    originalPrompt: z.string().optional().nullable(),
    prompt: z.string().optional().nullable(),
    imageId: z.number().optional().nullable(),
  }),
  async (req, res) => {
    const { id, base64, type, originalPrompt, prompt, projectId, imageId } = req.body;
    const asset = await u
      .db("o_assets")
      .where({ id, projectId, type })
      .select("id", "imageId")
      .first();
    if (!asset) return res.status(404).send(error("资产不存在或类型不匹配"));

    let selectedImageId = imageId;
    let selectedFilePath: string | null = null;
    if (base64) {
      const matches = base64.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/);
      const realBase64 = matches ? matches[1] : base64;
      const savePath = `/${projectId}/${type}/${uuidv4()}.png`;
      await u.oss.writeFile(savePath, Buffer.from(realBase64, "base64"));
      await u.db.transaction(async (trx) => {
        const [idData] = await trx("o_image").insert({
          assetsId: id,
          filePath: savePath,
          type,
          state: "已完成",
        });
        selectedImageId = Number(idData);
        selectedFilePath = savePath;
        await trx("o_assets")
          .where({ id, projectId })
          .update({
            ...(originalPrompt !== undefined ? { originalPrompt: originalPrompt ?? "" } : {}),
            ...(prompt !== undefined ? { prompt: prompt ?? "" } : {}),
            imageId: selectedImageId,
          });
      });
    } else {
      if (imageId != null) {
        const image = await u
          .db("o_image")
          .where({ id: imageId, assetsId: id, state: "已完成" })
          .select("id", "filePath")
          .first();
        if (!image)
          return res.status(400).send(error("所选图片不属于当前资产或不可用"));
        selectedFilePath = image.filePath;
      }
      await u
        .db("o_assets")
        .where({ id, projectId })
        .update({
          ...(originalPrompt !== undefined ? { originalPrompt: originalPrompt ?? "" } : {}),
          ...(prompt !== undefined ? { prompt: prompt ?? "" } : {}),
          ...(imageId !== undefined ? { imageId } : {}),
        });
    }
    res.status(200).send(
      success({
        message: "保存资产图片成功",
        assetId: id,
        imageId: selectedImageId ?? asset.imageId ?? null,
        filePath: selectedFilePath
          ? await u.oss.getFileUrl(selectedFilePath)
          : null,
      }),
    );
  },
);
