import express from "express";
import u from "@/utils";
import { error, success } from "@/lib/responseFormat";
import { requireAdmin } from "@/middleware/auth";
import { validateFields } from "@/middleware/middleware";
import { hashPassword } from "@/utils/password";
import { z } from "zod";

const router = express.Router();
export default router.post("/", requireAdmin, validateFields({
  id: z.number().int().positive(), name: z.string().trim().min(2).max(50),
  role: z.enum(["admin", "user"]).optional(), status: z.enum(["active", "disabled"]),
  password: z.string().min(8).max(200).optional(),
}), async (req, res) => {
  const { id, name, status, password } = req.body;
  const role = "admin";
  const duplicate = await u.db("o_user").where({ name }).whereNot({ id }).first();
  if (duplicate) return res.status(409).send(error("用户名已存在"));
  const updated = await u.db("o_user").where({ id }).update({ name, role, status, ...(password ? { password: await hashPassword(password) } : {}) });
  if (!updated) return res.status(404).send(error("用户不存在"));
  res.send(success({ id, name, role, status }));
});
