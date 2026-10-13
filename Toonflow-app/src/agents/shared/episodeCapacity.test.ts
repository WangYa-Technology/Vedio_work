import test from "node:test";
import assert from "node:assert/strict";

import { SCRIPT_CHECK_CONFIG } from "@/agents/scriptAgent/scriptChecks";
import { SKELETON_CHECK_CONFIG } from "@/agents/scriptAgent/skeletonChecks";
import { STORYBOARD_CHECK_CONFIG } from "@/agents/productionAgent/storyboardChecks";
import {
  DIALOGUE_PACING,
  EPISODE_CAPACITY_BUDGET,
  buildCapacityTable,
  dialogueCapacityMaxChars,
  estimateDialogueTiming,
  estimateEpisodeCapacity,
  inferDialogueLoad,
  planEpisodeSplit,
  suggestEpisodeCount,
  type CapacityUnit,
} from "./episodeCapacity";

/** 《照野炸串》EP01 实测素材：39 条 / 351 净字 / 72 标点 */
const EP01 = { lines: 39, chars: 351, marks: 72 };

/* ==================== 台词折算 ==================== */

test("台词折算：floor = 字数÷4.5 + 0.3×条数，safe = 字数÷4 + 0.4×标点 + 1×条数", () => {
  const timing = estimateDialogueTiming(EP01);
  assert.equal(timing.floorSeconds, 89.7);
  assert.equal(timing.safeSeconds, 155.6);
  assert.equal(timing.source, "measured");
});

test("缺条数/标点时按字数推断并标记 inferred", () => {
  const load = inferDialogueLoad({ chars: 350 });
  assert.equal(load.inferred, true);
  assert.equal(load.lines, 35);
  assert.equal(load.marks, 70);
  const measured = inferDialogueLoad({ chars: 350, lines: 39, marks: 72 });
  assert.equal(measured.inferred, false);
});

/* ==================== 容量反算 ==================== */

test("容量反算：20 条 / 40 标点 → 安全线内最多 216 字", () => {
  assert.equal(dialogueCapacityMaxChars({ lines: 20, marks: 40 }), 216);
  // 动作预算压到最小（24s）时可承载更多：4×(130−24−0.4×40−20) = 280
  assert.equal(
    dialogueCapacityMaxChars({ lines: 20, marks: 40 }, EPISODE_CAPACITY_BUDGET, DIALOGUE_PACING, 24),
    280,
  );
  const table = buildCapacityTable(EPISODE_CAPACITY_BUDGET, DIALOGUE_PACING, [20]);
  assert.deepEqual(table[0], { lines: 20, maxChars: 216, maxCharsAtMinimumAction: 280 });
});

/* ==================== 三态判定 ==================== */

test("三态判定：安全线内 → 通过", () => {
  const estimate = estimateEpisodeCapacity({ lines: 20, chars: 180, marks: 40 });
  assert.equal(estimate.result.level, "ok");
  assert.ok(estimate.totalSeconds <= EPISODE_CAPACITY_BUDGET.maxSeconds);
});

test("三态判定：EP01（39 条 / 351 字）→ 骑线占比 ≈100%，建议拆集", () => {
  const estimate = estimateEpisodeCapacity(EP01);
  assert.equal(estimate.result.level, "splitPressure");
  assert.equal(estimate.result.splitCount, 2);
  assert.ok(estimate.rideLineRatio > 0.9, `骑线占比应接近 100%，实际 ${estimate.rideLineRatio}`);
});

test("三态判定：台词下限本身超上限 → 必拆", () => {
  const estimate = estimateEpisodeCapacity({ lines: 100, chars: 2000, marks: 400 });
  assert.equal(estimate.result.level, "splitRequired");
  assert.ok(estimate.floorTotalSeconds > EPISODE_CAPACITY_BUDGET.maxSeconds);
});

test("三态判定：素材过少 → 素材不足", () => {
  const estimate = estimateEpisodeCapacity({ lines: 2, chars: 8, marks: 2 });
  assert.equal(estimate.result.level, "underflow");
});

/* ==================== 集数推算 ==================== */

test("集数推算：EP01 物理下限 1 集、舒适 2 集、上限 2 集", () => {
  const suggestion = suggestEpisodeCount(EP01);
  assert.equal(suggestion.min, 1);
  assert.equal(suggestion.comfort, 2);
  assert.equal(suggestion.max, 2);
});

/* ==================== 语义边界拆集 ==================== */

test("拆集算法：EP01 在节拍边界切成 2 集，两集均回落到预算区间", () => {
  const units: CapacityUnit[] = [
    { id: "1-1a", label: "视频曝光", chars: 110, marks: 22, lines: 12, boundaryAfter: "beat" },
    { id: "1-1b", label: "老王打趣", chars: 27, marks: 5, lines: 3, boundaryAfter: "beat" },
    { id: "1-1c", label: "谎言来电", chars: 160, marks: 33, lines: 18, boundaryAfter: "beat" },
    { id: "1-2", label: "收摊试探", chars: 54, marks: 12, lines: 6, boundaryAfter: "scene" },
  ];
  const plan = planEpisodeSplit(units);
  assert.equal(plan.parts.length, 2);
  assert.deepEqual(plan.parts[0].unitIds, ["1-1a", "1-1b"]);
  assert.deepEqual(plan.parts[1].unitIds, ["1-1c", "1-2"]);
  for (const part of plan.parts) {
    assert.notEqual(part.estimate.result.level, "splitRequired");
    assert.ok(part.estimate.floorTotalSeconds <= EPISODE_CAPACITY_BUDGET.maxSeconds);
    assert.ok(part.estimate.totalSeconds >= EPISODE_CAPACITY_BUDGET.underSeconds - 1);
  }
  assert.equal(plan.totalLoad.lines, 39);
  assert.equal(plan.totalLoad.chars, 351);
});

