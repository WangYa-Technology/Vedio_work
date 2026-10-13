/**
 * 分镜表文档工具（定点修复守卫）
 *
 * 目的：修复流程不再信任"模型自律保持其余内容不变"——
 * - 按「场」切块：未授权的场在合并结果中**字节级保留旧文**，修复版本写再多也影响不到；
 * - 授权范围内采用修复版本；未授权片段（片段级授权时）同样强制保留旧文；
 * - 结构变化（片段拆分/合并）只在整场授权时接受，部分授权下回退为整场采用并明确警告；
 * - 输出变更摘要：哪些场/片段被改动、哪些未动，供修复完成消息展示与用户核对。
 *
 * 设计约束：
 * - 纯函数、无 IO；解析的换行细节以"行序列"保真（空行也是行），保证未授权区域逐行一致。
 * - 与 storyboardChecks 共用片段标题解析，避免两套口径。
 */

import { parseSegmentHeading } from "./storyboardChecks";

/* ==================== 场切块 ==================== */

export interface SceneBlock {
  /** 文档顺序（1-based） */
  sceneOrder: number;
  sceneNo: number | null;
  headerLine: string;
  /** 场头到下一场头之前的全部行（含空行） */
  lines: string[];
}

export interface StoryboardSceneSplit {
  /** 第一个场头之前的全部行（通常为空） */
  preambleLines: string[];
  blocks: SceneBlock[];
}

const SCENE_HEADER_PATTERN = /^##\s*场\s*(\d+)\s*[：:]\s*(.*)$/;

function normalizeNewlines(markdown: string): string {
  return String(markdown ?? "").replace(/\r\n?/g, "\n");
}

/** 按「## 场N」把分镜表切成场块（未匹配内容归入 preamble） */
export function splitStoryboardScenes(markdown: string): StoryboardSceneSplit {
  const lines = normalizeNewlines(markdown).split("\n");
  const preambleLines: string[] = [];
  const blocks: SceneBlock[] = [];
  let current: SceneBlock | null = null;

  for (const line of lines) {
    const match = line.match(SCENE_HEADER_PATTERN);
    if (match) {
      current = {
        sceneOrder: blocks.length + 1,
        sceneNo: Number(match[1]),
        headerLine: line,
        lines: [line],
      };
      blocks.push(current);
      continue;
    }
    if (current) current.lines.push(line);
    else preambleLines.push(line);
  }

  return { preambleLines, blocks };
}

export interface SceneSegmentPart {
  /** 场内序号（1-based） */
  index: number;
  title: string;
  /** 从「### 片段X」行到下一片段之前的全部行（含空行） */
  lines: string[];
}

export interface SceneSegmentSplit {
  /** 场头到第一个片段标题之前的全部行（含空行） */
  headerLines: string[];
  segments: SceneSegmentPart[];
}

/** 把单个场块切成「场头行 + 片段块序列」 */
export function splitSceneSegments(sceneLines: string[]): SceneSegmentSplit {
  const headerLines: string[] = [];
  const segments: SceneSegmentPart[] = [];
  let currentSegment: SceneSegmentPart | null = null;

  for (const line of sceneLines) {
    const heading = parseSegmentHeading(line);
    if (heading) {
      currentSegment = {
        index: segments.length + 1,
        title: heading.title,
        lines: [line],
      };
      segments.push(currentSegment);
      continue;
    }
    if (currentSegment) currentSegment.lines.push(line);
    else headerLines.push(line);
  }

  return { headerLines, segments };
}

/* ==================== 授权合并 ==================== */

export interface RepairScope {
  /** 场的文档顺序（1-based，与 splitStoryboardScenes 的 sceneOrder 一致） */
  sceneOrder: number;
  /** 场内片段序号（1-based）；不传 = 整场授权（含场头） */
  segmentOrders?: number[];
}

