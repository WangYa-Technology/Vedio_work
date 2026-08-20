import express from "express";
import fs from "node:fs";
import path from "node:path";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

// 获取生成图片
export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number().optional(),
  }),
  async (req, res) => {
    const { projectId, scriptId } = req.body;
    const assetsQuery = u
      .db("o_assets")
      .leftJoin("o_image", "o_assets.id", "=", "o_image.assetsId")
      .where("o_assets.type", "clip")
      .andWhere("o_assets.projectId", projectId);
    if (scriptId !== undefined) {
      assetsQuery.andWhere("o_assets.scriptId", scriptId);
    }
    const list = await assetsQuery.select("*");
    const data = await Promise.all(
      list.map(async (item) => ({
        ...item,
        filePath: item.filePath ? await u.oss.getFileUrl(item.filePath) : "",
      })),
    );
    // 片尾素材是可选资源；文件不存在时不要返回一个无法访问的占位 URL。
    // 否则前端会反复请求不存在的文件，静态服务落入鉴权中间件并返回 401，
    // 进而干扰剪辑台素材缩略图的加载。
    const endingPath = path.join(u.getPath("assets"), "ending.mp4");
    if (fs.existsSync(endingPath)) {
      const ending = await u.oss.getFileUrl("/ending.mp4", "assets");
      data.push({
        id: 0,
        name: "Toonflow片尾",
        filePath: ending,
        type: "clip",
      });
    }
    // 查询已完成的视频。历史任务使用“已完成”，新任务使用“生成成功”；
    // 只按“生成成功”筛选会让剪辑台在已有成片时显示为空。
    const videoQuery = u
      .db("o_video")
      .whereIn("state", ["生成成功", "已完成"])
      .andWhere("projectId", projectId);
    if (scriptId !== undefined) {
      videoQuery.andWhere("scriptId", scriptId);
    }
    const videoRows = await videoQuery.select("*");
    // 处理并返回结果
    const video = await Promise.all(
      videoRows.map(async (row) => ({
        id: row.id,
        filePath: row.filePath ? await u.oss.getFileUrl(row.filePath) : "",
        videoTrackId: row.videoTrackId,
        duration: Number(row.duration ?? row.time ?? 0) || 0,
        name: row.name || row.storyboard || "",
      })),
    );

    res.status(200).send(success({ data, video }));
  },
);
