/**
 * 骨架容量体检模块（分集规划阶段的"容量事实层"）
 *
 * 目的：把"这一集的素材量能不能装进单集时长"从主观判断变成确定性结论，
 * 让分集规划阶段就能发现超载，避免"剧本写完后才发现超长、多轮修复无法收敛"。
 *
 * 设计约束：
 * - 骨架阶段尚无剧本文本，以原著素材估算，且**口径与剧本层/分镜层完全一致**（共享模型
 *   `@/agents/shared/episodeCapacity`，三层唯一真源）：台词素材按"逐字保留"折算（不再有隐式采用率），
 *   计入每镜缓冲与标点停顿 → 刚性台词下限 L（物理下界）与安全时长；
 *   再叠加动作/非台词预算得到"预计时长 T"。
 * - 双判据：L 超上限 → 严重超载（铁证级，与动作预算无关）；
 *   T 与 上限 / 严重阈值 / 不足阈值 比较 → 四级判定（ok/lightOver/severeOver/under）；
 *   同时输出制作侧三态（通过/可骑线/建议拆集/必拆/素材不足）与建议拆集数、授权删减反算字数。
 * - 纯函数与 IO 分离：解析/统计/估算均为纯函数，可单测；只有 runSkeletonChecks 读库。
 * - 参数集中可调：阈值见 SKELETON_CHECK_CONFIG，折算公式见共享模型（禁止本文件自建第二套数字）。
 * - 份额口径：同一章素材在全剧分集中只按"份额"计一次（同一章合计 ≤ 1.0，避免"一章被 N 集引用就按 N 份整章台词计"）。
 *   份额推导优先级：显式标注（片段词/`(a/b)`/`p%`）→ 按场次占比 → 按引用集数等比推断 → 单集整章引用；
 *   推导来源随判定结果输出：报告中标记"推断"的份额为估计值，供审核区分事实与推断。
 * - 容量口径对齐制作侧真源：计划语速 4 字/秒（分镜表"台词按 4 字/秒计算"），
 *   片段 12/17 秒档 → 生成压缩为成片 10/15 秒 → 成片节奏 ≈ 4.5 字/秒（45 字/10 秒）。
 */

import {
  DIALOGUE_PACING,
  EPISODE_CAPACITY_BUDGET,
  ESTIMATE_SOURCE_LABELS,
  capacityLevelMark,
  dialogueCapacityMaxChars,
  estimateDialogueTiming,
  estimateEpisodeCapacity as estimateLoadCapacity,
  describeSplitOverhead,
  formatCapacityTable,
  inferDialogueLoad,
  suggestEpisodeCount,
  type EpisodeCapacityLevel,
} from "@/agents/shared/episodeCapacity";

export type SkeletonCheckLevel = "ok" | "lightOver" | "severeOver" | "under";

export interface SkeletonCheckConfig {
  budget: {
    /** 严重超载阈值：预计时长 > 上限 × 该系数 + 容差 判严重超载 */
    severeOverRatio: number;
    /** T 判据的最小超出量（秒）：超出阈值不足该值时降级为轻度，避免估算噪声造成边界抖动 */
    severeToleranceSeconds: number;
    /** 素材不足阈值：预计时长 < 下限 × 该系数 判素材不足 */
    underRatio: number;
  };
  /** 单集目标时长（秒） */
  episodeTarget: { minSeconds: number; maxSeconds: number };
  /** 章节片段词 → 素材权重（未命中任何片段词时按整章 1.0 计） */
  fragmentWeights: Record<string, number>;
  /** 份额推导参数（同一章素材在全剧分集中合计不超过 1.0） */
  share: {
    /** 场次号上限：超过该值视为异常标注，回退为等比推断 */
    maxSceneNumber: number;
    /** 未分配余量提示阈值：某章未分配到任何集的份额占比超过该值时提示 */
    unassignedWarnRatio: number;
    /** 份额超配合计容差：某章合计份额超过 1 + 该容差时按比例归一并提示 */
    overAllocationTolerance: number;
  };
  /** 台词素材统计的口径（引号内容长度下限/上限，与剧本阶段台词比对口径一致） */
  quote: { minChars: number; maxChars: number };
}

export const SKELETON_CHECK_CONFIG: SkeletonCheckConfig = {
  budget: {
    severeOverRatio: 1.2,
    severeToleranceSeconds: 1,
    underRatio: 0.85,
  },
  episodeTarget: { minSeconds: 100, maxSeconds: 130 },
  fragmentWeights: {
    前半: 0.5,
    后半: 0.5,
    前段: 0.5,
    中段: 0.34,
    后段: 0.33,
    收束前段: 0.25,
    收束: 0.2,
  },
  share: {
    maxSceneNumber: 60,
    unassignedWarnRatio: 0.1,
    overAllocationTolerance: 0.02,
  },
  quote: { minChars: 2, maxChars: 60 },
};

/* ==================== 解析 ==================== */

const CN_INDEX = "[0-9一二三四五六七八九十百零〇两]+";
const EPISODE_A_PATTERN = /^###\s*集\s*(\d+)\s*[：:]\s*(.+?)\s*$/;
const ASSIGN_SECTION_PATTERN = /章节分配/;
const FRAGMENT_PATTERN = "收束前段|收束|前半|后半|中段|后段|前段";
const CHAPTER_REF_PATTERN = new RegExp(
  `第\\s*(${CN_INDEX})\\s*(?:[-–—~～至]\\s*第?\\s*(${CN_INDEX}))?\\s*章\\s*(${FRAGMENT_PATTERN})?`,
  "g",
);
/** 片段词匹配器（用于在声明尾部里找出片段词，位置不限） */
const FRAGMENT_MATCHER = new RegExp(FRAGMENT_PATTERN);
/** 百分比（半角/全角，允许被括号或其它分隔符包裹，位置不限） */
const PERCENT_PATTERN = /(\d+(?:\.\d+)?)\s*[%％]/;
/** `(a/b)` 比例（半角/全角括号） */
const FRACTION_PATTERN = /[（(]\s*(\d+)\s*\/\s*(\d+)\s*[)）]/;
const WHOLE_CHAPTER_PATTERN = /(全章|整章|全篇)/;
/** 场次号：`第2场` 或 `2场`（章节处理列的 `1场2保留` 走 extractChapterHandlingUsages） */
const DECLARED_SCENE_PATTERN = /第\s*(\d+)\s*场|(\d+)\s*场/;

/**
 * 章节使用声明：`第X章 [片段词][（p%）|p%][(a/b)][全章][第N场]`。
 *
 * 关键：章号之后到"下一个「第X章」之前"的整段都作为尾部交给子模式解析，
 * 因此「片段词 + 括号百分比」（如 `第1章 前段（28%）`）这类写法不会再被漏读
 * （旧实现只认紧跟章号的裸 `p%`，会把片段词权重当成份额，导致同章多集相加 117% 而误报超配）。
 * 显式份额优先级：`(a/b)` > `p%`（含括号/全角）> 片段词权重 > 整章标记（1.0）。
 */
const CHAPTER_USAGE_PATTERN = new RegExp(
  `第\\s*(${CN_INDEX})\\s*(?:[-–—~～至]\\s*第?\\s*(${CN_INDEX}))?\\s*章` +
    `((?:(?!第\\s*${CN_INDEX}\\s*章)[^\\n]){0,80})`,
  "g",
);

