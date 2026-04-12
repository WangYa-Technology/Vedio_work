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
    data: z.record(z.string(), z.any()),
  }),
  async (req, res) => {
    const { projectId, data } = req.body;
    const existing = await u.db("o_agentWorkData").where({ projectId, key: "storyboardAgent" }).first();
    const now = Date.now();
    if (existing) {
      await u.db("o_agentWorkData").where({ projectId, key: "storyboardAgent" }).update({ data: JSON.stringify(data), updateTime: now });
    } else {
      await u.db("o_agentWorkData").insert({ projectId, key: "storyboardAgent", data: JSON.stringify(data), createTime: now, updateTime: now });
    }
    res.status(200).send(success({ projectId }));
  },
);
