import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeRepairScopes,
  mergeStoryboardRepair,
  splitSceneSegments,
  splitStoryboardScenes,
  storyboardChangesToMarkdown,
  summarizeStoryboardChanges,
} from "./storyboardDoc";

function scene(sceneNo: number, title: string, segments: string[]): string[] {
  return [`## 场${sceneNo}：${title} ｜ 参演角色：林晚`, "", ...segments.flatMap((text) => [text, ""])];
}

function segment(title: string, rows: string[]): string {
  return [
    `### ${title}（约12s）`,
    "**引用资产名称**：[林晚, 客厅]",
    "**引用资产ID**：[1, 2]",
    "| 序号 | 画面描述 | 时长 | 景别 | 运镜 | 台词 | 音效 |",
    "|------|------|------|------|------|------|------|",
    ...rows,
  ].join("\n");
}

function row(serial: number, description: string, duration: number, dialogue = ""): string {
  return `| ${serial} | ${description} | ${duration} | 近景 | 固定 | ${dialogue} | 音效：风声 |`;
}

const OLD_TABLE = [
  ...scene(1, "客厅·日", [
    segment("片段一", [
      row(1, "林晚站在窗边，手指攥住衣角，视线落在门外", 4, "林晚：『你说什么？』"),
      row(2, "林晚转身走向门口，脚步放得很轻", 4),
      row(3, "门被风吹得轻轻晃动，林晚停住", 4),
    ]),
  ]),
  ...scene(2, "走廊·夜", [
    segment("片段一", [
      row(1, "走廊灯管垂着，林晚贴着墙根缓步向前", 4),
      row(2, "林晚抬眼看向走廊尽头，呼吸放轻", 4),
      row(3, "远处传来脚步声，林晚侧身贴住墙面", 4),
    ]),
    segment("片段二", [
      row(1, "林晚推开消防门，门轴发出一声轻响", 4),
      row(2, "林晚站在楼梯口向下张望", 4),
      row(3, "楼梯间的声控灯没有亮，她退后一步", 4),
    ]),
  ]),
].join("\n");

function replaceInTable(source: string, from: string, to: string): string {
  assert.ok(source.includes(from), `fixture 应包含待替换文本：${from.slice(0, 30)}`);
  return source.replace(from, to);
}

test("切片：场块、场头与行保真", () => {
  const split = splitStoryboardScenes(OLD_TABLE);
  assert.equal(split.blocks.length, 2);
  assert.equal(split.blocks[0].sceneNo, 1);
  assert.equal(split.blocks[1].sceneNo, 2);
  assert.equal(split.blocks[1].headerLine, "## 场2：走廊·夜 ｜ 参演角色：林晚");
  // 重建后与原文一致（行序列保真）
  const rebuilt = [...split.preambleLines, ...split.blocks.flatMap((block) => block.lines)].join("\n");
  assert.equal(rebuilt, OLD_TABLE);

  const parts = splitSceneSegments(split.blocks[1].lines);
  assert.equal(parts.segments.length, 2);
  assert.equal(parts.segments[0].title, "片段一");
  assert.equal(parts.segments[1].title, "片段二");
});

test("整场授权：只替换授权场，其余场逐行不变", () => {
  const NEW_TABLE = replaceInTable(
    OLD_TABLE,
    "走廊灯管垂着，林晚贴着墙根缓步向前",
    "走廊里空无一人，林晚贴着墙根急促向前，指节发白",
  );
  const { merged, warnings, appliedSceneOrders } = mergeStoryboardRepair(OLD_TABLE, NEW_TABLE, [
    { sceneOrder: 2 },
  ]);

  assert.deepEqual(appliedSceneOrders, [2]);
  assert.equal(warnings.length, 0);

  const oldSplit = splitStoryboardScenes(OLD_TABLE);
  const mergedSplit = splitStoryboardScenes(merged);
  // 场1 逐行一致
  assert.deepEqual(mergedSplit.blocks[0].lines, oldSplit.blocks[0].lines);
  // 场2 采用了修复版本
  assert.ok(merged.includes("指节发白"));
  assert.ok(!merged.includes("走廊灯管垂着，林晚贴着墙根缓步向前"));
});

test("片段级授权：数量一致时只替换授权片段", () => {
  let NEW_TABLE = replaceInTable(
    OLD_TABLE,
    "走廊灯管垂着，林晚贴着墙根缓步向前",
    "走廊里空无一人，林晚贴着墙根急促向前，指节发白",
  );
  NEW_TABLE = replaceInTable(
    NEW_TABLE,
    "林晚推开消防门，门轴发出一声轻响",
    "林晚一把推开消防门，门轴发出刺耳长响",
  );

  const { merged } = mergeStoryboardRepair(OLD_TABLE, NEW_TABLE, [
    { sceneOrder: 2, segmentOrders: [1] },
  ]);

  assert.ok(merged.includes("指节发白"), "授权片段应采用修复版本");
  assert.ok(!merged.includes("刺耳长响"), "未授权片段必须保留旧文");
  assert.ok(merged.includes("林晚推开消防门，门轴发出一声轻响"));
});

