import assert from "node:assert/strict";
import test from "node:test";
import {
  SKELETON_CHECK_CONFIG,
  buildChapterSharePlan,
  checkSkeletonStructure,
  estimateEpisodeCapacity,
  extractChapterHandlingUsages,
  extractChapterRefs,
  extractChapterUsages,
  parseSkeletonEpisodes,
  parseSkeletonEpisodesDetailed,
  skeletonReportToMarkdown,
  type ChapterStat,
  type SkeletonCheckReport,
  type SkeletonEpisode,
} from "./skeletonChecks";
import { EPISODE_CAPACITY_BUDGET } from "@/agents/shared/episodeCapacity";

function makeEpisode(
  episodeNo: number,
  refs: Array<{ chapter: number; fragment?: string; weight?: number }>,
): SkeletonEpisode {
  return {
    episodeNo,
    title: `第${episodeNo}集`,
    chapterText: refs.map((ref) => `第${ref.chapter}章${ref.fragment ?? ""}`).join("+"),
    chapterRefs: refs.map((ref) => ({ chapter: ref.chapter, fragment: ref.fragment, weight: ref.weight ?? 1 })),
    sourceMode: "A",
  };
}

function statsOf(entries: Array<[number, number, number]>): Map<number, ChapterStat> {
  return new Map(
    entries.map(([chapter, chars, quoteChars]) => [chapter, { chapter, chars, quoteChars }]),
  );
}

function weightPairs(refs: Array<{ chapter: number; weight: number }>): Array<[number, number]> {
  return refs.map((ref) => [ref.chapter, ref.weight]);
}

test("章节引用解析：片段权重、区间与多章拼接", () => {
  assert.deepEqual(weightPairs(extractChapterRefs("第1章后半+第2章前半")), [
    [1, 0.5],
    [2, 0.5],
  ]);
  assert.deepEqual(
    weightPairs(extractChapterRefs("第3-8章")).map(([chapter]) => chapter),
    [3, 4, 5, 6, 7, 8],
  );
  assert.deepEqual(weightPairs(extractChapterRefs("第11章中段")), [[11, 0.34]]);
  assert.deepEqual(weightPairs(extractChapterRefs("第12章后段")), [[12, 0.33]]);
  assert.deepEqual(weightPairs(extractChapterRefs("第12章收束前段")), [[12, 0.25]]);
  assert.deepEqual(weightPairs(extractChapterRefs("第12章收束")), [[12, 0.2]]);
  assert.deepEqual(weightPairs(extractChapterRefs("第6章+第7章+第8章")), [
    [6, 1],
    [7, 1],
    [8, 1],
  ]);
});

test("解析模式A：标题章节范围、章节分配段，且不误读删减决策中的章节", () => {
  const skeleton = [
    "### 集1：她说去进修（第1章前半）",
    "**戏剧功能：** 建立",
    "**章节分配：**",
    "- 第1章前半：保留（开场特写）",
    "**删减决策：** 删去原著成段环境描写",
    "",
    "### 集7：再战（第9章）",
    "**章节分配：**",
    "- 第9章：保留（面馆段）",
    "**删减决策：** 压缩第9-12章的商务谈判细节",
  ].join("\n");

  const episodes = parseSkeletonEpisodes(skeleton);
  assert.equal(episodes.length, 2);
  assert.equal(episodes[0].episodeNo, 1);
  assert.equal(episodes[0].title, "她说去进修");
  assert.equal(episodes[0].sourceMode, "A");
  assert.deepEqual(episodes[0].chapterRefs, [{ chapter: 1, fragment: "前半", weight: 0.5 }]);
  // 删减决策中的"第9-12章"不得计入本集素材
  assert.deepEqual(episodes[1].chapterRefs, [{ chapter: 9, fragment: undefined, weight: 1 }]);
});

test("解析模式B：总览表（含跳行表头与省略行）", () => {
  const skeleton = [
    "| 集 | 集标题 | 章节范围 | 戏剧功能 | 场景核心 | 章节处理 | 集末钩子 | 剧情卡点 |",
    "|----|--------|----------|----------|----------|----------|----------|--------|",
    "| 1 | 开场 | 第1章前半 | 建立 | 一句话 | `1保留` | 钩子 | 无 |",
    "| 2 | 反击 | 第2章后半-第3章 | 发展 | 一句话 | `2压缩/3保留` | 钩子 | 有 |",
    "| … | （每集一行，不跳号） | … | … | … | … | … | … |",
  ].join("\n");

  const episodes = parseSkeletonEpisodes(skeleton);
  assert.equal(episodes.length, 2);
  assert.equal(episodes[1].episodeNo, 2);
  assert.equal(episodes[1].sourceMode, "B");
  assert.deepEqual(weightPairs(episodes[1].chapterRefs), [
    [2, 0.5],
    [3, 1],
  ]);
});

