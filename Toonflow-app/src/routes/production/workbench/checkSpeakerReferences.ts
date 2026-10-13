import express from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/middleware/middleware";
import { error, success } from "@/lib/responseFormat";
import { buildVideoTaskData } from "@/utils/videoTaskData";
import { collectMissingSpeakerEntries } from "@/utils/speakerReferences";

const router = express.Router();

/**
 * 工作台"一键修复"的补齐检查接口：与视频推理前置校验同源（同一检测函数），
 * 供前端轮询“说话角色参考是否已补齐”。无 AI 调用，只做一次数据聚合。
 */
export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number().optional(),
    trackIds: z.array(z.number()).min(1),
  }),
  async (req, res) => {
    const { projectId, scriptId } = req.body;
    const requestedTrackIds = Array.from(
      new Set<number>((req.body.trackIds || []).map(Number)),
    );
    try {
      const tracks = await u
        .db("o_videoTrack")
        .where({ projectId })
        .whereIn("id", requestedTrackIds);
      if (tracks.length !== requestedTrackIds.length)
        return res.status(400).send(error("部分视频片段不存在或不属于当前项目"));
      const formalScriptIds = Array.from(
        new Set(tracks.map((track) => Number(track.scriptId)).filter(Boolean)),
      );
      if (formalScriptIds.length > 1)
        return res.status(400).send(error("同一次检查只能处理同一集中的视频片段"));
      const resolvedScriptId = formalScriptIds[0] || Number(scriptId);
      if (!resolvedScriptId)
        return res.status(400).send(error("缺少当前剧集，无法处理正式分镜"));

      const data = await buildVideoTaskData(projectId, resolvedScriptId);
      const taskMap = new Map<number, any>(
        data.trackList.map((item: any) => [Number(item.id), item]),
      );
      const tasks = requestedTrackIds
        .map((id) => taskMap.get(id))
        .filter(Boolean) as any[];
      if (tasks.length !== requestedTrackIds.length)
        return res.status(400).send(error("无法读取所选场次的完整分镜数据"));

      const profile = data.projectConfig.videoPromptProfile;
      const applicable =
        profile?.modelFamily === "minimax-h3" &&
        ["multiReference", "multimodal"].includes(
          String(profile?.modeKind || ""),
        );
      if (!applicable)
        return res
          .status(200)
          .send(success({ applicable: false, missingSpeakers: [] }));

      return res.status(200).send(
        success({
          applicable: true,
          missingSpeakers: collectMissingSpeakerEntries(tasks),
        }),
      );
    } catch (caught) {
      return res
        .status(500)
        .send(error(u.error(caught).message || "检查说话角色参考失败"));
    }
  },
);
