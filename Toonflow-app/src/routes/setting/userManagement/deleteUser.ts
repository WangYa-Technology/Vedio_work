import express from "express";
import u from "@/utils";
import { error, success } from "@/lib/responseFormat";
import { requireAdmin } from "@/middleware/auth";
import { validateFields } from "@/middleware/middleware";
import { z } from "zod";

const router = express.Router();
export default router.post("/", requireAdmin, validateFields({ id: z.number().int().positive() }), async (req, res) => {
  const id = Number(req.body.id);
  if (id === req.authUser!.id) return res.status(400).send(error("不能删除当前登录用户"));
  if (await u.db("o_project").where({ userId: id }).first()) return res.status(409).send(error("该用户仍有项目，请先转移或删除项目"));
  const deleted = await u.db("o_user").where({ id }).delete();
  if (!deleted) return res.status(404).send(error("用户不存在"));
  res.send(success());
});
