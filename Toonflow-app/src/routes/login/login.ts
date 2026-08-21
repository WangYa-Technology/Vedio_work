import express from "express";
import u from "@/utils";
import jwt from "jsonwebtoken";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { z } from "zod";
import { hashPassword, verifyPassword } from "@/utils/password";
const router = express.Router();

export function setToken(payload: string | object, expiresIn: string | number, secret: string): string {
  if (!payload || typeof secret !== "string" || !secret) {
    throw new Error("参数不合法");
  }
  return (jwt.sign as any)(payload, secret, { expiresIn });
}

// 登录
export default router.post(
  "/",
  validateFields({
    username: z.string(),
    password: z.string(),
  }),
  async (req, res) => {
    const { username, password } = req.body;

    const data = await u.db("o_user").where("name", "=", username).first();
    if (!data) return res.status(400).send(error("登录失败"));

    if (data.status === "disabled") return res.status(403).send(error("账号已停用"));
    if (await verifyPassword(password, String(data.password || ""))) {
      if (!String(data.password).startsWith("scrypt$")) {
        await u.db("o_user").where({ id: data.id }).update({ password: await hashPassword(password) });
      }
      const tokenData = await u.db("o_setting").where("key", "tokenKey").first();
      if (!tokenData) return res.status(400).send(error("未找到tokenKey"));
      const token = setToken(
        {
          id: data!.id,
          name: data!.name,
        },
        "7d",
        tokenData?.value as string,
      );

      return res.status(200).send(success({ token: "Bearer " + token, name: data.name, id: data.id, role: "admin" }, "登录成功"));
    } else {
      return res.status(400).send(error("用户名或密码错误"));
    }
  },
);
