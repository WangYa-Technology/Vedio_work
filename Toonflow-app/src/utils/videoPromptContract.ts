export interface VideoPromptContractConfig {
  artStyle?: string;
  videoRatio?: string;
  referenceToken?: string;
  visualStyleManual?: string;
}

export interface VideoPromptContractTask {
  segmentTitle?: string;
  duration?: number;
  dialogue?: string;
  segmentRows?: Array<{ dialogue?: string }>;
}

const STYLE_CONTAMINATION = /真人|实拍|IMAX|Arri\s*Alexa|2\.39\s*:\s*1|\b8K\b/i;
const SPOKEN_AUDIO = /(?:台词|对白|说|喊|叫|低语|旁白|独白)[：:]\s*[“"「『]?\s*(?!无台词|无对白|无)([^\n；。.!！]{1,80})/i;
const ACTION_ANCHORS = /猛然坐起|坐起|起身|踹门|推门|开门|转身|奔跑|跑向|冲向|抬头|低头|挥手|伸手|抓住|拔出|倒下|跌倒|爆炸|递给|拿起|放下|摔倒|拍打|敲门|看向|回头|后退|前进|拥抱|亲吻|殴打|踢|砍|躲|闪避|哭泣|大笑|怒吼|点头|摇头/g;

const GENERIC_STYLE_ANCHORS = new Set(
  [
    "cinematic",
    "cinematic lighting",
    "natural lighting",
    "warm tones",
    "cool tones",
    "clean lines",
    "vivid colors",
    "high detail",
    "ultra-fine detail",
    "shallow depth of field",
    "电影风格",
    "电影级光影",
    "自然光照",
    "温暖色调",
    "冷色调",
    "清晰线条",
    "色彩鲜明",
    "极致细节",
    "浅景深",
  ].map((value) => value.toLowerCase()),
);

function normalizeStyleAnchor(value: unknown) {
  return String(value || "")
    .replace(/^[`'“”\s]+|[`'“”\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * The style manuals use a Markdown table with English and Chinese label rows.
 * The first two non-generic labels in each row carry the medium/style identity;
 * later labels are usually reusable lighting and quality terms.
 */
export function extractDistinctiveStyleAnchors(manual: unknown) {
  const anchors: string[] = [];
  for (const line of String(manual || "").split(/\r?\n/)) {
    const match = line.match(/^\|[^|]+\|\s*`([^`]+)`\s*\|?\s*$/);
    if (!match) continue;
    const rowAnchors = match[1]
      .split(/[,，;；]/)
      .map(normalizeStyleAnchor)
      .filter(
        (value) =>
          value.length >= 3 &&
          !GENERIC_STYLE_ANCHORS.has(value),
      )
      .slice(0, 2);
    anchors.push(...rowAnchors);
  }
  return [...new Set(anchors)];
}

function normalizeRatio(value: unknown) {
  return String(value || "").replace(/\s/g, "").trim();
}

function hasNoDialogue(task: VideoPromptContractTask) {
  const rows = task.segmentRows?.length
    ? task.segmentRows
    : [{ dialogue: task.dialogue }];
  return rows.every((row) => {
    const value = String(row.dialogue || "").trim();
    return !value || /^(?:无|无台词|暂无|无对白|-)$/i.test(value);
  });
}

function actionAnchors(task: VideoPromptContractTask) {
  const descriptions = (task.segmentRows || [])
    .map((row: any) => String(row.description || row.visualAndAction || ""))
    .join(" ");
  return [...new Set(descriptions.match(ACTION_ANCHORS) || [])];
}

/** Return hard contract violations that can be verified without inspecting video pixels. */
export function collectVideoPromptContractViolations(
  task: VideoPromptContractTask,
  prompt: string,
  config: VideoPromptContractConfig = {},
) {
  const violations: string[] = [];
  const artStyle = String(config.artStyle || "").toLowerCase();
  const isRealisticStyle = /realpeople|realistic|documentary|写实|真人/.test(artStyle);
  if (!isRealisticStyle && STYLE_CONTAMINATION.test(prompt)) {
    violations.push("提示词包含与当前非真人画风冲突的摄影/画质标签");
  }

  const styleAnchors = extractDistinctiveStyleAnchors(
    config.visualStyleManual,
  );
  const normalizedPrompt = normalizeStyleAnchor(prompt);
  if (
    styleAnchors.length &&
    !styleAnchors.some((anchor) => normalizedPrompt.includes(anchor))
  ) {
    violations.push(
      `提示词缺少当前画风的可验证锚点（例如：${styleAnchors.slice(0, 4).join("、")}）`,
    );
  }

  const expectedRatio = normalizeRatio(config.videoRatio);
  const ratioMatches = Array.from(prompt.matchAll(/\b(\d+\s*:\s*\d+)\b/g)).map(
    (match) => normalizeRatio(match[1]),
  );
  if (expectedRatio && ratioMatches.some((ratio) => ratio !== expectedRatio)) {
    violations.push(`提示词包含与项目画幅 ${expectedRatio} 冲突的比例`);
  }

  if (hasNoDialogue(task) && SPOKEN_AUDIO.test(prompt)) {
    violations.push("原分镜无对白，但提示词添加了对白或旁白");
  }

  const missingActions = actionAnchors(task).filter((action) => !prompt.includes(action));
  if (missingActions.length) {
    violations.push(`分镜关键动作未保留：${missingActions.join("、")}`);
  }

  const shotCount = task.segmentRows?.length || 0;
  const timedMarkers = prompt.match(/\d+(?:\.\d+)?\s*(?:秒|s)(?!\w)/gi) || [];
  if (shotCount > 1 && timedMarkers.length < shotCount) {
    violations.push("多镜头提示词缺少逐镜时间分段，无法稳定控制动作节奏");
  }

  const token = String(config.referenceToken || "");
  if (token && prompt.includes("@图") && token !== "@图") {
    violations.push(`当前模型要求使用 ${token}，提示词仍使用 @图`);
  }
  return violations;
}
