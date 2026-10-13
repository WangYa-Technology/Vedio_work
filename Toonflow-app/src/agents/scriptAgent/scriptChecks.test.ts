import assert from "node:assert/strict";
import test from "node:test";
import {
  ScriptChecksCache,
  buildScriptChecksCacheKey,
  diffDialogue,
  estimateEpisodeDuration,
  extractNovelQuotes,
  extractScriptDialogues,
  normalizeForCompare,
  parseChapterRange,
  parseIndexNumber,
  parseScriptEpisode,
  previewEpisodeCapacity,
  renderSplitPlanTable,
  scanRedlines,
  similarityRatio,
  type ScriptCheckReport,
  type ScriptLine,
  type ScriptLineType,
} from "./scriptChecks";
import { EPISODE_CAPACITY_BUDGET } from "@/agents/shared/episodeCapacity";

function scriptLine(lineNo: number, type: ScriptLineType, text: string): ScriptLine {
  return { lineNo, type, text, raw: text };
}

function makeScript(dialogueText: string, actionCount = 0, sceneCount = 1): string {
  const blocks: string[] = [];
  for (let index = 1; index <= sceneCount; index += 1) {
    const actions = Array.from(
      { length: actionCount },
      () => "△他抬头看向窗外，手指在桌面上轻轻敲了两下。",
    ).join("\n");
    blocks.push(
      [`${index}-1 客厅 日/内`, "人物：林晚 沈砚", actions, `林晚：${dialogueText}`].filter(Boolean).join("\n"),
    );
  }
  return [
    "# 测试剧 EP01：开场",
    "# 目标时长：100-130秒",
    "# 原著范围：第1-12章 | 本集功能：承接",
    "# 平台：竖屏 | 风格：都市",
    "",
    "---",
    "",
    "## 剧情梗概",
    "",
    "一段梗概。",
    "",
    "## 本集承接",
    "",
    "- 上集结果：无",
    "- 本集任务：开场",
    "- 下集交棒：未知",
    "",
    "---",
    "",
    blocks.join("\n\n---\n\n"),
  ].join("\n");
}

test("解析场次、人物、台词与原著范围", () => {
  const parsed = parseScriptEpisode("测试剧 EP01：开场", makeScript("你到底为什么不肯说清楚？", 2, 2));

  assert.equal(parsed.episodeNo, 1);
  assert.deepEqual(parsed.chapterRange, { start: 1, end: 12 });
  assert.equal(parsed.scenes.length, 2);
  assert.deepEqual(parsed.scenes[0].characters, ["林晚", "沈砚"]);
  assert.equal(parsed.lines.filter((line) => line.type === "action").length, 4);
  assert.equal(extractScriptDialogues(parsed).length, 2);
});

test("时长折算三态：通过 / 骑线 / 超限 / 不足", () => {
  const okEstimate = estimateEpisodeDuration(parseScriptEpisode("测试剧 EP01：开场", makeScript("啊".repeat(560))));
  assert.equal(okEstimate.status, "ok");
  assert.ok(okEstimate.lowerSeconds >= 100 && okEstimate.upperSeconds <= 130);

  const borderline = estimateEpisodeDuration(parseScriptEpisode("测试剧 EP01：开场", makeScript("啊".repeat(520))));
  assert.equal(borderline.status, "borderline");

  const over = estimateEpisodeDuration(parseScriptEpisode("测试剧 EP01：开场", makeScript("啊".repeat(760))));
  assert.equal(over.status, "over");

  const under = estimateEpisodeDuration(parseScriptEpisode("测试剧 EP01：开场", makeScript("啊".repeat(300))));
  assert.equal(under.status, "under");
});

test("原著范围解析兼容前半/后半与跨章写法", () => {
  assert.deepEqual(parseChapterRange("# 原著范围：第1章前半 | 本集功能：建立+开场冲突"), { start: 1, end: 1 });
  assert.deepEqual(parseChapterRange("# 原著范围：第1章后半-第2章前半 | 本集功能：建立（反击启动）"), { start: 1, end: 2 });
  assert.deepEqual(parseChapterRange("# 原著范围：第2章后半-第3章"), { start: 2, end: 3 });
  assert.equal(parseChapterRange("# 原著范围：待定"), null);
});

test("标点归一化与相似度计算", () => {
  assert.equal(normalizeForCompare("你当真要走？"), normalizeForCompare("你当真要走?"));
  assert.equal(normalizeForCompare("“我不会走的……”"), "我不会走的");
  assert.equal(normalizeForCompare("马上！"), normalizeForCompare("马上。"));
  assert.equal(similarityRatio("你当真要走", "你真要走"), 0.8);
  assert.equal(similarityRatio("完全一致", "完全一致"), 1);
});

