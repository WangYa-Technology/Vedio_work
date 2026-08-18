import u from "@/utils";
import { buildProductionFlowData } from "@/utils/productionFlow";
import { resolveProjectVideoModel } from "@/services/videoGeneration";
import { parseModelReference } from "@/utils/modelRef";
import { resolveVideoModelPromptProfile } from "@/utils/videoModelPromptProfile";
import { collectVideoPromptContractViolations } from "@/utils/videoPromptContract";

type AnyObject = Record<string, any>;

export interface StoryboardSegmentRow {
  serial: string;
  description: string;
  duration: number;
  scale: string;
  cameraMovement: string;
  dialogue: string;
  sound: string;
}

interface StoryboardSegment {
  sceneTitle: string;
  segmentTitle: string;
  durationLabel: string;
  rows: StoryboardSegmentRow[];
}

function parseDuration(value: unknown): number {
  const match = String(value ?? "").match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : 0;
}

function stripStoryboardFieldLabel(value: unknown, label: string) {
  return String(value ?? "")
    .trim()
    .replace(new RegExp(`^${label}[：:]\\s*`), "")
    .trim();
}

function summarizeSegmentField(rows: StoryboardSegmentRow[], field: "dialogue" | "sound") {
  return rows
    .filter((row) => {
      const value = String(row[field] || "").trim();
      return value && !/^(?:无|暂无|无台词|无音效|—|-)$/.test(value);
    })
    .map((row) => `镜头 ${row.serial}：${row[field]}`)
    .join("\n");
}

function parseStoryboardTable(markdown: string): StoryboardSegment[] {
  const segments: StoryboardSegment[] = [];
  let sceneTitle = "";
  let current: StoryboardSegment | null = null;
  const finish = () => {
    if (current?.rows.length) segments.push(current);
    current = null;
  };

  for (const raw of String(markdown || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("## ")) {
      finish();
      sceneTitle = line.slice(3).trim();
      continue;
    }
    const match = line.match(/^###\s*(片段[^\s（(]+)(?:[（(]([^）)]+)[）)])?/);
    if (match) {
      finish();
      current = {
        sceneTitle,
        segmentTitle: match[1],
        durationLabel: match[2] || "",
        rows: [],
      };
      continue;
    }
    if (
      !current ||
      !line.startsWith("|") ||
      line.includes("---") ||
      line.includes("序号")
    )
      continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length < 7) continue;
    current.rows.push({
      serial: cells[0],
      description: cells[1],
      duration: parseDuration(cells[2]),
      scale: cells[3],
      cameraMovement: cells[4],
      dialogue: stripStoryboardFieldLabel(cells[5], "台词"),
      sound: stripStoryboardFieldLabel(cells[6], "音效"),
    });
  }
  finish();
  return segments;
}

function fileUrl(filePath?: string | null): string {
  if (!filePath) return "";
  if (/^https?:\/\//i.test(filePath)) return filePath;
  return `/oss/${String(filePath)
    .replace(/^[/\\]+/, "")
    .replace(/\\/g, "/")}`;
}

function parseMode(value: unknown): string | string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string") return "";
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : String(parsed ?? "");
  } catch {
    return value;
  }
}

function modeCapability(token: string) {
  const [type, countText] = token.split(":");
  const count = Number(countText);
  return {
    type,
    count: Number.isFinite(count) && count > 0 ? count : undefined,
  };
}

function resolveModelMode(
  projectMode: string | string[],
  modelModes: unknown,
): string | string[] {
  if (!Array.isArray(modelModes) || !modelModes.length) return projectMode;
  const candidates = modelModes.map((item) =>
    Array.isArray(item) ? item.map(String) : String(item),
  );
  if (Array.isArray(projectMode)) {
    const configuredTypes = new Set(
      projectMode.map((item) => modeCapability(item).type),
    );
    const matching = candidates.find(
      (candidate) =>
        Array.isArray(candidate) &&
        candidate.some((item) =>
          configuredTypes.has(modeCapability(item).type),
        ),
    );
    return matching || projectMode;
  }
  return (
    candidates.find((candidate) => candidate === projectMode) ||
    candidates[0] ||
    projectMode
  );
}

