import express from "express";
import { success } from "@/lib/responseFormat";
import u from "@/utils";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { ProjectGlobalContextSchema } from "@/schemas/projectGlobalContext";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    id: z.number(),
    data: z.object({
      storySkeleton: z.string(),
      adaptationStrategy: z.string(),
      projectGlobalContext: ProjectGlobalContextSchema.optional(),
      script: z.array(
        z.object({
          id: z.number().optional(),
          name: z.string().optional(),
          content: z.string(),
        }),
      ),
    }),
  }),
  async (req, res) => {
    const { id, data } = req.body;
    const current = await u.db("o_agentWorkData").where({ id }).first();
    let currentData: Record<string, unknown> = {};
    try {
      currentData = JSON.parse(current?.data ?? "{}");
    } catch {
      currentData = {};
    }
    await u
      .db("o_agentWorkData")
      .where({ id: id })
      .update({
        data: JSON.stringify({
          ...currentData,
          ...data,
          projectGlobalContext: data.projectGlobalContext ?? currentData.projectGlobalContext,
        }),
      });
    res.status(200).send(success("更新成功"));
  },
);
