export type VideoPromptVariation = {
  round: number;
  key: string;
  direction: string;
  requestNonce: string;
};

type VariationSnapshot = {
  creativeVariation?: {
    round?: unknown;
  };
};

const VARIATION_DIRECTIONS = [
  {
    key: "threat-first",
    direction:
      "威胁先行：开场先让危险、代价或失控状态占据画面，再用人物反应揭示其身份与反差。",
  },
  {
    key: "capability-collapse",
    direction:
      "能力坍塌：开场先给出人物原本能掌控的目标或优势，再立刻以同一动作中的受阻、失效或代价打断它。",
  },
  {
    key: "choice-under-pressure",
    direction:
      "两难施压：开场让人物在两个已有风险之间被迫选择，先呈现无法回避的代价，再推进其应对。",
  },
  {
    key: "countdown-escalation",
    direction:
      "倒计时升级：开场直接展示正在逼近的临界点，以空间、距离或物件变化逐镜压缩人物的反应时间。",
  },
] as const;

function readRound(snapshot: unknown) {
  if (!snapshot) return 0;
  try {
    const parsed = JSON.parse(String(snapshot)) as VariationSnapshot;
    const round = Number(parsed.creativeVariation?.round);
    return Number.isInteger(round) && round > 0 ? round : 0;
  } catch {
    return 0;
  }
}

export function resolveVideoPromptVariation(
  tasks: Array<{ promptInferenceSnapshot?: unknown }>,
  requestNonce: string,
): VideoPromptVariation {
  const previousRound = Math.max(
    0,
    ...tasks.map((task) => readRound(task.promptInferenceSnapshot)),
  );
  const round = previousRound + 1;
  const direction = VARIATION_DIRECTIONS[(round - 1) % VARIATION_DIRECTIONS.length];
  return { round, ...direction, requestNonce };
}

export function trimPreviousVideoPrompt(value: unknown, maxLength = 4_000) {
  const prompt = String(value || "").trim();
  if (!prompt || maxLength <= 0) return "";
  return prompt.length <= maxLength
    ? prompt
    : `${prompt.slice(0, maxLength)}\n[上一稿后文已省略]`;
}
