import express from "express";
import { success } from "@/lib/responseFormat";
import u from "@/utils";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

export default router.post(
  "/",
  validateFields({ projectId: z.number() }),
  async (req, res) => {
    const { projectId } = req.body;
    const shots = await u.db("o_storyboard_shot").where({ projectId }).orderBy("episodeNumber").orderBy("shotNumber");
    const characterBible = await u.db("o_character_bible").where({ projectId }).first() ?? null;
    const directorAlignment = await u.db("o_director_alignment").where({ projectId }).first() ?? null;
    const assetPrompts = await u.db("o_asset_prompt").where({ projectId }).orderBy("series").orderBy("assetNumber");
    res.status(200).send(success({ shots, characterBible, directorAlignment, assetPrompts }));
  },
);
