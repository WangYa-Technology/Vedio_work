import type { VideoPromptContractTask } from "@/utils/videoPromptContract";
import type { VideoModelPromptProfile } from "@/utils/videoModelPromptProfile";

interface MigrationContext {
  profile?: VideoModelPromptProfile | null;
  referenceToken?: string;
  references?: Array<{ name?: unknown; type?: unknown }>;
  task?: VideoPromptContractTask;
}

const FACE_CLARITY_ANCHOR = /(?:面部|脸部|人脸)[^。；\n]{0,36}(?:清晰|锐利|对焦|五官可辨|细节可辨)|五官[^。；\n]{0,24}(?:清晰|可辨|锐利)|(?:face|facial (?:features|details?))[^.\n]{0,42}(?:clear|sharp|readable|in focus|well-defined)/i;
const VISUAL_TEXT_NA = "画面文字：N/A，标题：N/A，对话气泡：N/A。";
const FACE_CLARITY_REQUIREMENT = "中景和中远景中的主要人物面部保持锐利对焦，眼睛、鼻子、嘴部与轮廓清晰可辨，不被景深、焦点漂移或运动模糊覆盖。";

/** Strip internal lip-sync controls before a prompt reaches the video model. */
export function removeNarrationLipSyncInstructions(value: string) {
  return String(value || "")
    .replace(
      /\s*while\s+the\s+on-screen\s+character(?:'s)?\s+lips?\s+remain\s+(?:completely\s+)?closed\.?/gi,
      "",
    )
    .replace(/[；;，,]?\s*角色闭嘴/g, "")
    .replace(/[；;，,]?\s*角色嘴部紧闭不动(?:（或角色不在画面中）)?/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function hasMediumOrMediumLongCharacterShot(
  task: VideoPromptContractTask | undefined,
  prompt: string,
) {
  return (task?.segmentRows || []).some((row) =>
    /中景|中远景|medium(?:[- ]long)? shot/i.test(
      String(row.scale || row.shotScale || ""),
    ),
  ) || /(?:景别[：:]?\s*)?(?:中景|中远景)|medium(?:[- ]long)? shot/i.test(prompt);
}

/** Bring saved prompts created by older templates up to the current output rules. */
export function enforceVideoPromptOutputConstraints(
  value: string,
  task?: VideoPromptContractTask,
) {
  let prompt = removeNarrationLipSyncInstructions(value);

  // This is the final official H3 field, so replacing through EOF cannot remove
  // any subsequent protocol section.
  prompt = prompt.replace(
    /(^\s*non[-_ ]diegetic[_ ]music\s*[：:]\s*)[\s\S]*$/im,
    "$1N/A",
  );
  prompt = prompt.replace(
    /(^\s*(?:背景音乐|背景配乐|非画内配乐|非叙事性音乐|BGM)\s*[：:]\s*)[^\n]*/gim,
    "$1N/A",
  );

  const additions: string[] = [];
  if (!/画面文字\s*[：:]\s*N\/?A/i.test(prompt)) additions.push(VISUAL_TEXT_NA);
  if (
    hasMediumOrMediumLongCharacterShot(task, prompt) &&
    !FACE_CLARITY_ANCHOR.test(prompt)
  ) {
    additions.push(FACE_CLARITY_REQUIREMENT);
  }
  if (!additions.length) return prompt.trim();

  const outputRules = additions.join("\n");
  if (/^\s*overall_soundscape\s*:/im.test(prompt)) {
    return prompt
      .replace(/^\s*overall_soundscape\s*:/im, `${outputRules}\noverall_soundscape:`)
      .trim();
  }
  return `${prompt}\n${outputRules}`.trim();
}

function isH3Profile(profile?: VideoModelPromptProfile | null) {
  return profile?.modelFamily === "minimax-h3";
}

function isH3ReferenceMode(profile?: VideoModelPromptProfile | null) {
  return isH3Profile(profile) &&
    (profile?.modeKind === "multiReference" || profile?.modeKind === "multimodal");
}

function activeReferences(
  references: Array<{ index: number; label: string }>,
  profile?: VideoModelPromptProfile | null,
) {
  if (!profile || profile.modeKind === "text") return [];
  const maxReferences = profile.modeKind === "firstLastFrame"
    ? 2
    : profile.referenceLimit || references.length;
  return references.slice(0, maxReferences);
}

function parseReferenceLines(prompt: string, referenceToken: string) {
  const escaped = referenceToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return Array.from(
    prompt.matchAll(new RegExp(`${escaped}\\s*(\\d+)\\s*[：:]\\s*([^\\n]+)`, "g")),
    (match) => ({ index: Number(match[1]), label: match[2].trim() }),
  );
}

function splitLegacyShots(body: string) {
  const firstTimingIndex = body.search(/\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?\s*(?:秒|s)\s*[：:]/);
  const prelude = firstTimingIndex > 0 ? body.slice(0, firstTimingIndex).trim() : "";
  const timeline = firstTimingIndex > 0 ? body.slice(firstTimingIndex) : body;
  const parts = timeline
    .split(/(?=\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?\s*(?:秒|s)\s*[：:])/g)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length <= 1) return [`[Shot 1] ${body.trim()}`.trim()];
  return parts.map((part, index) => {
    const timing = part.match(/^(\d+(?:\.\d+)?)\s*-\s*\d+(?:\.\d+)?\s*(?:秒|s)\s*[：:]\s*/);
    const content = timing ? part.slice(timing[0].length).trim() : part;
    if (index === 0) return `[Shot 1] ${[prelude, content].filter(Boolean).join(" ")}`.trim();
    const start = Number(timing?.[1] || 0).toFixed(3).padStart(6, "0");
    return `[Shot ${index + 1}] 00:${start} 切至 ${content}`.trim();
  });
}

function migrateLegacyPromptForH3Base(
  rawBody: string,
  references: Array<{ index: number; label: string }>,
  context: MigrationContext,
) {
  const profile = context.profile;
  const pictureReferences = activeReferences(references, profile);
  const hasAudio = profile?.audioPolicy !== "unsupported";
  const alignment = profile?.modeKind === "firstLastFrame" && pictureReferences.length
    ? `参考图与目标视频对齐：${pictureReferences
        .map((reference, index) => `<Picture ${index + 1}> 来自 ${context.referenceToken || "@图"}${reference.index}（${reference.label}），对应目标视频${index === 0 ? " 0.00 秒" : "末帧"}。`)
        .join(" ")}\n\n`
    : "";
  const pictureBindings = pictureReferences.length
    ? `${pictureReferences
        .map((reference, index) => `<Picture ${index + 1}> 是 ${context.referenceToken || "@图"}${reference.index}（${reference.label}）的稳定图像参考。`)
        .join(" ")}\n`
    : "";
  const soundscape = hasAudio
    ? "仅保留时间线中明确描述的环境声和动作拟音。"
    : "N/A";
  return `${alignment}integrated_multimodal_description:\n${pictureBindings}${splitLegacyShots(rawBody).join("\n")}\noverall_soundscape: ${soundscape}\nnon_diegetic_music: N/A`;
}

/** Migrate pre-H3 prompts at generation time without changing the saved source text. */
export function migrateLegacyPromptForH3(prompt: string, context: MigrationContext = {}) {
  if (!isH3Profile(context.profile)) return removeNarrationLipSyncInstructions(prompt);
  if (/^\s*(?:subject_definitions|integrated_multimodal_description)\s*:/im.test(prompt)) {
    return removeNarrationLipSyncInstructions(prompt);
  }
  const referenceToken = context.referenceToken || "@图";
  const mappedReferences = parseReferenceLines(prompt, referenceToken);
  const references = mappedReferences.length
    ? mappedReferences
    : (context.references || []).map((reference, index) => ({
        index: index + 1,
        label: String(reference.name || `reference ${index + 1}`),
      }));
  const contentMarker = prompt.match(/\[(?:视频内容|画面过程描述)\]/i);
  const rawBodyWithTrailingSections = contentMarker
    ? prompt.slice((contentMarker.index || 0) + contentMarker[0].length).trim()
    : prompt.trim();
  const rawBody = rawBodyWithTrailingSections
    .split(/\n\s*\[(?:不想要|整体要求补充)\]\s*/i)[0]
    .trim();
  if (!isH3ReferenceMode(context.profile)) {
    return removeNarrationLipSyncInstructions(
      migrateLegacyPromptForH3Base(rawBody, references, context),
    );
  }
  if (!references.length) return removeNarrationLipSyncInstructions(prompt);
  const selectedReferences = activeReferences(references, context.profile);
  const labels = selectedReferences.map((reference) => `<Subject ${reference.index}>`);
  const shots = splitLegacyShots(rawBody);
  const hasDownwardMotion = (context.task?.segmentRows || []).some((row) =>
    /坠落|坠入|下坠|自由落体|落向|降落|向下落/.test(String(row.description || row.visualAndAction || "")),
  );
  const directionAnchor = hasDownwardMotion
    ? " 人物从画面上方持续向下接近地面或水面，地面或水面在画面中不断放大，摄影机只跟随下降。"
    : "";
  const subjectDefinitions = selectedReferences
    .map((reference) => `<Subject ${reference.index}> 是来自 ${referenceToken}${reference.index} 的稳定参考“${reference.label}”；保持身份、外观、材质和空间职责一致。`)
    .join("\n");
  const retention = selectedReferences
    .map((reference) => `<Subject ${reference.index}>（在对应镜头中出现）：fully_preserved - 保持身份和视觉职责。`)
    .join("\n");
  const detailed = `${labels.join("、")} 与各自参考保持一致；人物突然遭遇原时间线中已经存在的可见阻碍。${directionAnchor}\n${shots.join("\n")}`;
  return removeNarrationLipSyncInstructions(
    `subject_definitions:\n${subjectDefinitions}\nsummary:\n[reference generation] 保持参考主体和原分镜时间线，将旧版提示词适配为 MiniMax H3 Ref2VA 中文提示词。\nretention_analysis:\n${retention}\ndetailed_description:\n${detailed}\noverall_soundscape: 保留时间线中明确描述的环境底床、动作拟音、呼吸、风声、撞击及其他镜内声音。\nnon_diegetic_music: N/A`,
  );
}
