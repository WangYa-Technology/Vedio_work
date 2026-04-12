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
    coreTheme: z.string(),
    characters: z.string(),
    wantNeedArc: z.string(),
    visualMotifs: z.string(),
    storyStructure: z.string(),
  }),
  async (req, res) => {
    const { projectId, coreTheme, characters, wantNeedArc, visualMotifs, storyStructure } = req.body;
    const now = Date.now();
    const existing = await u.db("o_character_bible").where({ projectId }).first();
    if (existing) {
      await u.db("o_character_bible").where({ projectId }).update({ coreTheme, characters, wantNeedArc, visualMotifs, storyStructure, updateTime: now });
    } else {
      await u.db("o_character_bible").insert({ projectId, coreTheme, characters, wantNeedArc, visualMotifs, storyStructure, createTime: now, updateTime: now });
    }
    const data = await u.db("o_character_bible").where({ projectId }).first();
    res.status(200).send(success(data));
  },
);
