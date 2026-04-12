import express from "express";
import { success, error } from "@/lib/responseFormat";
import u from "@/utils";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    key: z.string().optional(),
  }),
  async (req, res) => {
    const { key } = req.body;
    // Try Claude vendor first, fall back to toonflow
    const vendorId = (await u.db("o_vendorConfig").where("id", "claude").first()) ? "claude" : "toonflow";
    const vendorConfigData = await u.db("o_vendorConfig").where("id", vendorId).first();
    if (!vendorConfigData) return res.status(500).send(error("未找到该供应商配置"));
    if (!vendorConfigData.inputValues) return res.status(500).send(error("未找到模型配置数据"));
    const inputValue = JSON.parse(vendorConfigData.inputValues!);
    inputValue.apiKey = key;
    await u
      .db("o_vendorConfig")
      .where("id", vendorId)
      .update({
        inputValues: JSON.stringify(inputValue),
      });
    try {
      const resText = await u.Ai.Text(`${vendorId}:claude-haiku-4-5-20251001`).invoke({
        prompt: "1+1等于几？,请直接回答2，不要解释",
      });
      if (resText.text) {
        await u.db("o_agentDeploy").where("key", "scriptAgent").update({
          model: "claude-sonnet-4-6",
          modelName: `${vendorId}:claude-sonnet-4-6`,
          vendorId,
        });
        await u.db("o_agentDeploy").where("key", "storyboardAgent").update({
          model: "claude-sonnet-4-6",
          modelName: `${vendorId}:claude-sonnet-4-6`,
          vendorId,
        });
        await u.db("o_agentDeploy").where("key", "universalAi").update({
          model: "claude-haiku-4-5",
          modelName: `${vendorId}:claude-haiku-4-5-20251001`,
          vendorId,
        });
        res.status(200).send(success("一键填入成功"));
      }
    } catch (err) {
      console.error(err);
      inputValue.apiKey = "";
      await u
        .db("o_vendorConfig")
        .where("id", vendorId)
        .update({ inputValues: JSON.stringify(inputValue) });
      res.status(400).send(error("KEY无效，请重新输入"));
    }
  },
);
