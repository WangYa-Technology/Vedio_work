import express from "express";
import { success } from "@/lib/responseFormat";
import { getAssetInferenceTemplates } from "./assetPromptTemplateStore";

const router = express.Router();

export default router.post("/", async (_req, res) => {
  const data = await getAssetInferenceTemplates();
  res.status(200).send(success(data));
});

