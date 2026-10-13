import assert from "node:assert/strict";
import test from "node:test";
import {
  buildScriptAgentProgress,
  classifySupervisionScope,
  formatEpisodeRange,
  parseEpisodeNoFromName,
  parseScopeEpisodes,
  resolveTargetEpisodes,
  resolveTargetEpisodesOnSave,
  type SupervisionRoundLike,
} from "./progress";

/** 生成一份模式A骨架：### 集N：标题（第N章） */
function skeletonOf(count: number): string {
  return [
    "<storySkeleton>",
    "### 故事核",
    "一句话核心吸引力。",
    "### 分集决策",
    ...Array.from({ length: count }, (_, index) => `### 集${index + 1}：第${index + 1}章事件（第${index + 1}章）`),
    "</storySkeleton>",
  ].join("\n");
}

function round(partial: Partial<SupervisionRoundLike> & { at: number; scope: string }): SupervisionRoundLike {
  return {
    rating: "B",
    blockingCount: 0,
    mediumCount: 0,
    lightCount: 0,
    closedCount: 0,
    ...partial,
  };
}

test("剧本名解析集号：EP01 / ep 2 / 第3集", () => {
  assert.equal(parseEpisodeNoFromName("照野炸串 EP01：她说去进修"), 1);
  assert.equal(parseEpisodeNoFromName("某某剧 ep 12 标题"), 12);
  assert.equal(parseEpisodeNoFromName("第3集 开场"), 3);
  assert.equal(parseEpisodeNoFromName("没有集号的名字"), undefined);
});

test("审核范围解析集号区间：EP/第/裸区间", () => {
  assert.deepEqual(parseScopeEpisodes("EP01-EP03"), { from: 1, to: 3 });
  assert.deepEqual(parseScopeEpisodes("EP05"), { from: 5, to: 5 });
  assert.deepEqual(parseScopeEpisodes("第1-3集"), { from: 1, to: 3 });
  assert.deepEqual(parseScopeEpisodes("01-03"), { from: 1, to: 3 });
  assert.deepEqual(parseScopeEpisodes("EP03-EP02"), { from: 3, to: 3 }, "反向区间退化为单集");
  assert.equal(parseScopeEpisodes("故事骨架"), undefined);
});

test("审核范围归类：阶段级与集号级区分", () => {
  assert.deepEqual(classifySupervisionScope("故事骨架"), { kind: "stage", stage: "storySkeleton" });
  assert.deepEqual(classifySupervisionScope("改编策略"), { kind: "stage", stage: "adaptationStrategy" });
  assert.deepEqual(classifySupervisionScope("EP02-EP04"), { kind: "episodes", from: 2, to: 4 });
  assert.deepEqual(classifySupervisionScope("EP01-EP03 修复复检"), { kind: "episodes", from: 1, to: 3 });
  assert.deepEqual(classifySupervisionScope(""), { kind: "unknown" });
});

test("保存骨架时以新骨架为准：旧 targetEpisodes 不卡住拆集后的新集数", () => {
  // 老项目：字段 12 集，骨架已重写为 20 集 → 保存骨架时应落 20（否则进度/监督集数校验全部对不上）
  assert.equal(
    resolveTargetEpisodesOnSave({
      artifactType: "storySkeleton",
      artifactContent: skeletonOf(20),
      workData: { targetEpisodes: 12, storySkeleton: skeletonOf(20) },
    }),
    20,
  );
  // 骨架解析失败时回退到已存字段，不清空
  assert.equal(
    resolveTargetEpisodesOnSave({
      artifactType: "storySkeleton",
      artifactContent: "没有分集的骨架",
      workData: { targetEpisodes: 12, storySkeleton: skeletonOf(19) },
    }),
    12,
  );
  // 保存其他产物（改编策略/剧本）仍以已存字段优先，不因措辞变化抖动
  assert.equal(
    resolveTargetEpisodesOnSave({
      artifactType: "adaptationStrategy",
      artifactContent: "共 8 集",
      workData: { targetEpisodes: 19, storySkeleton: skeletonOf(19) },
    }),
    19,
  );
});

test("目标集数：优先已存字段，其次骨架分集解析，最后文本回退", () => {
  assert.equal(resolveTargetEpisodes({ targetEpisodes: 12, storySkeleton: skeletonOf(19) }), 12);
  assert.equal(resolveTargetEpisodes({ storySkeleton: skeletonOf(19) }), 19);
  assert.equal(resolveTargetEpisodes({ storySkeleton: "没有分集的骨架", adaptationStrategy: "共 8 集" }), 8);
  assert.equal(resolveTargetEpisodes({ storySkeleton: "", adaptationStrategy: "<集数>24集</集数>" }), 24);
  assert.equal(resolveTargetEpisodes({}), undefined);
  assert.equal(resolveTargetEpisodes({ targetEpisodes: 9999 }), undefined, "超上限的目标集数不采信");
});