test("同章多片段合并：权重封顶整章 1.0", () => {
  const episode = makeEpisode(2, [
    { chapter: 1, fragment: "前半", weight: 0.5 },
    { chapter: 1, fragment: "后半", weight: 0.5 },
  ]);
  const stats = statsOf([[1, 1000, 400]]);
  const estimate = estimateEpisodeCapacity(episode, stats);
  assert.equal(estimate.sourceChars, 1000);
  assert.equal(estimate.quoteChars, 400);
});

test("双判据分级：L 单独超限、T 超限、轻度、通过、不足（逐字口径）", () => {
  const stats = statsOf([[1, 4000, 1000]]);
  const base = makeEpisode(1, [{ chapter: 1 }]);

  const withQuoteChars = (quoteChars: number) =>
    estimateEpisodeCapacity(base, statsOf([[1, 4000, quoteChars]]));

  // 台词 1000 字 ≈ 100 条 / 200 标点 → L = 1000÷4.5 + 0.3×100 = 252.2s > 130s：刚性台词下限单独触发严重超载
  const severeByLower = withQuoteChars(1000);
  assert.equal(severeByLower.level, "severeOver");
  assert.equal(severeByLower.lowerSeconds, 252.2);
  assert.equal(severeByLower.capacityLevel, "splitRequired");
  assert.match(severeByLower.detail, /刚性台词下限/);

  // 400 字 ≈ 40 条 → L=100.9s（未超限）但 T = 172s + 40s 动作预算 = 212s > 157s：预计时长触发严重超载
  const severeByEstimate = withQuoteChars(400);
  assert.equal(severeByEstimate.lowerSeconds, 100.9);
  assert.equal(severeByEstimate.estimatedSeconds, 212);
  assert.equal(severeByEstimate.level, "severeOver");
  assert.equal(severeByEstimate.capacityLevel, "splitPressure");

  // 250 字 ≈ 25 条 → T = 147.5s ∈ (130, 157]，骑线占比 39% ≤ 40%：轻度超载（可骑线执行）
  const lightOne = withQuoteChars(250);
  assert.equal(lightOne.estimatedSeconds, 147.5);
  assert.equal(lightOne.capacityLevel, "rideLine");
  assert.equal(lightOne.level, "lightOver");

  // 200 字 ≈ 20 条 → T = 126s ∈ [100, 130]：通过
  assert.equal(withQuoteChars(200).level, "ok");
  assert.equal(withQuoteChars(200).capacityLevel, "ok");

  // 100 字 ≈ 10 条 → T = 83s < 85s：素材不足
  assert.equal(withQuoteChars(100).level, "under");
  assert.equal(withQuoteChars(100).capacityLevel, "underflow");
  assert.ok(stats.size === 1);
});

test("素材缺失章：按 0 计并判为素材不足", () => {
  const episode = makeEpisode(5, [{ chapter: 99 }]);
  const estimate = estimateEpisodeCapacity(episode, statsOf([[1, 1000, 400]]));
  assert.equal(estimate.quoteChars, 0);
  // 零素材时预计时长 = 动作/非台词预算
  assert.equal(estimate.estimatedSeconds, EPISODE_CAPACITY_BUDGET.actionReferenceSeconds);
  assert.equal(estimate.level, "under");
  assert.equal(estimate.capacityLevel, "underflow");
  assert.equal(estimate.parseWarning, undefined);
});

test("结构校验：集号不连续与章节未覆盖", () => {
  const episodes = [makeEpisode(1, [{ chapter: 1 }]), makeEpisode(3, [{ chapter: 3 }])];
  const warnings = checkSkeletonStructure(episodes, [1, 2, 3]);
  assert.ok(warnings.some((warning) => warning.includes("集号不连续")));
  assert.ok(warnings.some((warning) => warning.includes("第2章")));
});