function buildPrompt(videoDescription: string, assets: AnyObject[]) {
  const references = assets
    .filter((asset) => asset.src)
    .map(
      (asset, index) =>
        `@图片${index + 1}：${asset.name}（${asset.type === "role" ? "角色" : asset.type === "scene" ? "场景" : "道具"}参考图）`,
    )
    .join("\n");
  return `${references ? `[参考图]\n${references}\n\n` : ""}[视频内容]\n${videoDescription}`.trim();
}

async function ensureTracks(
  projectId: number,
  scriptId: number,
  storyboardList: AnyObject[],
) {
  const existingTracks = await u
    .db("o_videoTrack")
    .where({ projectId, scriptId });
  const existingIds = new Set(existingTracks.map((track) => Number(track.id)));
  let nextId = Math.max(Date.now(), ...existingIds, 0);

  for (const storyboard of storyboardList) {
    let trackId = Number(storyboard.trackId);
    if (!trackId || !existingIds.has(trackId)) {
      do nextId += 1;
      while (existingIds.has(nextId));
      trackId = nextId;
      await u.db("o_videoTrack").insert({
        id: trackId,
        projectId,
        scriptId,
        state: "未生成",
        prompt: "",
        duration: parseDuration(storyboard.duration),
      });
      await u
        .db("o_storyboard")
        .where({ id: storyboard.id })
        .update({ trackId });
      storyboard.trackId = trackId;
      existingIds.add(trackId);
    }
  }
  return u.db("o_videoTrack").where({ projectId, scriptId });
}

export interface VideoTaskDataOverrides {
  model?: unknown;
  mode?: unknown;
}

