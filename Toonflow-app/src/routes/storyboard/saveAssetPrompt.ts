import express from "express";
import { success } from "@/lib/responseFormat";
import u from "@/utils";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    series: z.string(),
    assetNumber: z.string(),
    assetName: z.string(),
    platform: z.string().optional(),
    prompt: z.string(),
    antiDistortion: z.string().optional(),
  }),
  async (req, res) => {
    const { projectId, series, assetNumber, assetName, platform = "generic", prompt, antiDistortion = "" } = req.body;
    const now = Date.now();
    const existing = await u.db("o_asset_prompt").where({ projectId, assetNumber }).first();
    if (existing) {
      await u.db("o_asset_prompt").where({ projectId, assetNumber }).update({ series, assetName, platform, prompt, antiDistortion, updateTime: now });
    } else {
      await u.db("o_asset_prompt").insert({ projectId, series, assetNumber, assetName, platform, prompt, antiDistortion, createTime: now, updateTime: now });
    }
    const data = await u.db("o_asset_prompt").where({ projectId, assetNumber }).first();
    res.status(200).send(success(data));
  },
);
