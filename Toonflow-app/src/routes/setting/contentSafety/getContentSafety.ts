import express from "express";
import { success } from "@/lib/responseFormat";
import u from "@/utils";
import { CONTENT_SAFETY_SETTING_KEY, DEFAULT_CONTENT_SAFETY_CONSTRAINT } from "@/constants/contentSafety";

const router = express.Router();

export default router.get("/", async (_req, res) => {
  const setting = await u.db("o_setting").where("key", CONTENT_SAFETY_SETTING_KEY).first();
  res.status(200).send(success({
    key: CONTENT_SAFETY_SETTING_KEY,
    constraint: String(setting?.value ?? DEFAULT_CONTENT_SAFETY_CONSTRAINT),
    defaultConstraint: DEFAULT_CONTENT_SAFETY_CONSTRAINT,
  }));
});
