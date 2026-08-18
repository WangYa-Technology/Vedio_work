import express from "express";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    artStyle: z.string().min(1),
  }),
  async (req, res) => {
    const { projectId, artStyle } = req.body;
    const updated = await u.db("o_project").where("id", projectId).update({ artStyle });
    if (!updated) return res.status(404).send(error("项目不存在"));
    return res.status(200).send(success({ projectId, artStyle }));
  },
);
