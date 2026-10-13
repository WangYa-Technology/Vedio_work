import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import { removeAssetsCascade } from "@/utils/assetCleanup";

const router = express.Router();

// 批量删除资产：与单条删除共用同一套级联清理逻辑
export default router.post(
  "/",
  validateFields({
    id: z.array(z.number()).min(1),
  }),
  async (req, res) => {
    try {
      const result = await removeAssetsCascade(req.body.id);
      res.status(200).send(success({ message: "删除资产成功", ...result }));
    } catch (deleteError) {
      res.status(400).send(error((deleteError as Error).message || "删除资产失败"));
    }
  },
);
