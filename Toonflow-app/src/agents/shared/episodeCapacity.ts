/**
 * 单集容量模型（骨架 / 剧本 / 分镜三层共用的唯一真源）
 *
 * 目的：让"这一集装不装得下、要拆成几集、每集台词怎么分"在**写剧本之前**就有确定性答案，
 * 避免同一份素材在骨架层判"通过"、剧本层判"骑线"、到分镜层才发现物理装不下（四轮返工、
 * 越改越碎）。三层只允许引用本模块的常量与公式，禁止任何一侧自建第二套数字。
 *
 * 口径（以分镜层"逐镜实测"为准，阈值一律沿用既有判定器，未做放宽）：
 * - 台词净时长下限 floor = C / hardCharsPerSecond + hardBufferSeconds × N
 *   （C=台词净字数不含标点，N=台词镜数≈台词条数；按条计缓冲，短句多时更接近真实）
 * - 台词安全时长 safe = C / safeCharsPerSecond + safePausePerMark × M + safeBufferSeconds × N
 *   （M=标点数；达到安全线即完全达标，介于 floor 与 safe 之间为骑线）
 * - 单集预计时长 = 台词净时长 + 动作/非台词预算；
 *   预算分两档：actionReferenceSeconds（常规动作密度，用于判"是否舒适"）
 *   与 actionMinimumSeconds（动作镜合并到极限，用于判"物理是否装得下"）。
 * - 判定 100–130s 目标、>157s 阻塞、<85s 素材不足、>8 段骑线、>10 段阻塞；
 *   均为既有阈值，本模块只负责用同一把尺子算出来。
 *
 * 三态（+ 两种拆分建议）：
 * - ok            safe + 常规动作预算 ≤ 上限 → 直接排
 * - rideLine      floor + 最小动作预算 ≤ 上限 < safe + 常规动作预算 → 可执行（允许骑线）
 * - splitPressure 需压到骑线的台词镜占比 > 阈值（默认 40%）→ 强制建议拆集（等于全片压语速）
 * - splitRequired floor + 最小动作预算 > 上限 → 物理装不下，必拆
 * - underflow     safe + 常规动作预算 < 素材不足线 → 素材偏少，考虑与相邻集合并
 *
 * 设计约束：纯函数、无 IO、无外部依赖；可单测；全部数值集中在本文件，供三层与技能文档引用。
 */

/* ==================== 台词语速口径 ==================== */

export interface DialoguePacing {
  /** 硬底线语速（字/秒）：低于「字数 ÷ 该值 + 硬底线余量」= 阻塞 */
  hardCharsPerSecond: number;
  /** 硬底线余量（秒/镜） */
  hardBufferSeconds: number;
  /** 安全线语速（字/秒）：达到即完全达标 */
  safeCharsPerSecond: number;
  /** 安全线标点停顿（秒/标点） */
  safePausePerMark: number;
  /** 安全线余量（秒/镜） */
  safeBufferSeconds: number;
}

export const DIALOGUE_PACING: DialoguePacing = {
  hardCharsPerSecond: 4.5,
  hardBufferSeconds: 0.3,
  safeCharsPerSecond: 4,
  safePausePerMark: 0.4,
  safeBufferSeconds: 1,
};

/* ==================== 单集预算 ==================== */

export interface SegmentTier {
  min: number;
  max: number;
  label: string;
}

