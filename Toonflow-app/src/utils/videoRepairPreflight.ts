/**
 * 视频「修复重试」提交前的预检与自动修。
 *
 * 背景：视频生成失败后，用户看到的往往是平台的通用文案，真正的问题可能落在入参上：
 * 例如提示词按 11 张参考图推理、但这次只提交了 4 张（`<Picture 8>` 之类的引用在本次提交里
 * 根本不存在），或者清晰度/时长不在该模型的声明档位内，或者素材文件已经缺失。
 * 这些都能在重试前判定，能自动修的（编号重排、档位夹取、超限截断、缺失剔除）直接修掉，
 * 修不了的（引用了本次未提交的素材）转成 blockers，由界面引导用户重新推提示词。
 *
 * 本模块保持纯函数特性：除可选注入的 `fileExists` 外不碰 DB/网络，便于单测。
 */

import {
  parseVideoModeTokens,
  type VideoModelPromptProfile,
} from "@/utils/videoModelPromptProfile";

export type VideoReferenceSource = "assets" | "storyboard";
export type VideoReferenceFileType = "image" | "video" | "audio";

export interface VideoRepairReference {
  index: number;
  id: number;
  sources: VideoReferenceSource;
  fileType: VideoReferenceFileType;
  filePath: string;
  /** 参考素材名称（资产名 / 分镜图标题），用于与提示词里的 `@图k：名称` 对齐 */
  name?: string;
}

export type VideoRepairBlockerCode =
  | "PICTURE_REFERENCE_MISMATCH"
  | "REFERENCE_MISSING"
  | "PROMPT_EMPTY"
  | "MODEL_UNAVAILABLE";

export interface VideoRepairBlocker {
  code: VideoRepairBlockerCode;
  /** 面向用户的中文说明 */
  message: string;
  /** 需要用户在界面上执行的动作 */
  action?: "regeneratePrompt" | "selectReferences";
}

export interface VideoRepairResult {
  /** 仅 `<Picture n>` 编号可能被重排，其余文字逐字不变 */
  prompt: string;
  references: VideoRepairReference[];
  resolution: string;
  duration: number;
  audio: boolean;
  /** 已自动修复项，可直接展示给用户 */
  fixed: string[];
  blockers: VideoRepairBlocker[];
}

export interface VideoRepairGenerationConfig {
  resolution?: string;
  duration?: number;
  audio?: boolean;
  mode?: string | string[];
}

export interface VideoRepairProjectConfig {
  durationResolutionMap?: unknown;
  videoPromptProfile?: Partial<VideoModelPromptProfile> | null;
  referenceToken?: string;
  audio?: unknown;
}

export interface VideoRepairInput {
  prompt: string;
  references: VideoRepairReference[];
  generationConfig: VideoRepairGenerationConfig;
  projectConfig?: VideoRepairProjectConfig;
  /** 文件存在性校验（重试路径注入 `u.oss.fileExists`）；不传则跳过该检查 */
  fileExists?: (filePath: string) => Promise<boolean>;
}

const DEFAULT_IMAGE_REFERENCE_LIMIT = 9;
const DEFAULT_AUDIO_REFERENCE_LIMIT = 3;
const FALLBACK_DURATION = 5;

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 资产名归一化：忽略空白与括号说明，便于与提示词里的 `@图k：名称` 对齐。 */
export function normalizeReferenceLabel(value: unknown) {
  return String(value ?? "")
    .replace(/[\s　]+/g, "")
    .replace(/[（(][^）)]*[）)]/g, "")
    .trim();
}

function normalizeAssetName(value: unknown) {
  return String(value ?? "")
    .replace(/[\s　]+/g, "")
    .trim()
    .replace(/[\-—－·、,，。.]+$/, "");
}

export interface VideoPictureBinding {
  /** 提示词里 `@图k：名称` 的名称部分 */
  label: string;
  /** 该行同时出现的 `<Picture n>` */
  picture: number;
}

/**
 * 解析提示词中「参考素材名称 ↔ `<Picture n>`」的绑定关系。
 * H3 的 subject_definitions 每行同时出现 `@图k：名称` 与 `referenced from <Picture n>`，
 * 因此可以逐行取出这条绑定，作为重排编号的依据。
 */