/** 声明文本归一：去掉 Markdown 强调符与行内代码符，避免 `**前半**` 这类写法干扰解析 */
function normalizeDeclarationText(text: string): string {
  return String(text ?? "").replace(/[*`]/g, "");
}
/** 「章节处理」列条目：`1场5保留` / `2压缩` / `3删` */
const HANDLING_ENTRY_PATTERN = /^(\d+)\s*(?:场\s*(\d+))?\s*(保留|压缩|删|删除|删去|整场)?/;
/** 延后类标注：该行声明的章节内容被挪到别的集，不计入本集素材 */
const DEFERRED_MARKER_PATTERN = /顺延|移至|挪至|留待/;
/** 疑似未识别的片段写法（常见变体），命中时给出解析提示 */
const SUSPICIOUS_FRAGMENT_PATTERN = /第\s*(?:\d+|[一二三四五六七八九十百零〇两]+)\s*章\s*(上半|下半|前部|后部|开头|结尾|尾声|收束后段|中段后)/;
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

/** 解析章节编号：支持阿拉伯数字与中文数字（一/十五/一百零五） */
export function parseChapterNumber(input: string): number | undefined {
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

/** 份额来源：explicit=显式标注，scene=按场次占比，inferred=按引用集数等比推断，whole=单集整章引用 */
export type ChapterShareSource = "explicit" | "scene" | "inferred" | "whole";

/** 一条章节使用声明：该集用了某章的哪个片段/哪一场/多少份额 */
export interface ChapterUsage {
  chapter: number;
  /** 片段词（前半/后半/中段/后段/收束前段/收束/全章），无片段词时缺省 */
  fragment?: string;
  /** 显式份额（片段词权重 / `(a/b)` / `p%`），无显式标注时缺省 */
  explicitShare?: number;
  /** 该集声明使用的场次号（`第3章 第2场` / `3场2保留`） */
  sceneNo?: number;
  /** 是否被延后至其他集（顺延/移至），延后的内容不计入本集素材 */
  deferred?: boolean;
}

export interface SkeletonChapterRef {
  chapter: number;
  /** 片段词（前半/后半/中段/后段/收束前段/收束），无片段词时缺省 */
  fragment?: string;
  /** 该引用的素材权重 */
  weight: number;
  /** 归一后的份额（同一章在全剧分集上的合计不超过 1.0）；由份额计划回填 */
  share?: number;
  /** 份额推导来源；由份额计划回填 */
  shareSource?: ChapterShareSource;
}

export interface SkeletonEpisode {
  episodeNo: number;
  title: string;
  /** 标题中的章节范围原文（如"第1章后半+第2章前半"） */
  chapterText: string;
  chapterRefs: SkeletonChapterRef[];
  /** 章节使用声明明细（含场次/显式份额）；份额计划据此推导 */
  chapterUsages?: ChapterUsage[];
  sourceMode: "A" | "B";
}

/** 从一段文本中提取章节引用（支持"第1章后半+第2章前半""第3-8章""第12章收束前段"） */
export function extractChapterRefs(text: string, config: SkeletonCheckConfig = SKELETON_CHECK_CONFIG): SkeletonChapterRef[] {
  const refs: SkeletonChapterRef[] = [];
  const pattern = new RegExp(CHAPTER_REF_PATTERN.source, "g");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(String(text ?? ""))) !== null) {
    const start = parseChapterNumber(match[1]);
    if (start === undefined) continue;
    const end = match[2] !== undefined ? parseChapterNumber(match[2]) : undefined;
    const fragment = match[3];
    const weight = fragment ? (config.fragmentWeights[fragment] ?? 1) : 1;

    if (end !== undefined && end > start) {
      for (let chapter = start; chapter <= end; chapter += 1) {
        refs.push({ chapter, weight: 1 });
      }
      continue;
    }
    refs.push({ chapter: start, fragment, weight });
  }
  return refs;
}

/** 去重（同章同片段只计一次），保持出现顺序 */
function dedupeRefs(refs: SkeletonChapterRef[]): SkeletonChapterRef[] {
  const seen = new Set<string>();
  const result: SkeletonChapterRef[] = [];
  for (const ref of refs) {
    const key = `${ref.chapter}|${ref.fragment ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(ref);
  }
  return result;
}

/** 扫描骨架中的疑似未识别片段写法（如"第1章上半"），返回去空白后的原文列表 */
export function collectSuspiciousFragmentLabels(skeletonText: string): string[] {
  const pattern = new RegExp(SUSPICIOUS_FRAGMENT_PATTERN.source, "g");
  const labels = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(String(skeletonText ?? ""))) !== null) {
    labels.add(match[0].replace(/\s+/g, ""));
  }
  return Array.from(labels);
}

/** 去重（同章同片段同场次同份额只计一次），保持出现顺序 */
function dedupeUsages(usages: ChapterUsage[]): ChapterUsage[] {
  const seen = new Set<string>();
  const result: ChapterUsage[] = [];
  for (const usage of usages) {
    const key = `${usage.chapter}|${usage.fragment ?? ""}|${usage.sceneNo ?? ""}|${usage.explicitShare ?? ""}|${usage.deferred ? "d" : ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(usage);
  }
  return result;
}

/**
 * 提取章节使用声明（比 extractChapterRefs 多识别显式比例/百分号/整章标记/场次号）。
 * 显式份额优先级：`(a/b)` > `p%` > 片段词权重 > 整章标记（1.0）。
 */
export function extractChapterUsages(text: string, config: SkeletonCheckConfig = SKELETON_CHECK_CONFIG): ChapterUsage[] {
  const usages: ChapterUsage[] = [];
  const pattern = new RegExp(CHAPTER_USAGE_PATTERN.source, "g");
  const raw = normalizeDeclarationText(text);
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    const start = parseChapterNumber(match[1]);
    if (start === undefined) continue;
    const end = match[2] !== undefined ? parseChapterNumber(match[2]) : undefined;
    const tail = match[3] ?? "";

    const fraction = tail.match(FRACTION_PATTERN);
    const percentMatch = tail.match(PERCENT_PATTERN);
    const fragmentMatch = tail.match(FRAGMENT_MATCHER);
    const whole = WHOLE_CHAPTER_PATTERN.test(tail);
    const sceneMatch = tail.match(DECLARED_SCENE_PATTERN);
    const numerator = fraction ? Number(fraction[1]) : undefined;
    const denominator = fraction ? Number(fraction[2]) : undefined;
    const percent = percentMatch ? Number(percentMatch[1]) : undefined;
    const fragment = fragmentMatch ? fragmentMatch[0] : undefined;
    const sceneNo = sceneMatch ? Number(sceneMatch[1] ?? sceneMatch[2]) : undefined;

    let explicitShare: number | undefined;
    if (numerator !== undefined && denominator !== undefined && denominator > 0 && numerator > 0) {
      explicitShare = Math.min(1, numerator / denominator);
    } else if (percent !== undefined && percent > 0) {
      // 显式百分比优先于片段词：`第1章 前段（28%）` 按 28% 计，片段词只作语义标注
      explicitShare = Math.min(1, percent / 100);
    } else if (fragment) {
      explicitShare = config.fragmentWeights[fragment] ?? undefined;
    } else if (end !== undefined && end > start) {
      // 区间（第X-Y章）声明的是整章覆盖，逐章按整章份额记
      explicitShare = 1;
    } else if (whole) {
      explicitShare = 1;
    }

    if (end !== undefined && end > start) {
      for (let chapter = start; chapter <= end; chapter += 1) {
        usages.push({ chapter, fragment, explicitShare, sceneNo });
      }
      continue;
    }
    usages.push({ chapter: start, fragment, explicitShare, sceneNo });
  }
  return usages;
}

/**
 * 提取「章节处理」列条目（`1场5保留` / `2压缩` / `3删`）。
 * 只取"保留/压缩"（未标注动作的条目按保留计），"删"类条目不产生素材占用。
 */
export function extractChapterHandlingUsages(text: string): ChapterUsage[] {
  const usages: ChapterUsage[] = [];
  const entries = String(text ?? "")
    .replace(/[`*]/g, "")
    .split(/[\/、,，;；|]+/);
  for (const entry of entries) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const matched = trimmed.match(HANDLING_ENTRY_PATTERN);
    if (!matched) continue;
    const action = matched[3] ?? "";
    if (/^删/.test(action)) continue;
    const chapter = Number(matched[1]);
    if (!Number.isSafeInteger(chapter) || chapter <= 0) continue;
    const sceneNo = matched[2] !== undefined ? Number(matched[2]) : undefined;
    usages.push({ chapter, sceneNo: sceneNo !== undefined && Number.isFinite(sceneNo) ? sceneNo : undefined });
  }
  return usages;
}

