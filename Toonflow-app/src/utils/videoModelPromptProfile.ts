export type VideoPromptModeKind =
  | "text"
  | "multiReference"
  | "firstLastFrame"
  | "multimodal";

export interface VideoModelPromptProfileInput {
  modelName?: unknown;
  displayName?: unknown;
  mode?: unknown;
  durationResolutionMap?: unknown;
  audio?: unknown;
}

export interface VideoModelPromptProfile {
  modelFamily: string;
  modeKind: VideoPromptModeKind;
  referenceToken: "@图" | "@图片";
  referenceLimit: number | null;
  maxDuration: number;
  audioPolicy: "supported" | "optional" | "unsupported";
  requiresStartEnd: boolean;
}

function modeTokens(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(modeTokens);
  const text = String(value ?? "").trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.flatMap(modeTokens) : [String(parsed)];
  } catch {
    return [text];
  }
}

function referenceLimitFromModes(tokens: string[]) {
  const count = tokens
    .map((token) => token.match(/^imageReference:(\d+)$/)?.[1])
    .filter(Boolean)
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0);
  return count.length ? Math.max(...count) : null;
}

function maxDurationFromMap(value: unknown) {
  if (!Array.isArray(value)) return 15;
  const durations = value
    .flatMap((item: any) => (Array.isArray(item?.duration) ? item.duration : [item?.duration]))
    .map(Number)
    .filter((duration) => Number.isFinite(duration) && duration > 0);
  return durations.length ? Math.max(...durations) : 15;
}

export function resolveVideoModelPromptProfile(
  input: VideoModelPromptProfileInput,
): VideoModelPromptProfile {
  const modelName = String(input.modelName || "");
  const displayName = String(input.displayName || "");
  const identity = `${modelName} ${displayName}`.toLowerCase();
  const tokens = modeTokens(input.mode);
  const hasImageReference = tokens.some((token) => token.startsWith("imageReference:"));
  const hasNonImageReference = tokens.some(
    (token) => token.startsWith("videoReference:") || token.startsWith("audioReference:"),
  );
  const requiresStartEnd = tokens.includes("startEndRequired");
  const hasSingleImage = tokens.includes("singleImage") || requiresStartEnd;
  const hasText = tokens.includes("text");
  const modeKind: VideoPromptModeKind = hasNonImageReference
    ? "multimodal"
    : hasImageReference
    ? "multiReference"
    : hasSingleImage
      ? "firstLastFrame"
      : hasText
        ? "text"
        : "multimodal";
  const audioPolicy = input.audio === false
    ? "unsupported"
    : input.audio === true
      ? "supported"
      : "optional";

  return {
    modelFamily: /seedance|即梦/.test(identity)
      ? "seedance"
      : /minimax|h3/.test(identity)
        ? "minimax-h3"
        : "generic",
    modeKind,
    referenceToken: /seedance\s*2|seedance-2|即梦\s*2/.test(identity)
      ? "@图片"
      : "@图",
    referenceLimit: referenceLimitFromModes(tokens),
    maxDuration: maxDurationFromMap(input.durationResolutionMap),
    audioPolicy,
    requiresStartEnd,
  };
}
