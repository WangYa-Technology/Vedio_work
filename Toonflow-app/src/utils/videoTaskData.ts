import u from "@/utils";
import { buildProductionFlowData } from "@/utils/productionFlow";
import { resolveProjectVideoModel } from "@/services/videoGeneration";
import { parseModelReference } from "@/utils/modelRef";
import { resolveVideoModelPromptProfile } from "@/utils/videoModelPromptProfile";

type AnyObject = Record<string, any>;

const MAX_EPISODE_SCRIPT_CONTEXT_CHARS = 4_000;
const MAX_SOURCE_CHAPTER_CONTEXT_CHARS = 6_000;

export interface StoryboardSegmentRow {
  serial: string;
  description: string;
  duration: number;
  scale: string;
  scaleDescription: string;
  cameraAngle: string;
  cameraMovement: string;
  location: string;
  dayPart: string;
  interiorExterior: string;
  spatialLayers: string;
  dialogue: string;
  sound: string;
}

export interface StoryboardSegment {
  sceneTitle: string;
  segmentTitle: string;
  durationLabel: string;
  location: string;
  dayPart: string;
  interiorExterior: string;
  spatialLayers: string;
  rows: StoryboardSegmentRow[];
}

function normalizedSceneTitle(value: unknown) {
  return String(value || "")
    .split(/\s*｜\s*参演角色/)[0]
    .replace(/\s+/g, "")
    .trim();
}

function storyboardSegmentKey(value: unknown) {
  const match = String(value || "").match(
    /^\s*([^｜\n]+?)\s*｜(?:\s*参演角色[^｜\n]*\s*｜)?\s*(片段[^｜\n]+?)\s*｜\s*序号/u,
  );
  if (!match) return "";
  return `${normalizedSceneTitle(match[1])}::${match[2].replace(/\s+/g, "")}`;
}

function segmentKey(segment: StoryboardSegment) {
  return `${normalizedSceneTitle(segment.sceneTitle)}::${segment.segmentTitle.replace(/\s+/g, "")}`;
}

export function groupStoryboardRowsBySegments(
  storyboardList: AnyObject[],
  segments: StoryboardSegment[],
) {
  if (!segments.length) {
    return storyboardList.map((storyboard) => ({
      segment: undefined,
      storyboards: [storyboard],
    }));
  }

  const rowsByKey = new Map<string, AnyObject[]>();
  const unmatched: AnyObject[] = [];
  for (const storyboard of storyboardList) {
    const key = storyboardSegmentKey(storyboard.videoDesc);
    if (!key) {
      unmatched.push(storyboard);
      continue;
    }
    const rows = rowsByKey.get(key) || [];
    rows.push(storyboard);
    rowsByKey.set(key, rows);
  }

  // Formal storyboard rows can be restored from older data where videoDesc no
  // longer contains the scene/segment marker. The persisted storyboard index
  // still follows the formal storyboard-table segment order, so use it as the
  // binding key instead of collapsing every row into an unassigned scene.
  for (const storyboard of unmatched) {
    const index = Number(storyboard.index);
    if (!Number.isInteger(index) || index < 0 || index >= segments.length) continue;
    const key = segmentKey(segments[index]);
    const rows = rowsByKey.get(key) || [];
    rows.push(storyboard);
    rowsByKey.set(key, rows);
  }

  const groups = segments.map((segment) => {
    const storyboards = rowsByKey.get(segmentKey(segment)) || [];
    return { segment, storyboards };
  });

  // When a formal storyboard table exists, it is the source of truth. Do not
  // surface orphan rows as a fake "未标注场次" group in the workbench.
  return groups.filter((group) => group.storyboards.length);
}

function parseDuration(value: unknown): number {
  const match = String(value ?? "").match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : 0;
}