/** 将"标题（第X-Y章）"拆为标题与章节范围；括号内不含章节信息时视为标题一部分 */
function splitTitleAndChapter(rawTitle: string): { title: string; chapterText: string } {
  const pattern = /[（(]([^（）()]*第\s*[0-9一二三四五六七八九十百零〇两]+\s*章[^（）()]*)[）)]\s*$/;
  const match = rawTitle.match(pattern);
  if (match && match.index !== undefined) {
    return { title: rawTitle.slice(0, match.index).trim(), chapterText: match[1].trim() };
  }
  return { title: rawTitle.trim(), chapterText: rawTitle.trim() };
}

/** 模式A：逐集展开（### 集N：标题（第X-Y章） + **章节分配：**…） */
function parseModeA(lines: string[], config: SkeletonCheckConfig): SkeletonEpisode[] {
  const starts: number[] = [];
  lines.forEach((line, index) => {
    if (EPISODE_A_PATTERN.test(line.trim())) starts.push(index);
  });
  if (!starts.length) return [];

  const episodes: SkeletonEpisode[] = [];
  starts.forEach((start, order) => {
    const end = order + 1 < starts.length ? starts[order + 1] : lines.length;
    const head = lines[start].trim().match(EPISODE_A_PATTERN);
    if (!head) return;
    const { title, chapterText } = splitTitleAndChapter(head[2]);

    // 优先取"章节分配"段落；未命中时回退到标题括号内的范围
    const refs: SkeletonChapterRef[] = [];
    const usages: ChapterUsage[] = [];
    const assignIndex = lines.slice(start, end).findIndex((line) => ASSIGN_SECTION_PATTERN.test(line));
    if (assignIndex >= 0) {
      for (let index = start + assignIndex + 1; index < end; index += 1) {
        const line = lines[index].trim();
        if (!line) continue;
        if (/^\*\*/.test(line)) break;
        if (!/^[-*]\s/.test(line)) continue;
        // "顺延/移至"的行是挪到别的集的内容，不计入本集素材
        if (DEFERRED_MARKER_PATTERN.test(line)) continue;
        refs.push(...extractChapterRefs(line, config));
        usages.push(...extractChapterUsages(line, config));
      }
    }
    if (!refs.length) refs.push(...extractChapterRefs(chapterText, config));
    // 标题括注里的片段/场次/比例同样是本集的声明，与分配段合并去重
    usages.push(...extractChapterUsages(chapterText, config));

    episodes.push({
      episodeNo: Number(head[1]),
      title: title || head[2],
      chapterText,
      chapterRefs: dedupeRefs(refs),
      chapterUsages: dedupeUsages(usages),
      sourceMode: "A",
    });
  });
  return episodes;
}

/** 模式B：总览表（| 集 | 集标题 | 章节范围 | … |） */
function parseModeB(lines: string[], config: SkeletonCheckConfig): SkeletonEpisode[] {
  const splitRow = (line: string): string[] =>
    line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());

  const headerIndex = lines.findIndex((line) => /^\|/.test(line.trim()) && /章节范围/.test(line));
  if (headerIndex < 0) return [];
  const header = splitRow(lines[headerIndex]);
  const episodeCol = header.findIndex((cell) => cell === "集" || /^集\b/.test(cell));
  const titleCol = header.findIndex((cell) => /集标题|标题/.test(cell));
  const rangeCol = header.findIndex((cell) => /章节范围/.test(cell));
  const handleCol = header.findIndex((cell) => /章节处理/.test(cell));

  const episodes: SkeletonEpisode[] = [];
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!/^\|/.test(line)) {
      if (episodes.length) break;
      continue;
    }
    if (/^\|[\s:|-]+\|?$/.test(line)) continue;
    const cells = splitRow(line);
    const episodeText = episodeCol >= 0 ? cells[episodeCol] : cells[0];
    const episodeNo = /^\d+$/.test(String(episodeText ?? "").trim()) ? Number(String(episodeText).trim()) : undefined;
    if (episodeNo === undefined) continue;
    const rawTitle = titleCol >= 0 ? String(cells[titleCol] ?? "").trim() : "";
    const { title, chapterText } = splitTitleAndChapter(rawTitle);
    const rangeText = rangeCol >= 0 ? String(cells[rangeCol] ?? "").trim() : "";
    const handleText = handleCol >= 0 ? String(cells[handleCol] ?? "").trim() : "";
    const refs = extractChapterRefs(rangeText || chapterText, config);
    const usages = [
      ...extractChapterUsages(rangeText || chapterText, config),
      ...extractChapterHandlingUsages(handleText),
    ];
    episodes.push({
      episodeNo,
      title: title || `第${episodeNo}集`,
      chapterText: rangeText || chapterText,
      chapterRefs: dedupeRefs(refs),
      chapterUsages: dedupeUsages(usages),
      sourceMode: "B",
    });
  }
  return episodes;
}

/** 本次判定采用的分集来源与两份解析结果的差异 */
export interface SkeletonParseSource {
  /** 本次判定采用的分集来源 */
  used: "A" | "B";
  /** 模式A（逐集展开）解析到的集数 */
  modeAEpisodes: number;
  /** 模式B（总览表）解析到的集数 */
  modeBEpisodes: number;
  /** 模式A 相对 1..最大集号 的缺号（展开段不完整时非空） */
  modeAMissing: number[];
  /** 模式B 相对 1..最大集号 的缺号 */
  modeBMissing: number[];
}

export interface SkeletonParseResult {
  episodes: SkeletonEpisode[];
  source?: SkeletonParseSource;
}

/** 相对 1..最大集号 的缺号（用于区分"骨架集号断裂"与"展开段不完整"） */
function missingEpisodeNumbers(episodes: SkeletonEpisode[]): number[] {
  if (!episodes.length) return [];
  const present = new Set(episodes.map((episode) => episode.episodeNo));
  const max = Math.max(...Array.from(present));
  const missing: number[] = [];
  for (let episodeNo = 1; episodeNo <= max; episodeNo += 1) {
    if (!present.has(episodeNo)) missing.push(episodeNo);
  }
  return missing;
}

/**
 * 解析骨架分集结果（含来源说明），兼容两种输出模式：
 * - 模式A（逐集展开）：`### 集N：标题（第X-Y章）` + `**章节分配：**`
 * - 模式B（>20 集总览表）：`| 集 | 集标题 | 章节范围 | … |`
 *
 * 两份同时存在时取"更完整的一份"（集数更多者；并列时取总览表）作为判定基准，
 * 避免把"关键集展开段漏号"误报成骨架集号断裂。
 */
