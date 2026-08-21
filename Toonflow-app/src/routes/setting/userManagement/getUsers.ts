import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { requireAdmin } from "@/middleware/auth";

const router = express.Router();
export default router.get("/", requireAdmin, async (_req, res) => {
  const users = await u.db("o_user")
    .leftJoin("o_project", "o_user.id", "o_project.userId")
    .select("o_user.id", "o_user.name", "o_user.role", "o_user.status", "o_user.createTime")
    .count("o_project.id as projectCount")
    .groupBy("o_user.id")
    .orderBy("o_user.id");
  res.send(success(users));
});
