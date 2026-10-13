/**
 * 分镜表确定性检查模块（生产审核链路的"事实层"）
 *
 * 目的：把"本该精确"的判定——片段累计时长档位、单镜台词时长、无台词镜上限、
 * 禁光影/配乐词、资产 ID 有效性、格式完整性——从审核层 LLM 的主观裁量中剥离，
 * 改由代码给出同输入同输出的确定性结论，供宿主自动回喂修复与审核报告原样引用，
 * 压缩评分方差，避免"同一句台词每轮算出不同字数/不同所需时长"的判据漂移。
 *
 * 设计约束：
 * - 纯函数与 IO 分离：解析 / 折算 / 扫描均为纯函数，可单测；只有 runStoryboardChecks 读库。
 * - 参数集中可调：见 STORYBOARD_CHECK_CONFIG。
 * - 台词行不做禁词扫描（台词是剧本原文，改字即改写台词）；只扫 画面描述 / 运镜 / 音效。
 * - 单镜台词时长给两级线：
 *   硬底线（快语速都放不下）= 阻塞，交宿主自动修复；
 *   安全线（慢语速 + 标点停顿 + 安全余量）= 完全达标；
 *   两线之间 = 骑线，交语义层（LLM 审核）结合画面动作裁量。
 */

import {
  extractScriptDialogues,
  normalizeForCompare,
  parseScriptEpisode,
  similarityRatio,
  type ScriptLine,
} from "@/agents/scriptAgent/scriptChecks";
import {
  EPISODE_CAPACITY_BUDGET,
  suggestSplitCount,
  type DialogueLoad,
} from "@/agents/shared/episodeCapacity";

export type StoryboardCheckSeverity = "阻塞" | "骑线" | "提示";

/* ==================== 配置 ==================== */

export interface StoryboardCheckConfig {
  /** 片段累计时长档位（分镜规划口径：12 秒档 / 17 秒档） */
  tiers: { min: number; max: number; label: string }[];
  /** 档位骑线容差（秒）：落在档位外但差值不超过该容差的，判骑线而非阻塞 */
  tierToleranceSeconds: number;
  /** 单镜台词时长折算 */
  dialogue: {
    /** 硬底线语速（字/秒）：低于「字数 ÷ 该值 + 硬底线余量」= 阻塞 */
    hardCharsPerSecond: number;
    hardBufferSeconds: number;
    /** 安全线语速（字/秒）+ 每个标点停顿（秒）+ 安全余量（秒）；达到即完全达标 */
    safeCharsPerSecond: number;
    safePausePerMark: number;
    safeBufferSeconds: number;
    /** 单镜台词超过该字数时给"拆镜"提示（提示级，不阻塞） */
    longLineChars: number;
  };
  /** 无台词镜时长上限（超过 = 骑线 / 阻塞） */
  silentShot: { borderlineSeconds: number; blockingSeconds: number };
  /** 画面描述长度（提示级） */
  description: { minChars: number; maxChars: number };
  /** 单镜台词容量上限（提示级；字数含标点。H3 参考档 = 46 字／镜；接入其它模型时按模型能力替换） */
  dialogueCapacity: { maxChars: number };
  /**
   * 单集合计容量（与骨架层 SKELETON_CHECK_CONFIG、剧本层 SCRIPT_CHECK_CONFIG 共用同一套数字：
   * 100~130 秒目标、130×1.2+1=157 秒严重线、85 秒素材不足线）。
   * 分镜阶段是"逐镜实测求和"，故上级三档为：>157s 阻塞 / >130s 骑线 / <85s 提示。
   */
  episodeTarget: {
    minSeconds: number;
    maxSeconds: number;
    /** 严重超载阈值：合计 > 上限 × 该系数 + 容差 判阻塞 */
    severeOverRatio: number;
    severeToleranceSeconds: number;
    /** 素材不足阈值：合计 < 下限 × 该系数 判提示 */
    underRatio: number;
    /** 上限容差（秒）：超上限不足该值不判骑线，避免四舍五入误报 */
    toleranceSeconds: number;
  };
  /** 剧本台词 ↔ 分镜台词 覆盖度比对（事实层） */
  coverage: {
    /** 模糊匹配阈值：相似度 ≥ 该值判"疑似改写"（骑线），低于则判缺失（阻塞） */
    similarityThreshold: number;
    /** 归一化后短于该字数的句子不参与模糊判定，直接判缺失，避免"好。"这类短句误配 */
    minFuzzyChars: number;
    /** 拆镜窗口上限：同一句落在连续 N 镜内、拼接后逐字一致 = 拆分（合规） */
    splitWindow: number;
    /** 报告与问题清单最多列出的明细条数（超出部分汇总计数） */
    maxReportItems: number;
  };
  /** 画面描述模糊指代词（命中 = 提示；规范守则14/15） */
  vagueWords: string[];
  /** 画面描述/运镜中的元语言与审核口径（命中 = 提示；规范守则13） */
  metaWords: string[];
  /** 后期操作词（画面描述/运镜命中 = 提示；规范守则4/8：慢放、变速、字幕属后期） */
  postWords: string[];
  /** 每集片段数预算（H3 参考档 = 8 段／集，见规范第一节）：>maxSegments 骑线、>blockingSegments 阻塞 */
  segmentBudget: { maxSegments: number; blockingSegments: number };
  /** 禁词表 */
  banned: {
    /** 光影色调强违规词（命中 = 阻塞） */
    lightWords: string[];
    /** 光影色调弱字（命中 = 提示；扫描前先剔除 allowList 内的常见无害词） */
    lightNoticeChars: string[];
    /** 扫描前剔除的常见无害词（如"目光""倒影"） */
    allowList: string[];
    /** 配乐类词（命中 = 阻塞，仅扫音效列） */
    musicWords: string[];
  };
}

export const STORYBOARD_CHECK_CONFIG: StoryboardCheckConfig = {
  tiers: [
    { min: 11, max: 13, label: "12 秒档" },
    { min: 16, max: 18, label: "17 秒档" },
  ],
  tierToleranceSeconds: 0.5,
  dialogue: {
    hardCharsPerSecond: 4.5,
    hardBufferSeconds: 0.3,
    safeCharsPerSecond: 4,
    safePausePerMark: 0.4,
    safeBufferSeconds: 1,
    longLineChars: 20,
  },
  silentShot: { borderlineSeconds: 6, blockingSeconds: 7 },
  description: { minChars: 15, maxChars: 60 },
  dialogueCapacity: { maxChars: 46 },
  episodeTarget: {
    minSeconds: 100,
    maxSeconds: 130,
    severeOverRatio: 1.2,
    severeToleranceSeconds: 1,
    underRatio: 0.85,
    toleranceSeconds: 1,
  },
  coverage: {
    similarityThreshold: 0.85,
    minFuzzyChars: 5,
    splitWindow: 3,
    maxReportItems: 6,
  },
  vagueWords: [
    "隐约人影",
    "隐约的人影",
    "众人攒动",
    "人头攒动",
    "更多身影",
    "模糊人影",
    "虚化人形",
    "一道黑影",
    "黑压压的人影",
  ],
  metaWords: ["无血迹", "按动作镜", "按对白镜", "按画外音镜", "按镜处理", "只有蛮力", "负面提示词"],
  postWords: ["慢放", "升格", "降格", "变速", "后期处理", "后期叠加", "补帧", "光流", "调色", "滤镜", "字幕"],
  segmentBudget: { maxSegments: 8, blockingSegments: 10 },
  banned: {
    lightWords: [
      "冷光", "暖光", "暖黄", "冷黄", "暖橙", "冷蓝", "逆光", "侧光", "顶光", "打光",
      "光影", "光晕", "光斑", "高光", "柔光", "硬光", "追光", "阴影", "暗影",
      "色温", "明暗", "色调", "暖色", "冷色", "冷暖", "黄雾", "灯光",
    ],
    lightNoticeChars: ["光", "影", "亮", "暗", "冷", "暖"],
    allowList: [
      "目光", "眼光", "眼神", "影子", "倒影", "身影", "人影", "光亮", "手机屏", "屏幕",
      "闪亮", "天亮", "夜色", "深夜", "前夜", "夜景", "照明", "冷面", "冷摊", "暖手",
    ],
    musicWords: ["BGM", "bgm", "Bgm", "配乐", "背景音乐", "音乐", "旋律", "主题曲", "插曲", "管弦", "弦乐铺底"],
  },
};

/* ==================== 解析 ==================== */

export interface StoryboardShot {
  /** 序号列的原始文本 */
  serialRaw: string;
  /** 序号（解析失败为 null） */
  serial: number | null;
  description: string;
  /** 时长（秒，解析失败为 null） */
  duration: number | null;
  durationRaw: string;
  shotSize: string;
  camera: string;
  /** 台词列原文（含来源人标注） */
  dialogueRaw: string;
  sound: string;
  /** 实际解析到的单元格数量 */
  columnCount: number;
}

export interface StoryboardSegment {
  /** 全文文档顺序（1-based） */
  index: number;
  /** 场内顺序（1-based） */
  orderInScene: number;
  /** 片段标题原文，如"片段一" */
  title: string;
  /** 标题声明的（约Ns）；无声明为 null */
  declaredSeconds: number | null;
  headingRaw: string;
  assetNames: string[];
  assetIds: number[];
  assetNamesRaw: string;
  assetIdsRaw: string;
  shots: StoryboardShot[];
  /** 片段级原始文本行（合并守卫使用） */
  rawLines: string[];
}

export interface StoryboardScene {
  /** 场号（解析失败为 null） */
  sceneNo: number | null;
  /** 文档顺序（1-based） */
  index: number;
  /** 场景名 */
  title: string;
  /** 参演角色（原文拆分） */
  characters: string[];
  headerRaw: string;
  segments: StoryboardSegment[];
  /** 场景级原始文本行（合并守卫使用） */
  rawLines: string[];
}