export function parseSkeletonEpisodesDetailed(
  content: string,
  config: SkeletonCheckConfig = SKELETON_CHECK_CONFIG,
): SkeletonParseResult {
  const lines = String(content ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const modeA = parseModeA(lines, config).sort((a, b) => a.episodeNo - b.episodeNo);
  const modeB = parseModeB(lines, config).sort((a, b) => a.episodeNo - b.episodeNo);
  if (!modeA.length && !modeB.length) return { episodes: [] };

  const source: SkeletonParseSource = {
    used: modeB.length >= modeA.length && modeB.length > 0 ? "B" : "A",
    modeAEpisodes: modeA.length,
    modeBEpisodes: modeB.length,
    modeAMissing: missingEpisodeNumbers(modeA),
    modeBMissing: missingEpisodeNumbers(modeB),
  };
  const episodes = source.used === "B" ? modeB : modeA;
  return { episodes, source };
}

export function parseSkeletonEpisodes(content: string, config: SkeletonCheckConfig = SKELETON_CHECK_CONFIG): SkeletonEpisode[] {
  return parseSkeletonEpisodesDetailed(content, config).episodes;
}

/* ==================== 素材统计 ==================== */

function countChars(text: string): number {
  return String(text ?? "").replace(/\s+/g, "").length;
}

/**
 * 统计原著引号内的台词素材字数（含标点、去空白）。
 * 与剧本阶段台词比对口径保持一致（长度过滤），但不做去重——素材量需要总量。
 */
export function countQuoteChars(text: string, config: SkeletonCheckConfig = SKELETON_CHECK_CONFIG): number {
  const { minChars, maxChars } = config.quote;
  const pattern = /[“"「『]([^”"」』\n]{1,120})[”"」』]/g;
  let total = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(String(text ?? ""))) !== null) {
    const plain = match[1].replace(/\s+/g, "");
    if (plain.length < minChars || plain.length > maxChars) continue;
    total += plain.length;
  }
  return total;
}

export interface ChapterStat {
  chapter: number;
  chars: number;
  quoteChars: number;
  /** 引号台词条数（每条引号 = 一条台词）；缺省时由 quoteChars 推断 */
  quoteLines?: number;
  /** 引号台词内的标点数；缺省时由 quoteChars 推断 */
  quoteMarks?: number;
}

/** 标点字符统计（与制作侧"标点停顿"口径一致，只数标点本身） */
export function countMarks(text: string): number {
  return (String(text ?? "").match(/[，。！？；、…—·,.!?;:]/g) ?? []).length;
}

/**
 * 统计原著引号内台词素材的完整负载：净字数（不含标点）、条数、标点数。
 * 与 `countQuoteChars` 同口径（同一正则与长度过滤），供共享容量模型折算 floor/safe。
 */
export function countQuoteStats(
  text: string,
  config: SkeletonCheckConfig = SKELETON_CHECK_CONFIG,
): { chars: number; lines: number; marks: number } {
  const { minChars, maxChars } = config.quote;
  const pattern = /[“"「『]([^”"」』\n]{1,120})[”"」』]/g;
  let chars = 0;
  let lines = 0;
  let marks = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(String(text ?? ""))) !== null) {
    const plain = match[1].replace(/\s+/g, "");
    if (plain.length < minChars || plain.length > maxChars) continue;
    const markCount = countMarks(plain);
    chars += plain.length - markCount;
    marks += markCount;
    lines += 1;
  }
  return { chars, lines, marks };
}

/* ==================== 份额计划（同一章全剧合计 ≤ 1.0） ==================== */

export interface ChapterShareAssignment {
  chapter: number;
  /** 归一后的份额（0-1） */
  share: number;
  source: ChapterShareSource;
}

export interface ChapterShareSummary {
  chapter: number;
  /** 引用该章的集号（升序） */
  episodes: number[];
  /** 各集的声明摘要（如 `EP01(场1)/EP02(场2)`） */
  declared: string;
  /** 归一后该章被分配的份额合计 */
  assigned: number;
  /** 该章用到的份额来源 */
  sources: ChapterShareSource[];
  /** 未分配余量（0-1），>0 表示该章有素材没有落到任何一集 */
  unassigned: number;
}

export interface ChapterSharePlan {
  /** 集号 → 章号 → 份额分配 */
  byEpisode: Map<number, Map<number, ChapterShareAssignment>>;
  byChapter: ChapterShareSummary[];
  warnings: string[];
}

export const SHARE_SOURCE_LABELS: Record<ChapterShareSource, string> = {
  explicit: "显式标注",
  scene: "按场次",
  inferred: "按引用集数推断",
  whole: "单集整章引用",
};

function episodeLabel(episodeNo: number): string {
  return `EP${String(episodeNo).padStart(2, "0")}`;
}

/** 单集对某章的声明聚合（同集同章的多条声明合并） */
interface ChapterUsageAggregate {
  episodeNo: number;
  explicitShare?: number;
  scenes: number[];
  fragments: string[];
  plain: boolean;
}

function episodeUsages(episode: SkeletonEpisode): ChapterUsage[] {
  const usages: ChapterUsage[] = episode.chapterUsages?.length
    ? episode.chapterUsages
    : episode.chapterRefs.map(
        (ref): ChapterUsage => ({
          chapter: ref.chapter,
          fragment: ref.fragment,
          // 片段引用本身即显式份额；无片段时留给份额推导
          explicitShare: ref.fragment ? ref.weight : undefined,
        }),
      );
  return dedupeUsages(usages.filter((usage) => !usage.deferred));
}

function describeAggregate(aggregate: ChapterUsageAggregate): string {
  const parts: string[] = [];
  if (aggregate.explicitShare !== undefined) parts.push(`${Math.round(aggregate.explicitShare * 100)}%`);
  if (aggregate.fragments.length) parts.push(aggregate.fragments.join("/"));
  if (aggregate.scenes.length) parts.push(`场${aggregate.scenes.slice().sort((a, b) => a - b).join("、")}`);
  if (!parts.length) parts.push("未标注");
  return `${episodeLabel(aggregate.episodeNo)}(${parts.join(" ")})`;
}

/**
 * 汇总全剧各集的章节使用声明，推导并归一每集每章的份额：
 * 显式标注 → 按场次占比 → 按引用集数等比推断 → 单集整章引用。
 * 归一后同一章在各集上的份额合计不超过 1.0，避免"一章被 N 集引用就按 N 份整章台词计"。
 */