function narrativeTrigrams(value: unknown) {
  const chars = Array.from(
    String(value || "")
      .replace(/[#*_`>|\-—–\s，。！？；：“”‘’、,.!?;:'"()[\]{}]/g, "")
      .trim(),
  );
  const grams = new Set<string>();
  for (let index = 0; index <= chars.length - 3; index += 1) {
    grams.add(chars.slice(index, index + 3).join(""));
  }
  return grams;
}

function narrativeOverlapScore(source: unknown, targetGrams: Set<string>) {
  if (!targetGrams.size) return 0;
  let score = 0;
  for (const gram of narrativeTrigrams(source)) {
    if (targetGrams.has(gram)) score += 1;
  }
  return score;
}

export function selectNarrativeContext(
  episodeScript: unknown,
  chapterRows: AnyObject[],
) {
  const script = String(episodeScript || "").trim();
  const scriptGrams = narrativeTrigrams(script);
  const ranked = chapterRows
    .map((row) => ({
      row,
      score: narrativeOverlapScore(row.chapterData, scriptGrams),
    }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        Number(left.row.chapterIndex || 0) - Number(right.row.chapterIndex || 0),
    );
  const candidates = ranked.some((item) => item.score > 0)
    ? ranked.filter((item) => item.score > 0).slice(0, 2)
    : ranked.slice(0, 1);

  let remaining = MAX_SOURCE_CHAPTER_CONTEXT_CHARS;
  const sourceChapters = candidates
    .sort(
      (left, right) =>
        Number(left.row.chapterIndex || 0) - Number(right.row.chapterIndex || 0),
    )
    .map(({ row }) => {
      const content = String(row.chapterData || "").trim().slice(0, remaining);
      remaining -= content.length;
      return {
        id: Number(row.id),
        chapterIndex: Number(row.chapterIndex) || null,
        title:
          String(row.chapter || "").trim() ||
          (row.chapterIndex ? `第${row.chapterIndex}章` : "未命名章节"),
        content,
      };
    })
    .filter((item) => item.content);

  return {
    episodeScript: script.slice(0, MAX_EPISODE_SCRIPT_CONTEXT_CHARS),
    sourceChapters,
  };
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

function parseScriptSceneMeta(script: string) {
  return String(script || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => line.match(/^\d+-\d+\s+(.+?)\s+(日|夜|清晨|黄昏)\s*\/\s*(内|外|内外|半室外)\s*$/))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => ({
      location: match[1].trim(),
      dayPart: match[2].trim(),
      interiorExterior: `${match[3].trim()}景`,
      spatialLayers: "",
    }));
}

function describeShotScale(scale: string) {
  const descriptions: Record<string, string> = {
    大全景: "环境占绝大部分，人物为小比例视觉锚点，用于建立整体地理范围与运动方向。",
    远景: "人物全身及大范围环境同时可见，用于交代主体与落点、对手或地标的距离关系。",
    全景: "完整人物与周边行动空间同时入画，用于看清站位、朝向和完整动作。",
    中远景: "人物膝部以上入画并保留前后景，用于兼顾动作幅度与多人空间关系。",
    中景: "人物腰部以上为主，保留手势和互动对象，用于承载对话与动作反应。",
    中近景: "人物胸部以上占主要画面，用于强化视线、表情与局部肢体变化。",
    近景: "人物肩部以上或关键局部占画面约一半，用于突出明确的状态变化。",
    特写: "面部或关键物件主导画面，背景弱化，用于锁定单一情绪或剧情信息。",
    大特写: "眼睛、手指或道具细节充满画面，用于强调不可替代的微小变化。",
  };
  return descriptions[scale] || "主体比例、前后景关系与叙事功能需和本镜画面内容保持一致。";
}

function inferSpatialLayers(location: string, sceneTitle: string) {
  const context = `${location} ${sceneTitle}`;
  if (/高空/.test(context) && /湖/.test(context)) return "高空→湖面";
  if (/湖岸/.test(context)) return "湖岸→湖面→湖心";
  return "";
}

function splitLegacyCamera(value: string) {
  const angle = value.match(/^(极高俯拍|微俯拍|俯拍|微仰拍|仰拍|低机位|平视)(?:后)?/)?.[1] || "";
  return {
    cameraAngle: angle,
    cameraMovement: angle ? value.replace(new RegExp(`^${angle}(?:后)?`), "").trim() || "固定" : value,
  };
}

export function parseStoryboardTable(markdown: string, script = ""): StoryboardSegment[] {
  const segments: StoryboardSegment[] = [];
  const scriptSceneMeta = parseScriptSceneMeta(script);
  let sceneTitle = "";
  let sceneMeta = { location: "", dayPart: "", interiorExterior: "", spatialLayers: "" };
  let sceneIndex = -1;
  let current: StoryboardSegment | null = null;
  let tableColumns: string[] = [];
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
      sceneIndex += 1;
      sceneMeta = scriptSceneMeta[sceneIndex] || { location: "", dayPart: "", interiorExterior: "", spatialLayers: "" };
      sceneMeta = {
        ...sceneMeta,
        spatialLayers: sceneMeta.spatialLayers || inferSpatialLayers(sceneMeta.location, sceneTitle),
      };
      continue;
    }
    if (line.startsWith("**空间信息**")) {
      const values = line
        .replace(/^\*\*空间信息\*\*[：:]\s*/, "")
        .split(/[；;]/)
        .map((item) => item.trim())
        .filter(Boolean)
        .reduce<Record<string, string>>((result, item) => {
          const match = item.match(/^([^：:]+)[：:]\s*(.*)$/);
          if (match) result[match[1].trim()] = match[2].trim();
          return result;
        }, {});
      sceneMeta = {
        location: values["地点"] || "",
        dayPart: values["时段"] || "",
        interiorExterior: values["内外"] || "",
        spatialLayers: values["空间层级"] || "",
      };
      continue;
    }
    const match = line.match(/^###\s*(片段[^\s（(]+)(?:[（(]([^）)]+)[）)])?/);
    if (match) {
      finish();
      current = {
        sceneTitle,
        segmentTitle: match[1],
        durationLabel: match[2] || "",
        ...sceneMeta,
        rows: [],
      };
      tableColumns = [];
      continue;
    }
    if (!current || !line.startsWith("|") || line.includes("---")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.includes("序号")) {
      tableColumns = cells;
      continue;
    }
    if (cells.length < 7) continue;
    const value = (name: string, fallbackIndex: number) => {
      const index = tableColumns.indexOf(name);
      return cells[index >= 0 ? index : fallbackIndex] || "";
    };
    const expanded = tableColumns.includes("景别说明");
    const legacyCamera = splitLegacyCamera(value("运镜", expanded ? 6 : 4));
    current.rows.push({
      serial: value("序号", 0),
      description: value("画面描述", 1),
      duration: parseDuration(value("时长", 2)),
      scale: value("景别", 3),
      scaleDescription: value("景别说明", -1) || describeShotScale(value("景别", 3)),
      cameraAngle: value("摄影角度", -1) || legacyCamera.cameraAngle,
      cameraMovement: value("摄影角度", -1) ? value("运镜", expanded ? 6 : 4) : legacyCamera.cameraMovement,
      location: current.location,
      dayPart: current.dayPart,
      interiorExterior: current.interiorExterior,
      spatialLayers: current.spatialLayers,
      dialogue: stripStoryboardFieldLabel(value("台词", expanded ? 7 : 5), "台词"),
      sound: stripStoryboardFieldLabel(value("音效", expanded ? 8 : 6), "音效"),
    });
  }
  finish();
  return segments;
}

async function fileUrl(filePath?: string | null): Promise<string> {
  if (!filePath) return "";
  if (/^https?:\/\//i.test(filePath)) return filePath;
  const normalizedPath = String(filePath)
    .replace(/^[/\\]+/, "")
    .replace(/\\/g, "/");
  if (!(await u.oss.fileExists(normalizedPath))) return "";
  return u.oss.getFileUrl(normalizedPath);
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
  const chapterRows = await u
    .db("o_novel")
    .where({ projectId })
    .orderBy("chapterIndex", "asc")
    .select("id", "chapterIndex", "chapter", "chapterData");
  const narrativeContext = selectNarrativeContext(flow.script, chapterRows);
  const segments = parseStoryboardTable(flow.storyboardTable || "", flow.script || "");
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
  const roleRelationIds = [...new Set(relations.filter((row) => row.type === "role").map((row) => Number(row.id)))].filter(Number.isFinite);
  const uniqueRoleRelationIds = [...new Set(roleRelationIds)];
  const voiceMap = new Map<number, AnyObject>();
  if (uniqueRoleRelationIds.length) {
    const voiceRows = await u
      .db("o_assetsRole2Audio")
      .join("o_assets as audioAsset", "o_assetsRole2Audio.assetsAudioId", "audioAsset.id")
      .leftJoin("o_image as audioImage", "audioAsset.imageId", "audioImage.id")
      .whereIn("o_assetsRole2Audio.assetsRoleId", uniqueRoleRelationIds)
      .andWhere("audioAsset.projectId", projectId)
      .andWhere("audioAsset.type", "clip")
      .select(
        "o_assetsRole2Audio.assetsRoleId",
        "audioAsset.id as assetId",
        "audioAsset.name",
        "audioImage.id as imageId",
        "audioImage.filePath",
        "audioImage.state",
      );
    await Promise.all(
      voiceRows.map(async (voice) => {
        const src = voice.filePath ? await u.oss.getFileUrl(voice.filePath) : "";
        if (!src) return;
        voiceMap.set(Number(voice.assetsRoleId), {
          id: Number(voice.assetId),
          assetId: Number(voice.assetId),
          imageId: Number(voice.imageId),
          name: voice.name || "声音参考",
          type: "audio",
          fileType: "audio",
          sources: "assets",
          src,
          state: voice.state || "已完成",
        });
      }),
    );
  }
  const relationMap = new Map<number, AnyObject[]>();
  for (const row of relations) {
    const storyboardId = Number(row.storyboardId);
    const list = relationMap.get(storyboardId) || [];
    const src = await fileUrl(row.filePath);
    if (!list.some((item) => Number(item.id) === Number(row.id))) {
      const voiceReference = row.type === "role" ? voiceMap.get(Number(row.id)) || null : null;
      list.push({
        id: Number(row.id),
        name: row.name || `资产 ${row.id}`,
        type: row.type || "asset",
        describe: row.describe || "",
        prompt: row.prompt || "",
        fileType: "image",
        sources: "assets",
        src,
        state: src ? row.state || "已完成" : "未生成",
        errorReason: row.errorReason || "",
        voiceReference,
        voicePath: voiceReference?.src || "",
        voiceAssetId: voiceReference?.assetId || null,
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

  const storyboardGroups = groupStoryboardRowsBySegments(storyboardList, segments);
  const tasks = await Promise.all(storyboardGroups.map(async ({ storyboards, segment }, index) => {
    const storyboard = storyboards[0];
    const assets = storyboards
      .flatMap((item) => relationMap.get(Number(item.id)) || [])
      .filter(
        (asset, assetIndex, list) =>
          list.findIndex((candidate) => Number(candidate.id) === Number(asset.id)) ===
          assetIndex,
      );
    const storyboardWithImage =
      storyboards.find((item) => item.filePath) || storyboard;
    const storyboardMedia = {
      id: Number(storyboardWithImage.id),
      name: `分镜图 ${index + 1}`,
      type: "storyboard",
      fileType: "image",
      sources: "storyboard",
      src: await fileUrl(storyboardWithImage.filePath),
      prompt: storyboardWithImage.prompt || "",
      state: storyboardWithImage.state || "未生成",
    };
    const excludesStoryboard =
      referenceMode ||
      /不使用(?:本分镜已生成的)?故事板图|不使用分镜图/.test(
        storyboards.map((item) => String(item.videoDesc || "")).join("\n"),
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
    const groupTracks = storyboards
      .map((item) => trackMap.get(Number(item.trackId)))
      .filter(Boolean);
    const promptMatchesSegment = (candidate: AnyObject | undefined) => {
      const raw = String(candidate?.promptInferenceSnapshot || "").trim();
      if (!raw || !segment) return true;
      try {
        const snapshot = JSON.parse(raw);
        return (
          normalizedSceneTitle(snapshot?.track?.sceneTitle) ===
            normalizedSceneTitle(segment.sceneTitle) &&
          String(snapshot?.track?.segmentTitle || "").replace(/\s+/g, "") ===
            segment.segmentTitle.replace(/\s+/g, "")
        );
      } catch {
        return true;
      }
    };
    const track =
      groupTracks.find(
        (candidate) =>
          String(candidate?.prompt || "").trim() && promptMatchesSegment(candidate),
      ) || groupTracks[0];
    const structuredDescription = segment?.rows
      .map((row) => row.description)
      .filter(Boolean)
      .join("\n");
    const videoDescription = String(
      structuredDescription || storyboards.map((item) => item.videoDesc).filter(Boolean).join("\n") || "",
    ).trim();
    const mismatchedPrompt = Boolean(track?.prompt) && !promptMatchesSegment(track);
    const stalePrompt =
      mismatchedPrompt ||
      (excludesStoryboard &&
        /分镜图|storyboard/i.test(String(track?.prompt || "")));
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
    const videos = await Promise.all(videoRows
      .filter(
        (video) =>
          storyboards.some(
            (item) => Number(video.videoTrackId) === Number(item.trackId),
          ),
      )
      .map(async (video) => ({
        ...video,
        src: await fileUrl(video.filePath),
        state: video.state === "生成成功" ? "已完成" : video.state || "未生成",
      })));
    return {
      id: Number(storyboard.trackId),
      storyboardId: Number(storyboard.id),
      storyboardIds: storyboards.map((item) => Number(item.id)),
      index,
      isEpisodeOpening: index === 0,
      shotNumber: index + 1,
      title: segment
        ? `${segment.sceneTitle} / ${segment.segmentTitle}`
        : `片段 ${index + 1}`,
      sceneTitle: segment?.sceneTitle || "",
      segmentTitle: segment?.segmentTitle || `片段 ${index + 1}`,
      location: segment?.location || "",
      dayPart: segment?.dayPart || "",
      interiorExterior: segment?.interiorExterior || "",
      spatialLayers: segment?.spatialLayers || "",
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
            ? [
                mismatchedPrompt
                  ? "已忽略与当前场次片段不匹配的旧视频提示词，并按正确镜头和资产重新装配"
                  : "已忽略仍引用故事板图的旧视频提示词，并按当前片段重新装配",
              ]
            : []),
        ],
      },
    };
  }));

  return {
    narrativeContext,
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