test("进度聚合：《摆摊》场景——3/19 集、EP01 阻塞、EP02/03 遗留建议", () => {
  const progress = buildScriptAgentProgress({
    workData: {
      storySkeleton: skeletonOf(19),
      adaptationStrategy: "### 改编策略\n内容若干",
      supervisionHistory: [
        round({ at: 1, scope: "故事骨架", rating: "B", blockingCount: 0 }),
        round({ at: 2, scope: "改编策略", rating: "A", blockingCount: 0 }),
        round({ at: 3, scope: "EP01-EP03", rating: "D", blockingCount: 2 }),
        round({ at: 4, scope: "EP02-EP04", rating: "B", blockingCount: 0, mediumCount: 2, lightCount: 3, closedCount: 2 }),
      ],
    },
    scripts: [
      { name: "照野炸串 EP01：她说去进修", content: "正文一", createTime: 1000 },
      { name: "照野炸串 EP02：婚房写谁名字", content: "正文二", createTime: 2000 },
      { name: "照野炸串 EP03：我送她上车", content: "正文三", createTime: 3000 },
    ],
  });

  assert.equal(progress.scripts.targetEpisodes, 19);
  assert.equal(progress.scripts.savedCount, 3);
  assert.equal(progress.scripts.remaining, 16);
  assert.deepEqual(progress.scripts.nextRange, { from: 4, to: 8 }, "下一批不超过 5 集");
  assert.equal(progress.stages.storySkeleton.ready, true);
  assert.equal(progress.stages.storySkeleton.latestReview?.rating, "B");
  assert.equal(progress.stages.adaptationStrategy.latestReview?.rating, "A");

  const byNo = new Map(progress.scripts.episodes.map((episode) => [episode.episodeNo, episode]));
  assert.equal(byNo.get(1)?.review.status, "blocked", "EP01 只被含 2 个阻塞的轮次覆盖");
  assert.equal(byNo.get(2)?.review.status, "issues", "EP02 被最新轮次覆盖且无阻塞但有遗留建议");
  assert.equal(byNo.get(3)?.review.status, "issues");
  assert.equal(byNo.get(1)?.review.at, 3);

  assert.match(progress.conclusive, /已保存 3\/19 集剧本/);
  assert.match(progress.conclusive, /最近审核通过/);
  assert.match(progress.conclusive, /继续生成 EP04-EP08/);
});

test("进度聚合：全部完成 / 未开始 / 审核未通过三种结论", () => {
  const allDone = buildScriptAgentProgress({
    workData: {
      storySkeleton: skeletonOf(3),
      adaptationStrategy: "策略",
      supervisionHistory: [round({ at: 1, scope: "EP01-EP03", rating: "A", blockingCount: 0 })],
    },
    scripts: [
      { name: "剧 EP01：一", content: "a" },
      { name: "剧 EP02：二", content: "b" },
      { name: "剧 EP03：三", content: "c" },
    ],
  });
  assert.equal(allDone.scripts.remaining, 0);
  assert.equal(allDone.scripts.nextRange, undefined);
  assert.match(allDone.conclusive, /已生成全部 3 集剧本/);
  assert.match(allDone.conclusive, /可进入制作流程/);

  const blocked = buildScriptAgentProgress({
    workData: {
      storySkeleton: skeletonOf(5),
      adaptationStrategy: "策略",
      supervisionHistory: [round({ at: 1, scope: "EP01-EP03", rating: "D", blockingCount: 2 })],
    },
    scripts: [{ name: "剧 EP01：一", content: "a" }],
  });
  assert.match(blocked.conclusive, /最近审核存在 2 个阻塞问题待修复/);

  const fresh = buildScriptAgentProgress({ workData: { storySkeleton: "", adaptationStrategy: "" }, scripts: [] });
  assert.equal(fresh.scripts.savedCount, 0);
  assert.match(fresh.conclusive, /故事骨架还未生成/);

  const strategyOnly = buildScriptAgentProgress({
    workData: { storySkeleton: skeletonOf(2), adaptationStrategy: "" },
    scripts: [],
  });
  assert.match(strategyOnly.conclusive, /下一步：制定改编策略/);

  const readyToWrite = buildScriptAgentProgress({
    workData: { storySkeleton: skeletonOf(12), adaptationStrategy: "策略" },
    scripts: [],
  });
  assert.match(readyToWrite.conclusive, /已就绪（共 12 集）/);
  assert.deepEqual(readyToWrite.scripts.nextRange, { from: 1, to: 5 });
});

test("进度聚合：集号缺口时下一批从缺口开始，且不越过目标集数", () => {
  const progress = buildScriptAgentProgress({
    workData: { storySkeleton: skeletonOf(6), adaptationStrategy: "策略" },
    scripts: [
      { name: "剧 EP01：一", content: "a" },
      { name: "剧 EP03：三", content: "c" },
      { name: "剧 EP06：六", content: "f" },
    ],
  });
  assert.equal(progress.scripts.savedCount, 3);
  assert.deepEqual(progress.scripts.nextRange, { from: 2, to: 6 }, "从缺号 EP02 开始，且不超过剩余目标");

  const tail = buildScriptAgentProgress({
    workData: { storySkeleton: skeletonOf(4), adaptationStrategy: "策略" },
    scripts: [
      { name: "剧 EP01：一", content: "a" },
      { name: "剧 EP02：二", content: "b" },
      { name: "剧 EP03：三", content: "c" },
    ],
  });
  assert.deepEqual(tail.scripts.nextRange, { from: 4, to: 4 });
});

test("集号区间展示格式", () => {
  assert.equal(formatEpisodeRange(1, 3), "EP01-EP03");
  assert.equal(formatEpisodeRange(4, 4), "EP04");
});
