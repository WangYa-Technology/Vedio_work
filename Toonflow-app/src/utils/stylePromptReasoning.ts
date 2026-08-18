import fs from "fs";
import { getArtPromptFile } from "./getArtPrompt";
import getPath from "./getPath";

const DEFAULT_TEMPLATE_PATH = [
  "skills",
  "production_skills",
  "style_prompt_reasoning_default.md",
];

function readDefaultTemplate() {
  try {
    return fs.readFileSync(getPath(DEFAULT_TEMPLATE_PATH), "utf-8").trim();
  } catch {
    return "";
  }
}

/**
 * Build the style reasoning context from files rather than a hard-coded style map.
 * Every style can own its prompt_reasoning.md; new styles still work through the
 * default protocol plus their art_storyboard_video.md visual constraints.
 */
export function resolveStylePromptReasoning(
  styleName: string,
  visualStyleManual = "",
) {
  const normalizedStyleName = String(styleName || "").trim();
  const styleTemplate = normalizedStyleName
    ? getArtPromptFile(
        normalizedStyleName,
        "art_skills",
        "prompt_reasoning",
      ).trim()
    : "";
  const visualManual = String(visualStyleManual || "").trim();

  return [
    readDefaultTemplate(),
    `## 当前项目风格\n${normalizedStyleName || "未指定"}`,
    styleTemplate
      ? `## 当前风格专属推理模板\n${styleTemplate}`
      : "## 当前风格专属推理模板\n未配置独立模板。严格从当前风格视觉标签中推导媒介、材质、色彩、光影、镜头与运动规则，不得套用其他风格。",
    visualManual
      ? `## 当前风格视频硬性标签\n${visualManual}\n\n标签必须转译进最终提示词，不要复述本段说明。`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