test("原文引号句提取支持多种引号并去重", () => {
  const quotes = extractNovelQuotes("他说：“你当真要走？”她没回答。\n「我不会走的。」\n“你当真要走？”");
  assert.ok(quotes.includes("你当真要走？"));
  assert.ok(quotes.includes("我不会走的。"));
  assert.equal(quotes.filter((quote) => quote === "你当真要走？").length, 1);
});

test("台词比对区分逐字保留 / 改写 / 疑似新增 / 未采用", () => {
  const scriptLines: ScriptLine[] = [
    scriptLine(1, "dialogue", "你当真要走?"),
    scriptLine(2, "dialogue", "你真要走"),
    scriptLine(3, "dialogue", "这件事我说的算不算数还不一定呢"),
    scriptLine(4, "os", "我不会走的。"),
  ];
  const result = diffDialogue(scriptLines, ["你当真要走？", "我不会走的。", "这世上没有谁能拦得住我。"]);

  assert.equal(result.counts.verbatim, 1);
  assert.equal(result.counts.rewritten, 1);
  assert.equal(result.counts.suspectAdded, 1);
  assert.ok(result.notAdopted.includes("这世上没有谁能拦得住我。"));
  assert.equal(result.rewritten[0].novel, "你当真要走？");
  assert.ok((result.rewritten[0].similarity ?? 0) >= 0.65);
  // OS/V.S. 不参与逐字保留率统计
  assert.equal(result.counts.scriptDialogues, 3);
});

test("红线扫描命中镜头技术标注与现实官职，且不误伤剧情词", () => {
  const risky = parseScriptEpisode(
    "测试剧 EP01：开场",
    `${makeScript("市长明天就到。")}\n△全景·缓推·约6秒，镜头停在她脸上。`,
  );
  const riskyHits = scanRedlines(risky);
  assert.ok(riskyHits.some((hit) => hit.rule === "镜头技术/秒数标注" && hit.severity === "阻塞"));
  assert.ok(riskyHits.some((hit) => hit.rule === "现实官职称谓" && hit.severity === "阻塞"));

  const safe = parseScriptEpisode("测试剧 EP01：开场", makeScript("客厅那扇全景落地窗很好看，再给我3秒我就说。"));
  const safeHits = scanRedlines(safe);
  assert.equal(safeHits.some((hit) => hit.rule === "镜头技术/秒数标注"), false);
});

test("结构校验提示场号不连续与场景分隔不足", () => {
  const jumpScript = [
    "# 测试剧 EP01：开场",
    "# 原著范围：第1章",
    "",
    "---",
    "",
    "1-1 客厅 日/内",
    "人物：林晚",
    "△她坐下。",
    "林晚：我不会走的。",
    "",
    "1-3 街上 夜/外",
    "人物：林晚",
    "△她快步走着。",
    "林晚：别跟着我。",
  ].join("\n");

  const hits = scanRedlines(parseScriptEpisode("测试剧 EP01：开场", jumpScript));
  assert.ok(hits.some((hit) => hit.rule === "场号不连续" && hit.severity === "提示"));
  assert.ok(hits.some((hit) => hit.rule === "场景分隔不足" && hit.severity === "提示"));
});

test("空内容与解析失败不抛异常", () => {
  const empty = parseScriptEpisode("测试剧 EP01：开场", "");
  assert.equal(empty.scenes.length, 0);
  assert.ok(empty.parseWarnings.length > 0);
  assert.doesNotThrow(() => estimateEpisodeDuration(empty));
  assert.doesNotThrow(() => scanRedlines(empty));
  assert.equal(extractNovelQuotes("").length, 0);
});

test("章节编号解析支持阿拉伯数字与中文数字", () => {
  assert.equal(parseIndexNumber("12"), 12);
  assert.equal(parseIndexNumber("十五"), 15);
  assert.equal(parseIndexNumber("一百零五"), 105);
  assert.equal(parseIndexNumber("abc"), undefined);
});

test("确定性检查缓存键：内容/范围变化即失效，剧本顺序不影响", () => {
  const scripts = [
    { name: "EP01", content: "第一集内容" },
    { name: "EP02", content: "第二集内容" },
  ];
  const base = buildScriptChecksCacheKey(9, scripts);

  assert.equal(base, buildScriptChecksCacheKey(9, [...scripts].reverse()), "剧本顺序不同应视为同一份内容");
  assert.notEqual(base, buildScriptChecksCacheKey(10, scripts), "项目不同应失效");
  assert.notEqual(base, buildScriptChecksCacheKey(9, [{ ...scripts[0] }, { name: "EP02", content: "第二集改过了" }]), "剧本内容变化应失效");
  assert.notEqual(base, buildScriptChecksCacheKey(9, scripts, { maxChapters: 5 }), "检查范围变化应失效");
  assert.notEqual(base, buildScriptChecksCacheKey(9, scripts, { scriptNames: ["EP01"] }), "指定剧本变化应失效");
});