export function parseVideoPictureBindings(
  prompt: string,
  referenceToken = "@图",
): VideoPictureBinding[] {
  const token = escapeRegExp(referenceToken || "@图");
  const labelPattern = new RegExp(`${token}\\s*(\\d+)\\s*[：:]\\s*([^,，；;：:()（）\\n]+)`);
  const picturePattern = /<\s*Picture\s+(\d+)\s*>/i;
  const bindings: VideoPictureBinding[] = [];
  for (const line of String(prompt ?? "").split(/\r?\n/)) {
    const labelMatch = line.match(labelPattern);
    const pictureMatch = line.match(picturePattern);
    if (!labelMatch || !pictureMatch) continue;
    const label = normalizeAssetName(labelMatch[2]);
    if (!label) continue;
    bindings.push({ label, picture: Number(pictureMatch[1]) });
  }
  return bindings;
}

interface VideoPictureAlignment {
  prompt: string;
  changes: Array<{ from: number; to: number; labels: string[] }>;
  unmatched: string[];
  conflicts: Array<{ picture: number; labels: string[] }>;
}

/**
 * 按「实际提交的参考素材顺序」重排提示词中的 `<Picture n>`。
 * 只改编号数字，其他字符（台词、时间轴、字段名）逐字保留。
 */
export function alignVideoPromptPictures(
  prompt: string,
  bindings: VideoPictureBinding[],
  references: Array<{ name?: string }>,
): VideoPictureAlignment {
  const source = String(prompt ?? "");
  const indexByLabel = new Map<string, number>();
  references.forEach((reference, position) => {
    const key = normalizeReferenceLabel(reference?.name);
    if (key && !indexByLabel.has(key)) indexByLabel.set(key, position + 1);
  });

  const pictureMap = new Map<number, number>();
  const labelsByPicture = new Map<number, Set<string>>();
  const unmatched: string[] = [];
  const conflicts: Array<{ picture: number; labels: string[] }> = [];

  for (const binding of bindings) {
    const target = indexByLabel.get(normalizeReferenceLabel(binding.label));
    if (!target) {
      unmatched.push(binding.label);
      continue;
    }
    const existing = pictureMap.get(binding.picture);
    if (existing !== undefined && existing !== target) {
      const labels = labelsByPicture.get(binding.picture) || new Set<string>();
      labels.add(binding.label);
      labelsByPicture.set(binding.picture, labels);
      conflicts.push({ picture: binding.picture, labels: [...labels] });
      continue;
    }
    pictureMap.set(binding.picture, target);
    const labels = labelsByPicture.get(binding.picture) || new Set<string>();
    labels.add(binding.label);
    labelsByPicture.set(binding.picture, labels);
  }

  const changes: Array<{ from: number; to: number; labels: string[] }> = [];
  let aligned = source;
  if (pictureMap.size) {
    aligned = aligned.replace(/<\s*Picture\s+(\d+)\s*>/gi, (match, rawNumber: string) => {
      const from = Number(rawNumber);
      const target = pictureMap.get(from);
      if (!target || target === from) return match;
      return `<Picture ${target}>`;
    });
    for (const [from, to] of [...pictureMap.entries()].sort((left, right) => left[0] - right[0])) {
      if (from === to) continue;
      changes.push({ from, to, labels: [...(labelsByPicture.get(from) || [])] });
    }
  }

  return {
    prompt: aligned,
    changes,
    unmatched: [...new Set(unmatched)],
    conflicts,
  };
}

interface DurationResolutionEntry {
  durations: number[];
  resolutions: string[];
}

function normalizeDurationResolutionMap(value: unknown): DurationResolutionEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item: any) => ({
      durations: (Array.isArray(item?.duration) ? item.duration : [item?.duration])
        .map(Number)
        .filter((duration: number) => Number.isFinite(duration) && duration > 0),
      resolutions: (Array.isArray(item?.resolution) ? item.resolution : [item?.resolution])
        .map((resolution: unknown) => String(resolution ?? "").trim())
        .filter(Boolean),
    }))
    .filter((entry) => entry.durations.length || entry.resolutions.length);
}

function parseResolution(value: string) {
  const text = String(value ?? "").trim();
  const match = text.match(/^(\d+(?:\.\d+)?)\s*([pkPK]?)(.*)$/);
  if (!match) return { size: Number.NaN, suffix: text.toLowerCase() };
  return { size: Number(match[1]), suffix: `${match[2]}${match[3]}`.toLowerCase() };
}

/** 从模型声明档位里挑最接近的清晰度：优先同后缀（竖/横/比例），再取尺寸最接近的。 */
export function resolveClosestResolution(current: string, allowed: string[]) {
  const values = allowed.filter(Boolean);
  if (!values.length) return current;
  if (values.includes(current)) return current;
  const currentMeta = parseResolution(current);
  return [...values]
    .map((value) => {
      const meta = parseResolution(value);
      const sameSuffix = meta.suffix === currentMeta.suffix ? 0 : 1;
      const distance =
        Number.isFinite(meta.size) && Number.isFinite(currentMeta.size)
          ? Math.abs(meta.size - currentMeta.size)
          : Number.POSITIVE_INFINITY;
      return { value, sameSuffix, distance };
    })
    .sort(
      (left, right) =>
        left.sameSuffix - right.sameSuffix ||
        left.distance - right.distance ||
        left.value.localeCompare(right.value),
    )[0].value;
}

