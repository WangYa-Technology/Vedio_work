import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { writeScriptAgentRuntime } from "@/utils/agentPersistence";

const router = express.Router();
const workflowState = z.enum(["idle", "working", "retrying", "complete", "error"]);
const runState = z.enum(["idle", "running", "interrupted", "complete", "error"]);

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    agentType: z.literal("scriptAgent"),
    data: z.object({
      version: z.literal(1),
      messages: z.array(z.record(z.string(), z.unknown())).max(500),
      workflowStatus: z.object({ state: workflowState, label: z.string(), phase: z.string().optional() }),
      runState: z.object({
        state: runState,
        phase: z.string().optional(),
        startedAt: z.number().optional(),
        updatedAt: z.number(),
        resumable: z.boolean(),
      }),
      updatedAt: z.number(),
    }),
  }),
  async (req, res) => {
    await writeScriptAgentRuntime(req.body.projectId, req.body.data);
    res.status(200).send(success(null));
  },
);
