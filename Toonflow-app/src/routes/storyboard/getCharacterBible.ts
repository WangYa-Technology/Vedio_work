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
    const data = await u.db("o_character_bible").where({ projectId }).first() ?? null;
    res.status(200).send(success(data));
  },
);