export interface StoryboardMergeResult {
  merged: string;
  warnings: string[];
  /** 实际采用修复版本的场顺序列表 */
  appliedSceneOrders: number[];
}

function collectScopeMap(scopes: RepairScope[]): Map<number, Set<number> | "all"> {
  const map = new Map<number, Set<number> | "all">();
  for (const scope of scopes ?? []) {
    if (!Number.isSafeInteger(scope.sceneOrder) || scope.sceneOrder <= 0) continue;
    if (!scope.segmentOrders || !scope.segmentOrders.length) {
      map.set(scope.sceneOrder, "all");
      continue;
    }
    const existing = map.get(scope.sceneOrder);
    if (existing === "all") continue;
    const set = existing ?? new Set<number>();
    for (const order of scope.segmentOrders) {
      if (Number.isSafeInteger(order) && order > 0) set.add(order);
    }
    map.set(scope.sceneOrder, set);
  }
  return map;
}

function matchNewBlock(
  oldBlock: SceneBlock,
  newBlocks: SceneBlock[],
  used: Set<number>,
): SceneBlock | null {
  // 优先按场号匹配；找不到再按文档顺序对齐
  const bySceneNo =
    oldBlock.sceneNo != null
      ? newBlocks.find((block) => block.sceneNo === oldBlock.sceneNo && !used.has(block.sceneOrder))
      : undefined;
  if (bySceneNo) return bySceneNo;
  const byOrder = newBlocks.find(
    (block) => block.sceneOrder === oldBlock.sceneOrder && !used.has(block.sceneOrder),
  );
  return byOrder ?? null;
}

/**
 * 授权合并：以旧表为骨架，授权范围用修复版本，范围外强制保留旧文。
 *
 * - 整场授权：该场整体采用修复版本；修复版本缺少该场时保留旧场并警告。
 * - 片段级授权：仅当新旧片段数一致时按位置替换授权片段；
 *   数量变化（拆分/合并）视为结构变化，回退为整场采用并警告。
 * - 新表中出现旧表没有的场：忽略（定点修复不应新增场）并警告。
 */
export function mergeStoryboardRepair(
  oldMarkdown: string,
  newMarkdown: string,
  scopes: RepairScope[],
): StoryboardMergeResult {
  const oldSplit = splitStoryboardScenes(oldMarkdown);
  const newSplit = splitStoryboardScenes(newMarkdown);
  const scopeMap = collectScopeMap(scopes);
  const warnings: string[] = [];
  const appliedSceneOrders: number[] = [];
  const usedNewOrders = new Set<number>();

  const outLines: string[] = [...oldSplit.preambleLines];

  for (const oldBlock of oldSplit.blocks) {
    const scope = scopeMap.get(oldBlock.sceneOrder);
    if (!scope) {
      outLines.push(...oldBlock.lines);
      continue;
    }

    const newBlock = matchNewBlock(oldBlock, newSplit.blocks, usedNewOrders);
    const label = oldBlock.sceneNo != null ? `场${oldBlock.sceneNo}` : `场${oldBlock.sceneOrder}`;

    if (!newBlock) {
      outLines.push(...oldBlock.lines);
      warnings.push(`${label} 在修复版本中未找到对应场次，已保留修复前内容`);
      continue;
    }
    usedNewOrders.add(newBlock.sceneOrder);

    if (scope === "all") {
      outLines.push(...newBlock.lines);
      appliedSceneOrders.push(oldBlock.sceneOrder);
      continue;
    }

    const oldParts = splitSceneSegments(oldBlock.lines);
    const newParts = splitSceneSegments(newBlock.lines);
    if (oldParts.segments.length !== newParts.segments.length) {
      outLines.push(...newBlock.lines);
      appliedSceneOrders.push(oldBlock.sceneOrder);
      warnings.push(
        `${label} 结构发生变化（片段数 ${oldParts.segments.length} → ${newParts.segments.length}），已整体采用修复版本`,
      );
      continue;
    }

    const mergedLines: string[] = [...oldParts.headerLines];
    for (const oldSegment of oldParts.segments) {
      const authorized = scope.has(oldSegment.index);
      const replacement = authorized ? newParts.segments[oldSegment.index - 1] : undefined;
      mergedLines.push(...(replacement ? replacement.lines : oldSegment.lines));
    }
    outLines.push(...mergedLines);
    appliedSceneOrders.push(oldBlock.sceneOrder);
  }

  // 未授权场不会被匹配消费（它们本来就该整体保留），因此"新增场"只按场号判定：
  // 修复版本中的场号在旧表中不存在，才算新增。
  const oldSceneNos = new Set(
    oldSplit.blocks.map((block) => block.sceneNo).filter((no): no is number => no != null),
  );
  const unmatchedNew = newSplit.blocks.filter((block) => {
    if (usedNewOrders.has(block.sceneOrder)) return false;
    if (block.sceneNo != null && oldSceneNos.has(block.sceneNo)) return false;
    return block.sceneNo != null;
  });
  for (const block of unmatchedNew) {
    warnings.push(`场${block.sceneNo} 是修复版本中新增的场次，定点修复不允许新增场，已忽略`);
  }

  return {
    merged: outLines.join("\n"),
    warnings,
    appliedSceneOrders,
  };
}