export interface EpisodeCapacityBudget {
  /** 单集目标下限（秒） */
  minSeconds: number;
  /** 单集目标上限（秒） */
  maxSeconds: number;
  /** 严重超载线（秒） */
  severeSeconds: number;
  /** 素材不足线（秒） */
  underSeconds: number;
  /** 上限容差（秒） */
  toleranceSeconds: number;
  /** 常规动作/非台词预算（秒）：正常动作镜密度下的占用 */
  actionReferenceSeconds: number;
  /** 最小动作/非台词预算（秒）：动作镜合并到极限后的最低占用 */
  actionMinimumSeconds: number;
  /** 每集片段上限（> 骑线） */
  maxSegments: number;
  /** 每集片段阻塞线（> 阻塞） */
  blockingSegments: number;
  /** 片段累计时长档位 */
  segmentTiers: SegmentTier[];
  /** 单镜台词容量上限（字，提示级） */
  dialogueCapacityMaxChars: number;
  /** 骑线占比阈值：超过即强制建议拆集 */
  rideLineRatioThreshold: number;
  /** 预排目标（秒）：低于上限，给片段档位取整与长台词拆镜留余量 */
  preScheduleTargetSeconds: number;
}

export const EPISODE_CAPACITY_BUDGET: EpisodeCapacityBudget = {
  minSeconds: 100,
  maxSeconds: 130,
  severeSeconds: 157,
  underSeconds: 85,
  toleranceSeconds: 1,
  actionReferenceSeconds: 40,
  actionMinimumSeconds: 24,
  maxSegments: 8,
  blockingSegments: 10,
  segmentTiers: [
    { min: 11, max: 13, label: "12 秒档" },
    { min: 16, max: 18, label: "17 秒档" },
  ],
  dialogueCapacityMaxChars: 46,
  rideLineRatioThreshold: 0.4,
  preScheduleTargetSeconds: 125,
};

/* ==================== 台词负载与折算 ==================== */

export interface DialogueLoad {
  /** 台词镜数（≈台词条数） */
  lines: number;
  /** 台词净字数（不含标点） */
  chars: number;
  /** 标点数 */
  marks: number;
  /** true 表示条数/标点由字数推断（旧数据缺字段），报告需标注"推断" */
  inferred?: boolean;
}

export interface DialogueTiming {
  /** 刚性台词下限（秒）：原文台词逐字保留时的物理下限 */
  floorSeconds: number;
  /** 台词安全时长（秒）：完全达标（无骑线）所需 */
  safeSeconds: number;
  /** 折算采用的镜数（乐观口径 = 台词条数） */
  shots: number;
  /** 长台词（>20 字）按「每镜 ≤20 字」拆镜后的镜数（分镜端强制拆镜口径，更保守） */
  splitShots: number;
  /** 长台词拆镜后的安全时长（秒）：预排余量的保守值 */
  splitSafeSeconds: number;
  /** 折算来源：measured=实测条数/标点；inferred=由字数推断 */
  source: "measured" | "inferred";
}

/**
 * 单镜台词容量参考：超过该字数分镜端必须拆镜（与分镜层 `longLineChars` 一致）。
 * 拆镜会让每条长台词多占一镜，从而多计 1 秒安全缓冲——这是剧本层预估与分镜端实测的主要差异来源。
 */
export const DIALOGUE_SPLIT_MAX_CHARS = 20;

/** 折算来源标签（报告用语，三层共用） */
export const ESTIMATE_SOURCE_LABELS: Record<DialogueTiming["source"], string> = {
  measured: "实测条数/标点",
  inferred: "推断（条数或标点由字数估计）",
};

/** 缺条数/标点时的推断系数（报告需标注"推断"） */
export const DIALOGUE_LOAD_ASSUMPTIONS = {
  /** 平均每条台词字数（用于由字数推断条数） */
  charsPerLine: 10,
  /** 每个标点对应的净字数（用于由字数推断标点数，约 20% 标点率） */
  charsPerMark: 5,
};

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 由已有字段推断缺失的条数/标点，并标记 inferred */
export function inferDialogueLoad(input: { chars: number; marks?: number; lines?: number }): DialogueLoad {
  const chars = Math.max(0, Number(input.chars) || 0);
  const hasLines = Number.isFinite(input.lines) && (input.lines as number) > 0;
  const hasMarks = Number.isFinite(input.marks) && (input.marks as number) >= 0;
  const lines = hasLines
    ? Math.round(input.lines as number)
    : Math.max(1, Math.round(chars / DIALOGUE_LOAD_ASSUMPTIONS.charsPerLine));
  const marks = hasMarks
    ? Math.round(input.marks as number)
    : Math.round(chars / DIALOGUE_LOAD_ASSUMPTIONS.charsPerMark);
  return { chars, lines, marks, inferred: !(hasLines && hasMarks) };
}

