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
    platformMode: z.string(),
    episodeNumber: z.number().optional(),
  }),
  async (req, res) => {
    const { projectId, platformMode, episodeNumber } = req.body;
    const query = u.db("o_storyboard_shot").where({ projectId });
    if (episodeNumber !== undefined) query.where({ episodeNumber });
    await query.update({ platformMode, updateTime: Date.now() });
    res.status(200).send(success({ platformMode }));
  },
);
