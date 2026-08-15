import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import u from "@/utils";
import { CONTENT_SAFETY_SETTING_KEY } from "@/constants/contentSafety";

const router = express.Router();

export default router.post(
  "/",
  validateFields({ constraint: z.string().max(20000) }),
  async (req, res) => {
    const constraint = req.body.constraint.trim();
    const updated = await u.db("o_setting").where("key", CONTENT_SAFETY_SETTING_KEY).update({ value: constraint });
    if (!updated) {
      await u.db("o_setting").insert({ key: CONTENT_SAFETY_SETTING_KEY, value: constraint });
    }
    res.status(200).send(success("内容安全约束已保存"));
  },
);