/** 台词净时长折算（floor=刚性下限，safe=安全线） */
export function estimateDialogueTiming(
  load: DialogueLoad,
  pacing: DialoguePacing = DIALOGUE_PACING,
): DialogueTiming {
  const chars = Math.max(0, load.chars);
  const lines = Math.max(0, load.lines);
  const marks = Math.max(0, load.marks);
  // 长台词按「每镜 ≤20 字」拆镜后的镜数：分镜端对 >20 字台词强制拆镜，拆出的每镜各计 1 秒缓冲
  const splitShots = Math.max(lines, Math.ceil(chars / DIALOGUE_SPLIT_MAX_CHARS));
  return {
    floorSeconds: round1(chars / pacing.hardCharsPerSecond + pacing.hardBufferSeconds * lines),
    safeSeconds: round1(
      chars / pacing.safeCharsPerSecond + pacing.safePausePerMark * marks + pacing.safeBufferSeconds * lines,
    ),
    shots: lines,
    splitShots,
    splitSafeSeconds: round1(
      chars / pacing.safeCharsPerSecond + pacing.safePausePerMark * marks + pacing.safeBufferSeconds * splitShots,
    ),
    source: load.inferred ? "inferred" : "measured",
  };
}

/**
 * 长台词拆镜的额外缓冲说明（无差异时返回 undefined）。
 * 用于报告：提示剧本层预估是"乐观口径"，分镜端按强制拆镜口径还会多占缓冲，预排需留余量。
 */
export function describeSplitOverhead(timing: DialogueTiming): string | undefined {
  const extraShots = timing.splitShots - timing.shots;
  if (extraShots <= 0) return undefined;
  const extraSeconds = round1(timing.splitSafeSeconds - timing.safeSeconds);
  return `长台词（>${DIALOGUE_SPLIT_MAX_CHARS} 字）按分镜端强制拆镜口径会有 ${timing.splitShots} 镜（+${extraShots} 镜，每镜多 ${DIALOGUE_PACING.safeBufferSeconds} 秒缓冲）→ 安全时长 ≈${timing.splitSafeSeconds}s（+${extraSeconds}s）；预排请预留该余量`;
}

/* ==================== 单集容量反算 ==================== */

/**
 * 单集可承载台词净字数上限（给定条数与标点）。
 * 解 safe ≤ 上限 − 常规动作预算：C_max = safeCharsPerSecond × (上限 − 动作预算 − 安全线停顿 − 安全线缓冲)
 */
export function dialogueCapacityMaxChars(
  load: Pick<DialogueLoad, "lines" | "marks">,
  budget: EpisodeCapacityBudget = EPISODE_CAPACITY_BUDGET,
  pacing: DialoguePacing = DIALOGUE_PACING,
  actionSeconds: number = budget.actionReferenceSeconds,
): number {
  const lines = Math.max(0, load.lines);
  const marks = Math.max(0, load.marks);
  const available =
    budget.maxSeconds -
    actionSeconds -
    pacing.safePausePerMark * marks -
    pacing.safeBufferSeconds * lines;
  return Math.max(0, Math.floor(pacing.safeCharsPerSecond * available));
}