export interface ParsedStoryboardTable {
  scenes: StoryboardScene[];
  warnings: string[];
}

const SCENE_HEADER_PATTERN = /^##\s*场\s*(\d+)\s*[：:]\s*(.*)$/;
export const SEGMENT_HEADER_PATTERN = /^###\s*(.+?)\s*(?:[（(]\s*约?\s*(\d+(?:\.\d+)?)\s*(?:s|秒)?\s*[）)])?\s*$/;

/** 解析片段标题行：「### 片段一（约12s）」→ { title: "片段一", declaredSeconds: 12 } */
export function parseSegmentHeading(line: string): { title: string; declaredSeconds: number | null } | null {
  const match = String(line ?? "").match(SEGMENT_HEADER_PATTERN);
  if (!match) return null;
  return {
    title: match[1].trim(),
    declaredSeconds: match[2] !== undefined ? Number(match[2]) : null,
  };
}
const ASSET_NAMES_PATTERN = /^\*\*引用资产名称\*\*\s*[：:]\s*[\[［]([\s\S]*?)[\]］]\s*$/;
const ASSET_IDS_PATTERN = /^\*\*引用资产ID\*\*\s*[：:]\s*[\[［]([\s\S]*?)[\]］]\s*$/i;
const TABLE_SEPARATOR_PATTERN = /^\|[\s:：\-—|]+\|$/;
const SHOT_ID_COLUMN_PATTERN = /序号/;
const SHOT_DESC_COLUMN_PATTERN = /画面描述/;

const SHOT_COLUMNS = ["序号", "画面描述", "时长", "景别", "运镜", "台词", "音效"] as const;
export const STORYBOARD_SHOT_COLUMN_COUNT = SHOT_COLUMNS.length;

function splitCells(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return [];
  const inner = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  return inner.split("|").map((cell) => cell.trim());
}

/** 解析时长单元格："4" / "4s" / "3.5 秒" / "4~5"（取首个数字） */
export function parseDurationCell(raw: string): number | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const match = text.match(/\d+(?:\.\d+)?/);
  if (!match) return null;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : null;
}

function parseAssetNames(raw: string): string[] {
  return String(raw ?? "")
    .split(/[,，、]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * 从台词单元格提取"实际说出的文本"（引号内内容优先）。
 * 支持 『』「」“”" 等包裹；无引号时回退为整格去来源人前缀的文本。
 */
export function extractDialogueTexts(cell: string): string[] {
  const text = String(cell ?? "").trim();
  if (!text) return [];
  const quoted: string[] = [];
  const pattern = /[『「“‘"]([^』」”’"]+)[』」”’"]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const inner = match[1].trim();
    if (inner) quoted.push(inner);
  }
  if (quoted.length) return quoted;
  // 无引号：去掉"说话人："前缀后取剩余文本
  const withoutSpeaker = text.replace(/^[^：:]{1,24}[：:]\s*/, "").trim();
  return withoutSpeaker ? [withoutSpeaker] : [];
}

/** 统计台词字数（仅文字与数字，不含空白与标点） */
export function countDialogueChars(text: string): number {
  return String(text ?? "").replace(/[^\p{L}\p{N}]/gu, "").length;
}

/** 统计台词标点数量（用于停顿折算） */
export function countDialogueMarks(text: string): number {
  const matches = String(text ?? "").match(/[,，。.、；;：:！!？?…—～~·\-－]/g);
  return matches ? matches.length : 0;
}

/**
 * 解析分镜表 markdown 为 场 → 片段 → 镜 的结构（AST）。
 * 容错优先：结构缺失只记 warnings，不抛异常。
 */
export function parseStoryboardTable(markdown: string): ParsedStoryboardTable {
  const lines = String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
  const warnings: string[] = [];
  const scenes: StoryboardScene[] = [];

  let currentScene: StoryboardScene | null = null;
  let currentSegment: StoryboardSegment | null = null;

  const ensureScene = (): StoryboardScene => {
    if (currentScene) return currentScene;
    warnings.push("发现不属于任何场次的内容（缺少「## 场N：…」场头），已归入隐式场0");
    currentScene = {
      sceneNo: null,
      index: scenes.length + 1,
      title: "",
      characters: [],
      headerRaw: "",
      segments: [],
      rawLines: [],
    };
    scenes.push(currentScene);
    return currentScene;
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/g, "");
    const trimmed = line.trim();

    const sceneMatch = trimmed.match(SCENE_HEADER_PATTERN);
    if (sceneMatch) {
      const rest = sceneMatch[2] ?? "";
      const [titlePart] = rest.split(/[｜|]/);
      const charsMatch = rest.match(/参演角色\s*[：:]\s*(.*)$/);
      currentScene = {
        sceneNo: Number(sceneMatch[1]),
        index: scenes.length + 1,
        title: String(titlePart ?? "").trim(),
        characters: charsMatch
          ? charsMatch[1].split(/[、,，]/).map((item) => item.trim()).filter(Boolean)
          : [],
        headerRaw: line,
        segments: [],
        rawLines: [line],
      };
      scenes.push(currentScene);
      currentSegment = null;
      continue;
    }

    const segmentHeading = parseSegmentHeading(trimmed);
    if (segmentHeading) {
      const scene = ensureScene();
      currentSegment = {
        index: scene.segments.length + 1 + scenes
          .slice(0, scenes.length - 1)
          .reduce((total, item) => total + item.segments.length, 0),
        orderInScene: scene.segments.length + 1,
        title: segmentHeading.title,
        declaredSeconds: segmentHeading.declaredSeconds,
        headingRaw: line,
        assetNames: [],
        assetIds: [],
        assetNamesRaw: "",
        assetIdsRaw: "",
        shots: [],
        rawLines: [line],
      };
      scene.segments.push(currentSegment);
      scene.rawLines.push(line);
      continue;
    }

    if (!trimmed) {
      continue;
    }

    const targetScene = currentScene as StoryboardScene | null;
    const targetSegment = currentSegment as StoryboardSegment | null;

    if (targetScene) targetScene.rawLines.push(line);
    if (targetSegment) targetSegment.rawLines.push(line);

    const namesMatch = trimmed.match(ASSET_NAMES_PATTERN);
    if (namesMatch) {
      if (!targetSegment) {
        warnings.push(`发现片段级「引用资产名称」但没有片段标题：${trimmed.slice(0, 40)}`);
        continue;
      }
      targetSegment.assetNamesRaw = namesMatch[1];
      targetSegment.assetNames = parseAssetNames(namesMatch[1]);
      continue;
    }

    const idsMatch = trimmed.match(ASSET_IDS_PATTERN);
    if (idsMatch) {
      if (!targetSegment) {
        warnings.push(`发现片段级「引用资产ID」但没有片段标题：${trimmed.slice(0, 40)}`);
        continue;
      }
      targetSegment.assetIdsRaw = idsMatch[1];
      targetSegment.assetIds = [...new Set((idsMatch[1].match(/\d+/g) || []).map(Number))];
      continue;
    }

    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      if (!currentSegment) continue;
      if (TABLE_SEPARATOR_PATTERN.test(trimmed)) continue;
      if (SHOT_ID_COLUMN_PATTERN.test(trimmed) && SHOT_DESC_COLUMN_PATTERN.test(trimmed)) continue;
      const cells = splitCells(trimmed);
      if (!cells.length) continue;
      const [serialRaw = "", description = "", durationRaw = "", shotSize = "", camera = "", dialogueRaw = "", sound = ""] = cells;
      currentSegment.shots.push({
        serialRaw,
        serial: /^\d+$/.test(serialRaw) ? Number(serialRaw) : null,
        description,
        duration: parseDurationCell(durationRaw),
        durationRaw,
        shotSize,
        camera,
        dialogueRaw,
        sound,
        columnCount: cells.length,
      });
      continue;
    }
  }

  if (!scenes.length) warnings.push("未识别到任何场次与片段（分镜表结构为空或格式不符）");

  // 重新计算全局片段序号（保证与文档顺序一致）
  let globalIndex = 0;
  for (const scene of scenes) {
    for (const segment of scene.segments) {
      globalIndex += 1;
      segment.index = globalIndex;
    }
  }

  return { scenes, warnings };
}

/* ==================== 检查 ==================== */

export interface StoryboardAssetRef {
  id: number;
  name: string;
  type: string;
  /** 衍生资产的父资产 ID（非衍生为 null） */
  parentId?: number | null;
}

export interface StoryboardIssue {
  severity: StoryboardCheckSeverity;
  category: string;
  /** 人类可读位置，如「场1·片段一·镜3」 */
  location: string;
  sceneNo: number | null;
  /** 文档顺序（授权范围用）：1-based */
  sceneOrder: number;
  /** 场内片段序号：1-based；场级问题为 null */
  segmentOrderInScene: number | null;
  segmentIndex: number | null;
  shotSerial: number | null;
  problem: string;
  /** 当前值（如"3 秒"） */
  current?: string;
  /** 目标/期望（如"≥ 4.7 秒"） */
  target?: string;
  /** 是否机器可自动修复（无歧义修改） */
  autoFixable: boolean;
}

/**
 * 容量豁免（由用户在决策层显式授权后落库，例如「接受现状/授权删减」）。
 * 工具不得自动生成豁免；判定时按「预算 + 豁免」执行。
 */
export interface StoryboardWaiver {
  /** duration = 放宽单集时长预算；dialogue = 授权删减台词字数 */
  scope: "duration" | "dialogue";
  /** scope=duration 时放宽的秒数 */
  allowanceSeconds?: number;
  /** scope=dialogue 时授权的删减字数 */
  allowanceChars?: number;
  reason?: string;
  grantedBy?: string;
  at?: number;
}