test("报告输出：包含判定口径、逐集估算与压缩建议", () => {
  const episodes = [makeEpisode(1, [{ chapter: 1 }]), makeEpisode(6, [{ chapter: 6 }, { chapter: 7 }, { chapter: 8 }])];
  const stats = statsOf([
    [1, 4000, 400],
    [6, 3000, 1000],
    [7, 2000, 600],
    [8, 2000, 600],
  ]);
  const report: SkeletonCheckReport = {
    generatedAt: Date.now(),
    projectId: 1,
    target: { ...SKELETON_CHECK_CONFIG.episodeTarget },
    estimates: episodes.map((episode) => estimateEpisodeCapacity(episode, stats)),
    structureWarnings: [],
    warnings: [],
  };
  const markdown = skeletonReportToMarkdown(report);
  assert.match(markdown, /骨架容量体检结果/);
  assert.match(markdown, /刚性台词下限 L/);
  assert.match(markdown, /EP06/);
  assert.match(markdown, /严重超载/);
  assert.match(markdown, /处理建议/);
  assert.match(markdown, /判定口径/);
  assert.match(markdown, /不得进入剧本编写阶段/);
});

test("无法识别分集时返回空数组", () => {
  assert.equal(parseSkeletonEpisodes("这是一段普通文本，没有分集信息。").length, 0);
});

test("份额推导：四集共章按场次占比，不再按整章重复计数", () => {
  const skeleton = [
    "| 集 | 集标题 | 章节范围 | 戏剧功能 | 场景核心 | 章节处理 | 集末钩子 | 剧情卡点 |",
    "|----|--------|----------|----------|----------|----------|----------|--------|",
    "| 1 | 一 | 第1章 第1场 | 建立 | 一句话 | `1场1保留` | 钩子 | 无 |",
    "| 2 | 二 | 第1章 第2场 | 发展 | 一句话 | `1场2保留` | 钩子 | 无 |",
    "| 3 | 三 | 第1章 第3场 | 发展 | 一句话 | `1场3保留` | 钩子 | 无 |",
    "| 4 | 四 | 第1章 第4场 | 高潮 | 一句话 | `1场4保留` | 钩子 | 有 |",
  ].join("\n");
  const episodes = parseSkeletonEpisodes(skeleton);
  assert.equal(episodes.length, 4);

  const plan = buildChapterSharePlan(episodes);
  assert.deepEqual(
    episodes.map((episode) => plan.byEpisode.get(episode.episodeNo)?.get(1)?.share),
    [0.25, 0.25, 0.25, 0.25],
  );
  assert.deepEqual(
    episodes.map((episode) => plan.byEpisode.get(episode.episodeNo)?.get(1)?.source),
    ["scene", "scene", "scene", "scene"],
  );
  assert.deepEqual(plan.warnings, []);

  const stats = statsOf([[1, 4000, 1000]]);
  for (const episode of episodes) {
    const estimate = estimateEpisodeCapacity(episode, stats, SKELETON_CHECK_CONFIG, plan);
    // 每集只分到第1章的 25% → 250 字 ≈ 25 条 → 预计 147.5s：轻度超载、可骑线执行
    assert.equal(estimate.quoteChars, 250);
    assert.equal(estimate.level, "lightOver");
    assert.equal(estimate.capacityLevel, "rideLine");
    assert.match(estimate.shareNote ?? "", /第1章 25%（按场次）/);
  }
});

test("份额解析：片段词+括号百分比时以百分比计费（不再按片段词权重）", () => {
  assert.deepEqual(
    extractChapterUsages("第1章 前段（28%）").map((usage) => [usage.chapter, usage.fragment, usage.explicitShare]),
    [[1, "前段", 0.28]],
  );
  assert.deepEqual(
    extractChapterUsages("第2章 中段（40%）").map((usage) => usage.explicitShare),
    [0.4],
  );
  assert.deepEqual(
    extractChapterUsages("第3章 后段 36%").map((usage) => usage.explicitShare),
    [0.36],
  );
  assert.deepEqual(
    extractChapterUsages("第4章（35%）").map((usage) => usage.explicitShare),
    [0.35],
  );
  assert.deepEqual(
    extractChapterUsages("第5章 收束 20％").map((usage) => usage.explicitShare),
    [0.2],
  );
  // 跨章组合：两条声明各自取百分比（第二个「第X章」起新的一条）
  assert.deepEqual(
    extractChapterUsages("第1章 后段（36%）＋第2章 前段（20%）").map((usage) => [usage.chapter, usage.explicitShare]),
    [
      [1, 0.36],
      [2, 0.2],
    ],
  );
  // 无百分比时仍回退片段词权重（向后兼容）
  assert.deepEqual(
    extractChapterUsages("第6章 中段").map((usage) => usage.explicitShare),
    [0.34],
  );
  assert.deepEqual(
    extractChapterUsages("第7章 第2场").map((usage) => [usage.explicitShare, usage.sceneNo]),
    [[undefined, 2]],
  );
  // 片段词+百分比+场次混写：三者都要取出
  assert.deepEqual(
    extractChapterUsages("第8章 前段（33%）第4场").map((usage) => [usage.fragment, usage.explicitShare, usage.sceneNo]),
    [["前段", 0.33, 4]],
  );
});

