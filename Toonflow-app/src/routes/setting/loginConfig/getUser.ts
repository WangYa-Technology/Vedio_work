import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
const router = express.Router();

export default router.get("/", async (req, res) => {
  const data = await u.db("o_user").where({ id: req.authUser!.id }).select("id", "name", "role", "status", "createTime").first();
  res.status(200).send(success(data));
});
