import express from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/middleware/middleware";
import { success } from "@/lib/responseFormat";
import { USER_PROMPT_ID_FLOOR } from "@/utils/promptTemplate";

const router = express.Router();
const PromptTypeSchema = z.enum([
  "imagePromptGeneration",
  "videoPromptGeneration",
  "assetInferenceTemplate",
]);

export default router.post(
  "/",
  validateFields({
    name: z.string().trim().min(1).max(80),
    type: PromptTypeSchema,
    data: z.string().trim().min(1),
  }),
  async (req, res) => {
    const { name, type, data } = req.body;
    let id = Math.max(Date.now(), USER_PROMPT_ID_FLOOR);
    while (await u.db("o_prompt").where({ id }).first()) id += 1;
    await u.db("o_prompt").insert({ id, name, type, data, useData: data });
    res.status(200).send(success({ id, name, type, data, source: "user" }));
  },
);