/** 生成容量查表（供技能文档与报告输出，避免文档里手写数字过期） */
export function buildCapacityTable(
  budget: EpisodeCapacityBudget = EPISODE_CAPACITY_BUDGET,
  pacing: DialoguePacing = DIALOGUE_PACING,
  lineOptions: number[] = [10, 15, 20, 25, 30],
): Array<{ lines: number; maxChars: number; maxCharsAtMinimumAction: number }> {
  return lineOptions.map((lines) => ({
    lines,
    maxChars: dialogueCapacityMaxChars({ lines, marks: lines * 2 }, budget, pacing),
    maxCharsAtMinimumAction: dialogueCapacityMaxChars(
      { lines, marks: lines * 2 },
      budget,
      pacing,
      budget.actionMinimumSeconds,
    ),
  }));
}

/* ==================== 单集三态判定 ==================== */

export type EpisodeCapacityLevel = "ok" | "rideLine" | "splitPressure" | "splitRequired" | "underflow";

export const CAPACITY_LEVEL_LABELS: Record<EpisodeCapacityLevel, string> = {
  ok: "通过（安全线内）",
  rideLine: "可执行（需骑线）",
  splitPressure: "建议拆集（骑线占比过高）",
  splitRequired: "必拆（物理装不下）",
  underflow: "素材不足（建议并集）",
};

export interface EpisodeCapacityAdvice {
  level: EpisodeCapacityLevel;
  /** 结论一句话（可直接进报告） */
  verdict: string;
  /** 可执行建议（拆集/并集/直接排/需授权删减） */
  advice: string;
  /** 建议拆集数（level 需要时给出） */
  splitCount?: number;
}

export interface EpisodeCapacityEstimate {
  load: DialogueLoad;
  timing: DialogueTiming;
  /** 本集采用的动作/非台词预算（常规） */
  actionReferenceSeconds: number;
  /** 本集采用的动作/非台词预算（最小） */
  actionMinimumSeconds: number;
  /** 常规预计时长 = safe + 常规动作预算 */
  totalSeconds: number;
  /** 刚性下限时长 = floor + 最小动作预算 */
  floorTotalSeconds: number;
  /** 需压到骑线的台词占比（0–1）：>0 表示原文台词必须低于安全线才能装下 */
  rideLineRatio: number;
  /** 超出上限的秒数（常规预计 − 上限，<0 表示富余） */
  overSeconds: number;
  result: EpisodeCapacityAdvice;
}

/** 单集是否属于"阻塞级"（必拆/高骑线/素材不足） */
export function isBlockingCapacityLevel(level: EpisodeCapacityLevel): boolean {
  return level === "splitRequired" || level === "splitPressure";
}

