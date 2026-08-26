import express from "express";
import { success } from "@/lib/responseFormat";
import u from "@/utils";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { EMPTY_PROJECT_GLOBAL_CONTEXT, ProjectGlobalContextSchema } from "@/schemas/projectGlobalContext";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    agentType: z.enum(["scriptAgent"]),
    data: z.object({
      storySkeleton: z.string(),
      adaptationStrategy: z.string(),
      projectGlobalContext: ProjectGlobalContextSchema.optional(),
      script: z.array(
        z.object({
          id: z.number().optional(),
          name: z.string().min(1),
          content: z.string(),
        }),
      ),
    }),
  }),
  async (req, res) => {
    const { projectId, agentType, data } = req.body;
    const now = Date.now();

    await u.db.transaction(async (trx) => {
      const workData = await trx("o_agentWorkData").where({ projectId, key: agentType }).first();
      let existingData: Record<string, unknown> = {};
      try {
        existingData = JSON.parse(workData?.data ?? "{}");
      } catch {
        existingData = {};
      }
      const existingGlobalContext = ProjectGlobalContextSchema.safeParse(existingData.projectGlobalContext);
      const persistedData = {
        storySkeleton: data.storySkeleton,
        adaptationStrategy: data.adaptationStrategy,
        projectGlobalContext:
          data.projectGlobalContext ??
          (existingGlobalContext.success
            ? existingGlobalContext.data
            : ProjectGlobalContextSchema.parse(EMPTY_PROJECT_GLOBAL_CONTEXT)),
      };
      if (workData) {
        await trx("o_agentWorkData").where({ id: workData.id }).update({
          data: JSON.stringify(persistedData),
          updateTime: now,
        });
      } else {
        await trx("o_agentWorkData").insert({
          projectId,
          key: agentType,
          data: JSON.stringify(persistedData),
          createTime: now,
          updateTime: now,
        });
      }

      for (const script of data.script) {
        const existing = script.id
          ? await trx("o_script").where({ id: script.id, projectId }).first()
          : await trx("o_script").where({ projectId, name: script.name }).first();
        if (existing) {
          await trx("o_script").where({ id: existing.id, projectId }).update({
            name: script.name,
            content: script.content,
          });
        } else {
          await trx("o_script").insert({
            projectId,
            name: script.name,
            content: script.content,
            createTime: now,
          });
        }
      }
    });

    res.status(200).send(success());
  },
);