export async function buildVideoTaskData(
  projectId: number,
  scriptId: number,
  overrides: VideoTaskDataOverrides = {},
) {
  const project = await u.db("o_project").where("id", projectId).first();
  if (project && !project.videoModel) {
    try {
      await resolveProjectVideoModel(project);
    } catch {
      // 保持工作台可打开；无法唯一匹配时由用户在面板中明确选择。
    }
  }
  const effectiveVideoModel = String(
    overrides.model || project?.videoModel || "",
  ).trim();
  const configuredMode = parseMode(
    overrides.mode === undefined ? project?.mode : overrides.mode,
  );
  const modelReference = parseModelReference(effectiveVideoModel);
  const vendor = modelReference.vendorId
    ? await u
        .db("o_vendorConfig")
        .where({ id: modelReference.vendorId, enable: 1 })
        .first()
    : null;
  const modelDetail = (() => {
    try {
      return (
        JSON.parse(vendor?.models || "[]").find(
          (item: AnyObject) => item.modelName === modelReference.modelName,
        ) || null
      );
    } catch {
      return null;
    }
  })();
  const mode = resolveModelMode(configuredMode, modelDetail?.mode);
  const videoPromptProfile = resolveVideoModelPromptProfile({
    modelName: modelReference.modelName,
    displayName: modelDetail?.name,
    mode,
    durationResolutionMap: modelDetail?.durationResolutionMap,
    audio: modelDetail?.audio,
  });
  const referenceToken = videoPromptProfile.referenceToken;
  const visualStyleManual = project?.artStyle
    ? u.getArtPromptFile(project.artStyle, "art_skills", "art_storyboard_video")
    : "";

  const flow = await buildProductionFlowData(projectId, scriptId);
  const segments = parseStoryboardTable(flow.storyboardTable || "");
  const storyboardList = await u
    .db("o_storyboard")
    .where({ projectId, scriptId })
    .orderBy("index", "asc");
  const trackData = await ensureTracks(projectId, scriptId, storyboardList);
  const trackMap = new Map(trackData.map((track) => [Number(track.id), track]));
  const storyboardIds = storyboardList
    .map((storyboard) => Number(storyboard.id))
    .filter(Boolean);
  const relations = storyboardIds.length
    ? await u
        .db("o_assets2Storyboard")
        .leftJoin("o_assets", "o_assets2Storyboard.assetId", "o_assets.id")
        .leftJoin("o_image", "o_assets.imageId", "o_image.id")
        .whereIn("o_assets2Storyboard.storyboardId", storyboardIds)
        .orderBy("o_assets2Storyboard.storyboardId", "asc")
        .orderBy("o_assets2Storyboard.sort", "asc")
        .orderBy("o_assets2Storyboard.assetId", "asc")
        .select(
          "o_assets2Storyboard.storyboardId",
          "o_assets.id",
          "o_assets.name",
          "o_assets.type",
          "o_assets.describe",
          "o_assets.prompt",
          "o_image.filePath",
          "o_image.state",
          "o_image.errorReason",
        )
    : [];
  const relationMap = new Map<number, AnyObject[]>();
  for (const row of relations) {
    const storyboardId = Number(row.storyboardId);
    const list = relationMap.get(storyboardId) || [];
    if (!list.some((item) => Number(item.id) === Number(row.id))) {
      list.push({
        id: Number(row.id),
        name: row.name || `资产 ${row.id}`,
        type: row.type || "asset",
        describe: row.describe || "",
        prompt: row.prompt || "",
        fileType: "image",
        sources: "assets",
        src: fileUrl(row.filePath),
        state: row.state || (row.filePath ? "已完成" : "未生成"),
        errorReason: row.errorReason || "",
      });
    }
    relationMap.set(storyboardId, list);
  }

  const videoRows = trackData.length
    ? await u.db("o_video").whereIn(
        "videoTrackId",
        trackData.map((track) => Number(track.id)),
      )
    : [];

  const declaredCapabilities: ReturnType<typeof modeCapability>[] = Array.isArray(modelDetail?.mode)
    ? modelDetail.mode.flatMap((candidate: unknown) => (Array.isArray(candidate) ? candidate.map((item) => modeCapability(String(item))) : []))
    : [];
  const capabilities = Array.isArray(mode)
    ? mode.map(modeCapability)
    : mode === "multiImage"
      ? declaredCapabilities
      : [];
  const imageLimit = capabilities.find(
    (item) => item.type === "imageReference",
  )?.count;
  const referenceMode = mode === "multiImage" || capabilities.some((item) => item.type === "imageReference");

  const tasks = storyboardList.map((storyboard, index) => {
    const segment = segments[index];
    const assets = relationMap.get(Number(storyboard.id)) || [];
    const storyboardMedia = {
      id: Number(storyboard.id),
      name: `分镜图 ${index + 1}`,
      type: "storyboard",
      fileType: "image",
      sources: "storyboard",
      src: fileUrl(storyboard.filePath),
      prompt: storyboard.prompt || "",
      state: storyboard.state || "未生成",
    };
    const excludesStoryboard =
      referenceMode ||
      /不使用(?:本分镜已生成的)?故事板图|不使用分镜图/.test(
        String(storyboard.videoDesc || ""),
      );
    let selectedMedias: AnyObject[] = [];
    if (referenceMode) {
      selectedMedias = assets.filter((asset) => asset.src);
      if (imageLimit) selectedMedias = selectedMedias.slice(0, imageLimit);
    } else if (mode !== "text") {
      selectedMedias = storyboardMedia.src
        ? [storyboardMedia]
        : assets.filter((asset) => asset.src).slice(0, 1);
    }

    const segmentDuration =
      segment?.rows.reduce((sum, row) => sum + row.duration, 0) ||
      parseDuration(storyboard.duration);
    const track = trackMap.get(Number(storyboard.trackId));
    const videoDescription = String(
      storyboard.videoDesc ||
        segment?.rows.map((row) => row.description).join("\n") ||
        "",
    ).trim();
    const stalePrompt =
      excludesStoryboard &&
      /分镜图|storyboard/i.test(String(track?.prompt || ""));
    const generatedPrompt = String(track?.prompt || "").trim();
    const prompt =
      generatedPrompt && !stalePrompt
        ? generatedPrompt
        : buildPrompt(
            videoDescription,
            selectedMedias.filter((item) => item.sources === "assets"),
          );
    const missingAssetNames = assets
      .filter((asset) => !asset.src)
      .map((asset) => asset.name);
    const videos = videoRows
      .filter(
        (video) => Number(video.videoTrackId) === Number(storyboard.trackId),
      )
      .map((video) => ({
        ...video,
        src: fileUrl(video.filePath),
        state: video.state === "生成成功" ? "已完成" : video.state || "未生成",
      }));
    const promptAudit = collectVideoPromptContractViolations(
      {
        segmentTitle: segment?.segmentTitle || `片段 ${index + 1}`,
        duration: segmentDuration,
        dialogue: summarizeSegmentField(segment?.rows || [], "dialogue"),
        segmentRows: segment?.rows || [],
      },
      prompt,
      {
        artStyle: project?.artStyle || "",
        videoRatio: project?.videoRatio || "16:9",
        referenceToken,
        visualStyleManual,
      },
    );

    return {
      id: Number(storyboard.trackId),
      storyboardId: Number(storyboard.id),
      index,
      shotNumber: index + 1,
      title: segment
        ? `${segment.sceneTitle} / ${segment.segmentTitle}`
        : `片段 ${index + 1}`,
      sceneTitle: segment?.sceneTitle || "",
      segmentTitle: segment?.segmentTitle || `片段 ${index + 1}`,
      segmentRows: segment?.rows || [],
      dialogue: summarizeSegmentField(segment?.rows || [], "dialogue"),
      sound: summarizeSegmentField(segment?.rows || [], "sound"),
      summary:
        segment?.rows.map((row) => row.description).join("\n") ||
        videoDescription,
      duration: segmentDuration,
      imagePrompt: storyboard.prompt || "",
      videoDesc: videoDescription,
      prompt,
      promptTemplateId: Number(track?.promptTemplateId) || null,
      promptTemplateVersion: track?.promptTemplateVersion || null,
      promptInferenceSnapshot: track?.promptInferenceSnapshot || null,
      promptAudit,
      promptSource:
        generatedPrompt && !stalePrompt ? "videoTrack" : "storyboard.videoDesc",
      state: track?.state || "未生成",
      reason: track?.reason || "",
      selectVideoId: Number(track?.videoId || track?.selectVideoId) || null,
      medias: selectedMedias,
      availableMedias: [
        ...assets,
        ...(storyboardMedia.src ? [storyboardMedia] : []),
      ],
      referenceAssets: assets,
      storyboard: storyboardMedia,
      excludesStoryboard,
      videoList: videos,
      readiness: {
        ready:
          Boolean(prompt) &&
          (mode === "text" || (selectedMedias.some((item) => item.src) && (!referenceMode || missingAssetNames.length === 0))),
        hasPrompt: Boolean(prompt),
        referenceCount: selectedMedias.filter((item) => item.src).length,
        referenceLimit: imageLimit || null,
        missingAssetNames,
        messages: [
          ...(!prompt ? ["缺少视频提示词"] : []),
          ...(mode !== "text" && !selectedMedias.some((item) => item.src)
            ? ["缺少可用参考图"]
            : []),
          ...(missingAssetNames.length
            ? [`${missingAssetNames.join("、")}尚无可用图片`]
            : []),
          ...(stalePrompt
            ? ["已忽略仍引用故事板图的旧视频提示词，并按当前片段重新装配"]
            : []),
        ],
      },
    };
  });

  return {
    projectConfig: {
      projectId,
      scriptId,
      videoModel: effectiveVideoModel,
      modelName: modelDetail?.modelName || modelReference.modelName || "",
      modelDisplayName: modelDetail?.name || "",
      referenceToken,
      mode: Array.isArray(mode) ? JSON.stringify(mode) : mode,
      modeCapabilities: capabilities,
      videoRatio: project?.videoRatio || "16:9",
      artStyle: project?.artStyle || "",
      directorManual: project?.directorManual || "",
      visualStyleManual,
      videoPromptProfile,
      durationResolutionMap: modelDetail?.durationResolutionMap || [],
      audio: modelDetail?.audio ?? false,
    },
    storyboardList: tasks.map((task) => ({
      ...storyboardList[task.index],
      src: task.storyboard.src,
      segmentTitle: task.segmentTitle,
      sceneTitle: task.sceneTitle,
    })),
    trackList: tasks,
  };
}