/** 从模型声明档位里挑最接近的时长：差值相同时取更短的一档（更省资源）。 */
export function resolveClosestDuration(current: number, allowed: number[]) {
  const values = allowed.filter((value) => Number.isFinite(value) && value > 0);
  if (!values.length) return current;
  if (values.includes(current)) return current;
  return values.reduce((best, value) => {
    const bestGap = Math.abs(best - current);
    const gap = Math.abs(value - current);
    if (gap < bestGap) return value;
    if (gap === bestGap && value < best) return value;
    return best;
  }, values[0]);
}

function referenceLimitFromMode(
  mode: unknown,
  type: "imageReference" | "audioReference",
): number | null {
  const counts = parseVideoModeTokens(mode)
    .map((token) => token.match(new RegExp(`^${type}:(\\d+)$`))?.[1])
    .filter(Boolean)
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0);
  return counts.length ? Math.max(...counts) : null;
}

function createModelUnavailableBlocker(message: string): VideoRepairBlocker {
  return { code: "MODEL_UNAVAILABLE", message, action: "regeneratePrompt" };
}

/**
 * 预检一次修复重试：返回可提交的入参与结构化修复报告。
 * blockers 非空时应拦截提交并引导用户处理，而不是继续消耗额度。
 */
export async function preflightVideoSubmission(
  input: VideoRepairInput,
): Promise<VideoRepairResult> {
  const fixed: string[] = [];
  const blockers: VideoRepairBlocker[] = [];
  const profile = input.projectConfig?.videoPromptProfile || null;
  const modeKind = profile?.modeKind;
  const referenceToken = String(
    input.projectConfig?.referenceToken || profile?.referenceToken || "@图",
  );
  const promptText = String(input.prompt ?? "");
  const generationConfig = input.generationConfig || {};

  // 1. 参考素材存在性：本地文件缺失的直接剔除（否则供应商必然报「资源链接失效」）。
  let references: VideoRepairReference[] = (Array.isArray(input.references)
    ? input.references
    : []
  ).filter((reference) => reference && String(reference.filePath || "").trim());
  if (input.fileExists) {
    const kept: VideoRepairReference[] = [];
    for (const reference of references) {
      if (await input.fileExists(reference.filePath)) {
        kept.push(reference);
        continue;
      }
      fixed.push(`已移除参考素材「${reference.name || reference.filePath}」：本地文件不存在`);
    }
    references = kept;
  }

  // 2. 数量上限：按模型声明的 imageReference/audioReference 上限截断多余的参考素材。
  const modeTokens = generationConfig.mode ?? null;
  let imageLimit =
    referenceLimitFromMode(modeTokens, "imageReference") ??
    (modeKind === "firstLastFrame" ? 2 : null) ??
    (typeof profile?.referenceLimit === "number" ? profile.referenceLimit : null) ??
    DEFAULT_IMAGE_REFERENCE_LIMIT;
  if (modeKind === "firstLastFrame") imageLimit = Math.min(imageLimit, 2);
  const audioLimit = referenceLimitFromMode(modeTokens, "audioReference") ?? DEFAULT_AUDIO_REFERENCE_LIMIT;

  const counters = { image: 0, audio: 0 };
  const keptReferences: VideoRepairReference[] = [];
  const droppedImages: VideoRepairReference[] = [];
  const droppedAudios: VideoRepairReference[] = [];
  for (const reference of references) {
    if (reference.fileType === "audio") {
      counters.audio += 1;
      if (counters.audio > audioLimit) {
        droppedAudios.push(reference);
        continue;
      }
    } else if (reference.fileType === "image") {
      counters.image += 1;
      if (counters.image > imageLimit) {
        droppedImages.push(reference);
        continue;
      }
    }
    keptReferences.push(reference);
  }
  references = keptReferences;
  if (droppedImages.length) {
    fixed.push(
      `已按模型上限移除 ${droppedImages.length} 张超出的参考图（最多 ${imageLimit} 张）：${droppedImages
        .map((reference) => reference.name || reference.filePath)
        .join("、")}`,
    );
  }
  if (droppedAudios.length) {
    fixed.push(
      `已按模型上限移除 ${droppedAudios.length} 段超出的参考音频（最多 ${audioLimit} 段）：${droppedAudios
        .map((reference) => reference.name || reference.filePath)
        .join("、")}`,
    );
  }

  // 3. 提示词图片编号对齐：只改 <Picture n> 的数字，其余逐字保留。
  let prompt = promptText;
  if (promptText.trim()) {
    const bindings = parseVideoPictureBindings(promptText, referenceToken);
    if (bindings.length) {
      const alignment = alignVideoPromptPictures(promptText, bindings, references);
      prompt = alignment.prompt;
      if (alignment.changes.length) {
        fixed.push(
          `已校正提示词里的参考图编号：${alignment.changes
            .map(
              (change) =>
                `<Picture ${change.from}> → <Picture ${change.to}>（${change.labels.join("、")}）`,
            )
            .join("；")}`,
        );
      }
      if (alignment.conflicts.length) {
        blockers.push({
          code: "PICTURE_REFERENCE_MISMATCH",
          message: `提示词中同一个 <Picture n> 指向了多个参考素材（${alignment.conflicts
            .map((conflict) => `<Picture ${conflict.picture}>：${conflict.labels.join("、")}`)
            .join("；")}），无法自动校正，请重新推该镜提示词`,
          action: "regeneratePrompt",
        });
      }
      if (alignment.unmatched.length) {
        blockers.push({
          code: "PICTURE_REFERENCE_MISMATCH",
          message: `提示词引用了本次未提交的参考素材：${alignment.unmatched.join(
            "、",
          )}。请重新推该镜提示词，或把对应参考素材补回后再生成`,
          action: "regeneratePrompt",
        });
      }
    }
  } else {
    blockers.push({
      code: "PROMPT_EMPTY",
      message: "这一镜还没有视频提示词，请先推提示词后再生成",
      action: "regeneratePrompt",
    });
  }

  // 4. 参考图是否满足该模式的最低要求。
  const imageReferences = references.filter((reference) => reference.fileType === "image");
  const audioReferences = references.filter((reference) => reference.fileType === "audio");
  if (modeKind === "firstLastFrame" && imageReferences.length < 2) {
    blockers.push({
      code: "REFERENCE_MISSING",
      message: "该模式需要首帧与尾帧两张参考图，当前可用参考图不足，请补齐参考素材后重试",
      action: "selectReferences",
    });
  } else if (modeKind === "multiReference" && !imageReferences.length) {
    blockers.push({
      code: "REFERENCE_MISSING",
      message: "该模式需要至少 1 张参考图，当前没有可用的参考图，请补齐参考素材后重试",
      action: "selectReferences",
    });
  } else if (modeKind === "multimodal" && !imageReferences.length && !audioReferences.length) {
    blockers.push({
      code: "REFERENCE_MISSING",
      message: "该模式需要参考图或参考音频，当前两者都没有可用素材，请补齐参考素材后重试",
      action: "selectReferences",
    });
  }

  // 5. 清晰度/时长/音频按模型声明档位校正（不做降规格，只夹回最近合法档位）。
  const entries = normalizeDurationResolutionMap(input.projectConfig?.durationResolutionMap);
  const allowedResolutions = [...new Set(entries.flatMap((entry) => entry.resolutions))];
  const allowedDurations = [...new Set(entries.flatMap((entry) => entry.durations))];
  const rawResolution = String(generationConfig.resolution || "").trim();
  let resolution = rawResolution;
  if (rawResolution && allowedResolutions.length) {
    const matched = resolveClosestResolution(rawResolution, allowedResolutions);
    if (matched !== rawResolution) {
      resolution = matched;
      fixed.push(`清晰度 ${rawResolution} 不在该模型的可选档位内，已改为最接近的 ${matched}`);
    }
  }
  const requestedDuration = Math.max(
    1,
    Math.round(Number(generationConfig.duration) || 0) || FALLBACK_DURATION,
  );
  let duration = requestedDuration;
  if (allowedDurations.length && !allowedDurations.includes(requestedDuration)) {
    duration = resolveClosestDuration(requestedDuration, allowedDurations);
    fixed.push(`时长 ${requestedDuration}s 不在该模型的可选档位内，已改为最接近的 ${duration}s`);
  }
  let audio = Boolean(generationConfig.audio);
  if (audio && profile?.audioPolicy === "unsupported") {
    audio = false;
    fixed.push("该模型不支持音频生成，已关闭音频");
  }

  return { prompt, references, resolution, duration, audio, fixed, blockers };
}

export const videoRepairPreflightInternals = {
  createModelUnavailableBlocker,
  normalizeDurationResolutionMap,
  referenceLimitFromMode,
};
