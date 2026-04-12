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
    const row = await u.db("o_agentWorkData").where({ projectId, key: "storyboardAgent" }).first();
    if (!row) {
      return res.status(200).send(success({ data: {}, id: null }));
    }
    const data = JSON.parse(row.data ?? "{}");
    res.status(200).send(success({ data, id: row.id }));
  },
);
