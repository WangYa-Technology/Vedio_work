/**
 * 剧本确定性检查模块（审核链路的"事实层"）
 *
 * 目的：把"本该精确"的判定——单集时长、原文台词逐字保留、格式红线与关键词——从审核层
 * LLM 的主观裁量中剥离，改由代码给出同输入同输出的确定性结论，供审核报告原样引用，
 * 压缩评分方差，避免"越改越低"。
 *
 * 设计约束：
 * - 纯函数与 IO 分离：解析/折算/比对/扫描均为纯函数，可单测；只有 runScriptChecks 读库。
 * - 参数集中可调：见 SCRIPT_CHECK_CONFIG。
 * - 时长本质是估算：输出快/慢两档区间与三态判定（ok/borderline/over/under），
 *   整体越界项判定为阻塞，骑线项交由审核层按语义裁量。
 * - 镜头技术词/秒数标注只在"描述位"（△ 动作行、场次标题行）扫描；台词行不扫，
 *   避免把"全景落地窗""再给我3秒"这类剧情内容误判为镜头语言。
 */

import {
  DIALOGUE_PACING,
  EPISODE_CAPACITY_BUDGET,
  capacityLevelMark,
  describeSplitOverhead,
  estimateDialogueTiming,
  estimateEpisodeCapacity as estimateLoadCapacity,
  formatCapacityTable,
  isBlockingCapacityLevel,
  planEpisodeSplit,
  type CapacityBoundaryLevel,
  type CapacityUnit,
  type DialogueLoad,
  type DialogueTiming,
  type EpisodeCapacityEstimate,
  type EpisodeSplitPlan,
} from "@/agents/shared/episodeCapacity";

export type CheckSeverity = "阻塞" | "提示";

export interface DurationPreset {
  /** 台词语速（字/秒） */
  dialogueCharsPerSecond: number;
  /** 动作描述折算语速（字/秒）；以 10 字/秒为基准按"动作系数"换算：fast 10/0.7≈14、slow 10/0.9≈11 */
  actionCharsPerSecond: number;
  /** 每场转换停顿（秒） */
  transitionSecondsPerScene: number;
  /** 单条 △ 动作的最小表演时长（秒） */
  minActionSecondsPerLine: number;
}

export interface ScriptCheckConfig {
  duration: {
    minSeconds: number;
    maxSeconds: number;
    fast: DurationPreset;
    slow: DurationPreset;
  };
  dialogue: {
    similarityThreshold: number;
    minSuspectAddedLength: number;
    minVerbatimSubstringLength: number;
    minQuoteLength: number;
    maxQuoteLength: number;
  };
  redline: {
    officialTitleWords: string[];
  };
}

export const SCRIPT_CHECK_CONFIG: ScriptCheckConfig = {
  duration: {
    minSeconds: 100,
    maxSeconds: 130,
    fast: {
      dialogueCharsPerSecond: 5.5,
      actionCharsPerSecond: 15,
      transitionSecondsPerScene: 1,
      minActionSecondsPerLine: 0.8,
    },
    slow: {
      dialogueCharsPerSecond: 4.5,
      actionCharsPerSecond: 12,
      transitionSecondsPerScene: 1.5,
      minActionSecondsPerLine: 1,
    },
  },
  dialogue: {
    similarityThreshold: 0.65,
    minSuspectAddedLength: 8,
    // 合并/拆分原文台词（原文短句以子串形式逐字出现）不算改写，因此子串判定放宽到 4 字
    minVerbatimSubstringLength: 4,
    minQuoteLength: 2,
    maxQuoteLength: 60,
  },
  redline: {
    officialTitleWords: ["市委书记", "省委书记", "市长", "县长", "省长", "书记", "部长", "厅长", "局长", "镇长", "乡长", "村长"],
  },
};

/* ==================== 解析 ==================== */

export type ScriptLineType = "dialogue" | "os" | "vs" | "action" | "other";

export interface ScriptLine {
  /** 1-based 行号（相对剧本 content 全篇） */
  lineNo: number;
  type: ScriptLineType;
  speaker?: string;
  text: string;
  raw: string;
}

export interface ScriptScene {
  /** 场号，如 "1-2" */
  sceneCode: string;
  title: string;
  characters: string[];
  lineNo: number;
}

export interface ParsedEpisode {
  name: string;
  episodeNo?: number;
  titleLine?: string;
  chapterRange?: { start: number; end: number } | null;
  chapterRangeRaw?: string;
  /** 正文起始行号；0 表示未识别到场次标题 */
  bodyStartLine: number;
  rawLines: string[];
  scenes: ScriptScene[];
  lines: ScriptLine[];
  parseWarnings: string[];
}

const SCENE_TITLE_PATTERN = /^\s*(\d+)\s*[-–—]\s*(\d+)\s+(\S.*)$/;
const CHARACTERS_PATTERN = /^\s*人物\s*[:：]\s*(.*)$/;
const ACTION_PATTERN = /^\s*△\s*(.*)$/;
/** 场记注释行（如「【信息差类型：…】」）：不是台词，必须排除在台词/时长折算之外 */
const NOTE_PATTERN = /^\s*【[^】]*】\s*$/;
const OS_PATTERN =
  /^\s*(OS|V\.S\.|VO|V\.O\.)\s*[（(]\s*([^，,）)]*)\s*[，,]\s*([^）)]*)\s*[）)]\s*[:：]\s*([\s\S]*)$/i;
const OS_LOOSE_PATTERN = /^\s*(OS|V\.S\.|VO|V\.O\.)\s*[（(]\s*([^）)]*)\s*[）)]\s*[:：]\s*([\s\S]*)$/i;
/**
 * 台词行：`说话人：台词`。
 * 说话人允许一段括注（如「陈照野（目光落到那口翻着的老汤上）」），
 * 括注计入说话人之外的表演提示、不作为台词内容；说话人名不含空格与结构符号。
 */