test("份额推导：片段词+百分比不会被误报超配（同章三集合计 100%）", () => {
  const skeleton = [
    "| 集 | 集标题 | 章节范围 | 戏剧功能 | 场景核心 | 章节处理 | 集末钩子 | 剧情卡点 |",
    "|----|--------|----------|----------|----------|----------|----------|--------|",
    "| 1 | 一 | 第1章 前段（28%） | 建立 | 一句话 | `1场2保留` | 钩子 | 无 |",
    "| 2 | 二 | 第1章 中段（36%） | 发展 | 一句话 | `1场4保留` | 钩子 | 无 |",
    "| 3 | 三 | 第1章 后段（36%） | 高潮 | 一句话 | `1场7保留` | 钩子 | 有 |",
  ].join("\n");
  const episodes = parseSkeletonEpisodes(skeleton);
  const plan = buildChapterSharePlan(episodes);
  assert.deepEqual(plan.warnings, [], "百分比已识别，不应报份额超配");
  assert.deepEqual(
    episodes.map((episode) => plan.byEpisode.get(episode.episodeNo)?.get(1)?.share),
    [0.28, 0.36, 0.36],
  );
  assert.deepEqual(
    episodes.map((episode) => plan.byEpisode.get(episode.episodeNo)?.get(1)?.source),
    ["explicit", "explicit", "explicit"],
  );
});

test("份额解析：显式比例、百分号、整章标记与处理列条目", () => {
  assert.deepEqual(
    extractChapterUsages("第3章(1/4)").map((usage) => usage.explicitShare),
    [0.25],
  );
  assert.deepEqual(
    extractChapterUsages("第4章 25%").map((usage) => usage.explicitShare),
    [0.25],
  );
  assert.deepEqual(
    extractChapterUsages("第5章前半").map((usage) => usage.explicitShare),
    [0.5],
  );
  assert.deepEqual(
    extractChapterUsages("第6章 全章").map((usage) => usage.explicitShare),
    [1],
  );
  assert.deepEqual(
    extractChapterUsages("第7章 第2场").map((usage) => usage.sceneNo),
    [2],
  );
  assert.deepEqual(
    extractChapterHandlingUsages("`1场5保留/1场6压缩/2删`").map((usage) => [usage.chapter, usage.sceneNo]),
    [
      [1, 5],
      [1, 6],
    ],
  );
  assert.deepEqual(
    extractChapterHandlingUsages("`3保留/4压缩/5删`").map((usage) => usage.chapter),
    [3, 4],
  );
});

test("回归：单集整章引用仍按整章计，重章不被洗白", () => {
  const episodes = [makeEpisode(1, [{ chapter: 1 }])];
  const plan = buildChapterSharePlan(episodes);
  assert.equal(plan.byEpisode.get(1)?.get(1)?.share, 1);
  assert.equal(plan.byEpisode.get(1)?.get(1)?.source, "whole");

  const estimate = estimateEpisodeCapacity(episodes[0], statsOf([[1, 4000, 1000]]), SKELETON_CHECK_CONFIG, plan);
  assert.equal(estimate.level, "severeOver");
  assert.equal(estimate.quoteChars, 1000);

  // 未提供份额计划时保持旧的权重口径（兼容路径）
  const legacy = estimateEpisodeCapacity(episodes[0], statsOf([[1, 4000, 1000]]));
  assert.equal(legacy.level, "severeOver");
});

test("解析择优：总览表与逐集展开并存时取更完整的一份", () => {
  const skeleton = [
    "| 集 | 集标题 | 章节范围 | 戏剧功能 | 场景核心 | 章节处理 | 集末钩子 | 剧情卡点 |",
    "|----|--------|----------|----------|----------|----------|----------|--------|",
    "| 1 | 一 | 第1章 第1场 | 建立 | 一句话 | `1场1保留` | 钩子 | 无 |",
    "| 2 | 二 | 第1章 第2场 | 发展 | 一句话 | `1场2保留` | 钩子 | 无 |",
    "| 3 | 三 | 第1章 第3场 | 高潮 | 一句话 | `1场3保留` | 钩子 | 有 |",
    "",
    "### 关键集展开",
    "",
    "### 集1：一（第1章 第1场）",
    "**章节分配：**",
    "- 第1章第1场：保留",
    "",
    "### 集3：三（第1章 第3场）",
    "**章节分配：**",
    "- 第1章第3场：保留",
  ].join("\n");

  const parsed = parseSkeletonEpisodesDetailed(skeleton);
  assert.equal(parsed.source?.used, "B");
  assert.equal(parsed.source?.modeAEpisodes, 2);
  assert.equal(parsed.source?.modeBEpisodes, 3);
  assert.deepEqual(parsed.source?.modeAMissing, [2]);
  assert.deepEqual(
    parsed.episodes.map((episode) => episode.episodeNo),
    [1, 2, 3],
  );
});

