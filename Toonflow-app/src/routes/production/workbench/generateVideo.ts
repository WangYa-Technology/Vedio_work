import express from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/middleware/middleware";
import { success } from "@/lib/responseFormat";
import {
  pendingVideoTaskData,
  updateVideoTaskState,
  VIDEO_WORKER_RUN_ID,
} from "@/utils/videoTaskRecovery";

const router = express.Router();

async function nextId(table: "o_video") {
  let id = Date.now();
  while (await u.db(table).where({ id }).first()) id += 1;
  return id;
}

async function resolveReferenceFile(item: {
  id: number;
  sources: "assets" | "storyboard";
}) {
  if (item.sources === "assets") {
    const asset = await u
      .db("o_assets")
      .leftJoin("o_image", "o_assets.imageId", "o_image.id")
      .where("o_assets.id", item.id)
      .select("o_assets.name", "o_image.filePath")
      .first();
    if (!asset?.filePath)
      throw new Error(`参考资产“${asset?.name || item.id}”没有可用图片`);
    return asset.filePath as string;
  }
  const storyboard = await u.db("o_storyboard").where({ id: item.id }).first();
  if (!storyboard?.filePath) throw new Error(`分镜图 ${item.id} 不存在`);
  return storyboard.filePath as string;
}

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number(),
    trackId: z.number(),
    uploadData: z.array(
      z.object({ id: z.number(), sources: z.enum(["assets", "storyboard"]) }),
    ),
    prompt: z.string().min(1),
    model: z.string().min(1),
    mode: z.union([z.string(), z.array(z.string())]).optional(),
    resolution: z.string().optional(),
    duration: z.number().optional(),
    audio: z.boolean().optional(),
  }),
  async (req, res) => {
    const {
      projectId,
      scriptId,
      trackId,
      uploadData,
      prompt,
      model,
      mode,
      resolution,
      duration,
      audio,
    } = req.body;
    const track = await u
      .db("o_videoTrack")
      .where({ id: trackId, projectId, scriptId })
      .first();
    if (!track) throw new Error("未找到对应的视频片段");
    const project = await u.db("o_project").where({ id: projectId }).first();
    const referencePaths = await Promise.all(
      uploadData.map(resolveReferenceFile),
    );
    const imageBase64 = await Promise.all(
      referencePaths.map((filePath) => u.oss.getImageBase64(filePath)),
    );
    const id = await nextId("o_video");
    const filePath = `${projectId}/video/${scriptId}/${u.uuid()}.mp4`;
    const requestedDuration = Math.max(
      1,
      Math.round(Number(duration || track.duration || 5)),
    );
    const effectiveDuration = /minimax.*h3|h3.*minimax/i.test(model)
      ? Math.min(15, requestedDuration)
      : requestedDuration;
    const startedAt = Date.now();

    await u.db("o_video").insert({
      id,
      projectId,
      scriptId,
      videoTrackId: trackId,
      filePath,
      state: "生成中",
      time: effectiveDuration,
      errorReason: "",
      model,
      providerTaskData: JSON.stringify(pendingVideoTaskData(startedAt)),
      createTime: startedAt,
    });
    await u
      .db("o_videoTrack")
      .where({ id: trackId })
      .update({
        prompt,
        duration: effectiveDuration,
        state: "生成中",
        reason: "",
      });
    res
      .status(200)
      .send(success({ id, state: "生成中" }, "视频生成任务已提交"));

    void (async () => {
      try {
        await (
          await u.Ai.Video(model as `${string}:${string}`).run(
            {
              prompt,
              imageBase64,
              aspectRatio: (project?.videoRatio ||
                "16:9") as `${number}:${number}`,
              mode: Array.isArray(mode)
                ? JSON.stringify(mode)
                : String(mode || ""),
              duration: effectiveDuration,
              resolution: resolution || "864x480",
              audio: Boolean(audio),
            },
            {
              taskClass: "videoGeneration",
              describe: `生成第 ${trackId} 个视频片段`,
              relatedObjects: JSON.stringify({
                trackId,
                references: uploadData,
              }),
              projectId,
              onProviderTask: async (task) => {
                await u
                  .db("o_video")
                  .where({ id })
                  .update({
                    providerTaskId: task.taskId,
                    providerTaskData: JSON.stringify({
                      ...task,
                      runId: VIDEO_WORKER_RUN_ID,
                      startedAt,
                    }),
                  });
              },
            },
          )
        ).save(filePath);
        await updateVideoTaskState({ id, videoTrackId: trackId }, "已完成");
      } catch (error) {
        const reason = u.error(error).message;
        await updateVideoTaskState({ id, videoTrackId: trackId }, "生成失败", reason);
      }
    })();
  },
);