const DIALOGUE_PATTERN =
  /^\s*([^：:\s#△|>【】（）()]{1,20})\s*(?:[（(][^）)]{0,24}[）)])?\s*[:：]\s*(.+)$/;
const DIVIDER_PATTERN = /^\s*-{3,}\s*$/;
const CHAPTER_INDEX_PATTERN = /第\s*([0-9一二三四五六七八九十百零〇两]+)\s*章/g;

const CN_DIGITS: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/** 解析章节编号：支持阿拉伯数字与中文数字（一/十五/二十/一百零五） */
export function parseIndexNumber(input: string): number | undefined {
  const raw = String(input ?? "").trim();
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) return Number(raw);

  let result = 0;
  let current = 0;
  let seen = false;
  for (const ch of raw) {
    if (ch === "百") {
      result += (current || 1) * 100;
      current = 0;
      seen = true;
      continue;
    }
    if (ch === "十") {
      result += (current || 1) * 10;
      current = 0;
      seen = true;
      continue;
    }
    const digit = CN_DIGITS[ch];
    if (digit === undefined) return undefined;
    current = digit;
    seen = true;
  }
  result += current;
  return seen ? result : undefined;
}

/**
 * 从"原著范围"行提取章节区间。
 * 兼容写法：`第1-12章`、`第1章前半`、`第1章后半-第2章前半`、`第2章后半-第3章`。
 * 取该行内所有「第X章」的最小值与最大值，覆盖被引用章节（"前半/后半"细化信息不参与区间计算）。
 */
export function parseChapterRange(line: string): { start: number; end: number } | null {
  const text = String(line ?? "");
  const numbers: number[] = [];
  let match: RegExpExecArray | null;

  // 形态一：连续区间写法，如“第1-12章”“第 3–8 章”
  const rangePattern = /第?\s*([0-9一二三四五六七八九十百零〇两]+)\s*[-–—~～至]\s*第?\s*([0-9一二三四五六七八九十百零〇两]+)\s*章/g;
  while ((match = rangePattern.exec(text)) !== null) {
    const start = parseIndexNumber(match[1]);
    const end = parseIndexNumber(match[2]);
    if (start !== undefined) numbers.push(start);
    if (end !== undefined) numbers.push(end);
  }

  // 形态二：逐章引用写法，如“第1章前半”“第1章后半-第2章前半”
  const indexPattern = /第\s*([0-9一二三四五六七八九十百零〇两]+)\s*章/g;
  while ((match = indexPattern.exec(text)) !== null) {
    const value = parseIndexNumber(match[1]);
    if (value !== undefined) numbers.push(value);
  }

  if (!numbers.length) return null;
  return { start: Math.min(...numbers), end: Math.max(...numbers) };
}

export function parseScriptEpisode(name: string, content: string): ParsedEpisode {
  const rawLines = String(content ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const parseWarnings: string[] = [];
  const fileName = String(name ?? "");

  const episodeNoMatch = fileName.match(/EP\s*[-_]?\s*(\d+)/i);
  const episodeNo = episodeNoMatch ? Number(episodeNoMatch[1]) : undefined;

  const firstContentLine = rawLines.find((line) => line.trim().length > 0);
  const titleLine =
    firstContentLine && firstContentLine.trim().startsWith("#")
      ? firstContentLine.trim().replace(/^#+\s*/, "").trim()
      : undefined;

  // 文件头区域（前 20 行）内查找"原著范围"行，避免误匹配正文中的章节提及
  const rangeLine = rawLines.slice(0, 20).find((line) => /原著(?:范围|章节)?\s*[:：]/.test(line));
  const chapterRange = rangeLine ? parseChapterRange(rangeLine) : null;
  const chapterRangeRaw = rangeLine?.trim();
  if (!chapterRange) {
    parseWarnings.push("未识别原著范围（文件头应含“# 原著范围：第X-Y章”），原文台词比对按全量章节执行且结果仅供参考");
  }

  const sceneStartIndexes: number[] = [];
  rawLines.forEach((line, index) => {
    if (SCENE_TITLE_PATTERN.test(line)) sceneStartIndexes.push(index);
  });
  const bodyStartIndex = sceneStartIndexes.length ? sceneStartIndexes[0] : -1;
  if (bodyStartIndex < 0) parseWarnings.push("未识别场次标题（应为“{场号} {场景名} {时间}/{光线}”），正文结构检查不可用");

  const lines: ScriptLine[] = [];
  const scenes: ScriptScene[] = [];
  let currentScene: ScriptScene | null = null;

  for (let index = Math.max(bodyStartIndex, 0); index < rawLines.length; index += 1) {
    const raw = rawLines[index];
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const lineNo = index + 1;

    const sceneMatch = trimmed.match(SCENE_TITLE_PATTERN);
    if (sceneMatch) {
      currentScene = {
        sceneCode: `${sceneMatch[1]}-${sceneMatch[2]}`,
        title: sceneMatch[3].trim(),
        characters: [],
        lineNo,
      };
      scenes.push(currentScene);
      lines.push({ lineNo, type: "other", text: trimmed, raw });
      continue;
    }

    const charactersMatch = trimmed.match(CHARACTERS_PATTERN);
    if (charactersMatch) {
      const names = charactersMatch[1].split(/\s+/).filter(Boolean);
      if (currentScene) currentScene.characters = names;
      lines.push({ lineNo, type: "other", text: trimmed, raw });
      continue;
    }

    const actionMatch = trimmed.match(ACTION_PATTERN);
    if (actionMatch) {
      lines.push({ lineNo, type: "action", text: actionMatch[1].trim(), raw });
      continue;
    }

    const osMatch = trimmed.match(OS_PATTERN);
    if (osMatch) {
      lines.push({
        lineNo,
        type: osMatch[1].replace(/\./g, "").toUpperCase() === "OS" ? "os" : "vs",
        speaker: osMatch[2].trim(),
        text: osMatch[4].trim(),
        raw,
      });
      continue;
    }

    const osLooseMatch = trimmed.match(OS_LOOSE_PATTERN);
    if (osLooseMatch) {
      lines.push({
        lineNo,
        type: osLooseMatch[1].replace(/\./g, "").toUpperCase() === "OS" ? "os" : "vs",
        speaker: osLooseMatch[2].trim(),
        text: osLooseMatch[3].trim(),
        raw,
      });
      continue;
    }

    if (DIVIDER_PATTERN.test(trimmed)) {
      lines.push({ lineNo, type: "other", text: trimmed, raw });
      continue;
    }

    // 场记注释（【…】）不是台词：若按台词计会虚增台词字数与时长折算
    if (NOTE_PATTERN.test(trimmed)) {
      lines.push({ lineNo, type: "other", text: trimmed, raw });
      continue;
    }

    const dialogueMatch = trimmed.match(DIALOGUE_PATTERN);
    if (dialogueMatch) {
      lines.push({ lineNo, type: "dialogue", speaker: dialogueMatch[1].trim(), text: dialogueMatch[2].trim(), raw });
      continue;
    }

    lines.push({ lineNo, type: "other", text: trimmed, raw });
  }

  if (!scenes.length && bodyStartIndex < 0) {
    parseWarnings.push("内容中未找到任何可解析的场次与台词");
  }

  return {
    name: fileName,
    episodeNo,
    titleLine,
    chapterRange,
    chapterRangeRaw,
    bodyStartLine: bodyStartIndex >= 0 ? bodyStartIndex + 1 : 0,
    rawLines,
    scenes,
    lines,
    parseWarnings,
  };
}

/* ==================== 时长折算 ==================== */

export type DurationStatus = "ok" | "borderline" | "over" | "under";

export interface DurationEstimate {
  dialogueChars: number;
  dialogueLines: number;
  actionChars: number;
  actionLines: number;
  sceneCount: number;
  /** 快语速估算（下界，秒） */
  lowerSeconds: number;
  /** 慢语速估算（上界，秒） */
  upperSeconds: number;
  status: DurationStatus;
  /** 骑线/越界说明 */
  detail: string;
}

function countChars(text: string): number {
  return String(text ?? "").replace(/\s+/g, "").length;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function estimateWithPreset(parsed: ParsedEpisode, preset: DurationPreset) {
  let dialogueChars = 0;
  let dialogueLines = 0;
  let actionChars = 0;
  let actionLines = 0;

  for (const line of parsed.lines) {
    if (line.type === "dialogue" || line.type === "os" || line.type === "vs") {
      const chars = countChars(line.text);
      dialogueChars += chars;
      dialogueLines += 1;
      continue;
    }
    if (line.type === "action") {
      actionChars += countChars(line.text);
      actionLines += 1;
    }
  }

  const sceneCount = Math.max(parsed.scenes.length, 1);
  const dialogueSeconds = dialogueChars / preset.dialogueCharsPerSecond;
  const actionSeconds = actionChars / preset.actionCharsPerSecond;
  const actionSecondsWithFloor = actionLines * preset.minActionSecondsPerLine;
  const transitionSeconds = sceneCount * preset.transitionSecondsPerScene;
  const total = dialogueSeconds + Math.max(actionSeconds, actionSecondsWithFloor) + transitionSeconds;

  return { dialogueChars, dialogueLines, actionChars, actionLines, sceneCount, seconds: total };
}

export function estimateEpisodeDuration(
  parsed: ParsedEpisode,
  config: ScriptCheckConfig = SCRIPT_CHECK_CONFIG,
): DurationEstimate {
  const { minSeconds, maxSeconds, fast, slow } = config.duration;
  const fastResult = estimateWithPreset(parsed, fast);
  const slowResult = estimateWithPreset(parsed, slow);
  const lowerSeconds = round1(fastResult.seconds);
  const upperSeconds = round1(slowResult.seconds);

  let status: DurationStatus = "ok";
  let detail = "区间落在 100-130 秒内";
  if (lowerSeconds > maxSeconds) {
    status = "over";
    detail = `整体超限：下限 ${lowerSeconds}s 已超过 ${maxSeconds}s`;
  } else if (upperSeconds < minSeconds) {
    status = "under";
    detail = `整体不足：上限 ${upperSeconds}s 仍低于 ${minSeconds}s`;
  } else if (lowerSeconds < minSeconds) {
    status = "borderline";
    detail = `骑线：下限 ${lowerSeconds}s 低于 ${minSeconds}s，需按语义裁量`;
  } else if (upperSeconds > maxSeconds) {
    status = "borderline";
    detail = `骑线：上限 ${upperSeconds}s 超过 ${maxSeconds}s，需按语义裁量`;
  }

  return {
    dialogueChars: fastResult.dialogueChars,
    dialogueLines: fastResult.dialogueLines,
    actionChars: fastResult.actionChars,
    actionLines: fastResult.actionLines,
    sceneCount: fastResult.sceneCount,
    lowerSeconds,
    upperSeconds,
    status,
    detail,
  };
}

/* ==================== 下游口径预演（与分镜端同一把尺子） ==================== */

/**
 * 台词单元：拆集落刀的最小粒度（一行台词一个单元）。
 * 边界级别用于让拆集算法优先落在场/节拍边界，实在不行才切在对话轮次之间。
 */
export function buildCapacityUnits(parsed: ParsedEpisode): CapacityUnit[] {
  const isSpoken = (line: ScriptLine) => line.type === "dialogue" || line.type === "os" || line.type === "vs";
  const sceneCodeAt = (lineNo: number): string => {
    let code = parsed.scenes[0]?.sceneCode ?? "1-1";
    for (const scene of parsed.scenes) {
      if (scene.lineNo <= lineNo) code = scene.sceneCode;
      else break;
    }
    return code;
  };

  const units: CapacityUnit[] = [];
  for (let index = 0; index < parsed.lines.length; index += 1) {
    const line = parsed.lines[index];
    if (!isSpoken(line)) continue;
    const text = String(line.text ?? "").replace(/\s+/g, "");
    const markCount = (text.match(/[，。！？；、…—·,.!?;:]/g) ?? []).length;
    const sceneCode = sceneCodeAt(line.lineNo);

    let next: ScriptLine | undefined;
    for (let cursor = index + 1; cursor < parsed.lines.length; cursor += 1) {
      if (isSpoken(parsed.lines[cursor])) {
        next = parsed.lines[cursor];
        break;
      }
    }
    let boundaryAfter: CapacityBoundaryLevel = "exchange";
    if (!next) {
      boundaryAfter = "scene";
    } else if (sceneCodeAt(next.lineNo) !== sceneCode) {
      boundaryAfter = "scene";
    } else if (next.lineNo !== line.lineNo + 1) {
      // 两条台词之间夹着 △ 动作行 → 节拍边界，优先在此落刀
      boundaryAfter = "beat";
    }

    units.push({
      id: `L${line.lineNo}`,
      label: `${sceneCode}·第${line.lineNo}行`,
      chars: Math.max(0, text.length - markCount),
      marks: markCount,
      lines: 1,
      boundaryAfter,
    });
  }
  return units;
}

export interface EpisodeCapacityPreview {
  load: DialogueLoad;
  timing: DialogueTiming;
  estimate: EpisodeCapacityEstimate;
  /** 需要拆集时给出的语义边界拆集方案（可直接执行） */
  splitPlan?: EpisodeSplitPlan;
}

/**
 * 写出剧本前先按分镜端口径预演：能不能装下、要不要拆集、怎么拆。
 * 与骨架层/分镜层共用 `@/agents/shared/episodeCapacity`，不再各算各的。
 */
export function previewEpisodeCapacity(
  parsed: ParsedEpisode,
  budget = EPISODE_CAPACITY_BUDGET,
): EpisodeCapacityPreview {
  const units = buildCapacityUnits(parsed);
  const load: DialogueLoad = units.reduce<DialogueLoad>(
    (sum, unit) => ({ chars: sum.chars + unit.chars, marks: sum.marks + unit.marks, lines: sum.lines + unit.lines }),
    { chars: 0, marks: 0, lines: 0 },
  );
  const timing = estimateDialogueTiming(load);
  const estimate = estimateLoadCapacity(load, budget);
  const preview: EpisodeCapacityPreview = { load, timing, estimate };
  if (estimate.result.level === "splitRequired" || estimate.result.level === "splitPressure") {
    preview.splitPlan = planEpisodeSplit(units, budget);
  }
  return preview;
}

/** 拆集方案渲染（报告与监督注入共用；parts 每行含台词分配与预计时长） */
export function renderSplitPlanTable(plan: EpisodeSplitPlan): string[] {
  const lines: string[] = [];
  lines.push("| 拆后集 | 台词范围 | 条数 | 净字数 | 标点 | 台词下限 | 台词安全 | 预计时长 | 结论 |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const part of plan.parts) {
    const { timing } = part.estimate;
    const safeText =
      timing.splitSafeSeconds > timing.safeSeconds
        ? `${timing.safeSeconds}s（长台词拆镜后 ≈${timing.splitSafeSeconds}s）`
        : `${timing.safeSeconds}s`;
    lines.push(
      `| 新EP${String(part.index).padStart(2, "0")} | ${part.label} | ${part.load.lines} | ${part.load.chars} | ${part.load.marks} | ${timing.floorSeconds}s | ${safeText} | ${part.estimate.totalSeconds}s | ${capacityLevelMark(part.estimate.result.level)} |`,
    );
  }
  return lines;
}

/* ==================== 台词比对 ==================== */

/**
 * 归一化用于"逐字保留"比对：只保留文字与数字，剔除空白与全部标点。
 * 这样「马上！」与「马上。」视为同一句（标点差异不算改写台词），
 * 文字层面的增删改仍可被检出。
 */
export function normalizeForCompare(input: string): string {
  return String(input ?? "").replace(/[^\p{L}\p{N}]/gu, "");
}

export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
    }
    previous = [...current];
  }
  return previous[b.length];
}

export function similarityRatio(a: string, b: string): number {
  const left = String(a ?? "");
  const right = String(b ?? "");
  if (!left.length && !right.length) return 1;
  if (!left.length || !right.length) return 0;
  if (left === right) return 1;
  const distance = levenshteinDistance(left, right);
  return 1 - distance / Math.max(left.length, right.length);
}

export interface DialogueMatch {
  script: string;
  novel: string;
  lineNo: number;
  similarity: number;
}

export interface SuspectAddedDialogue {
  script: string;
  lineNo: number;
  bestNovel?: string;
  similarity?: number;
}

export interface DialogueDiff {
  verbatim: DialogueMatch[];
  rewritten: DialogueMatch[];
  suspectAdded: SuspectAddedDialogue[];
  notAdopted: string[];
  unmatchedShort: number;
  counts: {
    scriptDialogues: number;
    novelQuotes: number;
    verbatim: number;
    rewritten: number;
    suspectAdded: number;
    unmatchedShort: number;
    notAdopted: number;
  };
}

export function extractScriptDialogues(parsed: ParsedEpisode): ScriptLine[] {
  return parsed.lines.filter((line) => line.type === "dialogue" && line.text.trim().length > 0);
}

export function extractNovelQuotes(text: string, config: ScriptCheckConfig = SCRIPT_CHECK_CONFIG): string[] {
  const { minQuoteLength, maxQuoteLength } = config.dialogue;
  const pattern = /[“"「『]([^”"」』\n]{1,120})[”"」』]/g;
  const quotes: string[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(String(text ?? ""))) !== null) {
    const quote = match[1].trim();
    const normalized = normalizeForCompare(quote);
    if (normalized.length < minQuoteLength || normalized.length > maxQuoteLength) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    quotes.push(quote);
  }
  return quotes;
}