export function estimateEpisodeCapacity(
  load: DialogueLoad,
  budget: EpisodeCapacityBudget = EPISODE_CAPACITY_BUDGET,
  pacing: DialoguePacing = DIALOGUE_PACING,
): EpisodeCapacityEstimate {
  const timing = estimateDialogueTiming(load, pacing);
  const actionReferenceSeconds = budget.actionReferenceSeconds;
  const actionMinimumSeconds = budget.actionMinimumSeconds;
  const totalSeconds = round1(timing.safeSeconds + actionReferenceSeconds);
  const floorTotalSeconds = round1(timing.floorSeconds + actionMinimumSeconds);
  const overSeconds = round1(totalSeconds - budget.maxSeconds);

  // 需要从安全线压到硬底线的秒数 / 台词可压缩总量 = 必须骑线的台词占比
  const compressible = Math.max(0, timing.safeSeconds - timing.floorSeconds);
  const needed = Math.max(0, overSeconds);
  const rideLineRatio = compressible > 0 ? clamp(needed / compressible, 0, 1) : needed > 0 ? 1 : 0;

  let level: EpisodeCapacityLevel;
  if (floorTotalSeconds > budget.maxSeconds + budget.toleranceSeconds) {
    level = "splitRequired";
  } else if (totalSeconds < budget.underSeconds) {
    level = "underflow";
  } else if (overSeconds <= budget.toleranceSeconds) {
    level = "ok";
  } else if (rideLineRatio > budget.rideLineRatioThreshold) {
    level = "splitPressure";
  } else {
    level = "rideLine";
  }

  const sourceNote = timing.source === "inferred" ? "（条数/标点由字数推断）" : "";
  const splitResult = suggestSplitCount(load, budget, pacing);
  const advice: EpisodeCapacityAdvice = {
    level,
    verdict: "",
    advice: "",
  };
  if (level === "ok") {
    advice.verdict = `预计 ${totalSeconds}s（台词 ${timing.safeSeconds}s + 动作预算 ${actionReferenceSeconds}s）${sourceNote} → 落在预算内，可直接排`;
    const conservativeSeconds = round1(timing.splitSafeSeconds + actionReferenceSeconds);
    advice.advice =
      conservativeSeconds > budget.maxSeconds
        ? `预排目标 ≤${budget.preScheduleTargetSeconds}s；注意长台词（>${DIALOGUE_SPLIT_MAX_CHARS} 字）拆镜后预计 ≈${conservativeSeconds}s（会越上限）——按拆镜后的保守值重排，或按建议拆集。`
        : `直接按预算排布（预排目标 ≤${budget.preScheduleTargetSeconds}s，给片段档位取整与长台词拆镜留余量）；动作镜按 4~6s 双拍合并，片段落 12/17 秒档。`;
  } else if (level === "rideLine") {
    advice.verdict = `预计 ${totalSeconds}s，超出上限 ${overSeconds}s，需把约 ${Math.round(rideLineRatio * 100)}% 的台词镜压到硬底线（下限 ${timing.floorSeconds}s）${sourceNote}`;
    advice.advice = "可执行（骑线项不阻塞、不作为返工理由）；若不想压语速，按建议拆集。";
    advice.splitCount = splitResult.comfort;
  } else if (level === "splitPressure") {
    advice.verdict = `预计 ${totalSeconds}s，超出上限 ${overSeconds}s，需把约 ${Math.round(rideLineRatio * 100)}% 的台词镜压到硬底线${sourceNote} → 等于全片压语速，拆集为默认路径`;
    advice.advice = `建议拆成 ${splitResult.comfort} 集（每集按安全线排布，不需删台词）；拆分需在语义边界落刀。`;
    advice.splitCount = splitResult.comfort;
  } else if (level === "splitRequired") {
    advice.verdict = `物理装不下：台词下限 ${timing.floorSeconds}s + 最小动作预算 ${actionMinimumSeconds}s = ${floorTotalSeconds}s > 上限 ${budget.maxSeconds}s${sourceNote}`;
    advice.advice = `必须拆集（至少 ${splitResult.min} 集，舒适 ${splitResult.comfort} 集）；如不拆集则只能回剧本删减台词（需用户授权并登记豁免）。`;
    advice.splitCount = splitResult.comfort;
  } else {
    advice.verdict = `预计 ${totalSeconds}s，低于素材不足线 ${budget.underSeconds}s${sourceNote} → 素材偏少`;
    advice.advice = "考虑与相邻集合并，或补入未用情节（不得靠注水动作镜凑时长）。";
  }
  return {
    load,
    timing,
    actionReferenceSeconds,
    actionMinimumSeconds,
    totalSeconds,
    floorTotalSeconds,
    rideLineRatio: Math.round(rideLineRatio * 1000) / 1000,
    overSeconds,
    result: advice,
  };
}

/* ==================== 集数推算 ==================== */

export interface EpisodeCountSuggestion {
  /** 物理下限集数（每集压到硬底线 + 最小动作预算） */
  min: number;
  /** 舒适集数（每集安全线 + 常规动作预算） */
  comfort: number;
  /** 上限集数（再多会出现素材不足） */
  max: number;
  notes: string[];
}