test("拆集算法：切不出合法方案时回退为单集并给出告警", () => {
  const units: CapacityUnit[] = [
    { id: "u1", chars: 600, marks: 120, lines: 60, boundaryAfter: "line" },
    { id: "u2", chars: 600, marks: 120, lines: 60, boundaryAfter: "line" },
  ];
  const plan = planEpisodeSplit(units);
  assert.ok(plan.warnings.length > 0);
  assert.ok(plan.parts.every((part) => part.load.lines > 0));
});

/* ==================== 三层一致性 ==================== */

test("三层口径一致：共享模型 == 骨架/剧本/分镜三处既有阈值", () => {
  // 台词折算：分镜层配置必须与共享模型逐字一致
  assert.equal(STORYBOARD_CHECK_CONFIG.dialogue.hardCharsPerSecond, DIALOGUE_PACING.hardCharsPerSecond);
  assert.equal(STORYBOARD_CHECK_CONFIG.dialogue.hardBufferSeconds, DIALOGUE_PACING.hardBufferSeconds);
  assert.equal(STORYBOARD_CHECK_CONFIG.dialogue.safeCharsPerSecond, DIALOGUE_PACING.safeCharsPerSecond);
  assert.equal(STORYBOARD_CHECK_CONFIG.dialogue.safePausePerMark, DIALOGUE_PACING.safePausePerMark);
  assert.equal(STORYBOARD_CHECK_CONFIG.dialogue.safeBufferSeconds, DIALOGUE_PACING.safeBufferSeconds);
  // 单集预算：三层目标一致
  for (const target of [SCRIPT_CHECK_CONFIG.duration, SKELETON_CHECK_CONFIG.episodeTarget, STORYBOARD_CHECK_CONFIG.episodeTarget]) {
    assert.equal(target.minSeconds, EPISODE_CAPACITY_BUDGET.minSeconds);
    assert.equal(target.maxSeconds, EPISODE_CAPACITY_BUDGET.maxSeconds);
  }
  // 素材不足线：骨架层与分镜层一致
  assert.equal(
    SKELETON_CHECK_CONFIG.episodeTarget.minSeconds * SKELETON_CHECK_CONFIG.budget.underRatio,
    EPISODE_CAPACITY_BUDGET.underSeconds,
  );
  assert.equal(
    STORYBOARD_CHECK_CONFIG.episodeTarget.minSeconds * STORYBOARD_CHECK_CONFIG.episodeTarget.underRatio,
    EPISODE_CAPACITY_BUDGET.underSeconds,
  );
  assert.equal(
    SKELETON_CHECK_CONFIG.episodeTarget.maxSeconds * SKELETON_CHECK_CONFIG.budget.severeOverRatio +
      SKELETON_CHECK_CONFIG.budget.severeToleranceSeconds,
    EPISODE_CAPACITY_BUDGET.severeSeconds,
  );
  assert.equal(
    STORYBOARD_CHECK_CONFIG.episodeTarget.maxSeconds * STORYBOARD_CHECK_CONFIG.episodeTarget.severeOverRatio +
      STORYBOARD_CHECK_CONFIG.episodeTarget.severeToleranceSeconds,
    EPISODE_CAPACITY_BUDGET.severeSeconds,
  );
  // 结构与台词容量：分镜层与共享模型一致
  assert.equal(STORYBOARD_CHECK_CONFIG.segmentBudget.maxSegments, EPISODE_CAPACITY_BUDGET.maxSegments);
  assert.equal(STORYBOARD_CHECK_CONFIG.segmentBudget.blockingSegments, EPISODE_CAPACITY_BUDGET.blockingSegments);
  assert.equal(STORYBOARD_CHECK_CONFIG.dialogueCapacity.maxChars, EPISODE_CAPACITY_BUDGET.dialogueCapacityMaxChars);
});

test("三层口径一致：同一素材换算差异 ≤5%（共享模型 vs 骨架层 0.7 采用率旧口径之外的新口径）", () => {
  // 骨架层新口径 = 共享模型（同一函数）；分镜层逐镜口径 = 同一公式，差异只允许来自四舍五入
  const timing = estimateDialogueTiming(EP01);
  const productionSafe =
    EP01.chars / STORYBOARD_CHECK_CONFIG.dialogue.safeCharsPerSecond +
    EP01.marks * STORYBOARD_CHECK_CONFIG.dialogue.safePausePerMark +
    EP01.lines * STORYBOARD_CHECK_CONFIG.dialogue.safeBufferSeconds;
  const diff = Math.abs(timing.safeSeconds - productionSafe) / productionSafe;
  assert.ok(diff <= 0.05, `差异 ${(diff * 100).toFixed(2)}% 超过 5%`);
});