test("结构变化（片段拆分）：部分授权下整场采用并给出警告", () => {
  const newScene2 = [
    "## 场2：走廊·夜 ｜ 参演角色：林晚",
    "",
    segment("片段一", [
      row(1, "走廊里空无一人，林晚贴着墙根急促向前", 4),
      row(2, "林晚抬眼看向走廊尽头，呼吸放轻", 4),
    ]),
    "",
    segment("片段二", [
      row(1, "远处传来脚步声，林晚侧身贴住墙面", 3),
      row(2, "林晚推开消防门，门轴发出一声轻响", 3),
    ]),
    "",
    segment("片段三", [
      row(1, "林晚站在楼梯口向下张望", 5),
      row(2, "楼梯间的声控灯没有亮，她退后一步", 5),
    ]),
  ].join("\n");
  const NEW_TABLE = OLD_TABLE.split("## 场2")[0] + newScene2;

  const { merged, warnings } = mergeStoryboardRepair(OLD_TABLE, NEW_TABLE, [
    { sceneOrder: 2, segmentOrders: [2] },
  ]);

  assert.ok(merged.includes("片段三"), "结构变化时整场采用修复版本");
  assert.ok(warnings.some((item) => item.includes("结构发生变化")));
  // 场1 仍保留旧文
  assert.ok(merged.includes("林晚站在窗边，手指攥住衣角，视线落在门外"));
});

test("修复版本缺少授权场：保留旧场并警告；新增场：忽略并警告", () => {
  const missingScene = splitStoryboardScenes(OLD_TABLE).blocks[0].lines.join("\n");
  const { merged, warnings } = mergeStoryboardRepair(OLD_TABLE, missingScene, [{ sceneOrder: 2 }]);
  assert.deepEqual(splitStoryboardScenes(merged).blocks.map((block) => block.sceneNo), [1, 2]);
  assert.ok(warnings.some((item) => item.includes("未找到对应场次")));

  const extraScene = `${OLD_TABLE}\n\n## 场9：天台·日 ｜ 参演角色：林晚\n\n${segment("片段一", [row(1, "林晚站在天台边缘", 6)])}`;
  const extra = mergeStoryboardRepair(OLD_TABLE, extraScene, [{ sceneOrder: 1 }]);
  assert.equal(splitStoryboardScenes(extra.merged).blocks.length, 2);
  assert.ok(extra.warnings.some((item) => item.includes("新增的场次")));
});

test("变更摘要：报告改动场与片段", () => {
  const NEW_TABLE = replaceInTable(
    OLD_TABLE,
    "林晚抬眼看向走廊尽头，呼吸放轻",
    "林晚抬眼看向走廊尽头，呼吸绷紧了半拍",
  );
  const summary = summarizeStoryboardChanges(OLD_TABLE, NEW_TABLE);
  assert.equal(summary.changedSceneCount, 1);
  const scene2 = summary.scenes.find((item) => item.sceneNo === 2);
  assert.ok(scene2?.changed);
  assert.deepEqual(
    scene2?.segments.filter((item) => item.changed).map((item) => item.title),
    ["片段一"],
  );
  const scene1 = summary.scenes.find((item) => item.sceneNo === 1);
  assert.equal(scene1?.changed, false);

  const markdown = storyboardChangesToMarkdown(summary);
  assert.ok(markdown.includes("共改动 1 个场"));
  assert.ok(markdown.includes("场2"));
  assert.ok(markdown.includes("未改动"));
});

test("授权范围解码：默认场级，可选片段级", () => {
  const issues = [
    { sceneOrder: 2, sceneNo: 2, segmentOrderInScene: 1 },
    { sceneOrder: 2, sceneNo: 2, segmentOrderInScene: 2 },
    { sceneOrder: 4, sceneNo: 4, segmentOrderInScene: 3 },
  ];
  assert.deepEqual(decodeRepairScopes(issues), [{ sceneOrder: 2 }, { sceneOrder: 4 }]);
  assert.deepEqual(decodeRepairScopes(issues, { preferSegmentLevel: true }), [
    { sceneOrder: 2, segmentOrders: [1, 2] },
    { sceneOrder: 4, segmentOrders: [3] },
  ]);
});
