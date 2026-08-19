import type { VideoPromptContractTask } from "@/utils/videoPromptContract";
import type { VideoModelPromptProfile } from "@/utils/videoModelPromptProfile";

interface MigrationContext {
  profile?: VideoModelPromptProfile | null;
  referenceToken?: string;
  references?: Array<{ name?: unknown; type?: unknown }>;
  task?: VideoPromptContractTask;
}

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
    return `[Shot ${index + 1}] At 00:${start}, the camera cuts to ${content}`.trim();
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
    ? `How the reference pictures align with the target video — ${pictureReferences
        .map((reference, index) => `<Picture ${index + 1}> from ${context.referenceToken || "@图"}${reference.index} (${reference.label}) aligns with the ${index === 0 ? "0.00" : "final"}-second mark of the target video.`)
        .join(" ")}\n\n`
    : "";
  const pictureBindings = pictureReferences.length
    ? `${pictureReferences
        .map((reference, index) => `<Picture ${index + 1}> is the stable image from ${context.referenceToken || "@图"}${reference.index} (${reference.label}).`)
        .join(" ")}\n`
    : "";
  const soundscape = hasAudio
    ? "Preserve only the physical ambience and action sounds explicitly described in the timeline."
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
  const contentMarker = prompt.match(/\[视频内容\]/i);
  const rawBody = contentMarker
    ? prompt.slice((contentMarker.index || 0) + contentMarker[0].length).trim()
    : prompt.trim();
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
    ? " The subject moves continuously downward from the upper part of the frame toward the ground or water surface; the ground or water surface grows larger, and the camera only follows the descent."
    : "";
  const subjectDefinitions = selectedReferences
    .map((reference) => `<Subject ${reference.index}> is the stable ${reference.label} reference from ${referenceToken}${reference.index}; preserve its identity, appearance, material, and spatial role.`)
    .join("\n");
  const retention = selectedReferences
    .map((reference) => `<Subject ${reference.index}> (appears throughout the shot timeline): fully_preserved - identity and visual role retained.`)
    .join("\n");
  const detailed = `${labels.join(", ")} remain consistent with their supplied references while the subject suddenly faces the visible obstacle already present in the original timeline.${directionAnchor}\n${shots.join("\n")}`;
  return removeNarrationLipSyncInstructions(
    `subject_definitions:\n${subjectDefinitions}\nsummary:\n[reference generation] Preserve the supplied subjects and the original shot timeline while adapting this legacy prompt to MiniMax H3 Ref2VA.\nretention_analysis:\n${retention}\ndetailed_description:\n${detailed}\noverall_soundscape: Preserve the physical ambience, action sounds, breathing, wind, impacts, and other diegetic sounds described in the timeline.\nnon_diegetic_music: N/A`,
  );
}