export function suggestSplitCount(
  load: DialogueLoad,
  budget: EpisodeCapacityBudget = EPISODE_CAPACITY_BUDGET,
  pacing: DialoguePacing = DIALOGUE_PACING,
): EpisodeCountSuggestion {
  const timing = estimateDialogueTiming(load, pacing);
  // 物理下限：每集台词 floor 不超过 上限 − 最小动作预算
  const floorBudgetPerEpisode = Math.max(1, budget.maxSeconds - budget.actionMinimumSeconds);
  const min = Math.max(1, Math.ceil(timing.floorSeconds / floorBudgetPerEpisode - 1e-6));
  // 舒适：每集台词 safe 不超过 上限 − 常规动作预算
  const safeBudgetPerEpisode = Math.max(1, budget.maxSeconds - budget.actionReferenceSeconds);
  const comfort = Math.max(1, Math.ceil(timing.safeSeconds / safeBudgetPerEpisode - 1e-6));
  // 上限：拆得太多会低于素材不足线（每集 floor + 常规动作预算 ≥ 85s，含容差）
  const underBudgetPerEpisode = Math.max(
    1,
    budget.underSeconds - budget.actionReferenceSeconds - budget.toleranceSeconds,
  );
  const max = Math.max(1, Math.floor(timing.floorSeconds / underBudgetPerEpisode + 1e-6));
  const notes: string[] = [];
  notes.push(`物理下限 ${min} 集（每集台词压到硬底线、动作镜合并到 ${budget.actionMinimumSeconds}s 预算）`);
  notes.push(`舒适 ${comfort} 集（每集台词按安全线排布，不需删台词）`);
  if (max < comfort) notes.push(`上限 ${max} 集：再拆会低于素材不足线 ${budget.underSeconds}s`);
  return { min, comfort: Math.max(comfort, min), max: Math.max(max, min), notes };
}

export function suggestEpisodeCount(
  total: DialogueLoad,
  budget: EpisodeCapacityBudget = EPISODE_CAPACITY_BUDGET,
  pacing: DialoguePacing = DIALOGUE_PACING,
): EpisodeCountSuggestion {
  return suggestSplitCount(total, budget, pacing);
}

/* ==================== 语义边界拆集 ==================== */

/** 拆集候选单元的语义级别（越靠前越适合落刀） */
export type CapacityBoundaryLevel = "scene" | "beat" | "exchange" | "line";

export interface CapacityUnit {
  /** 单元标识（场号/节拍号/台词行号） */
  id: string;
  /** 展示标签（如「1-1 夜市后巷摊位」） */
  label?: string;
  /** 该单元的台词净字数 */
  chars: number;
  /** 该单元的标点数 */
  marks: number;
  /** 该单元的台词条数 */
  lines: number;
  /** 该单元之后允许落刀的语义级别 */
  boundaryAfter: CapacityBoundaryLevel;
}

export interface EpisodeSplitPart {
  index: number;
  unitIds: string[];
  label: string;
  load: DialogueLoad;
  estimate: EpisodeCapacityEstimate;
}

export interface EpisodeSplitPlan {
  parts: EpisodeSplitPart[];
  totalLoad: DialogueLoad;
  suggestion: EpisodeCountSuggestion;
  warnings: string[];
}

const BOUNDARY_COST: Record<CapacityBoundaryLevel, number> = {
  scene: 0,
  beat: 1,
  exchange: 2.5,
  line: 6,
};

function sumUnits(units: CapacityUnit[]): DialogueLoad {
  const chars = units.reduce((sum, unit) => sum + unit.chars, 0);
  const marks = units.reduce((sum, unit) => sum + unit.marks, 0);
  const lines = units.reduce((sum, unit) => sum + unit.lines, 0);
  return { chars, marks, lines };
}

function partLabel(units: CapacityUnit[], index: number): string {
  const first = units[0]?.label ?? units[0]?.id ?? "";
  const last = units[units.length - 1]?.label ?? units[units.length - 1]?.id ?? "";
  return first && last && first !== last ? `${first} → ${last}` : `${first}（第 ${index} 集）`;
}