/* ==================== 变更摘要 ==================== */

export interface SegmentChangeInfo {
  index: number;
  title: string;
  changed: boolean;
}

export interface SceneChangeInfo {
  sceneOrder: number;
  sceneNo: number | null;
  title: string;
  changed: boolean;
  segments: SegmentChangeInfo[];
  note?: string;
}

export interface StoryboardChangeSummary {
  hasChanges: boolean;
  changedSceneCount: number;
  scenes: SceneChangeInfo[];
}

function sceneTitleFromHeader(headerLine: string): string {
  const match = headerLine.match(SCENE_HEADER_PATTERN);
  if (!match) return "";
  const rest = match[2] ?? "";
  const [titlePart] = rest.split(/[｜|]/);
  return String(titlePart ?? "").trim();
}

function sceneTextOf(block: { lines: string[] }): string {
  return block.lines.join("\n");
}

/** 对比新旧分镜表，生成「哪些场/片段被改动」的变更摘要 */
export function summarizeStoryboardChanges(
  oldMarkdown: string,
  newMarkdown: string,
): StoryboardChangeSummary {
  const oldSplit = splitStoryboardScenes(oldMarkdown);
  const newSplit = splitStoryboardScenes(newMarkdown);
  const usedNewOrders = new Set<number>();
  const scenes: SceneChangeInfo[] = [];

  for (const oldBlock of oldSplit.blocks) {
    const newBlock = matchNewBlock(oldBlock, newSplit.blocks, usedNewOrders);
    const title = sceneTitleFromHeader(oldBlock.headerLine);
    if (newBlock) usedNewOrders.add(newBlock.sceneOrder);

    if (!newBlock) {
      scenes.push({
        sceneOrder: oldBlock.sceneOrder,
        sceneNo: oldBlock.sceneNo,
        title,
        changed: true,
        segments: [],
        note: "修复版本中未找到对应场次，内容保持不变（异常）",
      });
      continue;
    }

    const oldParts = splitSceneSegments(oldBlock.lines);
    const newParts = splitSceneSegments(newBlock.lines);
    const changed = sceneTextOf(oldBlock) !== sceneTextOf(newBlock);

    const segments: SegmentChangeInfo[] = oldParts.segments.map((oldSegment) => {
      const counterpart = newParts.segments.find((item) => item.title === oldSegment.title) ?? newParts.segments[oldSegment.index - 1];
      return {
        index: oldSegment.index,
        title: oldSegment.title,
        changed: counterpart ? counterpart.lines.join("\n") !== oldSegment.lines.join("\n") : true,
      };
    });
    if (newParts.segments.length !== oldParts.segments.length) {
      const extra = newParts.segments
        .slice(oldParts.segments.length)
        .map((item) => ({ index: item.index, title: item.title, changed: true }));
      segments.push(...extra);
    }

    scenes.push({
      sceneOrder: oldBlock.sceneOrder,
      sceneNo: oldBlock.sceneNo,
      title,
      changed,
      segments,
    });
  }

  for (const newBlock of newSplit.blocks.filter((block) => !usedNewOrders.has(block.sceneOrder))) {
    scenes.push({
      sceneOrder: newBlock.sceneOrder,
      sceneNo: newBlock.sceneNo,
      title: sceneTitleFromHeader(newBlock.headerLine),
      changed: true,
      segments: splitSceneSegments(newBlock.lines).segments.map((item) => ({
        index: item.index,
        title: item.title,
        changed: true,
      })),
      note: "新增场次",
    });
  }

  const changedScenes = scenes.filter((scene) => scene.changed);
  return {
    hasChanges: changedScenes.length > 0,
    changedSceneCount: changedScenes.length,
    scenes,
  };
}

