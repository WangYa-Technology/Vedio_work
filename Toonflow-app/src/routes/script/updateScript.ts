import express from "express";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

// 编辑剧本
export default router.post(
  "/",
  validateFields({
    id: z.number(),
    name: z.string(),
    content: z.string(),
    assets: z.array(z.number()),
  }),
  async (req, res) => {
    const { id, name, content, assets } = req.body;
    if (content.length >= 3000) return res.status(400).send(error("内容不能超过3000字"));

    const currentScript = await u.db("o_script").where({ id }).select("content", "projectId", "extractState").first();
    if (!currentScript) return res.status(404).send(error("剧本不存在"));
    if (currentScript.extractState === 0 || currentScript.extractState === 2) {
      return res.status(409).send(error("资产正在提取中，请完成后再编辑剧本"));
    }
    const contentChanged = currentScript.content !== content;

    await u.db.transaction(async (trx) => {
      await trx("o_script").where({ id }).update({
        name,
        content,
        ...(contentChanged
          ? {
              extractState: -2,
              errorReason: null,
              extractStartedAt: null,
              extractFinishedAt: null,
            }
          : {}),
      });
      const assetsData = assets.length ? await trx("o_assets").whereIn("id", assets).where("projectId", currentScript.projectId).select("id") : [];
      await trx("o_scriptAssets").where({ scriptId: id }).delete();
      if (assetsData.length) {
        await trx("o_scriptAssets").insert(assetsData.map((item) => ({ scriptId: id, assetId: item.id })));
      }
    });

    res.status(200).send(success({ message: "编辑剧本成功" }));
  },
);