test("确定性检查 TTL 缓存：命中、键不匹配、过期与清空", () => {
  const cache = new ScriptChecksCache(45_000);
  const report = { generatedAt: 1, projectId: 1, episodes: [], summary: {} } as unknown as ScriptCheckReport;

  assert.equal(cache.read("k1", 0), null);

  cache.write("k1", report, 1000);
  assert.equal(cache.read("k1", 1000), report, "未到期应命中");
  assert.equal(cache.read("k1", 1000 + 44_999), report, "到期前一刻应命中");
  assert.equal(cache.read("k2", 1000), null, "键不一致不应命中");
  assert.equal(cache.read("k1", 1000 + 45_000), null, "到期即失效");

  cache.write("k1", report, 2000);
  cache.clear();
  assert.equal(cache.read("k1", 2000), null, "清空后不应命中");
});

/* ==================== 下游口径预演（与分镜端同一把尺子） ==================== */

test("解析修正：场记注释不计台词，带括注的说话人计入台词", () => {
  const content = [
    "# 测试剧 EP01：开场",
    "# 目标时长：100-130秒",
    "# 原著范围：第1章",
    "",
    "---",
    "",
    "1-1 摊位 夜/外",
    "",
    "【信息差类型：观众先知型——主角已知、女主以为他不知】",
    "",
    "人物：陈照野 老王",
    "",
    "△陈照野低头剁辣椒。",
    "",
    "陈照野（目光落到那口汤上）：半个月？",
    "",
    "老王：照野，你笑啥呢？",
  ].join("\n");
  const parsed = parseScriptEpisode("测试剧 EP01", content);
  const spoken = parsed.lines.filter((line) => line.type === "dialogue");
  assert.equal(spoken.length, 2, "场记注释不应被算作台词");
  assert.equal(spoken[0].speaker, "陈照野", "带括注的说话人应解析为名字本身");
  assert.equal(spoken[0].text, "半个月？");
});

test("容量预演：台词超容时判必拆/建议拆集并给出拆集方案表", () => {
  const lines: string[] = [];
  for (let index = 1; index <= 40; index += 1) {
    lines.push(`陈照野：这是第${index}句测试台词，内容不短也不长。`);
  }
  const content = [
    "# 测试剧 EP01：开场",
    "# 目标时长：100-130秒",
    "# 原著范围：第1章",
    "",
    "---",
    "",
    "1-1 摊位 夜/外",
    "",
    "人物：陈照野",
    "",
    ...lines,
  ].join("\n");
  const parsed = parseScriptEpisode("测试剧 EP01", content);
  const preview = previewEpisodeCapacity(parsed);
  assert.equal(preview.load.lines, 40);
  assert.ok(preview.load.chars > 300, `净字数应大于 300，实际 ${preview.load.chars}`);
  assert.ok(preview.timing.safeSeconds > 130, "40 条台词的台词安全时长应超过单集上限");
  assert.ok(
    preview.estimate.result.level === "splitRequired" || preview.estimate.result.level === "splitPressure",
    `应判拆集，实际 ${preview.estimate.result.level}`,
  );
  assert.ok(preview.splitPlan, "应给出拆集方案");
  assert.ok(preview.splitPlan!.parts.length >= 2, "拆集方案至少 2 集");
  for (const part of preview.splitPlan!.parts) {
    assert.ok(part.estimate.floorTotalSeconds <= EPISODE_CAPACITY_BUDGET.maxSeconds, "每集应满足物理下限约束");
  }
  const table = renderSplitPlanTable(preview.splitPlan!);
  assert.ok(table.some((row) => /新EP01/.test(row)));
});

test("容量预演：装得下时不报拆集", () => {
  const content = [
    "# 测试剧 EP01：开场",
    "# 目标时长：100-130秒",
    "# 原著范围：第1章",
    "",
    "---",
    "",
    "1-1 摊位 夜/外",
    "",
    "人物：陈照野",
    "",
    "陈照野：行，你去吧。",
    "老王：照野，你笑啥呢？",
  ].join("\n");
  const parsed = parseScriptEpisode("测试剧 EP01", content);
  const preview = previewEpisodeCapacity(parsed);
  assert.equal(preview.estimate.result.level, "underflow");
  assert.equal(preview.splitPlan, undefined);
});