export function diffDialogue(
  scriptLines: ScriptLine[],
  novelQuotes: string[],
  config: ScriptCheckConfig = SCRIPT_CHECK_CONFIG,
): DialogueDiff {
  const { similarityThreshold, minSuspectAddedLength, minVerbatimSubstringLength } = config.dialogue;
  const dialogues = scriptLines.filter((line) => line.type === "dialogue" && line.text.trim().length > 0);
  const quoteEntries = novelQuotes
    .map((quote) => ({ raw: quote, norm: normalizeForCompare(quote) }))
    .filter((entry) => entry.norm.length > 0);
  const usedQuotes = new Set<number>();

  const verbatim: DialogueMatch[] = [];
  const rewritten: DialogueMatch[] = [];
  const suspectAdded: SuspectAddedDialogue[] = [];
  let unmatchedShort = 0;

  for (const line of dialogues) {
    const norm = normalizeForCompare(line.text);
    if (!norm) continue;

    const exactIndex = quoteEntries.findIndex((entry) => entry.norm === norm);
    if (exactIndex >= 0) {
      verbatim.push({ script: line.text, novel: quoteEntries[exactIndex].raw, lineNo: line.lineNo, similarity: 1 });
      usedQuotes.add(exactIndex);
      continue;
    }

    // 拆分/截取但不改写（原文句以子串形式逐字出现）视为逐字保留
    const substringIndex = quoteEntries.findIndex((entry) => {
      if (entry.norm.length >= minVerbatimSubstringLength && norm.includes(entry.norm)) return true;
      return norm.length >= minVerbatimSubstringLength && entry.norm.includes(norm);
    });
    if (substringIndex >= 0) {
      verbatim.push({
        script: line.text,
        novel: quoteEntries[substringIndex].raw,
        lineNo: line.lineNo,
        similarity: 1,
      });
      usedQuotes.add(substringIndex);
      continue;
    }

    let bestIndex = -1;
    let bestRatio = 0;
    quoteEntries.forEach((entry, index) => {
      const maxLength = Math.max(entry.norm.length, norm.length);
      if (maxLength === 0) return;
      // 长度差剪枝：差距过大时相似度不可能达到阈值
      if (Math.abs(entry.norm.length - norm.length) / maxLength > 1 - similarityThreshold) return;
      const ratio = similarityRatio(norm, entry.norm);
      if (ratio > bestRatio) {
        bestRatio = ratio;
        bestIndex = index;
      }
    });

    if (bestIndex >= 0 && bestRatio >= similarityThreshold) {
      rewritten.push({
        script: line.text,
        novel: quoteEntries[bestIndex].raw,
        lineNo: line.lineNo,
        similarity: Math.round(bestRatio * 100) / 100,
      });
      usedQuotes.add(bestIndex);
      continue;
    }

    if (norm.length >= minSuspectAddedLength) {
      suspectAdded.push({
        script: line.text,
        lineNo: line.lineNo,
        bestNovel: bestIndex >= 0 ? quoteEntries[bestIndex].raw : undefined,
        similarity: bestIndex >= 0 ? Math.round(bestRatio * 100) / 100 : undefined,
      });
      continue;
    }

    unmatchedShort += 1;
  }

  const notAdopted = quoteEntries.filter((_, index) => !usedQuotes.has(index)).map((entry) => entry.raw);

  return {
    verbatim,
    rewritten,
    suspectAdded,
    notAdopted,
    unmatchedShort,
    counts: {
      scriptDialogues: dialogues.length,
      novelQuotes: quoteEntries.length,
      verbatim: verbatim.length,
      rewritten: rewritten.length,
      suspectAdded: suspectAdded.length,
      unmatchedShort,
      notAdopted: notAdopted.length,
    },
  };
}

