import express from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/middleware/middleware";
import { success } from "@/lib/responseFormat";
import { recoverPendingVideoTasks } from "@/utils/videoTaskRecovery";

const router = express.Router();

// /oss 静态目录受登录鉴权保护，而 <video> 标签不会带上 Authorization 头，
// 因此视频地址必须走 u.oss.getFileUrl 生成带 expires/signature 的签名链接（与 getVideoList 一致）。
async function fileUrl(filePath?: string | null) {
  if (!filePath) return "";
  return u.oss.getFileUrl(filePath);
}

interface LibraryVideo {
  id: number;
  src: string;
  state: string;
  playable: boolean;
  duration: number;
  createTime: number;
  videoTrackId: number;
  trackIndex: number;
  errorReason: string;
}

interface LibraryEpisode {
  scriptId: number | null;
  episode: number | null;
  name: string;
  createTime: number;
  videos: LibraryVideo[];
}

// 成片库：按项目一次性返回所有已生成视频，并按剧集（o_script）分组，前端可直接展示“第几集”。
export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
  }),
  async (req, res) => {
    const { projectId } = req.body;
    // 剧集没有“第几集”字段，按创建时间生成序号，作为成片库中的集号。
    const scripts = await u
      .db("o_script")
      .where({ projectId })
      .orderByRaw("COALESCE(createTime, 0) ASC, id ASC")
      .select("id", "name", "createTime");
    const videos = await u
      .db("o_video")
      .where({ projectId })
      .orderByRaw("COALESCE(createTime, 0) DESC, id DESC")
      .select("*");
    void recoverPendingVideoTasks(videos);

    // 视频本身不存时长，取所在分镜（o_videoTrack）的时长作为展示时长；
    // 同时按分镜在同一集中的顺序生成分镜序号，方便在成片库里定位片段。
    const tracks = await u
      .db("o_videoTrack")
      .where({ projectId })
      .orderBy("id", "asc")
      .select("id", "scriptId", "duration");
    const trackDuration = new Map(
      tracks.map((track) => [Number(track.id), Number(track.duration) || 0]),
    );
    const trackIndex = new Map<number, number>();
    const trackCounter = new Map<number, number>();
    for (const track of tracks) {
      const scriptId = Number(track.scriptId);
      const next = (trackCounter.get(scriptId) || 0) + 1;
      trackCounter.set(scriptId, next);
      trackIndex.set(Number(track.id), next);
    }

    const scriptIds = new Set(scripts.map((script) => Number(script.id)));
    const grouped = new Map<number, typeof videos>();
    const orphans: typeof videos = [];
    for (const video of videos) {
      const scriptId = Number(video.scriptId);
      if (!scriptIds.has(scriptId)) {
        orphans.push(video);
        continue;
      }
      const group = grouped.get(scriptId);
      if (group) group.push(video);
      else grouped.set(scriptId, [video]);
    }

    const toLibraryVideos = (list: typeof videos): Promise<LibraryVideo[]> => {
      // 同一分镜的多个版本相邻排列：分镜按集内顺序，版本按生成时间倒序。
      const sorted = [...list].sort((a, b) => {
        const aIndex =
          trackIndex.get(Number(a.videoTrackId)) ?? Number.MAX_SAFE_INTEGER;
        const bIndex =
          trackIndex.get(Number(b.videoTrackId)) ?? Number.MAX_SAFE_INTEGER;
        if (aIndex !== bIndex) return aIndex - bIndex;
        return (Number(b.createTime) || 0) - (Number(a.createTime) || 0);
      });
      return Promise.all(
        sorted.map(async (video) => {
          const state = video.state === "生成成功" ? "已完成" : video.state || "未生成";
          const src = state === "已完成" ? await fileUrl(video.filePath) : "";
          const playable = state === "已完成" && Boolean(src);
          const fileMissing = state === "已完成" && !playable;
          return {
            id: Number(video.id),
            src,
            state: fileMissing ? "生成失败" : state,
            playable,
            duration:
              trackDuration.get(Number(video.videoTrackId)) ??
              (Number(video.time) || 0),
            createTime: Number(video.createTime) || 0,
            videoTrackId: Number(video.videoTrackId) || 0,
            trackIndex: trackIndex.get(Number(video.videoTrackId)) || 0,
            errorReason: fileMissing
              ? String(video.errorReason || "视频文件不存在，请重新生成")
              : String(video.errorReason || ""),
          };
        }),
      );
    };

    const episodes: LibraryEpisode[] = [];
    for (const [index, script] of scripts.entries()) {
      episodes.push({
        scriptId: Number(script.id),
        episode: index + 1,
        name: String(script.name || ""),
        createTime: Number(script.createTime) || 0,
        videos: await toLibraryVideos(grouped.get(Number(script.id)) || []),
      });
    }
    // 剧集被删除后遗留的成片统一归入“其他”，避免成片在库里消失。
    if (orphans.length) {
      episodes.push({
        scriptId: null,
        episode: null,
        name: "",
        createTime: 0,
        videos: await toLibraryVideos(orphans),
      });
    }

    const totalVideos = episodes.reduce(
      (sum, episode) => sum + episode.videos.length,
      0,
    );
    res.status(200).send(success({ episodes, totalVideos }));
  },
);