/** 剧本台词 ↔ 分镜台词覆盖度（事实层；同输入同输出） */
export interface StoryboardDialogueCoverage {
  /** 剧本台词句数（含 OS/VO） */
  scriptLines: number;
  /** 分镜台词单元数（一个镜可承载多句） */
  storyboardUnits: number;
  /** 逐字一致（归一化后完全相等） */
  verbatim: number;
  /** 拆镜承载（同一句落在连续多镜，拼接后逐字一致）= 合规 */
  split: number;
  /** 缺失（剧本有、分镜找不到） */
  missing: Array<{ script: string; lineNo: number; speaker?: string }>;
  /** 疑似改写（相似度达阈值但非逐字） */
  rewritten: Array<{ script: string; lineNo: number; best: string; similarity: number; location: string }>;
  /** 分镜额外（分镜有、剧本找不到；可能为 VO/画面文字） */
  extra: Array<{ text: string; location: string }>;
}

export interface StoryboardCheckReport {
  generatedAt: number;
  sceneCount: number;
  segmentCount: number;
  shotCount: number;
  issues: StoryboardIssue[];
  blockingCount: number;
  borderlineCount: number;
  noticeCount: number;
  parseWarnings: string[];
  /** 单集合计时长（秒）= 全部镜时长之和；时长不可解析的镜按 0 计并单独计数 */
  episodeSeconds?: number;
  /** 时长不可解析的镜数（合计失真风险提示） */
  shotsWithoutDuration?: number;
  /** 本次判定采用的单集上限（含 duration 豁免） */
  effectiveMaxSeconds?: number;
  /** 台词净时长下限（秒）：字数÷4.5+0.3×台词镜数，物理上不可再低 */
  dialogueFloorSeconds?: number;
  /** 台词安全时长（秒）：字数÷4+0.4×标点+1×台词镜数 */
  dialogueSafeSeconds?: number;
  /** 本集台词字数（不含标点）与标点数 */
  dialogueChars?: number;
  dialogueMarks?: number;
  /** 含台词的镜数（骑线占比的分母） */
  dialogueShots?: number;
  /** 低于台词安全线的镜数（骑线 + 阻塞） */
  dialogueShotsTight?: number;
  /** 骑线占比 = 低于安全线的台词镜 / 台词镜总数（0-1） */
  rideLineRatio?: number;
  /** 拆集建议（提示级：骑线不阻塞、不得作为返工理由；容量不够时优先拆集） */
  splitSuggestion?: { count: number; reason: string };
  /** 施加的豁免 */
  appliedWaivers?: StoryboardWaiver[];
  /** 台词覆盖度（未提供剧本时为 undefined） */
  dialogueCoverage?: StoryboardDialogueCoverage;
}

