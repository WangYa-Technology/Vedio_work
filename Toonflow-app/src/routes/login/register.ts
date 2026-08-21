import express from "express";
import u from "@/utils";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { hashPassword } from "@/utils/password";
import { z } from "zod";

const router = express.Router();

// 内部工具注册：仅账户名和密码，新用户默认普通用户且供应商配置全局共享。
export default router.post(
  "/",
  validateFields({ username: z.string().trim().min(2).max(50), password: z.string().min(8).max(200) }),
  async (req, res) => {
    const username = String(req.body.username).trim();
    const password = String(req.body.password);
    if (await u.db("o_user").where({ name: username }).first()) return res.status(409).send(error("账户名已存在，请直接登录"));
    const max = await u.db("o_user").max("id as id").first();
    const id = Number((max as any)?.id || 0) + 1;
    await u.db("o_user").insert({ id, name: username, password: await hashPassword(password), role: "admin", status: "active", createTime: Date.now() });
    res.status(201).send(success({ id, name: username, role: "admin" }, "注册成功，请登录"));
  },
);
