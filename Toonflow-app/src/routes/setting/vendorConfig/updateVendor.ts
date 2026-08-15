import express from "express";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import u from "@/utils";
import { z } from "zod";
import { vendorInputSchema, vendorModelSchema } from "@/schemas/vendorConfig";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    id: z.string(),
    inputValues: z.record(z.string(), z.string()),
    inputs: z.array(vendorInputSchema),
    models: z.array(vendorModelSchema),
  }),
  async (req, res) => {
    const { id, models, inputs, inputValues } = req.body;

    await u
      .db("o_vendorConfig")
      .where("id", id)
      .update({
        inputs: JSON.stringify(inputs),
        inputValues: JSON.stringify(inputValues),
        models: JSON.stringify(models),
      });
    res.status(200).send(success("更新成功"));
  },
);