export interface StoryboardCheckOptions {
  assets?: StoryboardAssetRef[];
  config?: StoryboardCheckConfig;
  /** 本集剧本（用于"剧本台词 ↔ 分镜台词"逐条比对；缺省则跳过比对并提示） */
  script?: { name?: string; content?: string } | null;
  /** 已登记的容量豁免（按"预算 + 豁免"判定） */
  waivers?: StoryboardWaiver[];
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function locationLabel(scene: StoryboardScene, segment?: StoryboardSegment | null, shot?: StoryboardShot | null): string {
  const sceneLabel = scene.sceneNo != null ? `场${scene.sceneNo}` : `场${scene.index}（未编号）`;
  if (!segment) return sceneLabel;
  const parts = [sceneLabel, segment.title || `片段${segment.orderInScene}`];
  if (shot?.serial != null) parts.push(`镜${shot.serial}`);
  return parts.join("·");
}

function dialogueMetrics(shots: StoryboardShot[]): { chars: number; marks: number } {
  let chars = 0;
  let marks = 0;
  for (const shot of shots) {
    for (const text of extractDialogueTexts(shot.dialogueRaw)) {
      chars += countDialogueChars(text);
      marks += countDialogueMarks(text);
    }
  }
  return { chars, marks };
}

function sanitizeForScan(text: string, allowList: string[]): string {
  let result = String(text ?? "");
  for (const word of allowList) {
    result = result.split(word).join("");
  }
  return result;
}

function countOccurrences(text: string, words: string[]): string[] {
  return words.filter((word) => word && text.includes(word));
}

/* ==================== 单集合计与台词覆盖度（事实层纯函数） ==================== */

export interface StoryboardEpisodeFacts {
  /** 全部镜时长之和（秒） */
  seconds: number;
  /** 时长不可解析的镜数 */
  shotsWithoutDuration: number;
  /** 台词字数（不含标点与空白） */
  dialogueChars: number;
  /** 台词标点数 */
  dialogueMarks: number;
  /** 含台词的镜数 */
  dialogueShots: number;
}

/** 逐镜求和得到单集容量事实（时长不可解析按 0 计但单独计数） */
export function collectEpisodeFacts(parsed: ParsedStoryboardTable): StoryboardEpisodeFacts {
  const facts: StoryboardEpisodeFacts = {
    seconds: 0,
    shotsWithoutDuration: 0,
    dialogueChars: 0,
    dialogueMarks: 0,
    dialogueShots: 0,
  };
  for (const scene of parsed.scenes) {
    for (const segment of scene.segments) {
      for (const shot of segment.shots) {
        if (shot.duration == null) facts.shotsWithoutDuration += 1;
        else facts.seconds += shot.duration;
        const texts = extractDialogueTexts(shot.dialogueRaw);
        if (!texts.length) continue;
        facts.dialogueShots += 1;
        for (const text of texts) {
          facts.dialogueChars += countDialogueChars(text);
          facts.dialogueMarks += countDialogueMarks(text);
        }
      }
    }
  }
  facts.seconds = round1(facts.seconds);
  return facts;
}

export interface StoryboardDialogueUnit {
  /** 台词正文（已剥离说话人与引号） */
  text: string;
  /** 归一化文本（仅文字与数字） */
  norm: string;
  location: string;
}

/** 按镜序收集分镜台词单元（用于与剧本逐条比对） */
export function collectStoryboardDialogueUnits(parsed: ParsedStoryboardTable): StoryboardDialogueUnit[] {
  const units: StoryboardDialogueUnit[] = [];
  for (const scene of parsed.scenes) {
    for (const segment of scene.segments) {
      for (const shot of segment.shots) {
        for (const text of extractDialogueTexts(shot.dialogueRaw)) {
          const norm = normalizeForCompare(text);
          if (!norm) continue;
          units.push({ text: String(text).trim(), norm, location: locationLabel(scene, segment, shot) });
        }
      }
    }
  }
  return units;
}

/** 剧本书写规范里的对白行：`角色（情绪/动作）：台词`（前缀较长时解析器会归入 other，这里补捞） */
const PARENTHETICAL_DIALOGUE_PATTERN = /^([^：:\s#△|>【〖（(]{1,12})（[^）]{1,20}）\s*[:：]\s*(.+)$/;

/**
 * 取剧本中的"可听见内容"（对白 + OS/VO），保持行序。
 * - 剔除剧本内场记注释（【信息差类型：…】等，解析器会误判为对白）；
 * - 补捞"角色（超长情绪说明）：台词"这类被解析器归入 other 的对白行。
 */
export function scriptSpokenLines(content: string, name?: string): ScriptLine[] {
  const parsed = parseScriptEpisode(String(name ?? ""), String(content ?? ""));
  const captured = new Set<number>();
  const lines: ScriptLine[] = [];
  const push = (line: ScriptLine) => {
    if (!line.text.trim() || !normalizeForCompare(line.text)) return;
    captured.add(line.lineNo);
    lines.push(line);
  };

  for (const line of parsed.lines) {
    const speaker = String(line.speaker ?? "");
    // 场记注释不是可听见内容（解析器的通用对白规则会把「【信息差类型：…】」判成对白）
    if (/^[【〖[]/.test(speaker) || /^[【〖]/.test(line.raw.trim())) continue;
    if (line.type === "dialogue" || line.type === "os" || line.type === "vs") {
      push(line);
      continue;
    }
    const matched = line.raw.trim().match(PARENTHETICAL_DIALOGUE_PATTERN);
    if (!matched || captured.has(line.lineNo)) continue;
    push({
      lineNo: line.lineNo,
      type: "dialogue",
      speaker: matched[1].trim(),
      text: matched[2].trim(),
      raw: line.raw,
    });
  }

  return lines.sort((a, b) => a.lineNo - b.lineNo);
}

/**
 * 剧本台词 ↔ 分镜台词 逐条比对（确定性）：
 * 逐字一致 → 拆镜（连续 2..N 镜拼接后一致，合规）→ 疑似改写（相似度达阈值）→ 缺失。
 * 分镜中未被匹配到的台词单元 → 额外（多为 VO/画面文字）。
 */
export function checkDialogueCoverage(
  scriptContent: string,
  scriptName: string | undefined,
  units: StoryboardDialogueUnit[],
  config: StoryboardCheckConfig = STORYBOARD_CHECK_CONFIG,
): StoryboardDialogueCoverage {
  const { similarityThreshold, minFuzzyChars, splitWindow } = config.coverage;
  const lines = scriptSpokenLines(scriptContent, scriptName);
  const used = new Array<boolean>(units.length).fill(false);
  const indexByNorm = new Map<string, number[]>();
  units.forEach((unit, index) => {
    const list = indexByNorm.get(unit.norm) ?? [];
    list.push(index);
    indexByNorm.set(unit.norm, list);
  });

  const coverage: StoryboardDialogueCoverage = {
    scriptLines: lines.length,
    storyboardUnits: units.length,
    verbatim: 0,
    split: 0,
    missing: [],
    rewritten: [],
    extra: [],
  };

  const unmatchedLines: ScriptLine[] = [];
  for (const line of lines) {
    const norm = normalizeForCompare(line.text);
    const candidates = indexByNorm.get(norm) ?? [];
    const hit = candidates.find((index) => !used[index]);
    if (hit !== undefined) {
      used[hit] = true;
      coverage.verbatim += 1;
      continue;
    }
    unmatchedLines.push(line);
  }

  const stillMissing: ScriptLine[] = [];
  for (const line of unmatchedLines) {
    const norm = normalizeForCompare(line.text);
    let matched = false;
    for (let start = 0; start < units.length && !matched; start += 1) {
      if (used[start]) continue;
      let merged = "";
      for (let step = 1; step <= splitWindow; step += 1) {
        const index = start + step - 1;
        if (index >= units.length || used[index]) break;
        merged += units[index].norm;
        if (step >= 2 && merged === norm) {
          for (let cursor = start; cursor < start + step; cursor += 1) used[cursor] = true;
          coverage.split += 1;
          matched = true;
          break;
        }
        if (merged.length > norm.length) break;
      }
    }
    if (!matched) stillMissing.push(line);
  }

  for (const line of stillMissing) {
    const norm = normalizeForCompare(line.text);
    let bestIndex = -1;
    let bestScore = 0;
    if (norm.length >= minFuzzyChars) {
      for (let index = 0; index < units.length; index += 1) {
        if (used[index]) continue;
        const score = similarityRatio(norm, units[index].norm);
        if (score > bestScore) {
          bestScore = score;
          bestIndex = index;
        }
      }
    }
    if (bestIndex >= 0 && bestScore >= similarityThreshold) {
      used[bestIndex] = true;
      coverage.rewritten.push({
        script: line.text,
        lineNo: line.lineNo,
        best: units[bestIndex].text,
        similarity: Math.round(bestScore * 100) / 100,
        location: units[bestIndex].location,
      });
      continue;
    }
    coverage.missing.push({ script: line.text, lineNo: line.lineNo, speaker: line.speaker });
  }

  units.forEach((unit, index) => {
    if (!used[index]) coverage.extra.push({ text: unit.text, location: unit.location });
  });
  return coverage;
}

/** 纯函数：对分镜表 markdown 做确定性检查 */
export function checkStoryboardTable(
  markdown: string,
  options: StoryboardCheckOptions = {},
): StoryboardCheckReport {
  const config = options.config ?? STORYBOARD_CHECK_CONFIG;
  const parsed = parseStoryboardTable(markdown);
  const assets = options.assets;
  const assetById = assets ? new Map(assets.map((asset) => [asset.id, asset])) : null;
  const hasSceneAsset = assets ? assets.some((asset) => asset.type === "scene") : false;

  const issues: StoryboardIssue[] = [];
  const push = (issue: StoryboardIssue) => issues.push(issue);

  let segmentCount = 0;
  let shotCount = 0;
  /** 低于台词安全线的镜数（含阻塞与骑线）：用于算"骑线占比"——占比过高说明全片在压语速，应拆集 */
  let dialogueShotsTight = 0;

  for (const scene of parsed.scenes) {
    const sceneBase = {
      sceneNo: scene.sceneNo,
      sceneOrder: scene.index,
    };

    if (!scene.title) {
      push({
        severity: "阻塞",
        category: "场头格式",
        location: `场${scene.index}`,
        ...sceneBase,
        segmentOrderInScene: null,
        segmentIndex: null,
        shotSerial: null,
        problem: "缺失场头（应为「## 场N：场景名 ｜ 参演角色：…」）",
        autoFixable: true,
      });
    }

    if (!scene.segments.length) {
      push({
        severity: "阻塞",
        category: "片段结构",
        location: `场${scene.index}`,
        ...sceneBase,
        segmentOrderInScene: null,
        segmentIndex: null,
        shotSerial: null,
        problem: "该场没有任何片段（缺少「### 片段X（约Ns）」段落）",
        autoFixable: true,
      });
      continue;
    }

    for (const segment of scene.segments) {
      segmentCount += 1;
      const segmentBase = {
        sceneNo: scene.sceneNo,
        sceneOrder: scene.index,
        segmentOrderInScene: segment.orderInScene,
        segmentIndex: segment.index,
      };

      if (!segment.shots.length) {
        push({
          severity: "阻塞",
          category: "片段结构",
          location: locationLabel(scene, segment),
          ...segmentBase,
          shotSerial: null,
          problem: "片段没有任何镜（缺少七列镜表行）",
          autoFixable: true,
        });
        continue;
      }

      // ---- 片段累计时长档位 ----
      let declaredOrComputedTotal = 0;
      let hasMissingDuration = false;
      for (const shot of segment.shots) {
        if (shot.duration == null) {
          hasMissingDuration = true;
          push({
            severity: "阻塞",
            category: "镜表格式",
            location: locationLabel(scene, segment, shot),
            ...segmentBase,
            shotSerial: shot.serial,
            problem: `时长列无法解析（原文「${shot.durationRaw}」）`,
            current: shot.durationRaw,
            target: "填写秒数（如 3 或 3.5）",
            autoFixable: false,
          });
        } else {
          declaredOrComputedTotal += shot.duration;
        }
      }

      if (!hasMissingDuration) {
        const total = round1(declaredOrComputedTotal);
        const tier = config.tiers.find((item) => total >= item.min && total <= item.max);
        if (!tier) {
          const tolerance = config.tierToleranceSeconds;
          const nearTier = config.tiers.find(
            (item) => total >= item.min - tolerance && total <= item.max + tolerance,
          );
          push({
            severity: nearTier ? "骑线" : "阻塞",
            category: "片段时长档位",
            location: locationLabel(scene, segment),
            ...segmentBase,
            shotSerial: null,
            problem: nearTier
              ? `片段累计 ${total} 秒，逼近${nearTier.label}边界（${nearTier.min}~${nearTier.max} 秒）`
              : `片段累计 ${total} 秒，不落在任何档位（12 秒档 11~13 秒 / 17 秒档 16~18 秒）`,
            current: `${total} 秒`,
            target: `${config.tiers.map((item) => `${item.label} ${item.min}~${item.max} 秒`).join(" 或 ")}`,
            autoFixable: true,
          });
        }
        if (segment.declaredSeconds != null && Math.abs(segment.declaredSeconds - total) > 0.5) {
          push({
            severity: "提示",
            category: "片段时长档位",
            location: locationLabel(scene, segment),
            ...segmentBase,
            shotSerial: null,
            problem: `标题声明「约${segment.declaredSeconds}s」与实际镜时长合计 ${total} 秒不一致`,
            current: `声明 ${segment.declaredSeconds} 秒 / 实际 ${total} 秒`,
            target: "标题声明与实际合计保持一致",
            autoFixable: true,
          });
        }
      }

      // ---- 资产引用 ----
      if (segment.assetIds.length !== segment.assetNames.length) {
        push({
          severity: "阻塞",
          category: "资产引用",
          location: locationLabel(scene, segment),
          ...segmentBase,
          shotSerial: null,
          problem: `引用资产名称（${segment.assetNames.length} 项）与引用资产ID（${segment.assetIds.length} 项）数量不一致`,
          current: `名称 ${segment.assetNames.length} / ID ${segment.assetIds.length}`,
          target: "名称与 ID 一一对应",
          autoFixable: true,
        });
      }

      if (assetById) {
        const missingIds = segment.assetIds.filter((id) => !assetById.has(id));
        if (missingIds.length) {
          push({
            severity: "阻塞",
            category: "资产引用",
            location: locationLabel(scene, segment),
            ...segmentBase,
            shotSerial: null,
            problem: `引用资产ID 在资产库中不存在：${missingIds.join(", ")}`,
            current: missingIds.join(", "),
            target: "仅引用资产库中真实存在的 ID",
            autoFixable: true,
          });
        }
        if (hasSceneAsset) {
          const sceneAssets = segment.assetIds
            .map((id) => assetById.get(id))
            .filter((asset): asset is StoryboardAssetRef => Boolean(asset && asset.type === "scene"));
          if (!sceneAssets.length) {
            push({
              severity: "阻塞",
              category: "资产引用",
              location: locationLabel(scene, segment),
              ...segmentBase,
              shotSerial: null,
              problem: "片段未引用任何 scene（场景）类型资产",
              current: segment.assetIds.join(", ") || "无",
              target: "补充所处场景的场景资产 ID",
              autoFixable: true,
            });
          }
        }
        const nameMismatch = segment.assetNames.filter((name) => {
          const candidates = [...assetById.values()];
          return !candidates.some((asset) => asset.name === name || asset.name.includes(name) || name.includes(asset.name));
        });
        if (nameMismatch.length) {
          push({
            severity: "提示",
            category: "资产引用",
            location: locationLabel(scene, segment),
            ...segmentBase,
            shotSerial: null,
            problem: `引用资产名称部分与资产库名称不一致：${nameMismatch.join("、")}`,
            current: nameMismatch.join("、"),
            target: "使用资产库中的正式名称",
            autoFixable: true,
          });
        }
      }

      // ---- 逐镜检查 ----
      for (const shot of segment.shots) {
        shotCount += 1;
        const shotBase = { ...segmentBase, shotSerial: shot.serial };

        if (shot.columnCount !== STORYBOARD_SHOT_COLUMN_COUNT) {
          push({
            severity: shot.columnCount > STORYBOARD_SHOT_COLUMN_COUNT ? "阻塞" : "提示",
            category: "镜表格式",
            location: locationLabel(scene, segment, shot),
            ...shotBase,
            problem: `镜表行应为 ${STORYBOARD_SHOT_COLUMN_COUNT} 列（${SHOT_COLUMNS.join("/")}），实际 ${shot.columnCount} 列`,
            current: `${shot.columnCount} 列`,
            target: `${STORYBOARD_SHOT_COLUMN_COUNT} 列`,
            autoFixable: shot.columnCount > STORYBOARD_SHOT_COLUMN_COUNT,
          });
        }

        const dialogues = extractDialogueTexts(shot.dialogueRaw);
        const duration = shot.duration;

        if (dialogues.length) {
          const chars = dialogues.reduce((total, text) => total + countDialogueChars(text), 0);
          const marks = dialogues.reduce((total, text) => total + countDialogueMarks(text), 0);
          const hardRequired = round1(chars / config.dialogue.hardCharsPerSecond + config.dialogue.hardBufferSeconds);
          const safeRequired = round1(
            chars / config.dialogue.safeCharsPerSecond +
              marks * config.dialogue.safePausePerMark +
              config.dialogue.safeBufferSeconds,
          );
          if (duration != null) {
            if (duration < hardRequired) {
              dialogueShotsTight += 1;
              push({
                severity: "阻塞",
                category: "台词镜时长",
                location: locationLabel(scene, segment, shot),
                ...shotBase,
                problem: `台词 ${chars} 字（${marks} 标点）配 ${duration} 秒，低于可承载下限`,
                current: `${duration} 秒`,
                target: `≥ ${hardRequired} 秒（完全达标需 ≥ ${safeRequired} 秒）`,
                autoFixable: true,
              });
            } else if (duration < safeRequired) {
              dialogueShotsTight += 1;
              push({
                severity: "骑线",
                category: "台词镜时长",
                location: locationLabel(scene, segment, shot),
                ...shotBase,
                problem: `台词 ${chars} 字（${marks} 标点）配 ${duration} 秒，处于骑线区`,
                current: `${duration} 秒`,
                target: `完全达标需 ≥ ${safeRequired} 秒`,
                autoFixable: false,
              });
            }
          }
          if (chars > config.dialogue.longLineChars) {
            push({
              severity: "提示",
              category: "长台词拆镜",
              location: locationLabel(scene, segment, shot),
              ...shotBase,
              problem: `单镜台词 ${chars} 字（> ${config.dialogue.longLineChars} 字），需按语义拆镜或确认单镜呈现有持续变化填充`,
              current: `${chars} 字`,
              target: `拆为多个连续镜（各换景别/视角）`,
              autoFixable: false,
            });
          }
          if (chars > config.dialogueCapacity.maxChars) {
            push({
              severity: "提示",
              category: "台词容量",
              location: locationLabel(scene, segment, shot),
              ...shotBase,
              problem: `单镜台词 ${chars} 字，超过每镜容量上限 ${config.dialogueCapacity.maxChars} 字（H3 参考档；接入其它模型时按模型能力替换）`,
              current: `${chars} 字`,
              target: `≤ ${config.dialogueCapacity.maxChars} 字`,
              autoFixable: false,
            });
          }
        } else if (duration != null) {
          if (duration > config.silentShot.blockingSeconds) {
            push({
              severity: "阻塞",
              category: "无台词镜时长",
              location: locationLabel(scene, segment, shot),
              ...shotBase,
              problem: `无台词镜时长 ${duration} 秒，超过上限`,
              current: `${duration} 秒`,
              target: `≤ ${config.silentShot.borderlineSeconds} 秒`,
              autoFixable: true,
            });
          } else if (duration > config.silentShot.borderlineSeconds) {
            push({
              severity: "骑线",
              category: "无台词镜时长",
              location: locationLabel(scene, segment, shot),
              ...shotBase,
              problem: `无台词镜时长 ${duration} 秒，贴边`,
              current: `${duration} 秒`,
              target: `≤ ${config.silentShot.borderlineSeconds} 秒`,
              autoFixable: false,
            });
          }
        }

        // 禁词扫描：只扫 画面描述 / 运镜 / 音效（台词是剧本原文，不扫）
        const scanFields: { field: string; text: string }[] = [
          { field: "画面描述", text: shot.description },
          { field: "运镜", text: shot.camera },
        ];
        for (const item of scanFields) {
          const sanitized = sanitizeForScan(item.text, config.banned.allowList);
          const strongHits = countOccurrences(sanitized, config.banned.lightWords);
          if (strongHits.length) {
            push({
              severity: "阻塞",
              category: "禁光影色调",
              location: locationLabel(scene, segment, shot),
              ...shotBase,
              problem: `${item.field}命中光影色调禁词：${strongHits.join("、")}`,
              current: strongHits.join("、"),
              target: "删除禁词，改用动作/物象/状态描述",
              autoFixable: true,
            });
          } else {
            const weakHits = countOccurrences(sanitized, config.banned.lightNoticeChars);
            if (weakHits.length) {
              push({
                severity: "提示",
                category: "禁光影色调",
                location: locationLabel(scene, segment, shot),
                ...shotBase,
                problem: `${item.field}出现疑似光影字：${weakHits.join("、")}`,
                current: weakHits.join("、"),
                target: "如为光影/色调描述请删除；如为物理物件（灯管等）可保留",
                autoFixable: false,
              });
            }
          }
        }
        const soundSanitized = sanitizeForScan(shot.sound, config.banned.allowList);
        const musicHits = countOccurrences(soundSanitized, config.banned.musicWords);
        if (musicHits.length) {
          push({
            severity: "阻塞",
            category: "音效禁配乐",
            location: locationLabel(scene, segment, shot),
            ...shotBase,
            problem: `音效列命中配乐类词：${musicHits.join("、")}`,
            current: musicHits.join("、"),
            target: "音效只保留环境音 + 动作音/拟音",
            autoFixable: true,
          });
        }

        // 画面描述长度（提示级）
        const descChars = countDialogueChars(shot.description);
        if (shot.description && descChars > 0 && descChars < config.description.minChars) {
          push({
            severity: "提示",
            category: "画面描述长度",
            location: locationLabel(scene, segment, shot),
            ...shotBase,
            problem: `画面描述 ${descChars} 字，偏短（建议 ${config.description.minChars}~${config.description.maxChars} 字）`,
            current: `${descChars} 字`,
            target: `≥ ${config.description.minChars} 字`,
            autoFixable: false,
          });
        } else if (descChars > config.description.maxChars) {
          push({
            severity: "提示",
            category: "画面描述长度",
            location: locationLabel(scene, segment, shot),
            ...shotBase,
            problem: `画面描述 ${descChars} 字，偏长（建议 ${config.description.minChars}~${config.description.maxChars} 字，建立镜可适当放宽）`,
            current: `${descChars} 字`,
            target: `≤ ${config.description.maxChars} 字（可拆镜）`,
            autoFixable: false,
          });
        }

        // ---- 规范提示级扫描（守则13/14/15、守则4/8；只提示、不参与阻塞判定）----
        const descScan = shot.description || "";
        const cameraScan = shot.camera || "";
        const vagueHits = countOccurrences(descScan, config.vagueWords);
        if (vagueHits.length) {
          push({
            severity: "提示",
            category: "模糊指代",
            location: locationLabel(scene, segment, shot),
            ...shotBase,
            problem: `画面描述命中模糊指代：${vagueHits.join("、")}（守则14/15：改用可识别的具名主体、具体光效或音效承载）`,
            current: vagueHits.join("、"),
            target: "改为具名主体 / 具体光效 / 音效承载",
            autoFixable: false,
          });
        }
        const metaHits = [
          ...new Set([...countOccurrences(descScan, config.metaWords), ...countOccurrences(cameraScan, config.metaWords)]),
        ];
        if (metaHits.length) {
          push({
            severity: "提示",
            category: "元语言入画面",
            location: locationLabel(scene, segment, shot),
            ...shotBase,
            problem: `画面描述/运镜命中元语言或审核口径：${metaHits.join("、")}（守则13：只写看得见的画面事实）`,
            current: metaHits.join("、"),
            target: "删除制作口径说明，只保留可见可闻内容",
            autoFixable: false,
          });
        }
        const postHits = [
          ...new Set([...countOccurrences(descScan, config.postWords), ...countOccurrences(cameraScan, config.postWords)]),
        ];
        if (postHits.length) {
          push({
            severity: "提示",
            category: "后期操作入画面",
            location: locationLabel(scene, segment, shot),
            ...shotBase,
            problem: `画面描述/运镜命中后期操作词：${postHits.join("、")}（守则4/8：慢放、变速、字幕等属后期，写在【后期标注】行）`,
            current: postHits.join("、"),
            target: "移到【后期标注】行或删除",
            autoFixable: false,
          });
        }
      }
    }
  }

  // ---- 单集容量事实层：逐镜求和 vs 单集预算（与骨架/剧本两层同一套数字）----
  const facts = collectEpisodeFacts(parsed);
  const waivers = options.waivers ?? [];
  const durationAllowance = waivers
    .filter((waiver) => waiver.scope === "duration")
    .reduce((sum, waiver) => sum + Math.max(0, waiver.allowanceSeconds ?? 0), 0);
  const dialogueAllowance = waivers
    .filter((waiver) => waiver.scope === "dialogue")
    .reduce((sum, waiver) => sum + Math.max(0, waiver.allowanceChars ?? 0), 0);
  const { episodeTarget, dialogue: dialogueConfig } = config;
  const effectiveMax = round1(episodeTarget.maxSeconds + durationAllowance);
  const severeLine = round1(episodeTarget.maxSeconds * episodeTarget.severeOverRatio + episodeTarget.severeToleranceSeconds);
  const effectiveSevereLine = round1(effectiveMax + (severeLine - episodeTarget.maxSeconds));
  const waiverNote =
    durationAllowance > 0 || dialogueAllowance > 0
      ? `（本集已登记豁免：时长 +${durationAllowance}s、授权删减台词 ${dialogueAllowance} 字，判定预算 ${effectiveMax}s）`
      : "";
  const overSeconds = round1(facts.seconds - effectiveMax);

  if (facts.seconds > effectiveSevereLine) {
    push({
      severity: "阻塞",
      category: "单集合计时长",
      location: "全表",
      sceneNo: null,
      sceneOrder: 0,
      segmentOrderInScene: null,
      segmentIndex: null,
      shotSerial: null,
      problem: `本集合计 ${facts.seconds}s，超出单集上限 ${effectiveMax}s 共 ${overSeconds}s（超 ${Math.round((overSeconds / effectiveMax) * 100)}%）${waiverNote}：必须压缩（先合并/删除动作镜、再去台词）或回剧本删减、回骨架拆集；不得靠延长镜时长或继续补镜消化`,
      current: `${facts.seconds}s`,
      target: `≤ ${effectiveMax}s（严重线 ${effectiveSevereLine}s）`,
      autoFixable: false,
    });
  } else if (facts.seconds > effectiveMax + episodeTarget.toleranceSeconds) {
    push({
      severity: "骑线",
      category: "单集合计时长",
      location: "全表",
      sceneNo: null,
      sceneOrder: 0,
      segmentOrderInScene: null,
      segmentIndex: null,
      shotSerial: null,
      problem: `本集合计 ${facts.seconds}s，超出单集上限 ${effectiveMax}s 共 ${overSeconds}s${waiverNote}：需压缩至预算内，或由用户授权登记容量豁免后复检`,
      current: `${facts.seconds}s`,
      target: `≤ ${effectiveMax}s`,
      autoFixable: false,
    });
  } else if (facts.seconds < episodeTarget.minSeconds * episodeTarget.underRatio) {
    push({
      severity: "提示",
      category: "单集合计时长",
      location: "全表",
      sceneNo: null,
      sceneOrder: 0,
      segmentOrderInScene: null,
      segmentIndex: null,
      shotSerial: null,
      problem: `本集合计 ${facts.seconds}s，低于单集下限 ${episodeTarget.minSeconds}s 的 ${episodeTarget.underRatio} 倍（${round1(episodeTarget.minSeconds * episodeTarget.underRatio)}s）：素材偏少，考虑与相邻集合并或补入未用情节`,
      current: `${facts.seconds}s`,
      target: `≥ ${round1(episodeTarget.minSeconds * episodeTarget.underRatio)}s`,
      autoFixable: false,
    });
  }

  // ---- 容量缺口：台词净时长（物理下限）已超预算时，压缩动作镜无法解决 ----
  const countableChars = Math.max(0, facts.dialogueChars - dialogueAllowance);
  const dialogueFloorSeconds = round1(
    countableChars / dialogueConfig.hardCharsPerSecond + dialogueConfig.hardBufferSeconds * facts.dialogueShots,
  );
  const dialogueSafeSeconds = round1(
    countableChars / dialogueConfig.safeCharsPerSecond +
      dialogueConfig.safePausePerMark * facts.dialogueMarks +
      dialogueConfig.safeBufferSeconds * facts.dialogueShots,
  );
  if (dialogueFloorSeconds > effectiveMax + episodeTarget.toleranceSeconds) {
    const charsToCut = Math.ceil((dialogueFloorSeconds - effectiveMax) * dialogueConfig.hardCharsPerSecond);
    push({
      severity: "阻塞",
      category: "容量缺口",
      location: "全表",
      sceneNo: null,
      sceneOrder: 0,
      segmentOrderInScene: null,
      segmentIndex: null,
      shotSerial: null,
      problem: `台词净时长下限 ${dialogueFloorSeconds}s 已超过单集预算 ${effectiveMax}s（台词 ${countableChars} 字 / ${facts.dialogueShots} 镜）${waiverNote}：即使动作镜全部删除也装不下，必须回剧本删减约 ${charsToCut} 字台词（需用户授权）或回骨架拆集`,
      current: `台词下限 ${dialogueFloorSeconds}s`,
      target: `≤ ${effectiveMax}s（需删减 ≥${charsToCut} 字或拆集）`,
      autoFixable: false,
    });
  }

  // ---- 每集片段数预算分级：>预算 骑线、>阻塞线 阻塞（抑制"靠加片段塞时长"）----
  if (segmentCount > config.segmentBudget.blockingSegments) {
    push({
      severity: "阻塞",
      category: "片段预算",
      location: "全表",
      sceneNo: null,
      sceneOrder: 0,
      segmentOrderInScene: null,
      segmentIndex: null,
      shotSerial: null,
      problem: `全表共 ${segmentCount} 个片段，超过每集 ${config.segmentBudget.blockingSegments} 段阻塞线（预算 ${config.segmentBudget.maxSegments} 段）：说明在靠增段/加镜塞时长，必须合并片段并压缩总时长`,
      current: `${segmentCount} 段`,
      target: `≤ ${config.segmentBudget.maxSegments} 段`,
      autoFixable: false,
    });
  } else if (segmentCount > config.segmentBudget.maxSegments) {
    push({
      severity: "骑线",
      category: "片段预算",
      location: "全表",
      sceneNo: null,
      sceneOrder: 0,
      segmentOrderInScene: null,
      segmentIndex: null,
      shotSerial: null,
      problem: `全表共 ${segmentCount} 个片段，超过每集 ${config.segmentBudget.maxSegments} 段预算（规范第一节：≤8 分镜 = 96 秒）`,
      current: `${segmentCount} 段`,
      target: `≤ ${config.segmentBudget.maxSegments} 段（超出部分与相邻片段合并）`,
      autoFixable: false,
    });
  }

  // ---- 台词覆盖度：剧本 ↔ 分镜 逐条比对（事实层；缺失=阻塞、疑似改写=骑线、额外=提示）----
  const scriptContent = options.script?.content ?? "";
  let dialogueCoverage: StoryboardDialogueCoverage | undefined;
  if (scriptContent.trim()) {
    const units = collectStoryboardDialogueUnits(parsed);
    dialogueCoverage = checkDialogueCoverage(scriptContent, options.script?.name, units, config);
    const { maxReportItems } = config.coverage;
    dialogueCoverage.missing.slice(0, maxReportItems).forEach((item) => {
      push({
        severity: "阻塞",
        category: "台词覆盖度",
        location: `剧本 L${item.lineNo}${item.speaker ? `（${item.speaker}）` : ""}`,
        sceneNo: null,
        sceneOrder: 0,
        segmentOrderInScene: null,
        segmentIndex: null,
        shotSerial: null,
        problem: `剧本台词在分镜中找不到逐字承载：${item.script}`,
        current: "缺失",
        target: "按原文补入对应镜台词字段并标明来源人；确需删减时由用户授权登记豁免",
        autoFixable: false,
      });
    });
    if (dialogueCoverage.missing.length > maxReportItems) {
      push({
        severity: "阻塞",
        category: "台词覆盖度",
        location: "全表",
        sceneNo: null,
        sceneOrder: 0,
        segmentOrderInScene: null,
        segmentIndex: null,
        shotSerial: null,
        problem: `另有 ${dialogueCoverage.missing.length - maxReportItems} 句剧本台词缺失（详见检查报告"台词覆盖度事实层"清单）`,
        current: `${dialogueCoverage.missing.length} 句缺失`,
        target: "全部逐字补入或申报取舍",
        autoFixable: false,
      });
    }
    dialogueCoverage.rewritten.slice(0, maxReportItems).forEach((item) => {
      push({
        severity: "骑线",
        category: "台词覆盖度",
        location: item.location,
        sceneNo: null,
        sceneOrder: 0,
        segmentOrderInScene: null,
        segmentIndex: null,
        shotSerial: null,
        problem: `疑似改写：剧本「${item.script}」↔ 分镜「${item.best}」（相似度 ${item.similarity}）`,
        current: `相似度 ${item.similarity}`,
        target: "确认是否逐字保留；确属改写需用户授权并登记",
        autoFixable: false,
      });
    });
    dialogueCoverage.extra.slice(0, maxReportItems).forEach((item) => {
      push({
        severity: "提示",
        category: "台词覆盖度",
        location: item.location,
        sceneNo: null,
        sceneOrder: 0,
        segmentOrderInScene: null,
        segmentIndex: null,
        shotSerial: null,
        problem: `分镜台词在剧本中无对应（可能为 VO/画面文字）：${item.text}`,
        current: "剧本中无对应",
        target: "确认为 VO/画面文字则保留；否则删除或回剧本登记",
        autoFixable: false,
      });
    });
  }

  for (const warning of parsed.warnings) {
    if (warning.includes("结构为空")) {
      push({
        severity: "阻塞",
        category: "结构",
        location: "全表",
        sceneNo: null,
        sceneOrder: 0,
        segmentOrderInScene: null,
        segmentIndex: null,
        shotSerial: null,
        problem: warning,
        autoFixable: false,
      });
    }
  }

  // ---- 骑线占比与拆集建议（提示级：骑线不阻塞、不得作为返工理由；占比过高说明该集只能靠压语速装下）----
  const rideLineRatio =
    facts.dialogueShots > 0 ? Math.round((dialogueShotsTight / facts.dialogueShots) * 1000) / 1000 : 0;
  const capacityLoad: DialogueLoad = {
    chars: countableChars,
    marks: facts.dialogueMarks,
    lines: facts.dialogueShots,
  };
  const theoreticalSplit = suggestSplitCount(capacityLoad, EPISODE_CAPACITY_BUDGET);
  const overBySeconds = facts.seconds > effectiveMax;
  const byActualSeconds = overBySeconds ? Math.ceil((facts.seconds - 0.0001) / effectiveMax) : 1;
  const pressure = rideLineRatio > EPISODE_CAPACITY_BUDGET.rideLineRatioThreshold;
  const underflow = facts.seconds > 0 && facts.seconds < episodeTarget.minSeconds * episodeTarget.underRatio;
  // 仅在"拆了确实能解决"时给建议：实测超上限，或字时比整体偏紧且拆开后每集能安全装下
  const needSplit = !underflow && (overBySeconds || (pressure && theoreticalSplit.comfort > 1));
  const splitCount = underflow ? 1 : Math.max(theoreticalSplit.comfort, byActualSeconds, pressure ? 2 : 1);
  const splitSuggestion = needSplit
    ? {
        count: splitCount,
        reason:
          `实测分镜 ${facts.seconds}s / 预算 ${effectiveMax}s，理论舒适 ${theoreticalSplit.comfort} 集；` +
          `台词净时长安全 ${dialogueSafeSeconds ?? 0}s；骑线镜 ${dialogueShotsTight}/${facts.dialogueShots}` +
          `（占比 ${Math.round(rideLineRatio * 100)}%，阈值 ${Math.round(EPISODE_CAPACITY_BUDGET.rideLineRatioThreshold * 100)}%）`,
      }
    : undefined;
  if (splitSuggestion && facts.dialogueShots > 0) {
    push({
      severity: "提示",
      category: "拆集建议",
      location: "全表",
      sceneNo: null,
      sceneOrder: 0,
      segmentOrderInScene: null,
      segmentIndex: null,
      shotSerial: null,
      problem: `本集建议拆成 ${splitSuggestion.count} 集（台词逐字保留，按场/节拍边界落刀）；依据：${splitSuggestion.reason}`,
      current: `${facts.seconds}s / 骑线占比 ${Math.round(rideLineRatio * 100)}%`,
      target: `拆成 ${splitSuggestion.count} 集后每集回落 ${config.episodeTarget.minSeconds}~${config.episodeTarget.maxSeconds}s`,
      autoFixable: false,
    });
    push({
      severity: "提示",
      category: "拆集建议",
      location: "全表",
      sceneNo: null,
      sceneOrder: 0,
      segmentOrderInScene: null,
      segmentIndex: null,
      shotSerial: null,
      problem:
        "骑线项与拆集建议均为提示级：骑线项不作为返工理由，禁止用删台词、压语速、超段数消化时长；容量不够时优先拆集，其次由用户授权删减并登记豁免",
      autoFixable: false,
    });
  }

  const blockingCount = issues.filter((issue) => issue.severity === "阻塞").length;
  const borderlineCount = issues.filter((issue) => issue.severity === "骑线").length;
  const noticeCount = issues.filter((issue) => issue.severity === "提示").length;

  return {
    generatedAt: Date.now(),
    sceneCount: parsed.scenes.length,
    segmentCount,
    shotCount,
    issues,
    blockingCount,
    borderlineCount,
    noticeCount,
    parseWarnings: parsed.warnings,
    episodeSeconds: facts.seconds,
    shotsWithoutDuration: facts.shotsWithoutDuration,
    effectiveMaxSeconds: effectiveMax,
    dialogueFloorSeconds,
    dialogueSafeSeconds,
    dialogueChars: countableChars,
    dialogueMarks: facts.dialogueMarks,
    dialogueShots: facts.dialogueShots,
    dialogueShotsTight,
    rideLineRatio,
    splitSuggestion,
    appliedWaivers: waivers,
    dialogueCoverage,
  };
}

/* ==================== 报告输出 ==================== */

export function isBlockingReport(report: StoryboardCheckReport): boolean {
  return report.blockingCount > 0;
}

function severityLabel(severity: StoryboardCheckSeverity): string {
  return severity === "阻塞" ? "阻塞" : severity === "骑线" ? "骑线" : "提示";
}

/** 豁免说明（仅用于报告文案） */
function durationAllowanceNote(report: StoryboardCheckReport): string {
  const allowance = (report.appliedWaivers ?? [])
    .filter((waiver) => waiver.scope === "duration")
    .reduce((sum, waiver) => sum + Math.max(0, waiver.allowanceSeconds ?? 0), 0);
  return allowance > 0 ? `（含已登记豁免 ${allowance}s）` : "";
}

/** 生成给监制审核注入的 markdown 报告（结论必须原样引用） */
export function storyboardReportToMarkdown(report: StoryboardCheckReport): string {
  const lines: string[] = [];
  lines.push("## 分镜表确定性检查结果（由工具生成，审核必须原样引用，不得改写结论）");
  lines.push("");
  lines.push(
    `- 检查范围：${report.sceneCount} 场 / ${report.segmentCount} 片段 / ${report.shotCount} 镜`,
  );
  const { episodeTarget, segmentBudget, coverage } = STORYBOARD_CHECK_CONFIG;
  const severeLine = round1(episodeTarget.maxSeconds * episodeTarget.severeOverRatio + episodeTarget.severeToleranceSeconds);
  const underLine = round1(episodeTarget.minSeconds * episodeTarget.underRatio);
  lines.push(
    `- 判定口径：单集合计须落 ${episodeTarget.minSeconds}~${episodeTarget.maxSeconds} 秒（>${episodeTarget.maxSeconds}s 骑线、>${severeLine}s 阻塞、<${underLine}s 素材不足；台词净时长下限超预算 = 容量缺口阻塞）；片段累计须落 12 秒档（11~13s）或 17 秒档（16~18s）；含台词镜时长安全线 = 字数÷4 + 0.4×标点 + 1s（低于硬底线 = 阻塞，介于硬底线与安全线 = 骑线交语义裁量）；无台词镜 ≤6s；光影色调/配乐禁词命中 = 阻塞；片段数 >${segmentBudget.maxSegments} 段骑线、>${segmentBudget.blockingSegments} 段阻塞；台词覆盖度（剧本 ↔ 分镜）缺失 = 阻塞、疑似改写 = 骑线、分镜额外 = 提示；台词容量（≤46 字）/ 模糊指代 / 元语言 / 后期操作词 / 拆集建议为提示级，不参与阻塞判定；骑线项不阻塞且不得作为返工理由——容量不够时先按「拆集建议」拆集（与骨架/剧本层同一口径），删台词或放宽时长须用户授权并登记豁免`,
  );
  lines.push(
    `- 结论汇总：阻塞 ${report.blockingCount} 项 / 骑线 ${report.borderlineCount} 项 / 提示 ${report.noticeCount} 项`,
  );
  lines.push("");

  if (report.episodeSeconds != null) {
    const effectiveMax = report.effectiveMaxSeconds ?? episodeTarget.maxSeconds;
    const over = round1(report.episodeSeconds - effectiveMax);
    const verdict =
      report.episodeSeconds > effectiveMax
        ? `超出上限 ${over}s${durationAllowanceNote(report)}`
        : report.episodeSeconds < underLine
          ? "低于素材不足线"
          : "预算内";
    lines.push("### 单集容量事实层（逐镜求和，确定性）");
    lines.push("");
    lines.push(
      `- 单集合计：**${report.episodeSeconds}s**（预算 ${episodeTarget.minSeconds}~${episodeTarget.maxSeconds}s，严重线 ${severeLine}s）→ ${verdict}${report.shotsWithoutDuration ? `；另有 ${report.shotsWithoutDuration} 镜时长不可解析（按 0 计）` : ""}`,
    );
    lines.push(
      `- 台词净时长：下限 ${report.dialogueFloorSeconds ?? 0}s / 安全 ${report.dialogueSafeSeconds ?? 0}s（台词 ${report.dialogueChars ?? 0} 字、标点 ${report.dialogueMarks ?? 0} 个）；非台词占用 ≈ ${round1(report.episodeSeconds - (report.dialogueFloorSeconds ?? 0))}s`,
    );
    lines.push(
      `- 片段数：${report.segmentCount} 段（预算 ≤${segmentBudget.maxSegments} 段，>${segmentBudget.blockingSegments} 段阻塞）`,
    );
    const rideLinePct = Math.round((report.rideLineRatio ?? 0) * 100);
    lines.push(
      `- 字时比（骑线占比）：${report.dialogueShotsTight ?? 0}/${report.dialogueShots ?? 0} 个台词镜低于安全线（${rideLinePct}%，阈值 ${Math.round(EPISODE_CAPACITY_BUDGET.rideLineRatioThreshold * 100)}%）→ 骑线项为提示级：不作为返工理由，不得用删台词/压语速消化`,
    );
    if (report.splitSuggestion) {
      lines.push(
        `- 拆集建议（提示级）：拆成 ${report.splitSuggestion.count} 集（依据：${report.splitSuggestion.reason}）；台词逐字保留，按场/节拍边界落刀`,
      );
    }
    if (report.appliedWaivers?.length) {
      const note = report.appliedWaivers
        .map(
          (waiver) =>
            `${waiver.scope === "duration" ? `时长 +${waiver.allowanceSeconds ?? 0}s` : `删减台词 ${waiver.allowanceChars ?? 0} 字`}${waiver.reason ? `（${waiver.reason}）` : ""}${waiver.grantedBy ? `｜授权：${waiver.grantedBy}` : ""}`,
        )
        .join("；");
      lines.push(`- 已登记豁免：${note}（工具不得自动生成豁免，仅按登记执行）`);
    }
    lines.push("");
  }

  if (report.dialogueCoverage) {
    const coverageInfo = report.dialogueCoverage;
    lines.push("### 台词覆盖度事实层（剧本 ↔ 分镜 逐条比对）");
    lines.push("");
    lines.push(
      `- 剧本台词 ${coverageInfo.scriptLines} 句 / 分镜台词单元 ${coverageInfo.storyboardUnits} 条：逐字一致 ${coverageInfo.verbatim}、拆镜承载 ${coverageInfo.split}、疑似改写 ${coverageInfo.rewritten.length}、缺失 ${coverageInfo.missing.length}、分镜额外 ${coverageInfo.extra.length}`,
    );
    if (coverageInfo.missing.length) {
      lines.push("- 缺失（阻塞）：");
      coverageInfo.missing
        .slice(0, coverage.maxReportItems * 2)
        .forEach((item) => lines.push(`  - 剧本 L${item.lineNo}${item.speaker ? `（${item.speaker}）` : ""}：${item.script}`));
      if (coverageInfo.missing.length > coverage.maxReportItems * 2) {
        lines.push(`  - …另有 ${coverageInfo.missing.length - coverage.maxReportItems * 2} 句`);
      }
    } else {
      lines.push("- 缺失（阻塞）：无");
    }
    if (coverageInfo.rewritten.length) {
      lines.push("- 疑似改写（骑线，需语义确认）：");
      coverageInfo.rewritten
        .slice(0, coverage.maxReportItems)
        .forEach((item) =>
          lines.push(`  - ${item.location}：剧本「${item.script}」↔ 分镜「${item.best}」（相似度 ${item.similarity}）`),
        );
    }
    if (coverageInfo.extra.length) {
      lines.push("- 分镜额外（提示，多为 VO/画面文字）：");
      coverageInfo.extra
        .slice(0, coverage.maxReportItems)
        .forEach((item) => lines.push(`  - ${item.location}：${item.text}`));
    }
    lines.push("");
  } else {
    lines.push("### 台词覆盖度事实层");
    lines.push("");
    lines.push("- 未提供本集剧本，跳过逐条比对（不得由审核层自行提取剧本台词核对；请检查工作区剧本是否已保存）。");
    lines.push("");
  }

  if (!report.issues.length) {
    lines.push("所有确定性检查项通过，无阻塞与骑线项。");
    return lines.join("\n");
  }

  lines.push("| # | 级别 | 检查项 | 位置 | 问题 | 当前值 | 目标值 |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  report.issues.forEach((issue, index) => {
    lines.push(
      `| ${index + 1} | ${severityLabel(issue.severity)} | ${issue.category} | ${issue.location} | ${issue.problem} | ${issue.current ?? "-"} | ${issue.target ?? "-"} |`,
    );
  });
  lines.push("");
  lines.push("> 工具判定通过项不得再列为问题；阻塞项必须原样引用；骑线项由审核层结合语义裁量并注明理由。");
  return lines.join("\n");
}

/** 生成给执行层自动修复的阻塞清单（精确 位置/当前值/目标值） */
export function buildBlockingRepairChecklist(report: StoryboardCheckReport): string {
  const blocking = report.issues.filter((issue) => issue.severity === "阻塞");
  if (!blocking.length) return "";
  const lines: string[] = [];
  lines.push("【机器校验·阻塞项修复清单】（以下每一项都必须修复，修复后保持其余内容不变）");
  blocking.forEach((issue, index) => {
    const current = issue.current ? `当前：${issue.current}；` : "";
    const target = issue.target ? `目标：${issue.target}` : "";
    lines.push(`${index + 1}. [${issue.category}] ${issue.location} —— ${issue.problem}；${current}${target}`);
  });
  return lines.join("\n");
}

/* ==================== 读库入口 ==================== */

function parseFlowDataStoryboardTable(data: unknown): string {
  try {
    const parsed = typeof data === "string" ? JSON.parse(data || "{}") : (data as Record<string, unknown>) ?? {};
    return typeof parsed.storyboardTable === "string" ? parsed.storyboardTable : "";
  } catch {
    return "";
  }
}

export interface RunStoryboardChecksResult {
  report: StoryboardCheckReport;
  markdown: string;
}

/** 读取项目资产库（供检查器与编排层共用） */
export async function loadStoryboardAssets(projectIdValue: number): Promise<StoryboardAssetRef[]> {
  const { default: u } = await import("@/utils");
  const projectId = Number(projectIdValue);
  if (!Number.isSafeInteger(projectId) || projectId <= 0) return [];
  const assetRows = (await u
    .db("o_assets")
    .where({ projectId })
    .select("id", "name", "type", "assetsId")) as { id: number; name: string | null; type: string | null; assetsId: number | null }[];
  return assetRows.map((row) => ({
    id: Number(row.id),
    name: String(row.name ?? ""),
    type: String(row.type ?? ""),
    parentId: row.assetsId == null ? null : Number(row.assetsId),
  }));
}

/** 读取工作区当前保存的分镜表 markdown（无则返回空串） */
export async function loadStoryboardTable(projectIdValue: number, scriptIdValue: number): Promise<string> {
  const { default: u } = await import("@/utils");
  const projectId = Number(projectIdValue);
  const scriptId = Number(scriptIdValue);
  if (!Number.isSafeInteger(projectId) || projectId <= 0 || !Number.isSafeInteger(scriptId) || scriptId <= 0) {
    return "";
  }
  const workData = await u
    .db("o_agentWorkData")
    .where({ projectId, episodesId: scriptId, key: "productionFlowData" })
    .first();
  return parseFlowDataStoryboardTable(workData?.data);
}

/**
 * 读库：读取工作区分镜表 + 资产库，执行确定性检查
 *
 * 【多模型接缝（待接入）】`options.config` 是档位、台词容量等检查参数的注入口。
 * 接入非 H3 视频模型时，在此处按「项目模型 → resolveVideoModelPromptProfile → 推导
 * tiers / dialogue」生成 config；缺省时沿用 `STORYBOARD_CHECK_CONFIG`（H3 参考档：
 * 11~13s / 16~18s、台词 ≤46 字），保证存量项目口径零漂移。
 * 见《H3分镜生成通用规范》第八节《多模型适配（待接入）》。
 */
function parseFlowDataRecord(data: unknown): Record<string, unknown> {
  try {
    const parsed = typeof data === "string" ? JSON.parse(data || "{}") : (data as Record<string, unknown>) ?? {};
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 解析工作区里的容量豁免登记（仅接受已落库的显式记录，工具不自动生成） */
export function parseStoryboardWaivers(value: unknown): StoryboardWaiver[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === "object")
    .map((item): StoryboardWaiver => {
      const record = item as Record<string, unknown>;
      const seconds = record.allowanceSeconds == null ? undefined : Number(record.allowanceSeconds);
      const chars = record.allowanceChars == null ? undefined : Number(record.allowanceChars);
      const at = record.at == null ? undefined : Number(record.at);
      return {
        scope: record.scope === "dialogue" ? "dialogue" : "duration",
        allowanceSeconds: seconds != null && Number.isFinite(seconds) ? seconds : undefined,
        allowanceChars: chars != null && Number.isFinite(chars) ? chars : undefined,
        reason: typeof record.reason === "string" ? record.reason : undefined,
        grantedBy: typeof record.grantedBy === "string" ? record.grantedBy : undefined,
        at: at != null && Number.isFinite(at) ? at : undefined,
      };
    });
}

export interface StoryboardCheckContext {
  /** 本集剧本（工作区 script 优先，其次 o_script；都没有则为 null） */
  script: { name?: string; content?: string } | null;
  /** 已登记的容量豁免 */
  waivers: StoryboardWaiver[];
}

/** 读取本集检查上下文（剧本 + 豁免），供构建期检查与读库入口共用 */
export async function loadStoryboardCheckContext(
  projectIdValue: number,
  scriptIdValue: number,
): Promise<StoryboardCheckContext> {
  const projectId = Number(projectIdValue);
  const scriptId = Number(scriptIdValue);
  if (!Number.isSafeInteger(projectId) || projectId <= 0 || !Number.isSafeInteger(scriptId) || scriptId <= 0) {
    return { script: null, waivers: [] };
  }
  const { default: u } = await import("@/utils");
  const [flowRow, scriptRow] = await Promise.all([
    u.db("o_agentWorkData").where({ projectId, episodesId: scriptId, key: "productionFlowData" }).first(),
    u.db("o_script").where({ projectId, id: scriptId }).first(),
  ]);
  const flowData = parseFlowDataRecord(flowRow?.data);
  const flowScript = typeof flowData.script === "string" ? flowData.script : "";
  const fallbackScript = String((scriptRow as { content?: unknown } | undefined)?.content ?? "");
  const content = flowScript.trim() ? flowScript : fallbackScript;
  return {
    script: content.trim()
      ? { name: String((scriptRow as { name?: unknown } | undefined)?.name ?? ""), content }
      : null,
    waivers: parseStoryboardWaivers(flowData.waivers),
  };
}

export async function runStoryboardChecks(
  projectIdValue: number,
  scriptIdValue: number,
  options: {
    config?: StoryboardCheckConfig;
    waivers?: StoryboardWaiver[];
    script?: { name?: string; content?: string } | null;
  } = {},
): Promise<RunStoryboardChecksResult> {
  const projectId = Number(projectIdValue);
  const scriptId = Number(scriptIdValue);

  const emptyReport = checkStoryboardTable("", { config: options.config });
  if (!Number.isSafeInteger(projectId) || projectId <= 0 || !Number.isSafeInteger(scriptId) || scriptId <= 0) {
    return { report: emptyReport, markdown: "" };
  }

  const [markdown, assets, context] = await Promise.all([
    loadStoryboardTable(projectId, scriptId),
    loadStoryboardAssets(projectId),
    loadStoryboardCheckContext(projectId, scriptId),
  ]);

  const report = checkStoryboardTable(markdown, {
    assets,
    config: options.config,
    script: options.script === undefined ? context.script : options.script,
    waivers: options.waivers ?? context.waivers,
  });
  return { report, markdown };
}