export function buildChapterSharePlan(
  episodes: SkeletonEpisode[],
  config: SkeletonCheckConfig = SKELETON_CHECK_CONFIG,
): ChapterSharePlan {
  const { maxSceneNumber, unassignedWarnRatio, overAllocationTolerance } = config.share;
  const warnings: string[] = [];
  const aggregates = new Map<string, ChapterUsageAggregate>();
  const aggregatesByChapter = new Map<number, ChapterUsageAggregate[]>();

  for (const episode of episodes) {
    for (const usage of episodeUsages(episode)) {
      const key = `${usage.chapter}|${episode.episodeNo}`;
      let aggregate = aggregates.get(key);
      if (!aggregate) {
        aggregate = { episodeNo: episode.episodeNo, scenes: [], fragments: [], plain: false };
        aggregates.set(key, aggregate);
        const list = aggregatesByChapter.get(usage.chapter) ?? [];
        list.push(aggregate);
        aggregatesByChapter.set(usage.chapter, list);
      }
      if (
        usage.explicitShare !== undefined &&
        (aggregate.explicitShare === undefined || usage.explicitShare > aggregate.explicitShare)
      ) {
        aggregate.explicitShare = usage.explicitShare;
      }
      if (usage.sceneNo !== undefined && !aggregate.scenes.includes(usage.sceneNo)) aggregate.scenes.push(usage.sceneNo);
      if (usage.sceneNo === undefined) aggregate.plain = true;
      if (usage.fragment && !aggregate.fragments.includes(usage.fragment)) aggregate.fragments.push(usage.fragment);
    }
  }

  const byEpisode = new Map<number, Map<number, ChapterShareAssignment>>();
  const byChapter: ChapterShareSummary[] = [];

  for (const chapter of Array.from(aggregatesByChapter.keys()).sort((a, b) => a - b)) {
    const chapterAggregates = (aggregatesByChapter.get(chapter) ?? []).slice().sort((a, b) => a.episodeNo - b.episodeNo);
    const explicitTotal = Math.min(
      1,
      chapterAggregates.reduce((sum, item) => sum + (item.explicitShare ?? 0), 0),
    );
    const restAggregates = chapterAggregates.filter((item) => item.explicitShare === undefined);
    const remaining = Math.max(0, 1 - explicitTotal);
    const allScenes = chapterAggregates.flatMap((item) => item.scenes);
    const maxScene = allScenes.length ? Math.max(...allScenes) : 0;
    const sceneMode = maxScene > 0 && maxScene <= maxSceneNumber;
    const sceneAggregates = sceneMode ? restAggregates.filter((item) => item.scenes.length) : [];
    const plainAggregates = restAggregates.filter((item) => !sceneAggregates.includes(item));
    const sceneTotal = sceneAggregates.reduce((sum, item) => sum + (remaining * item.scenes.length) / maxScene, 0);
    const plainShare = plainAggregates.length ? Math.max(0, remaining - sceneTotal) / plainAggregates.length : 0;

    const raw = new Map<number, ChapterShareAssignment>();
    for (const aggregate of chapterAggregates) {
      if (aggregate.explicitShare !== undefined) {
        raw.set(aggregate.episodeNo, { chapter, share: aggregate.explicitShare, source: "explicit" });
        continue;
      }
      if (sceneAggregates.includes(aggregate)) {
        raw.set(aggregate.episodeNo, {
          chapter,
          share: (remaining * aggregate.scenes.length) / maxScene,
          source: "scene",
        });
        continue;
      }
      const singleAggregate = chapterAggregates.length === 1;
      raw.set(aggregate.episodeNo, {
        chapter,
        share: singleAggregate ? remaining : plainShare,
        source: singleAggregate ? "whole" : "inferred",
      });
    }

    let total = Array.from(raw.values()).reduce((sum, item) => sum + item.share, 0);
    if (total > 1 + overAllocationTolerance) {
      warnings.push(
        `第${chapter}章份额合计 ${Math.round(total * 100)}%（超出 100%，按声明值计）：${chapterAggregates.map(describeAggregate).join("、")}；` +
          `已按比例归一到 100%——归一不改变"该章素材总量"这一事实，但会让每集素材算多或算少。` +
          `常见原因是多集只写裸片段词（前半 0.5 + 中段 0.34 + 后段 0.33 = 117%）；请改为每集写显式占比（推荐「第N章 片段词（p%）」，判定器优先采信百分比、片段词只作语义标注），不要反复修改已被正确识别的标注`,
      );
      for (const assignment of raw.values()) assignment.share = assignment.share / total;
      total = 1;
    }
    const unassigned = Math.max(0, 1 - total);
    if (unassigned > unassignedWarnRatio) {
      warnings.push(
        `第${chapter}章约 ${Math.round(unassigned * 100)}% 素材未分配到任何一集：${chapterAggregates.map(describeAggregate).join("、")}；若属有意删减请在《全局删减决策记录》登记，否则请补全该章的场次/片段/比例标注`,
      );
    }

    for (const [episodeNo, assignment] of raw) {
      const episodeMap = byEpisode.get(episodeNo) ?? new Map<number, ChapterShareAssignment>();
      episodeMap.set(chapter, assignment);
      byEpisode.set(episodeNo, episodeMap);
    }

    const sources: ChapterShareSource[] = [];
    for (const assignment of raw.values()) {
      if (!sources.includes(assignment.source)) sources.push(assignment.source);
    }
    byChapter.push({
      chapter,
      episodes: chapterAggregates.map((item) => item.episodeNo),
      declared: chapterAggregates.map(describeAggregate).join("/"),
      assigned: Math.round(total * 1000) / 1000,
      sources,
      unassigned: Math.round(unassigned * 1000) / 1000,
    });
  }

  return { byEpisode, byChapter, warnings };
}

/** 把份额计划回填到分集引用上（供报告与下游消费者读取 share/shareSource） */
export function applyChapterSharePlan(episodes: SkeletonEpisode[], plan: ChapterSharePlan): void {
  for (const episode of episodes) {
    const assignments = plan.byEpisode.get(episode.episodeNo);
    if (!assignments) continue;
    for (const ref of episode.chapterRefs) {
      const assignment = assignments.get(ref.chapter);
      if (!assignment) continue;
      ref.share = Math.round(assignment.share * 1000) / 1000;
      ref.shareSource = assignment.source;
    }
  }
}

/* ==================== 估算与判定 ==================== */