test("跨章引用：逐章分别计份额，延后行不计入本集", () => {
  const skeleton = [
    "### 集1：开场（第1章 第1场）",
    "**章节分配：**",
    "- 第1章第1场：保留（开场）",
    "- 第1章第2场：顺延至集2",
    "- 第2章第1场：压缩并入集末钩子",
    "",
    "### 集2：承接（第1章 第2场）",
    "**章节分配：**",
    "- 第1章第2场：保留",
    "- 第2章第1场：保留",
  ].join("\n");

  const episodes = parseSkeletonEpisodes(skeleton);
  const plan = buildChapterSharePlan(episodes);
  // 第1章：EP01 用场1、EP02 用场2（EP01 的"顺延至集2"不计入本集）
  assert.deepEqual(
    episodes.map((episode) => plan.byEpisode.get(episode.episodeNo)?.get(1)?.share),
    [0.5, 0.5],
  );
  // 第2章：两集都声明场1 → 合计 200%，按比例归一为各 50% 并给出提示
  assert.deepEqual(
    episodes.map((episode) => plan.byEpisode.get(episode.episodeNo)?.get(2)?.share),
    [0.5, 0.5],
  );
  assert.ok(plan.warnings.some((warning) => warning.includes("第2章份额合计")));
});

test("份额校验：未分配余量提示与超配合计归一", () => {
  const single = [makeEpisode(1, [{ chapter: 1, fragment: "后半", weight: 0.5 }])];
  const plan = buildChapterSharePlan(single);
  assert.equal(plan.byChapter[0].assigned, 0.5);
  assert.equal(plan.byChapter[0].unassigned, 0.5);
  assert.ok(plan.warnings.some((warning) => warning.includes("未分配到任何一集")));
  const estimate = estimateEpisodeCapacity(single[0], statsOf([[1, 1000, 400]]), SKELETON_CHECK_CONFIG, plan);
  assert.equal(estimate.quoteChars, 200);

  const overlapped = [1, 2, 3].map((episodeNo) =>
    makeEpisode(episodeNo, [{ chapter: 1, fragment: "前半", weight: 0.5 }]),
  );
  const overPlan = buildChapterSharePlan(overlapped);
  assert.ok(overPlan.warnings.some((warning) => warning.includes("超出 100%")));
  assert.deepEqual(
    overlapped.map((episode) =>
      Math.round((overPlan.byEpisode.get(episode.episodeNo)?.get(1)?.share ?? 0) * 100),
    ),
    [33, 33, 33],
  );
});

test("报告输出：包含解析来源与份额推断小节", () => {
  const episodes = parseSkeletonEpisodes(
    [
      "| 集 | 集标题 | 章节范围 | 戏剧功能 | 场景核心 | 章节处理 | 集末钩子 | 剧情卡点 |",
      "|----|--------|----------|----------|----------|----------|----------|--------|",
      "| 1 | 一 | 第1章 第1场 | 建立 | 一句话 | `1场1保留` | 钩子 | 无 |",
      "| 2 | 二 | 第1章 第2场 | 发展 | 一句话 | `1场2保留` | 钩子 | 无 |",
    ].join("\n"),
  );
  const plan = buildChapterSharePlan(episodes);
  const report: SkeletonCheckReport = {
    generatedAt: 0,
    projectId: 1,
    target: { ...SKELETON_CHECK_CONFIG.episodeTarget },
    estimates: episodes.map((episode) =>
      estimateEpisodeCapacity(
        episode,
        statsOf([
          [1, 4000, 400],
          [2, 4000, 400],
        ]),
        SKELETON_CHECK_CONFIG,
        plan,
      ),
    ),
    structureWarnings: [],
    warnings: [...plan.warnings],
    parseSource: {
      used: "B",
      modeAEpisodes: 1,
      modeBEpisodes: 2,
      modeAMissing: [2],
      modeBMissing: [],
    },
    shareSummaries: plan.byChapter,
  };
  const markdown = skeletonReportToMarkdown(report);
  assert.match(markdown, /解析来源与份额推断/);
  assert.match(markdown, /逐集展开缺 EP02/);
  assert.match(markdown, /归一后合计/);
  assert.match(markdown, /份额口径/);
});