/**
 * 按语义边界把一集（或若干场）切成 k 集：切点尽量落在场/节拍边界，
 * 每集台词 + 动作预算回落 100–130s，且不低于素材不足线；返回可直接执行的方案表。
 *
 * 约束（硬）：每集 floor_total ≤ 上限 + 容差（否则物理装不下，切点视为非法）；
 *          每集 safe_total ≥ 素材不足线 − 容差（否则该集太薄，切点视为非法）。
 * 目标（软）：优先舒适（safe + 常规动作预算 ≤ 上限）、其次骑线占比低、切点语义级别高、集数不超舒适值。
 */
export function planEpisodeSplit(
  units: CapacityUnit[],
  budget: EpisodeCapacityBudget = EPISODE_CAPACITY_BUDGET,
  pacing: DialoguePacing = DIALOGUE_PACING,
): EpisodeSplitPlan {
  const usableUnits = units.filter((unit) => unit.chars > 0 || unit.lines > 0);
  const totalLoad = sumUnits(usableUnits);
  const suggestion = suggestSplitCount(totalLoad, budget, pacing);
  const warnings: string[] = [];
  if (!usableUnits.length) {
    return { parts: [], totalLoad, suggestion, warnings: ["没有可拆分的台词素材"] };
  }

  const prefix: DialogueLoad[] = [{ chars: 0, marks: 0, lines: 0 }];
  for (const unit of usableUnits) {
    const last = prefix[prefix.length - 1];
    prefix.push({
      chars: last.chars + unit.chars,
      marks: last.marks + unit.marks,
      lines: last.lines + unit.lines,
    });
  }
  const sliceLoad = (start: number, end: number): DialogueLoad => ({
    chars: prefix[end].chars - prefix[start].chars,
    marks: prefix[end].marks - prefix[start].marks,
    lines: prefix[end].lines - prefix[start].lines,
  });

  const count = usableUnits.length;
  const maxParts = clamp(suggestion.comfort + 2, 1, count);
  const maxSeparable = suggestion.max + 1; // 允许试探到"再拆就素材不足"的一档

  const costOf = (start: number, end: number): { cost: number; valid: boolean; estimate: EpisodeCapacityEstimate } => {
    const load = sliceLoad(start, end);
    const estimate = estimateEpisodeCapacity(load, budget, pacing);
    const invalid = estimate.floorTotalSeconds > budget.maxSeconds + budget.toleranceSeconds;
    const tooThin = estimate.totalSeconds + budget.toleranceSeconds < budget.underSeconds;
    const comfortGap = Math.max(0, estimate.overSeconds);
    const thinGap = estimate.totalSeconds < budget.minSeconds ? budget.minSeconds - estimate.totalSeconds : 0;
    const cost =
      comfortGap * 3 + // 超出上限：优先消除
      estimate.rideLineRatio * 12 + // 骑线占比：等同全片压语速，重罚
      thinGap * 1.5 + // 偏薄
      BOUNDARY_COST[usableUnits[end - 1].boundaryAfter] * 4; // 落刀语义代价
    return { cost, valid: !invalid && !tooThin, estimate };
  };

  // DP：dp[k][i] = 前 i 个单元切成 k 份的最小代价
  const INF = Number.POSITIVE_INFINITY;
  const dp: number[][] = Array.from({ length: maxParts + 1 }, () => new Array(count + 1).fill(INF));
  const back: number[][] = Array.from({ length: maxParts + 1 }, () => new Array(count + 1).fill(-1));
  dp[0][0] = 0;
  for (let k = 1; k <= maxParts; k += 1) {
    for (let end = 1; end <= count; end += 1) {
      if (end < k) continue;
      for (let start = k - 1; start < end; start += 1) {
        if (dp[k - 1][start] === INF) continue;
        const { cost, valid } = costOf(start, end);
        if (!valid) continue;
        const next = dp[k - 1][start] + cost;
        if (next < dp[k][end]) {
          dp[k][end] = next;
          back[k][end] = start;
        }
      }
    }
  }

  // 选出合法切分中代价最小者；同样代价优先集数少（更接近舒适值）
  let bestK = 0;
  let bestCost = INF;
  for (let k = 1; k <= Math.min(maxParts, maxSeparable); k += 1) {
    if (dp[k][count] === INF) continue;
    const penalty = Math.abs(k - suggestion.comfort) * 0.5;
    if (dp[k][count] + penalty < bestCost) {
      bestCost = dp[k][count] + penalty;
      bestK = k;
    }
  }

  if (!bestK) {
    warnings.push(
      `找不到满足「每集 ≤${budget.maxSeconds}s 且 ≥${budget.underSeconds}s」的切分：素材总量或单集粒度不匹配，请人工指定切点（可先用 1 集并压缩动作镜）`,
    );
    const whole = estimateEpisodeCapacity(totalLoad, budget, pacing);
    return {
      parts: [
        {
          index: 1,
          unitIds: usableUnits.map((unit) => unit.id),
          label: partLabel(usableUnits, 1),
          load: totalLoad,
          estimate: whole,
        },
      ],
      totalLoad,
      suggestion,
      warnings,
    };
  }

  const parts: EpisodeSplitPart[] = [];
  let cursor = count;
  for (let k = bestK; k >= 1; k -= 1) {
    const start = back[k][cursor];
    const slice = usableUnits.slice(start, cursor);
    parts.unshift({
      index: k,
      unitIds: slice.map((unit) => unit.id),
      label: partLabel(slice, k),
      load: sliceLoad(start, cursor),
      estimate: estimateEpisodeCapacity(sliceLoad(start, cursor), budget, pacing),
    });
    cursor = start;
  }

  for (const part of parts) {
    if (part.estimate.result.level === "underflow") {
      warnings.push(`第 ${part.index} 集预计 ${part.estimate.totalSeconds}s，低于素材不足线，建议与该集相邻内容再平衡`);
    }
  }
  if (parts.length > suggestion.comfort) {
    warnings.push(`实际切分为 ${parts.length} 集，多于舒适值 ${suggestion.comfort} 集（受语义边界限制）`);
  }
  return { parts, totalLoad, suggestion, warnings };
}