function sceneLabel(scene: SceneChangeInfo): string {
  return scene.sceneNo != null ? `场${scene.sceneNo}` : `场${scene.sceneOrder}`;
}

/** 变更摘要 → 面向用户的 markdown（修复完成消息用） */
export function storyboardChangesToMarkdown(summary: StoryboardChangeSummary): string {
  const lines: string[] = [];
  lines.push("## 定点修复变更摘要（授权范围外内容未改动）");
  lines.push("");
  if (!summary.hasChanges) {
    lines.push("本次修复未产生任何内容变化。");
    return lines.join("\n");
  }
  lines.push(`共改动 ${summary.changedSceneCount} 个场：`);
  lines.push("");
  for (const scene of summary.scenes) {
    const label = sceneLabel(scene) + (scene.title ? `（${scene.title}）` : "");
    if (!scene.changed) {
      lines.push(`- ${label}：未改动`);
      continue;
    }
    const changedSegments = scene.segments.filter((segment) => segment.changed).map((segment) => segment.title);
    const detail = changedSegments.length ? `改动片段：${changedSegments.join("、")}` : "场头或结构改动";
    lines.push(`- ${label}：${detail}${scene.note ? `（${scene.note}）` : ""}`);
  }
  return lines.join("\n");
}

/* ==================== 授权范围解码 ==================== */

export interface ScopeDecodeSource {
  sceneOrder: number;
  sceneNo: number | null;
  segmentOrderInScene: number | null;
}

/**
 * 由问题清单的位置信息推导授权范围。
 * 默认输出「场级」授权（修复时长/结构问题时允许该场内部自由调整以重排时长）；
 * 传入 preferSegmentLevel 时输出片段级授权（问题只涉及个别片段且不需要结构变化时使用）。
 */
export function decodeRepairScopes(
  issues: ScopeDecodeSource[],
  options: { preferSegmentLevel?: boolean } = {},
): RepairScope[] {
  const byScene = new Map<number, Set<number>>();
  for (const issue of issues) {
    if (!Number.isSafeInteger(issue.sceneOrder) || issue.sceneOrder <= 0) continue;
    if (!byScene.has(issue.sceneOrder)) byScene.set(issue.sceneOrder, new Set<number>());
    if (issue.segmentOrderInScene != null && Number.isSafeInteger(issue.segmentOrderInScene)) {
      byScene.get(issue.sceneOrder)!.add(issue.segmentOrderInScene);
    }
  }
  const scopes: RepairScope[] = [];
  for (const [sceneOrder, segmentOrders] of byScene.entries()) {
    if (options.preferSegmentLevel && segmentOrders.size) {
      scopes.push({ sceneOrder, segmentOrders: [...segmentOrders] });
    } else {
      scopes.push({ sceneOrder });
    }
  }
  return scopes;
}