export interface SkeletonEpisodeEstimate {
  episodeNo: number;
  title: string;
  chapterText: string;
  /** 按份额折算的原文规模（字） */
  sourceChars: number;
  /** 按份额折算的台词净字数（不含标点） */
  quoteChars: number;
  /** 按份额折算的台词条数 */
  quoteLines: number;
  /** 按份额折算的台词标点数 */
  quoteMarks: number;
  /** 刚性台词下限（秒）：逐字保留 + 每镜缓冲的物理下界 */
  lowerSeconds: number;
  /** 预计时长（秒）= 台词安全时长 + 动作/非台词预算 */
  estimatedSeconds: number;
  level: SkeletonCheckLevel;
  /** 制作侧三态口径（与剧本层/分镜层同一把尺子） */
  capacityLevel: EpisodeCapacityLevel;
  /** 建议拆集数（需要拆集时给出） */
  splitCount?: number;
  /** 需压到骑线的台词占比（0-1） */
  rideLineRatio: number;
  /** 若走"授权删减"路线达到预算，需删减的台词字数（需用户授权） */
  authorizedCutChars: number;
  /** 长台词（>20 字）按分镜端强制拆镜口径的安全时长（保守值；与预计时长同口径的差值即预排余量） */
  splitSafeSeconds: number;
  /** 长台词拆镜的额外缓冲说明（无差异时缺省） */
  splitOverheadNote?: string;
  /** 折算来源：实测条数/标点 或 由字数推断 */
  timingSource: "measured" | "inferred";
  detail: string;
  suggestion: string;
  parseWarning?: string;
  /** 本集各章份额摘要（如"第1章 17%（按场次）"）；未提供份额计划时缺省 */
  shareNote?: string;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function levelDetail(level: SkeletonCheckLevel, lower: number, estimate: number, config: SkeletonCheckConfig): string {
  const { minSeconds, maxSeconds } = config.episodeTarget;
  const { severeOverRatio, severeToleranceSeconds, underRatio } = config.budget;
  switch (level) {
    case "severeOver":
      if (lower > maxSeconds) {
        return `严重超载：刚性台词下限 ${lower}s（逐字保留）已超过 ${maxSeconds}s，物理上装不下，必须拆集或回剧本删减（需用户授权）`;
      }
      return `严重超载：预计时长 ${estimate}s 超过安全线 ${round1(maxSeconds * severeOverRatio + severeToleranceSeconds)}s（上限 ${maxSeconds}s × ${severeOverRatio} + ${severeToleranceSeconds}s 容差），必须拆集或压缩动作镜`;
    case "lightOver":
      return `轻度超载：预计时长 ${estimate}s 高于上限 ${maxSeconds}s，需合并重复场面、压缩动作镜或顺延情节节点`;
    case "under":
      return `素材不足：预计时长 ${estimate}s 低于下限 ${minSeconds}s 的 ${underRatio} 倍（${round1(minSeconds * underRatio)}s），建议与相邻集合并且补入未用情节`;
    default:
      return `容量在 ${minSeconds}-${maxSeconds}s 目标区间内`;
  }
}

/**
 * 对单集做容量估算与四级判定（双判据）。
 * 提供 sharePlan 时按"归一后的章份额"计（同一章全剧合计 ≤ 1.0）；
 * 未提供时退回旧的"同章多片段合并、封顶整章 1.0"权重口径（兼容既有调用与单测）。
 */
export function estimateEpisodeCapacity(
  episode: SkeletonEpisode,
  stats: Map<number, ChapterStat>,
  config: SkeletonCheckConfig = SKELETON_CHECK_CONFIG,
  sharePlan?: ChapterSharePlan,
): SkeletonEpisodeEstimate {
  const { severeOverRatio, severeToleranceSeconds, underRatio } = config.budget;
  const { minSeconds, maxSeconds } = config.episodeTarget;

  const shareByChapter = new Map<number, { share: number; source?: ChapterShareSource }>();
  const assignments = sharePlan?.byEpisode.get(episode.episodeNo);
  if (sharePlan) {
    for (const [chapter, assignment] of assignments ?? []) {
      shareByChapter.set(chapter, { share: assignment.share, source: assignment.source });
    }
  } else {
    // 兼容路径：同章多片段合并（封顶整章 1.0）
    for (const ref of episode.chapterRefs) {
      const current = shareByChapter.get(ref.chapter);
      shareByChapter.set(ref.chapter, { share: Math.min(1, (current?.share ?? 0) + ref.weight) });
    }
  }

  let sourceChars = 0;
  let quoteChars = 0;
  let quoteLines = 0;
  let quoteMarks = 0;
  let inferred = false;
  for (const [chapter, entry] of Array.from(shareByChapter.entries())) {
    const stat = stats.get(chapter);
    if (!stat) continue;
    sourceChars += stat.chars * entry.share;
    // 旧数据可能只有 quoteChars：按共享模型的推断系数补齐条数/标点，并在报告中标注"推断"
    const chapterLoad = inferDialogueLoad({ chars: stat.quoteChars, marks: stat.quoteMarks, lines: stat.quoteLines });
    quoteChars += chapterLoad.chars * entry.share;
    quoteLines += chapterLoad.lines * entry.share;
    quoteMarks += chapterLoad.marks * entry.share;
    if (chapterLoad.inferred) inferred = true;
  }

  // 与剧本层/分镜层同一把尺子：逐字保留 + 每镜缓冲 + 标点停顿 + 动作/非台词预算
  const load = {
    chars: Math.round(quoteChars),
    lines: Math.round(quoteLines),
    marks: Math.round(quoteMarks),
    inferred,
  };
  const timing = estimateDialogueTiming(load);
  const capacity = estimateLoadCapacity(load, EPISODE_CAPACITY_BUDGET);
  const lowerSeconds = timing.floorSeconds;
  const estimatedSeconds = capacity.totalSeconds;
  const severeLimit = round1(maxSeconds * severeOverRatio + severeToleranceSeconds);
  const underLimit = round1(minSeconds * underRatio);

  let level: SkeletonCheckLevel = "ok";
  // 与决策树对齐：必拆（splitRequired）与建议拆集（splitPressure，骑线占比 > 40%）都按"严重超载"处理，
  // 避免出现"轻度超载 + 建议拆集"两套词汇互相打架
  if (
    capacity.result.level === "splitRequired" ||
    capacity.result.level === "splitPressure" ||
    lowerSeconds > maxSeconds
  ) {
    level = "severeOver";
  } else if (estimatedSeconds > severeLimit) {
    level = "severeOver";
  } else if (estimatedSeconds > maxSeconds + EPISODE_CAPACITY_BUDGET.toleranceSeconds) {
    level = "lightOver";
  } else if (estimatedSeconds < underLimit) {
    level = "under";
  }

  // "授权删减"路线反算：若不走拆集，需删掉多少字台词才能回到安全线（需用户授权并登记豁免）
  const authorizedCutChars =
    estimatedSeconds > maxSeconds ? Math.max(0, load.chars - dialogueCapacityMaxChars(load, EPISODE_CAPACITY_BUDGET)) : 0;

  const estimate: SkeletonEpisodeEstimate = {
    episodeNo: episode.episodeNo,
    title: episode.title,
    chapterText: episode.chapterText,
    sourceChars: Math.round(sourceChars),
    quoteChars: load.chars,
    quoteLines: load.lines,
    quoteMarks: load.marks,
    lowerSeconds,
    estimatedSeconds,
    level,
    capacityLevel: capacity.result.level,
    splitCount: capacity.result.splitCount,
    rideLineRatio: capacity.rideLineRatio,
    authorizedCutChars,
    splitSafeSeconds: timing.splitSafeSeconds,
    splitOverheadNote: describeSplitOverhead(timing),
    timingSource: timing.source,
    detail: `${levelDetail(level, lowerSeconds, estimatedSeconds, config)}；跨层口径（${ESTIMATE_SOURCE_LABELS[timing.source]}）：${capacity.result.verdict}`,
    suggestion: capacity.result.advice,
  };
  if (sharePlan) {
    estimate.shareNote = Array.from(shareByChapter.entries())
      .sort((a, b) => a[0] - b[0])
      .map(
        ([chapter, item]) =>
          `第${chapter}章 ${Math.round(item.share * 100)}%（${item.source ? SHARE_SOURCE_LABELS[item.source] : "未标注"}）`,
      )
      .join("、");
  }
  if (!episode.chapterRefs.length) {
    estimate.parseWarning = "未识别到章节范围，容量估算为 0，仅供参考";
  }
  return estimate;
}

/* ==================== 结构校验 ==================== */

/** 集号连续性与章节覆盖检查（提示级） */
export function checkSkeletonStructure(episodes: SkeletonEpisode[], availableChapters: number[]): string[] {
  const warnings: string[] = [];
  if (!episodes.length) return warnings;

  for (let index = 1; index < episodes.length; index += 1) {
    if (episodes[index].episodeNo !== episodes[index - 1].episodeNo + 1) {
      warnings.push(`集号不连续：第${episodes[index - 1].episodeNo}集 → 第${episodes[index].episodeNo}集`);
    }
  }

  const covered = new Set<number>();
  for (const episode of episodes) {
    for (const ref of episode.chapterRefs) covered.add(ref.chapter);
  }
  const missing = availableChapters.filter((chapter) => !covered.has(chapter));
  if (missing.length) {
    warnings.push(`以下章节未被任何一集覆盖：${missing.map((chapter) => `第${chapter}章`).join("、")}`);
  }

  const noRefEpisodes = episodes.filter((episode) => !episode.chapterRefs.length).map((episode) => episode.episodeNo);
  if (noRefEpisodes.length) {
    warnings.push(`以下集未识别到章节范围：${noRefEpisodes.map((no) => `第${no}集`).join("、")}`);
  }
  return warnings;
}

/* ==================== 读库入口 ==================== */

export interface SkeletonCheckReport {
  generatedAt: number;
  projectId: number;
  /** 单集目标时长 */
  target: { minSeconds: number; maxSeconds: number };
  estimates: SkeletonEpisodeEstimate[];
  structureWarnings: string[];
  warnings: string[];
  /** 本次判定采用的分集来源（骨架同时含总览表与逐集展开时给出差异） */
  parseSource?: SkeletonParseSource;
  /** 按章份额分配（同一章全剧合计 ≤ 100%） */
  shareSummaries?: ChapterShareSummary[];
}

export interface RunSkeletonChecksOptions {
  /** 直接传入骨架文本（不读库）；用于回放与测试 */
  skeletonText?: string;
  /** 直接传入章节数据（不读库）；用于回放与测试 */
  chapters?: Array<{ chapterIndex?: string | null; chapterData?: string | null }>;
}

interface NovelRow {
  chapterIndex?: string | null;
  chapterData?: string | null;
}

function rowIndexNumber(row: NovelRow): number | undefined {
  const matched = String(row.chapterIndex ?? "").match(/\d+/);
  return matched ? Number(matched[0]) : undefined;
}

function emptyReport(projectId: number, generatedAt: number): SkeletonCheckReport {
  return {
    generatedAt,
    projectId,
    target: { ...SKELETON_CHECK_CONFIG.episodeTarget },
    estimates: [],
    structureWarnings: [],
    warnings: [],
  };
}

export async function runSkeletonChecks(
  projectIdValue: number,
  options: RunSkeletonChecksOptions = {},
): Promise<SkeletonCheckReport> {
  const generatedAt = Date.now();
  const projectId = Number(projectIdValue);
  if (!Number.isSafeInteger(projectId) || projectId <= 0) return emptyReport(projectId, generatedAt);

  const { default: u } = await import("@/utils");
  const config = SKELETON_CHECK_CONFIG;

  let skeletonText = options.skeletonText;
  if (skeletonText === undefined) {
    const row = await u.db("o_agentWorkData").where({ projectId, key: "scriptAgent" }).first();
    let workData: Record<string, unknown> = {};
    try {
      workData = JSON.parse(String(row?.data ?? "{}"));
    } catch {
      workData = {};
    }
    skeletonText = typeof workData.storySkeleton === "string" ? workData.storySkeleton : "";
  }

  const report = emptyReport(projectId, generatedAt);
  const rawSkeletonText = String(skeletonText ?? "");
  const parsed = parseSkeletonEpisodesDetailed(rawSkeletonText, config);
  const episodes = parsed.episodes;
  if (!episodes.length) {
    report.warnings.push("未从骨架中识别到分集信息（支持“### 集N：标题（第X-Y章）”与总览表两种格式）");
    return report;
  }
  report.parseSource = parsed.source;

  // 份额计划：同一章在全剧分集上的加权份额合计不超过 1.0（失败时按比例归一并在提示中说明）
  const sharePlan = buildChapterSharePlan(episodes, config);
  applyChapterSharePlan(episodes, sharePlan);
  report.shareSummaries = sharePlan.byChapter;
  report.warnings.push(...sharePlan.warnings);

  const suspiciousLabels = collectSuspiciousFragmentLabels(rawSkeletonText);
  if (suspiciousLabels.length) {
    report.warnings.push(
      `疑似未识别的片段写法：${suspiciousLabels.slice(0, 5).join("、")}${suspiciousLabels.length > 5 ? " 等" : ""}；请改用 前半/后半/中段/后段/收束前段/收束，或“第N章(a/b)”“第N章 p%”写法`,
    );
  }

  const chapterRows =
    options.chapters ??
    ((await u.db("o_novel").where({ projectId }).select("chapterIndex", "chapterData")) as NovelRow[]);

  const stats = new Map<number, ChapterStat>();
  for (const row of chapterRows) {
    const chapter = rowIndexNumber(row);
    if (chapter === undefined) continue;
    const text = String(row.chapterData ?? "");
    const quote = countQuoteStats(text, config);
    stats.set(chapter, {
      chapter,
      chars: countChars(text),
      quoteChars: quote.chars,
      quoteLines: quote.lines,
      quoteMarks: quote.marks,
    });
  }
  if (!stats.size) {
    report.warnings.push("未读取到章节原文，容量估算的台词素材按 0 计，仅结构校验有效");
  }

  report.estimates = episodes.map((episode) => estimateEpisodeCapacity(episode, stats, config, sharePlan));
  report.structureWarnings = checkSkeletonStructure(episodes, Array.from(stats.keys()).sort((a, b) => a - b));
  return report;
}

/* ==================== 报告输出 ==================== */

const LEVEL_LABELS: Record<SkeletonCheckLevel, string> = {
  ok: "通过",
  lightOver: "轻度超载",
  severeOver: "严重超载",
  under: "素材不足",
};

export function skeletonReportToMarkdown(report: SkeletonCheckReport): string {
  const { budget, episodeTarget } = SKELETON_CHECK_CONFIG;
  const severeLimit = round1(episodeTarget.maxSeconds * budget.severeOverRatio + budget.severeToleranceSeconds);
  const underLimit = round1(episodeTarget.minSeconds * budget.underRatio);
  const lines: string[] = [];

  lines.push("## 骨架容量体检结果（由工具生成，审核报告必须原样引用，不得改写结论）");
  lines.push("");
  lines.push(`- 检查范围：共 ${report.estimates.length} 集${report.estimates.length ? `（EP${String(report.estimates[0].episodeNo).padStart(2, "0")}-EP${String(report.estimates[report.estimates.length - 1].episodeNo).padStart(2, "0")}）` : ""}`);
  lines.push(
    `- 容量口径（与剧本层/分镜层同一把尺子，逐字保留）：刚性台词下限 L = 台词净字数 ÷ ${DIALOGUE_PACING.hardCharsPerSecond} + ${DIALOGUE_PACING.hardBufferSeconds} × 台词条数；台词安全时长 = 净字数 ÷ ${DIALOGUE_PACING.safeCharsPerSecond} + ${DIALOGUE_PACING.safePausePerMark} × 标点 + ${DIALOGUE_PACING.safeBufferSeconds} × 条数；预计时长 T = 台词安全时长 + 动作/非台词预算 ${EPISODE_CAPACITY_BUDGET.actionReferenceSeconds}s（动作镜合并到极限时 ${EPISODE_CAPACITY_BUDGET.actionMinimumSeconds}s）`,
  );
  lines.push(
    `- 判定口径：满足以下任一条 = 严重超载（阻塞，必须回骨架拆集或由用户授权删减）：① L > ${episodeTarget.maxSeconds}s；② T > ${severeLimit}s（${round1(episodeTarget.maxSeconds * budget.severeOverRatio)}s + ${budget.severeToleranceSeconds}s 估算容差）；③ 骑线占比 > ${Math.round(EPISODE_CAPACITY_BUDGET.rideLineRatioThreshold * 100)}%（建议拆集）；④ L + 最小动作预算 ${EPISODE_CAPACITY_BUDGET.actionMinimumSeconds}s > ${episodeTarget.maxSeconds}s（必拆）。仅 ${episodeTarget.maxSeconds}s < T ≤ ${severeLimit}s 且骑线占比 ≤ ${Math.round(EPISODE_CAPACITY_BUDGET.rideLineRatioThreshold * 100)}% = 轻度超载（可执行）；T < ${underLimit}s = 素材不足；其余通过`,
  );
  lines.push(
    `- 制作侧三态（拆集决策树）：安全线内 = 直接排；需骑线（≤${Math.round(EPISODE_CAPACITY_BUDGET.rideLineRatioThreshold * 100)}% 台词压到硬底线）= 可执行且不得作为返工理由；骑线占比 > ${Math.round(EPISODE_CAPACITY_BUDGET.rideLineRatioThreshold * 100)}% = 建议拆集；L + 最小动作预算 > ${episodeTarget.maxSeconds}s = 必拆；T < ${underLimit}s = 素材不足（考虑并集）`,
  );
  lines.push(
    `- 容量查表（单集安全线内可承载台词，动作预算 ${EPISODE_CAPACITY_BUDGET.actionReferenceSeconds}s）：${formatCapacityTable(EPISODE_CAPACITY_BUDGET).join("；")}`,
  );
  lines.push(
    "- 份额口径：同一章素材在全剧分集中合计不超过 100%；推导优先级：显式标注（片段词、(a/b)、p%）→ 按场次占比 → 按引用集数等比推断 → 单集整章引用；标记为“推断”的份额为估计值，采纳前请补标注",
  );
  lines.push("");
  let sectionNo = 0;
  const nextSection = (title: string) => {
    sectionNo += 1;
    return `### ${sectionNo}. ${title}`;
  };

  const source = report.parseSource;
  if (source || report.shareSummaries?.length) {
    lines.push(nextSection("解析来源与份额推断"));
    lines.push("");
    if (source) {
      lines.push(`- 判定基准：模式${source.used}（${source.used === "B" ? "总览表" : "逐集展开"}），共 ${report.estimates.length} 集`);
      if (source.modeAEpisodes && source.modeBEpisodes) {
        const differences: string[] = [];
        if (source.modeAEpisodes !== source.modeBEpisodes) {
          differences.push(`集数不一致（逐集展开 ${source.modeAEpisodes} 节 / 总览表 ${source.modeBEpisodes} 集）`);
        }
        if (source.modeAMissing.length) differences.push(`逐集展开缺 ${source.modeAMissing.map(episodeLabel).join("、")}`);
        if (source.modeBMissing.length) differences.push(`总览表缺 ${source.modeBMissing.map(episodeLabel).join("、")}`);
        lines.push(
          `- 逐集展开段与总览表差异：${differences.length ? differences.join("；") : "无"}；集号以采用的${source.used === "B" ? "总览表" : "逐集展开段"}为准，展开段不完整不得判定为骨架集号断裂`,
        );
      }
    }
    if (report.shareSummaries?.length) {
      lines.push("");
      lines.push("| 章 | 引用集 | 声明 | 归一后合计 | 来源 | 未分配 |");
      lines.push("| --- | --- | --- | --- | --- | --- |");
      for (const summary of report.shareSummaries) {
        lines.push(
          `| 第${summary.chapter}章 | ${summary.episodes.map(episodeLabel).join("、")} | ${summary.declared} | ${Math.round(summary.assigned * 100)}% | ${summary.sources.map((item) => SHARE_SOURCE_LABELS[item]).join("/")} | ${Math.round(summary.unassigned * 100)}% |`,
        );
      }
      const inferredChapters = report.shareSummaries.filter((summary) => summary.sources.includes("inferred"));
      if (inferredChapters.length) {
        lines.push("");
        lines.push(
          `- 推断份额（未标注场次/片段/比例，按引用集数等比估计）：${inferredChapters.map((summary) => `第${summary.chapter}章`).join("、")}；如需精确判定请补标注后复检`,
        );
      }
    }
    lines.push("");
  }

  lines.push(nextSection("逐集容量估算"));
  lines.push("");
  lines.push(
    "| 集 | 章节素材 | 原文规模 | 台词素材 | 刚性台词下限 L | 预计时长 T | 判定 | 制作侧三态 | 建议拆集 |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const estimate of report.estimates) {
    const chapterText = estimate.chapterText || "-";
    const splitNote = estimate.splitCount && estimate.splitCount > 1 ? `${estimate.splitCount} 集` : "-";
    lines.push(
      `| ${episodeLabel(estimate.episodeNo)} | ${chapterText} | ${estimate.sourceChars}字 | ${estimate.quoteLines}条/${estimate.quoteChars}字/${estimate.quoteMarks}标点 | ${estimate.lowerSeconds}s | ${estimate.estimatedSeconds}s | ${LEVEL_LABELS[estimate.level]} | ${capacityLevelMark(estimate.capacityLevel)} | ${splitNote} |`,
    );
  }
  lines.push("");
  lines.push(
    `- 说明：台词素材列为「条数/净字数/标点数」；折算来源为${ESTIMATE_SOURCE_LABELS[report.estimates.some((item) => item.timingSource === "inferred") ? "inferred" : "measured"]}的集已标注在明细中`,
  );
  lines.push("");

  lines.push(nextSection("超载与不足明细"));
  lines.push("");
  const abnormal = report.estimates.filter((estimate) => estimate.level !== "ok");
  if (!abnormal.length) {
    lines.push("无。");
  } else {
    for (const estimate of abnormal) {
      const shareNote = estimate.shareNote ? `（份额：${estimate.shareNote}）` : "";
      lines.push(`- ${episodeLabel(estimate.episodeNo)}：${estimate.detail}${shareNote}`);
      lines.push(`  - 处理建议：${estimate.suggestion}`);
      if (estimate.splitOverheadNote) {
        lines.push(`  - 预排余量：${estimate.splitOverheadNote}`);
      }
      if (estimate.splitCount && estimate.splitCount > 1) {
        lines.push(`  - 建议拆集：${estimate.splitCount} 集（按场/节拍边界落刀，台词逐字保留）`);
      }
      if (estimate.authorizedCutChars > 0) {
        lines.push(
          `  - 授权删减路线（需用户明确授权并登记豁免）：删减约 ${estimate.authorizedCutChars} 字台词可回到预算内`,
        );
      }
      if (estimate.timingSource === "inferred") {
        lines.push("  - 折算来源：条数/标点由字数推断（旧骨架缺声明），采纳前请补《容量预算》声明");
      }
    }
  }
  lines.push("");

  const parseWarnings = report.estimates
    .filter((estimate) => estimate.parseWarning)
    .map((estimate) => `- ${episodeLabel(estimate.episodeNo)}：${estimate.parseWarning}`);
  if (parseWarnings.length) {
    lines.push(nextSection("解析提示"));
    lines.push("");
    lines.push(...parseWarnings);
    lines.push("");
  }

  if (report.structureWarnings.length) {
    lines.push(nextSection("结构校验提示"));
    lines.push("");
    lines.push(...report.structureWarnings.map((warning) => `- ${warning}`));
    lines.push("");
  }

  const pick = (level: SkeletonCheckLevel) =>
    report.estimates
      .filter((estimate) => estimate.level === level)
      .map((estimate) => episodeLabel(estimate.episodeNo))
      .join("、");
  lines.push(nextSection("汇总"));
  lines.push("");
  lines.push(
    `- 严重超载：${pick("severeOver") || "无"}；轻度超载：${pick("lightOver") || "无"}；素材不足：${pick("under") || "无"}；通过：${pick("ok") || "无"}`,
  );
  const pickCapacity = (level: EpisodeCapacityLevel) =>
    report.estimates
      .filter((estimate) => estimate.capacityLevel === level)
      .map((estimate) => episodeLabel(estimate.episodeNo))
      .join("、");
  lines.push(
    `- 制作侧三态：必拆 ${pickCapacity("splitRequired") || "无"}；建议拆集 ${pickCapacity("splitPressure") || "无"}；可骑线执行（不得作为返工理由）${pickCapacity("rideLine") || "无"}；直接排 ${pickCapacity("ok") || "无"}`,
  );
  const totalLoad = report.estimates.reduce(
    (sum, estimate) => ({
      chars: sum.chars + estimate.quoteChars,
      lines: sum.lines + estimate.quoteLines,
      marks: sum.marks + estimate.quoteMarks,
      inferred: sum.inferred || estimate.timingSource === "inferred",
    }),
    { chars: 0, lines: 0, marks: 0, inferred: false },
  );
  if (totalLoad.chars > 0) {
    const count = suggestEpisodeCount(totalLoad, EPISODE_CAPACITY_BUDGET);
    lines.push(
      `- 全剧集数建议（逐字保留口径，共 ${totalLoad.lines} 条 / ${totalLoad.chars} 字）：物理下限 ${count.min} 集；舒适 ${count.comfort} 集；上限 ${count.max} 集。${count.notes.join("；")}`,
    );
    const splitNeeded = report.estimates.filter(
      (estimate) => estimate.capacityLevel === "splitRequired" || estimate.capacityLevel === "splitPressure",
    );
    if (splitNeeded.length) {
      const extra = splitNeeded.reduce((sum, estimate) => sum + Math.max(0, (estimate.splitCount ?? 1) - 1), 0);
      lines.push(
        `- 拆集投影：${splitNeeded.map((estimate) => `${episodeLabel(estimate.episodeNo)}→${estimate.splitCount ?? 1}集`).join("、")}；若全部执行，总集数约 ${report.estimates.length + extra} 集`,
      );
    }
  }
  if (report.warnings.length) {
    lines.push(...report.warnings.map((warning) => `- 检查提示：${warning}`));
  }
  lines.push("");
  lines.push(
    "处理口径：严重超载为确定性阻塞，不得进入剧本编写阶段——先按「建议拆集」重划分集（台词逐字保留，默认不动原文），复检通过后再写剧本；删台词与放宽时长仅限用户明确授权并登记豁免。轻度超载与素材不足为提示项，由审核按语义裁量与用户决策。以上结论为工具判定的事实层，审核不得推翻。",
  );

  return lines.join("\n");
}
