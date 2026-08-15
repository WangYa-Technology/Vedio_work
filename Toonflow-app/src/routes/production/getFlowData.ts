import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { success } from "@/lib/responseFormat";
import { buildProductionFlowData } from "@/utils/productionFlow";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    episodesId: z.number(),
  }),
  async (req, res) => {
    const { projectId, episodesId } = req.body;
    const data = await buildProductionFlowData(projectId, episodesId);
    res.status(200).send(success(data));
  },
);
