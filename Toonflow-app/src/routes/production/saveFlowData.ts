import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { success } from "@/lib/responseFormat";
import { saveProductionFlowData } from "@/utils/productionFlow";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    episodesId: z.number(),
    data: z.any(),
  }),
  async (req, res) => {
    const { projectId, episodesId, data } = req.body;
    await saveProductionFlowData(projectId, episodesId, data);
    res.status(200).send(success(true));
  },
);
