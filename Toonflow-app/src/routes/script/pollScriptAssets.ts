import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    ids: z.array(z.number()),
  }),
  async (req, res) => {
    const { ids } = req.body;
    const timeoutBefore = Date.now() - 15 * 60 * 1000;
    await u
      .db("o_script")
      .whereIn("id", ids)
      .whereIn("extractState", [0, 2])
      .whereNotNull("extractStartedAt")
      .where("extractStartedAt", "<", timeoutBefore)
      .update({
        extractState: -1,
        errorReason: "资产提取超过15分钟，请重新提取",
        extractFinishedAt: Date.now(),
      });
    const data = await u
      .db("o_script")
      .whereIn("id", ids)
      .select("id", "extractState", "errorReason", "extractStartedAt", "extractFinishedAt");
    res.status(200).send(success(data));
  },
);
