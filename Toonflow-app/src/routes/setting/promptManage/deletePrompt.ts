import express from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/middleware/middleware";
import { success } from "@/lib/responseFormat";
import { isUserPromptId } from "@/utils/promptTemplate";

const router = express.Router();

export default router.post(
  "/",
  validateFields({ id: z.number() }),
  async (req, res) => {
    const prompt = await u.db("o_prompt").where({ id: req.body.id }).first();
    if (!prompt) throw new Error("提示词模版不存在");
    if (!isUserPromptId(prompt.id)) throw new Error("官方提示词模版不能删除");
    await u.db("o_prompt").where({ id: req.body.id }).delete();
    res.status(200).send(success({ id: req.body.id }));
  },
);
