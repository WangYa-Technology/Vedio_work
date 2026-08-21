import express from "express";
import u from "@/utils";
import { error, success } from "@/lib/responseFormat";
import { requireAdmin } from "@/middleware/auth";
import { validateFields } from "@/middleware/middleware";
import { hashPassword } from "@/utils/password";
import { z } from "zod";

const router = express.Router();
export default router.post("/", requireAdmin, validateFields({
  name: z.string().trim().min(2).max(50),
  password: z.string().min(8).max(200),
  role: z.enum(["admin", "user"]).default("admin"),
}), async (req, res) => {
  const { name, password } = req.body;
  const role = "admin";
  if (await u.db("o_user").where({ name }).first()) return res.status(409).send(error("用户名已存在"));
  const row = await u.db("o_user").max("id as id").first();
  const id = Number((row as any)?.id || 0) + 1;
  await u.db("o_user").insert({ id, name, password: await hashPassword(password), role, status: "active", createTime: Date.now() });
  res.send(success({ id, name, role, status: "active" }));
});