/* ==================== 红线扫描 ==================== */

export type RedlineCategory = "格式禁止项" | "内容红线" | "结构校验";

export interface RedlineHit {
  category: RedlineCategory;
  rule: string;
  severity: CheckSeverity;
  lineNo?: number;
  excerpt: string;
  note?: string;
}

const SHOT_TECH_PATTERN =
  /缓推|急推|推镜|拉镜|摇镜|移镜|跟镜|运镜|机位|景别|升格|降格|俯拍|仰拍|平拍/;
const SHOT_LENGTH_PATTERN = /(?:全景|远景|中景|近景|特写)\s*(?:镜头|景别|画面|视角|效果|，|,|。|；|;|、|）|\)|】|$)/;
const SECOND_MARK_PATTERN =
  /约\s*\d+(?:\.\d+)?\s*秒|（[^）]*\d+(?:\.\d+)?\s*秒[^）]*）|\([^)]*\d+(?:\.\d+)?\s*秒[^)]*\)|\d+(?:\.\d+)?\s*秒[·、]/;
const ACT_MARK_PATTERN = /第\s*[一二三四五六七八九十\d]+\s*幕/;
const BEAT_TIME_PATTERN = /\d+\s*s\s*[-–—]\s*\d+\s*s/i;
const STORYBOARD_PATTERN = /分镜|逐片段|时间轴|10\s*\/\s*12\s*\/\s*15/;
const META_PATTERN = /字数\s*[:：]|共\s*\d+\s*字|场景数量|台词字数|创作说明|本集共\s*\d+/;
const VERSION_PATTERN = /修订版|终稿|定稿|最终版|v\s*\d+(?:\.\d+)*/i;

