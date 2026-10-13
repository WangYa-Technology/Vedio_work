import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import { removeAssetsCascade } from "@/utils/assetCleanup";

const router = express.Router();

// 删除资产：级联清理衍生资产、图片与文件、分镜引用绑定、剧本关联、角色声音关联
export default router.post(
  "/",
  validateFields({
    id: z.number(),
  }),
  async (req, res) => {
    try {
      const result = await removeAssetsCascade([req.body.id]);
      res.status(200).send(success({ message: "删除资产成功", ...result }));
    } catch (deleteError) {
      res.status(400).send(error((deleteError as Error).message || "删除资产失败"));
    }
  },
);
