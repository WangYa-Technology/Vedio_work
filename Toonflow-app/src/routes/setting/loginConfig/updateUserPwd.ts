import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { hashPassword } from "@/utils/password";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    name: z.string(),
    password: z.string(),
    id: z.number(),
  }),
  async (req, res) => {
    const { name, password, id } = req.body;
    if (req.authUser!.id !== id && req.authUser!.role !== "admin") return res.status(403).send({ message: "无权修改其他用户" });
    await u.db("o_user").where("id", id).update({
      name,
      password: await hashPassword(password),
    });
    res.status(200).send(success("保存设置成功"));
  },
);