function excerptOf(raw: string, limit = 60): string {
  const text = String(raw ?? "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export function scanRedlines(
  parsed: ParsedEpisode,
  config: ScriptCheckConfig = SCRIPT_CHECK_CONFIG,
): RedlineHit[] {
  const hits: RedlineHit[] = [];

  // 版本标记只查标题位（技能规定集标题不得附加版本后缀）
  if (parsed.titleLine && VERSION_PATTERN.test(parsed.titleLine)) {
    hits.push({
      category: "格式禁止项",
      rule: "集标题版本标记",
      severity: "阻塞",
      excerpt: excerptOf(parsed.titleLine),
    });
  }

  for (const line of parsed.lines) {
    const isDescription = line.type === "action" || line.type === "other";

    if (isDescription) {
      if (SHOT_TECH_PATTERN.test(line.text) || SHOT_LENGTH_PATTERN.test(line.text) || SECOND_MARK_PATTERN.test(line.text)) {
        hits.push({
          category: "格式禁止项",
          rule: "镜头技术/秒数标注",
          severity: "阻塞",
          lineNo: line.lineNo,
          excerpt: excerptOf(line.raw),
        });
      }
      if (ACT_MARK_PATTERN.test(line.text) || BEAT_TIME_PATTERN.test(line.text)) {
        hits.push({
          category: "格式禁止项",
          rule: "幕/节拍时间标注",
          severity: "阻塞",
          lineNo: line.lineNo,
          excerpt: excerptOf(line.raw),
        });
      }
    }

    if (STORYBOARD_PATTERN.test(line.text)) {
      hits.push({
        category: "格式禁止项",
        rule: "分镜/时间轴信息",
        severity: "阻塞",
        lineNo: line.lineNo,
        excerpt: excerptOf(line.raw),
      });
    }

    if (META_PATTERN.test(line.text)) {
      hits.push({
        category: "格式禁止项",
        rule: "统计/创作元信息",
        severity: "阻塞",
        lineNo: line.lineNo,
        excerpt: excerptOf(line.raw),
      });
    }

    const titleHit = config.redline.officialTitleWords.filter((word) => line.text.includes(word));
    if (titleHit.length) {
      const longest = titleHit.sort((a, b) => b.length - a.length)[0];
      hits.push({
        category: "内容红线",
        rule: "现实官职称谓",
        severity: "阻塞",
        lineNo: line.lineNo,
        excerpt: excerptOf(line.raw),
        note: `命中“${longest}”，短剧不得使用现实官职称谓`,
      });
    }
  }

  // 结构校验
  if (parsed.episodeNo === undefined) {
    hits.push({
      category: "结构校验",
      rule: "集号缺失",
      severity: "提示",
      excerpt: excerptOf(parsed.name),
      note: "剧本名称应含 EP{NN}",
    });
  }
  if (parsed.titleLine && parsed.name && parsed.titleLine !== parsed.name) {
    hits.push({
      category: "结构校验",
      rule: "名称与首行标题不一致",
      severity: "提示",
      excerpt: excerptOf(`${parsed.name} ≠ ${parsed.titleLine}`),
    });
  }

  const sceneCodes = parsed.scenes.map((scene) => scene.sceneCode.split("-").map(Number));
  for (let index = 1; index < sceneCodes.length; index += 1) {
    const [prevEpisode, prevScene] = sceneCodes[index - 1];
    const [episode, scene] = sceneCodes[index];
    const normalJump = episode === prevEpisode && scene === prevScene + 1;
    const nextEpisodeJump = episode === prevEpisode + 1 && scene === 1;
    if (!normalJump && !nextEpisodeJump) {
      hits.push({
        category: "结构校验",
        rule: "场号不连续",
        severity: "提示",
        lineNo: parsed.scenes[index].lineNo,
        excerpt: `${sceneCodes[index - 1].join("-")} → ${sceneCodes[index].join("-")}`,
      });
    }
  }

  const dividerCount = parsed.lines.filter((line) => DIVIDER_PATTERN.test(line.text)).length;
  if (parsed.scenes.length > 1 && dividerCount < parsed.scenes.length - 1) {
    hits.push({
      category: "结构校验",
      rule: "场景分隔不足",
      severity: "提示",
      excerpt: `场次 ${parsed.scenes.length} 个，但“---”分隔仅 ${dividerCount} 处`,
    });
  }

  return hits;
}

/* ==================== 读库入口 ==================== */

export interface EpisodeCheckResult {
  name: string;
  episodeNo?: number;
  chapterRange?: { start: number; end: number } | null;
  duration?: DurationEstimate;
  dialogue?: DialogueDiff;
  /** 下游口径预演（与分镜端同一把尺子）：逐字保留下的下限/安全时长、三态与拆集方案 */
  capacity?: EpisodeCapacityPreview;
  redlines: RedlineHit[];
  parseWarnings: string[];
  error?: string;
}

export interface ScriptCheckReport {
  generatedAt: number;
  projectId: number;
  episodes: EpisodeCheckResult[];
  summary: {
    episodeCount: number;
    blockingCount: number;
    noticeCount: number;
    durationOver: string[];
    durationUnder: string[];
    durationBorderline: string[];
    /** 下游口径：必拆/建议拆集（阻塞）与可骑线执行（提示）的集 */
    capacitySplit: string[];
    capacityRideLine: string[];
    capacityUnderflow: string[];
    rewrittenTotal: number;
    rewrittenReliable: number;
    suspectAddedTotal: number;
    suspectAddedReliable: number;
    chapterRangeUnknown: string[];
  };
}

export interface RunScriptChecksOptions {
  /** 只检查指定名称的剧本；不传则检查项目下全部剧本 */
  scriptNames?: string[];
  /** 单次检查最多加载的章节数（范围未知时的兜底），默认 300 */
  maxChapters?: number;
}

interface NovelRow {
  chapterIndex?: string | null;
  chapterData?: string | null;
}

interface ScriptRow {
  name?: string | null;
  content?: string | null;
}

function rowIndexNumber(row: NovelRow): number | undefined {
  const matched = String(row.chapterIndex ?? "").match(/\d+/);
  return matched ? Number(matched[0]) : undefined;
}

/* ==================== 结果缓存与事件循环让出 ==================== */

/** 同一次审核会多次触发确定性检查（宿主预注入 + 工具调用），用 TTL 缓存避免重复全量扫描 */
export const SCRIPT_CHECKS_CACHE_TTL_MS = 45_000;

/** 剧本指纹用的廉价散列（FNV-1a），只用来判定"内容是否变过"，不做安全用途 */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** 缓存键：项目 + 检查范围 + 剧本指纹（名称与内容变化都会导致失效） */
export function buildScriptChecksCacheKey(
  projectId: number,
  scripts: ScriptRow[],
  options: RunScriptChecksOptions = {},
): string {
  const fingerprint = scripts
    .map((row) => `${String(row.name ?? "")}#${fnv1a(String(row.content ?? ""))}`)
    .sort()
    .join("|");
  const scope = (options.scriptNames ?? []).slice().sort().join(",");
  return `${projectId}::${options.maxChapters ?? 300}::${scope}::${fingerprint}`;
}

/** 极简单条 TTL 缓存：键不一致或过期即视为未命中 */
export class ScriptChecksCache {
  private entry: { key: string; expiresAt: number; report: ScriptCheckReport } | null = null;

  constructor(private readonly ttlMs: number = SCRIPT_CHECKS_CACHE_TTL_MS) {}

  read(key: string, now: number = Date.now()): ScriptCheckReport | null {
    if (!this.entry || this.entry.key !== key || this.entry.expiresAt <= now) return null;
    return this.entry.report;
  }

  write(key: string, report: ScriptCheckReport, now: number = Date.now()) {
    this.entry = { key, expiresAt: now + this.ttlMs, report };
  }

  clear() {
    this.entry = null;
  }
}

export const scriptChecksCache = new ScriptChecksCache();

/** 让出事件循环：避免整轮扫描长时间独占线程导致心跳/推送被阻塞 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export async function runScriptChecks(
  projectIdValue: number,
  options: RunScriptChecksOptions = {},
): Promise<ScriptCheckReport> {
  const { default: u } = await import("@/utils");
  const projectId = Number(projectIdValue);
  const generatedAt = Date.now();

  const emptyReport: ScriptCheckReport = {
    generatedAt,
    projectId,
    episodes: [],
    summary: {
      episodeCount: 0,
      blockingCount: 0,
      noticeCount: 0,
      durationOver: [],
      durationUnder: [],
      durationBorderline: [],
      capacitySplit: [],
      capacityRideLine: [],
      capacityUnderflow: [],
      rewrittenTotal: 0,
      rewrittenReliable: 0,
      suspectAddedTotal: 0,
      suspectAddedReliable: 0,
      chapterRangeUnknown: [],
    },
  };
  if (!Number.isSafeInteger(projectId) || projectId <= 0) return emptyReport;

  const scriptRows = (await u
    .db("o_script")
    .where({ projectId })
    .select("name", "content")) as ScriptRow[];

  const allowNames = options.scriptNames?.length ? new Set(options.scriptNames) : undefined;
  const selectedRows = scriptRows.filter((row) => (allowNames ? allowNames.has(String(row.name ?? "")) : true));
  // 同一次审核里"宿主预注入"与"工具调用"会重复触发检查：命中 TTL 缓存直接复用上次结论
  const cacheKey = buildScriptChecksCacheKey(projectId, selectedRows, options);
  const cachedReport = scriptChecksCache.read(cacheKey);
  if (cachedReport) return cachedReport;

  const parsedEpisodes = selectedRows
    .map((row) => parseScriptEpisode(String(row.name ?? ""), String(row.content ?? "")))
    .sort((a, b) => (a.episodeNo ?? Number.MAX_SAFE_INTEGER) - (b.episodeNo ?? Number.MAX_SAFE_INTEGER));

  if (!parsedEpisodes.length) return emptyReport;

  // 章节文本按需加载
  const maxChapters = options.maxChapters ?? 300;
  const status = { truncated: false };
  const novelTextByIndex = await loadNovelTextByIndex(u.db as (table: string) => any, projectId, parsedEpisodes, maxChapters, status);

  const episodes: EpisodeCheckResult[] = [];
  for (const parsed of parsedEpisodes) {
    const result: EpisodeCheckResult = {
      name: parsed.name,
      episodeNo: parsed.episodeNo,
      chapterRange: parsed.chapterRange,
      redlines: [],
      parseWarnings: [...parsed.parseWarnings],
    };
    try {
      result.duration = estimateEpisodeDuration(parsed);
      // 写出剧本前先用分镜端口径预演：装不下就当场给拆集方案，避免"剧本通过、分镜爆炸"
      result.capacity = previewEpisodeCapacity(parsed);
      result.redlines = scanRedlines(parsed);

      const chapterTexts: string[] = [];
      if (parsed.chapterRange) {
        for (let index = parsed.chapterRange.start; index <= parsed.chapterRange.end; index += 1) {
          const text = novelTextByIndex.get(index);
          if (text) chapterTexts.push(text);
        }
        if (!chapterTexts.length) result.parseWarnings.push("原著范围内未读取到章节原文，跳过原文台词比对");
      } else {
        for (const text of novelTextByIndex.values()) chapterTexts.push(text);
        if (chapterTexts.length) result.parseWarnings.push("原著范围未识别，已按全量章节比对");
      }

      if (chapterTexts.length) {
        const quotes = extractNovelQuotes(chapterTexts.join("\n"));
        result.dialogue = diffDialogue(extractScriptDialogues(parsed), quotes);
      }
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
    }
    episodes.push(result);
    // 逐集让出事件循环：单集内的原文台词比对是同步重计算，连续跑完整批次会长时间独占线程
    await yieldToEventLoop();
  }

  const redlineBlockingCount = episodes.reduce(
    (total, episode) => total + episode.redlines.filter((hit) => hit.severity === "阻塞").length,
    0,
  );
  const noticeCount = episodes.reduce(
    (total, episode) => total + episode.redlines.filter((hit) => hit.severity === "提示").length,
    0,
  );
  // 容量预演阻塞：必拆/建议拆集（相当于"这一集按分镜口径装不下"，必须在写分镜前处理）
  const capacitySplitEpisodes = episodes.filter(
    (episode) => episode.capacity && isBlockingCapacityLevel(episode.capacity.estimate.result.level),
  );
  const blockingCount = redlineBlockingCount + capacitySplitEpisodes.length;

  const report: ScriptCheckReport = {
    generatedAt,
    projectId,
    episodes,
    summary: {
      episodeCount: episodes.length,
      blockingCount,
      noticeCount,
      durationOver: episodes.filter((episode) => episode.duration?.status === "over").map((episode) => episodeLabel(episode)),
      durationUnder: episodes.filter((episode) => episode.duration?.status === "under").map((episode) => episodeLabel(episode)),
      durationBorderline: episodes
        .filter((episode) => episode.duration?.status === "borderline")
        .map((episode) => episodeLabel(episode)),
      capacitySplit: capacitySplitEpisodes.map((episode) => episodeLabel(episode)),
      capacityRideLine: episodes
        .filter((episode) => episode.capacity?.estimate.result.level === "rideLine")
        .map((episode) => episodeLabel(episode)),
      capacityUnderflow: episodes
        .filter((episode) => episode.capacity?.estimate.result.level === "underflow")
        .map((episode) => episodeLabel(episode)),
      rewrittenTotal: episodes.reduce((total, episode) => total + (episode.dialogue?.counts.rewritten ?? 0), 0),
      rewrittenReliable: episodes
        .filter((episode) => episode.chapterRange)
        .reduce((total, episode) => total + (episode.dialogue?.counts.rewritten ?? 0), 0),
      suspectAddedTotal: episodes.reduce((total, episode) => total + (episode.dialogue?.counts.suspectAdded ?? 0), 0),
      suspectAddedReliable: episodes
        .filter((episode) => episode.chapterRange)
        .reduce((total, episode) => total + (episode.dialogue?.counts.suspectAdded ?? 0), 0),
      chapterRangeUnknown: episodes.filter((episode) => !episode.chapterRange).map((episode) => episodeLabel(episode)),
    },
  };
  if (status.truncated) {
    report.episodes[0]?.parseWarnings.push(`章节加载数量超过上限 ${maxChapters}，原文比对仅覆盖部分章节`);
  }
  scriptChecksCache.write(cacheKey, report);
  return report;
}

async function loadNovelTextByIndex(
  // knex 实例类型随 @/utils 导出，避免在此处引入额外依赖，使用结构化最小类型
  db: (table: string) => any,
  projectId: number,
  parsedEpisodes: ParsedEpisode[],
  maxChapters: number,
  status: { truncated: boolean },
): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  const needed = new Set<number>();
  let needAll = false;

  for (const parsed of parsedEpisodes) {
    if (parsed.chapterRange) {
      for (let index = parsed.chapterRange.start; index <= parsed.chapterRange.end; index += 1) needed.add(index);
    } else {
      needAll = true;
    }
  }

  const indexRows = (await db("o_novel").where({ projectId }).select("chapterIndex")) as NovelRow[];
  const valueByIndex = new Map<number, string>();
  for (const row of indexRows) {
    const index = rowIndexNumber(row);
    if (index === undefined) continue;
    if (!needAll && !needed.has(index)) continue;
    if (valueByIndex.size >= maxChapters) {
      status.truncated = true;
      break;
    }
    valueByIndex.set(index, String(row.chapterIndex ?? ""));
  }
  if (!valueByIndex.size) return result;

  const rows = (await db("o_novel")
    .where({ projectId })
    .whereIn("chapterIndex", [...valueByIndex.values()])
    .select("chapterIndex", "chapterData")) as NovelRow[];

  for (const row of rows) {
    const index = rowIndexNumber(row);
    if (index === undefined) continue;
    const text = String(row.chapterData ?? "");
    if (text.trim()) result.set(index, text);
  }
  return result;
}

/* ==================== 报告输出 ==================== */

export function episodeLabel(episode: { episodeNo?: number; name: string }): string {
  return episode.episodeNo !== undefined ? `EP${String(episode.episodeNo).padStart(2, "0")}` : episode.name;
}

export function reportToMarkdown(report: ScriptCheckReport): string {
  const lines: string[] = [];
  const { summary } = report;
  const scope = report.episodes.map((episode) => episodeLabel(episode)).join("、") || "无";

  lines.push("## 确定性检查结果（由工具生成，审核报告必须原样引用，不得改写结论）");
  lines.push("");
  lines.push(`- 检查范围：${scope}（共 ${summary.episodeCount} 集）`);
  lines.push(
    `- 参考折算（连续朗读口径，仅供对照）：台词 ${SCRIPT_CHECK_CONFIG.duration.fast.dialogueCharsPerSecond}→${SCRIPT_CHECK_CONFIG.duration.slow.dialogueCharsPerSecond} 字/秒，动作 ${SCRIPT_CHECK_CONFIG.duration.fast.actionCharsPerSecond}→${SCRIPT_CHECK_CONFIG.duration.slow.actionCharsPerSecond} 字/秒，场转换 ${SCRIPT_CHECK_CONFIG.duration.fast.transitionSecondsPerScene}→${SCRIPT_CHECK_CONFIG.duration.slow.transitionSecondsPerScene} 秒/场`,
  );
  lines.push(
    `- 判定口径（下游口径为准，与分镜端同一把尺子）：刚性台词下限 = 净字数 ÷ ${DIALOGUE_PACING.hardCharsPerSecond} + ${DIALOGUE_PACING.hardBufferSeconds} × 台词条数；台词安全时长 = 净字数 ÷ ${DIALOGUE_PACING.safeCharsPerSecond} + ${DIALOGUE_PACING.safePausePerMark} × 标点 + ${DIALOGUE_PACING.safeBufferSeconds} × 条数；预计时长 = 台词安全时长 + 动作/非台词预算 ${EPISODE_CAPACITY_BUDGET.actionReferenceSeconds}s`,
  );
  lines.push(
    `- 分级：必拆（台词下限 + 最小动作预算 ${EPISODE_CAPACITY_BUDGET.actionMinimumSeconds}s > ${EPISODE_CAPACITY_BUDGET.maxSeconds}s）或骑线占比 > ${Math.round(EPISODE_CAPACITY_BUDGET.rideLineRatioThreshold * 100)}% = 阻塞（须先拆集再写分镜，台词逐字保留）；骑线项（≤${Math.round(EPISODE_CAPACITY_BUDGET.rideLineRatioThreshold * 100)}%）= 提示，不得作为返工理由；素材不足 = 提示（考虑并集）；红线命中 = 阻塞`,
  );
  lines.push(
    `- 容量查表（单集安全线内可承载台词，动作预算 ${EPISODE_CAPACITY_BUDGET.actionReferenceSeconds}s）：${formatCapacityTable(EPISODE_CAPACITY_BUDGET).join("；")}`,
  );
  lines.push("");

  lines.push("### 1. 单集时长折算");
  lines.push("");
  lines.push("| 集 | 台词字数 | 台词行 | 动作条数 | 场数 | 估算区间(秒) | 判定 |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const episode of report.episodes) {
    const estimate = episode.duration;
    if (!estimate) {
      lines.push(`| ${episodeLabel(episode)} | - | - | - | - | - | 检查失败 |`);
      continue;
    }
    const statusLabel =
      estimate.status === "ok"
        ? "通过"
        : estimate.status === "borderline"
          ? `骑线（${estimate.detail}）`
          : estimate.status === "over"
            ? `超限（${estimate.detail}）`
            : `不足（${estimate.detail}）`;
    lines.push(
      `| ${episodeLabel(episode)} | ${estimate.dialogueChars} | ${estimate.dialogueLines} | ${estimate.actionLines} | ${estimate.sceneCount} | ${estimate.lowerSeconds}-${estimate.upperSeconds} | ${statusLabel} |`,
    );
  }
  lines.push("");

  lines.push("### 2. 下游口径预演（与分镜端同一把尺子）");
  lines.push("");
  lines.push("| 集 | 台词条数 | 净字数 | 标点 | 刚性台词下限 | 台词安全 | 预计时长 | 三态 | 建议拆集 |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const episode of report.episodes) {
    const capacity = episode.capacity;
    if (!capacity) {
      lines.push(`| ${episodeLabel(episode)} | - | - | - | - | - | - | 检查失败 | - |`);
      continue;
    }
    const splitNote = capacity.estimate.result.splitCount && capacity.estimate.result.splitCount > 1
      ? `${capacity.estimate.result.splitCount} 集`
      : "-";
    lines.push(
      `| ${episodeLabel(episode)} | ${capacity.load.lines} | ${capacity.load.chars} | ${capacity.load.marks} | ${capacity.timing.floorSeconds}s | ${capacity.timing.safeSeconds}s | ${capacity.estimate.totalSeconds}s | ${capacityLevelMark(capacity.estimate.result.level)} | ${splitNote} |`,
    );
  }
  lines.push("");
  for (const episode of report.episodes) {
    const capacity = episode.capacity;
    if (!capacity) continue;
    lines.push(`- ${episodeLabel(episode)}：${capacity.estimate.result.verdict}`);
    lines.push(`  - 处理建议：${capacity.estimate.result.advice}`);
    const splitOverhead = describeSplitOverhead(capacity.timing);
    if (splitOverhead) lines.push(`  - 预排余量：${splitOverhead}`);
    if (capacity.splitPlan && capacity.splitPlan.parts.length > 1) {
      lines.push(`  - 拆集方案（落刀于场/节拍/对话轮次边界，台词逐字保留）：`);
      lines.push(...renderSplitPlanTable(capacity.splitPlan).map((row) => `    ${row}`));
    }
  }
  lines.push("");

  lines.push("### 3. 原文台词逐字比对");
  lines.push("");
  const withDialogue = report.episodes.filter((episode) => episode.dialogue);
  if (!withDialogue.length) {
    lines.push("未执行（缺少原著范围内章节原文或范围未识别）。");
  } else {
    lines.push("| 集 | 原著范围 | 剧本台词句 | 原文句 | 逐字保留 | 改写 | 疑似新增 | 未采用 |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const episode of withDialogue) {
      const counts = episode.dialogue!.counts;
      const scope = episode.chapterRange
        ? episode.chapterRange.start === episode.chapterRange.end
          ? `第${episode.chapterRange.start}章`
          : `第${episode.chapterRange.start}-${episode.chapterRange.end}章`
        : "未知（结果仅供参考）";
      lines.push(
        `| ${episodeLabel(episode)} | ${scope} | ${counts.scriptDialogues} | ${counts.novelQuotes} | ${counts.verbatim} | ${counts.rewritten} | ${counts.suspectAdded} | ${counts.notAdopted} |`,
      );
    }
    lines.push("");
    lines.push(
      "改写明细（原著范围可信时为违反“原文台词逐字保留”，按阻塞问题计；范围未知的集仅供参考、不计阻塞）：",
    );
    const rewrittenRows = withDialogue.flatMap((episode) =>
      episode.dialogue!.rewritten.map(
        (item) =>
          `- ${episodeLabel(episode)}${episode.chapterRange ? "" : "（范围未知）"} 第${item.lineNo}行（相似度 ${item.similarity}）：原文“${item.novel}”→ 剧本“${item.script}”`,
      ),
    );
    lines.push(...(rewrittenRows.length ? rewrittenRows : ["- 无"]));
    lines.push("");
    lines.push("疑似新增明细（范围可信且用户未授权新增对白时按阻塞问题计；范围未知的集仅供参考）：");
    const addedRows = withDialogue.flatMap((episode) =>
      episode.dialogue!.suspectAdded.map(
        (item) =>
          `- ${episodeLabel(episode)}${episode.chapterRange ? "" : "（范围未知）"} 第${item.lineNo}行：“${item.script}”`,
      ),
    );
    lines.push(...(addedRows.length ? addedRows : ["- 无"]));
    lines.push("");
    lines.push("未采用（信息项：短剧按场景选择性采用，不直接判违规，仅供取舍参考）：");
    const notAdoptedRows = withDialogue.flatMap((episode) =>
      episode.dialogue!.notAdopted.slice(0, 5).map((quote) => `- ${episodeLabel(episode)}：“${quote}”`),
    );
    lines.push(...(notAdoptedRows.length ? notAdoptedRows : ["- 无"]));
  }
  lines.push("");

  lines.push("### 4. 红线扫描");
  lines.push("");
  const redlineRows = report.episodes.flatMap((episode) =>
    episode.redlines.map(
      (hit) =>
        `| ${episodeLabel(episode)} | ${hit.category} | ${hit.rule} | ${hit.severity} | ${hit.lineNo ? `第${hit.lineNo}行` : "-"} | ${hit.excerpt} |`,
    ),
  );
  if (redlineRows.length) {
    lines.push("| 集 | 类别 | 规则 | 级别 | 位置 | 摘录 |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    lines.push(...redlineRows);
  } else {
    lines.push("无命中。");
  }
  lines.push("");

  const parseWarnings = report.episodes.flatMap((episode) =>
    episode.parseWarnings.map((warning) => `- ${episodeLabel(episode)}：${warning}`),
  );
  if (parseWarnings.length) {
    lines.push("### 5. 解析提示");
    lines.push("");
    lines.push(...parseWarnings);
    lines.push("");
  }

  lines.push("### 6. 汇总");
  lines.push("");
  lines.push(
    `- 阻塞项：${summary.blockingCount}（含红线命中与「必拆/建议拆集」集）；提示项（结构类）：${summary.noticeCount}`,
  );
  lines.push(
    `- 下游口径（逐字保留）：必拆/建议拆集 ${summary.capacitySplit.length ? summary.capacitySplit.join("、") : "无"}；可骑线执行 ${summary.capacityRideLine.length ? summary.capacityRideLine.join("、") : "无"}；素材不足 ${summary.capacityUnderflow.length ? summary.capacityUnderflow.join("、") : "无"}`,
  );
  lines.push(
    `- 参考口径（连续朗读）：超限 ${summary.durationOver.length ? summary.durationOver.join("、") : "无"}；不足 ${
      summary.durationUnder.length ? summary.durationUnder.join("、") : "无"
    }；骑线 ${summary.durationBorderline.length ? summary.durationBorderline.join("、") : "无"}`,
  );
  lines.push(
    `- 台词：改写 ${summary.rewrittenTotal} 处（范围可信 ${summary.rewrittenReliable} 处，其余仅供参考、不计阻塞）；疑似新增 ${summary.suspectAddedTotal} 处（范围可信 ${summary.suspectAddedReliable} 处）`,
  );
  if (summary.chapterRangeUnknown.length) {
    lines.push(`- 原著范围未识别：${summary.chapterRangeUnknown.join("、")}`);
  }
  lines.push("");
  lines.push("以上结论为工具判定的事实层，审核不得推翻；判断类维度（因果、动机、信息逻辑、钩子、节奏感受）仍由审核层裁量。");

  return lines.join("\n");
}
