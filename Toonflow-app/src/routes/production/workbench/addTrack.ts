import express from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/middleware/middleware";
import { success } from "@/lib/responseFormat";

const router = express.Router();

export default router.post(
  "/",
  validateFields({ projectId: z.number(), scriptId: z.number() }),
  async (req, res) => {
    let id = Date.now();
    while (await u.db("o_videoTrack").where({ id }).first()) id += 1;
    const row = { id, projectId: req.body.projectId, scriptId: req.body.scriptId, state: "未生成", prompt: "", duration: 5 };
    await u.db("o_videoTrack").insert(row);
    res.status(200).send(success(row));
  },
);