/* ==================== 报告输出 ==================== */

const LEVEL_MARK: Record<EpisodeCapacityLevel, string> = {
  ok: "通过",
  rideLine: "骑线可执行",
  splitPressure: "建议拆集",
  splitRequired: "必拆",
  underflow: "素材不足",
};

export function capacityLevelMark(level: EpisodeCapacityLevel): string {
  return LEVEL_MARK[level];
}

/** 单集容量一行的通用渲染（三层报告共用，避免文案漂移） */
export function formatEpisodeCapacityLine(label: string, estimate: EpisodeCapacityEstimate): string {
  const { load, timing, totalSeconds, rideLineRatio } = estimate;
  return (
    `${label}：台词 ${load.lines} 条 / ${load.chars} 字 / ${load.marks} 标点` +
    ` → 下限 ${timing.floorSeconds}s、安全 ${timing.safeSeconds}s，预计 ${totalSeconds}s` +
    `（骑线占比 ${Math.round(rideLineRatio * 100)}%）→ ${capacityLevelMark(estimate.result.level)}`
  );
}

/** 容量查表渲染（技能文档与报告脚注共用） */
export function formatCapacityTable(budget: EpisodeCapacityBudget = EPISODE_CAPACITY_BUDGET): string[] {
  const table = buildCapacityTable(budget);
  return table.map((row) => `${row.lines} 条 → ≤${row.maxChars} 字（动作预算压缩到极限时 ≤${row.maxCharsAtMinimumAction} 字）`);
}
