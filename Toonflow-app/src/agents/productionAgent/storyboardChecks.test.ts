import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBlockingRepairChecklist,
  checkStoryboardTable,
  countDialogueChars,
  countDialogueMarks,
  extractDialogueTexts,
  parseDurationCell,
  parseStoryboardTable,
  STORYBOARD_CHECK_CONFIG,
  storyboardReportToMarkdown,
  type StoryboardAssetRef,
} from "./storyboardChecks";

const ASSETS: StoryboardAssetRef[] = [
  { id: 1, name: "林晚", type: "role", parentId: null },
  { id: 2, name: "客厅", type: "scene", parentId: null },
  { id: 9, name: "旧菜刀与案板", type: "props", parentId: null },
];

const TABLE_HEADER = [
  "| 序号 | 画面描述 | 时长 | 景别 | 运镜 | 台词 | 音效 |",
  "|------|------|------|------|------|------|------|",
];

function shotRow(
  serial: number,
  duration: number | string,
  dialogue = "",
  extra: { description?: string; sound?: string; camera?: string } = {},
): string {
  const description = extra.description ?? "林晚站在客厅中央，手指收紧攥住衣角，喉咙滚动了一下";
  const sound = extra.sound ?? "音效：窗外风声、布料摩擦声";
  const camera = extra.camera ?? "固定";
  return `| ${serial} | ${description} | ${duration} | 近景 | ${camera} | ${dialogue} | ${sound} |`;
}

function makeTable(options: {
  rows: string[];
  assetNames?: string[];
  assetIds?: number[];
  declared?: number;
  sceneHeader?: string;
}): string {
  const names = options.assetNames ?? ["林晚", "客厅"];
  const ids = options.assetIds ?? [1, 2];
  return [
    options.sceneHeader ?? "## 场1：客厅·日 ｜ 参演角色：林晚",
    "",
    `### 片段一（约${options.declared ?? 12}s）`,
    `**引用资产名称**：[${names.join(", ")}]`,
    `**引用资产ID**：[${ids.join(", ")}]`,
    ...TABLE_HEADER,
    ...options.rows,
  ].join("\n");
}

/* ==================== 基础工具 ==================== */

test("解析时长单元格与台词文本", () => {
  assert.equal(parseDurationCell("4"), 4);
  assert.equal(parseDurationCell("3.5 秒"), 3.5);
  assert.equal(parseDurationCell("4s"), 4);
  assert.equal(parseDurationCell(""), null);
  assert.equal(parseDurationCell("无"), null);

  assert.deepEqual(extractDialogueTexts("林晚：『你说什么？』"), ["你说什么？"]);
  assert.deepEqual(extractDialogueTexts("（VO）银行流水文字：『收款人：许曼青。材料费。』"), ["收款人：许曼青。材料费。"]);
  assert.deepEqual(extractDialogueTexts(""), []);
  assert.deepEqual(extractDialogueTexts("林晚：无引号也识别"), ["无引号也识别"]);

  assert.equal(countDialogueChars("照野，好了没啊？饿死了！"), 9);
  assert.equal(countDialogueMarks("照野，好了没啊？饿死了！"), 3);
});

test("解析场/片段/镜与资产引用", () => {
  const parsed = parseStoryboardTable(
    makeTable({
      rows: [
        shotRow(1, 4, "林晚：『你说什么？』"),
        shotRow(2, 4, "林晚：『我不信。』"),
        shotRow(3, 4, ""),
      ],
    }),
  );
  assert.equal(parsed.scenes.length, 1);
  assert.equal(parsed.scenes[0].sceneNo, 1);
  assert.equal(parsed.scenes[0].title, "客厅·日");
  assert.deepEqual(parsed.scenes[0].characters, ["林晚"]);
  assert.equal(parsed.scenes[0].segments.length, 1);
  const segment = parsed.scenes[0].segments[0];
  assert.equal(segment.title, "片段一");
  assert.equal(segment.declaredSeconds, 12);
  assert.deepEqual(segment.assetNames, ["林晚", "客厅"]);
  assert.deepEqual(segment.assetIds, [1, 2]);
  assert.equal(segment.shots.length, 3);
  assert.equal(segment.shots[0].duration, 4);
  assert.equal(segment.shots[2].dialogueRaw, "");
});

/* ==================== 片段档位 ==================== */

test("片段累计时长：落档通过、掉档阻塞、贴边骑线", () => {
  const ok = checkStoryboardTable(
    makeTable({ rows: [shotRow(1, 4, "林晚：『你说什么？』"), shotRow(2, 4, ""), shotRow(3, 5, "")] }),
    { assets: ASSETS },
  );
  assert.equal(ok.issues.filter((issue) => issue.category === "片段时长档位" && issue.severity !== "提示").length, 0);

  const over = checkStoryboardTable(
    makeTable({ rows: [shotRow(1, 4, ""), shotRow(2, 5, ""), shotRow(3, 5, "")] }),
    { assets: ASSETS },
  );
  const blocking = over.issues.find((issue) => issue.category === "片段时长档位" && issue.severity === "阻塞");
  assert.ok(blocking, "14 秒应判阻塞");
  assert.equal(blocking?.current, "14 秒");

  const borderline = checkStoryboardTable(
    makeTable({ rows: [shotRow(1, 4, ""), shotRow(2, 3.7, ""), shotRow(3, 3, "")] }),
    { assets: ASSETS },
  );
  const near = borderline.issues.find((issue) => issue.category === "片段时长档位" && issue.severity === "骑线");
  assert.ok(near, "10.7 秒应判骑线");
});

/* ==================== 台词镜时长 ==================== */

test("台词镜时长：35 字塞 3 秒判阻塞", () => {
  const longLine =
    "嗯，可能也就十来天吧。照野，我也是为了咱们以后。咱总不能一直在夜市摆摊吧？";
  const report = checkStoryboardTable(
    makeTable({
      rows: [
        shotRow(1, 3, `许曼青（听筒）：『${longLine}』`),
        shotRow(2, 4, ""),
        shotRow(3, 5, ""),
      ],
    }),
    { assets: ASSETS },
  );
  const issue = report.issues.find((item) => item.category === "台词镜时长" && item.severity === "阻塞");
  assert.ok(issue, "长台词配短时长应判阻塞");
  assert.equal(issue?.location, "场1·片段一·镜1");
  assert.ok((issue?.target ?? "").includes("秒"));
  assert.equal(issue?.autoFixable, true);
});

test("台词镜时长：安全通过不再报，骑线单独分级", () => {
  const safe = checkStoryboardTable(
    makeTable({
      rows: [shotRow(1, 4, "林晚：『你说什么？』"), shotRow(2, 4, ""), shotRow(3, 4, "")],
    }),
    { assets: ASSETS },
  );
  assert.equal(safe.issues.filter((item) => item.category === "台词镜时长").length, 0);

  const borderline = checkStoryboardTable(
    makeTable({
      rows: [shotRow(1, 3, "老顾客：『照野，好了没啊？饿死了！』"), shotRow(2, 4, ""), shotRow(3, 5, "")],
    }),
    { assets: ASSETS },
  );
  const near = borderline.issues.find((item) => item.category === "台词镜时长" && item.severity === "骑线");
  assert.ok(near, "10 字配 3 秒应判骑线而非阻塞");
});

/* ==================== 无台词镜 ==================== */

test("无台词镜：超限分档", () => {
  const over = checkStoryboardTable(
    makeTable({ rows: [shotRow(1, 8, ""), shotRow(2, 3, ""), shotRow(3, 2, "")] }),
    { assets: ASSETS },
  );
  assert.ok(over.issues.some((item) => item.category === "无台词镜时长" && item.severity === "阻塞"));

  const edge = checkStoryboardTable(
    makeTable({ rows: [shotRow(1, 6.5, ""), shotRow(2, 3, ""), shotRow(3, 3, "")] }),
    { assets: ASSETS },
  );
  assert.ok(edge.issues.some((item) => item.category === "无台词镜时长" && item.severity === "骑线"));

  const fine = checkStoryboardTable(
    makeTable({ rows: [shotRow(1, 5, "林晚：『走吧。』"), shotRow(2, 4, ""), shotRow(3, 4, "")] }),
    { assets: ASSETS },
  );
  assert.equal(fine.issues.filter((item) => item.category === "无台词镜时长").length, 0);
});

/* ==================== 禁词 ==================== */

test("禁词扫描：命中阻塞；台词行不扫；白名单防误报", () => {
  const hit = checkStoryboardTable(
    makeTable({
      rows: [
        shotRow(1, 4, "", { description: "刀身在灯管下反着一点冷光，林晚的手停住" }),
        shotRow(2, 4, ""),
        shotRow(3, 4, ""),
      ],
    }),
    { assets: ASSETS },
  );
  const lightIssue = hit.issues.find((item) => item.category === "禁光影色调" && item.severity === "阻塞");
  assert.ok(lightIssue, "冷光应判阻塞");
  assert.equal(lightIssue?.autoFixable, true);

  const inDialogue = checkStoryboardTable(
    makeTable({
      rows: [shotRow(1, 4, "林晚：『你站在冷光里干什么？』"), shotRow(2, 4, ""), shotRow(3, 4, "")],
    }),
    { assets: ASSETS },
  );
  assert.equal(
    inDialogue.issues.filter((item) => item.category === "禁光影色调" && item.severity === "阻塞").length,
    0,
    "台词是剧本原文，不做禁词扫描",
  );

  const allowWord = checkStoryboardTable(
    makeTable({
      rows: [
        shotRow(1, 4, "", { description: "林晚的目光落向门口，倒影在水面轻轻晃动" }),
        shotRow(2, 4, ""),
        shotRow(3, 4, ""),
      ],
    }),
    { assets: ASSETS },
  );
  assert.equal(
    allowWord.issues.filter((item) => item.category === "禁光影色调" && item.severity === "阻塞").length,
    0,
    "目光/倒影不应被误报为光影禁词",
  );
});

test("音效禁配乐：命中阻塞", () => {
  const report = checkStoryboardTable(
    makeTable({
      rows: [
        shotRow(1, 4, "", { sound: "音效：低沉大提琴铺底 + 风声" }),
        shotRow(2, 4, ""),
        shotRow(3, 4, ""),
      ],
    }),
    { assets: ASSETS },
  );
  // "弦乐铺底"在配置表中；此处验证配置词表内的通用命中
  const report2 = checkStoryboardTable(
    makeTable({
      rows: [
        shotRow(1, 4, "", { sound: "音效：背景音乐渐起 + 风声" }),
        shotRow(2, 4, ""),
        shotRow(3, 4, ""),
      ],
    }),
    { assets: ASSETS },
  );
  assert.ok(report2.issues.some((item) => item.category === "音效禁配乐" && item.severity === "阻塞"));
  assert.equal(report.issues.filter((item) => item.category === "音效禁配乐" && item.severity === "阻塞").length, 0);
});

/* ==================== 资产引用 ==================== */

test("资产引用：无效 ID / 缺场景资产 / 数量不一致", () => {
  const invalid = checkStoryboardTable(
    makeTable({
      rows: [shotRow(1, 4, "林晚：『你说什么？』"), shotRow(2, 4, ""), shotRow(3, 4, "")],
      assetNames: ["林晚", "客厅", "幽灵道具"],
      assetIds: [1, 2, 999],
    }),
    { assets: ASSETS },
  );
  assert.ok(invalid.issues.some((item) => item.category === "资产引用" && item.problem.includes("999")));

  const noScene = checkStoryboardTable(
    makeTable({
      rows: [shotRow(1, 4, "林晚：『你说什么？』"), shotRow(2, 4, ""), shotRow(3, 4, "")],
      assetNames: ["林晚"],
      assetIds: [1],
    }),
    { assets: ASSETS },
  );
  assert.ok(noScene.issues.some((item) => item.category === "资产引用" && item.problem.includes("scene")));

  const countMismatch = checkStoryboardTable(
    makeTable({
      rows: [shotRow(1, 4, "林晚：『你说什么？』"), shotRow(2, 4, ""), shotRow(3, 4, "")],
      assetNames: ["林晚", "客厅"],
      assetIds: [1],
    }),
    { assets: ASSETS },
  );
  assert.ok(countMismatch.issues.some((item) => item.problem.includes("数量不一致")));

  const nameMismatch = checkStoryboardTable(
    makeTable({
      rows: [shotRow(1, 4, "林晚：『你说什么？』"), shotRow(2, 4, ""), shotRow(3, 4, "")],
      assetNames: ["林晚", "旧菜刀"],
      assetIds: [1, 9],
    }),
    { assets: ASSETS },
  );
  // 名称「旧菜刀」是资产「旧菜刀与案板」的子串 → 视为模糊一致，不报
  assert.equal(nameMismatch.issues.filter((item) => item.category === "资产引用" && item.severity === "提示").length, 0);
});

test("镜表列数异常与时长不可解析", () => {
  const brokenRow = "| 1 | 林晚站在客厅中央攥住衣角喉咙滚动 | 无 | 近景 | 固定 | 林晚：『你说什么？』 | 音效：风声 |";
  const report = checkStoryboardTable(
    makeTable({
      rows: [brokenRow, shotRow(2, 4, ""), shotRow(3, 4, "")],
    }),
    { assets: ASSETS },
  );
  assert.ok(report.issues.some((item) => item.category === "镜表格式" && item.severity === "阻塞"));
});

/* ==================== 报告输出 ==================== */

test("报告与修复清单输出", () => {
  const report = checkStoryboardTable(
    makeTable({
      rows: [
        shotRow(1, 3, "许曼青（听筒）：『嗯，可能也就十来天吧。照野，我也是为了咱们以后。咱总不能一直在夜市摆摊吧？』"),
        shotRow(2, 4, ""),
        shotRow(3, 3, ""),
      ],
    }),
    { assets: ASSETS },
  );
  assert.ok(report.blockingCount > 0);
  const checklist = buildBlockingRepairChecklist(report);
  assert.ok(checklist.includes("场1·片段一·镜1"));
  assert.ok(checklist.includes("目标"));

  const markdown = storyboardReportToMarkdown(report);
  assert.ok(markdown.includes("分镜表确定性检查结果"));
  assert.ok(markdown.includes("原样引用"));
});

/* ==================== 规范提示级校验（守则4/8/13/14/15；不参与阻塞判定）==================== */

test("提示级：单镜台词超容量只出提示，不进阻塞", () => {
  const line =
    "照野，你听我说，摊子收完咱们就去找他们，把话说清楚，别再拖了，今天必须有个结果，不能再这样下去，我一个人撑不住了。";
  const report = checkStoryboardTable(makeTable({ rows: [shotRow(1, 12, `许曼青：『${line}』`)] }), {
    assets: ASSETS,
  });
  const capacity = report.issues.find((item) => item.category === "台词容量");
  assert.ok(capacity, "超过 46 字应给台词容量提示");
  assert.equal(capacity?.severity, "提示");
  assert.ok((capacity?.problem ?? "").includes("容量上限"));
  assert.equal(report.blockingCount, 0);
});

test("提示级：模糊指代 / 元语言 / 后期操作词均只出提示", () => {
  const report = checkStoryboardTable(
    makeTable({
      rows: [
        shotRow(1, 4, "", {
          description: "殿内众人攒动，一道黑影从梁上落下，无血迹，画面按动作镜处理",
          sound: "音效：木梁吱呀声、衣料摩擦声",
        }),
        shotRow(2, 4, "", {
          description: "老者在案前落座，手指按住卷宗纸页，目光停在落款上",
          camera: "慢放推近",
          sound: "音效：纸页翻动声",
        }),
        shotRow(3, 4, "", {
          description: "门外雨线连成一片，水洼被雨点打散，檐下灯笼摇晃",
          sound: "音效：雨声、屋檐滴水声",
        }),
      ],
    }),
    { assets: ASSETS },
  );

  const vague = report.issues.find((item) => item.category === "模糊指代");
  assert.ok(vague, "「众人攒动 / 一道黑影」应命中模糊指代");
  assert.equal(vague?.severity, "提示");
  assert.ok((vague?.current ?? "").includes("众人攒动"));

  const meta = report.issues.find((item) => item.category === "元语言入画面");
  assert.ok(meta, "「无血迹 / 按动作镜」应命中元语言");
  assert.equal(meta?.severity, "提示");
  assert.ok((meta?.current ?? "").includes("无血迹"));

  const post = report.issues.find((item) => item.category === "后期操作入画面");
  assert.ok(post, "运镜列「慢放」应命中后期操作词");
  assert.equal(post?.severity, "提示");

  assert.equal(report.blockingCount, 0);
});

test("片段预算分级：超预算骑线、超阻塞线阻塞", () => {
  const build = (count: number) => {
    const numerals = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二", "十三"];
    const segments = numerals.slice(0, count).map((numeral) =>
      [
        `### 片段${numeral}（约12s）`,
        "**引用资产名称**：[林晚, 客厅]",
        "**引用资产ID**：[1, 2]",
        ...TABLE_HEADER,
        shotRow(1, 6, "林晚：『你说什么？』"),
        shotRow(2, 6, ""),
      ].join("\n"),
    );
    return ["## 场1：客厅·日 ｜ 参演角色：林晚", "", ...segments].join("\n");
  };

  // 9 段：超 8 段预算但未到 10 段阻塞线 → 骑线
  const borderline = checkStoryboardTable(build(9), { assets: ASSETS });
  const borderlineIssue = borderline.issues.find((item) => item.category === "片段预算");
  assert.equal(borderlineIssue?.severity, "骑线");
  assert.equal(borderline.blockingCount, 0);

  // 11 段：超 10 段阻塞线 → 阻塞（抑制靠加片段塞时长）
  const blocking = checkStoryboardTable(build(11), { assets: ASSETS });
  const blockingIssue = blocking.issues.find((item) => item.category === "片段预算");
  assert.equal(blockingIssue?.severity, "阻塞");
  assert.ok(blocking.blockingCount >= 1);
});

/* ==================== 单集容量 / 台词覆盖度（事实层） ==================== */

const SEGMENT_NUMERALS = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二", "十三", "十四"];

/** 构造多片段的真实分镜表（每片段各自落档） */
function tableOf(segments: Array<Array<{ seconds: number; dialogue?: string }>>): string {
  const blocks = segments.map((shots, index) => {
    const total = shots.reduce((sum, shot) => sum + shot.seconds, 0);
    return [
      `### 片段${SEGMENT_NUMERALS[index] ?? index + 1}（约${total}s）`,
      "**引用资产名称**：[林晚, 客厅]",
      "**引用资产ID**：[1, 2]",
      ...TABLE_HEADER,
      ...shots.map((shot, shotIndex) => shotRow(shotIndex + 1, shot.seconds, shot.dialogue ?? "")),
    ].join("\n");
  });
  return ["## 场1：客厅·日 ｜ 参演角色：林晚", "", ...blocks].join("\n");
}

test("单集合计：超严重线阻塞、超上限骑线、豁免后按新预算判定", () => {
  // 13 段 × 16s = 208s，超严重线 157s（同时超片段预算 10 段）
  const overloaded = tableOf(Array.from({ length: 13 }, () => [{ seconds: 8, dialogue: "林晚：『你说什么？』" }, { seconds: 8 }]));
  const overloadedReport = checkStoryboardTable(overloaded, { assets: ASSETS });
  assert.equal(overloadedReport.episodeSeconds, 208);
  const episodeIssue = overloadedReport.issues.find((item) => item.category === "单集合计时长");
  assert.equal(episodeIssue?.severity, "阻塞");
  assert.match(episodeIssue?.problem ?? "", /超出单集上限 130s 共 78s/);
  const budgetIssue = overloadedReport.issues.find((item) => item.category === "片段预算");
  assert.equal(budgetIssue?.severity, "阻塞");

  // 8 段 × 16s = 128s：预算内，无单集问题
  const withinBudget = tableOf(Array.from({ length: 8 }, () => [{ seconds: 8, dialogue: "林晚：『你说什么？』" }, { seconds: 8 }]));
  const withinReport = checkStoryboardTable(withinBudget, { assets: ASSETS });
  assert.equal(withinReport.episodeSeconds, 128);
  assert.equal(withinReport.issues.find((item) => item.category === "单集合计时长"), undefined);

  // 9 段 × 16s = 144s：超上限但未到严重线 → 骑线
  const overLimit = tableOf(Array.from({ length: 9 }, () => [
    { seconds: 8, dialogue: "林晚：『你说什么？』" },
    { seconds: 8 },
  ]));
  const overLimitReport = checkStoryboardTable(overLimit, { assets: ASSETS });
  assert.equal(overLimitReport.episodeSeconds, 144);
  const overIssue = overLimitReport.issues.find((item) => item.category === "单集合计时长");
  assert.equal(overIssue?.severity, "骑线");
  assert.equal(overLimitReport.effectiveMaxSeconds, 130);

  const waivedReport = checkStoryboardTable(overLimit, {
    assets: ASSETS,
    waivers: [{ scope: "duration", allowanceSeconds: 20, reason: "维持现状不再拆集", grantedBy: "user" }],
  });
  assert.equal(waivedReport.effectiveMaxSeconds, 150);
  assert.equal(waivedReport.issues.find((item) => item.category === "单集合计时长"), undefined);
  const markdown = storyboardReportToMarkdown(waivedReport);
  assert.match(markdown, /已登记豁免/);
  assert.match(markdown, /维持现状不再拆集/);
});

test("容量缺口：台词净时长下限超预算判阻塞并给出需删字数", () => {
  const config = {
    ...STORYBOARD_CHECK_CONFIG,
    episodeTarget: { ...STORYBOARD_CHECK_CONFIG.episodeTarget, minSeconds: 10, maxSeconds: 20 },
  };
  const line = "这是一句相当长的台词内容需要拆成多镜承载而且还要再长一些";
  const table = tableOf([
    [
      { seconds: 8, dialogue: `林晚：『${line}』` },
      { seconds: 8, dialogue: `陆明：『${line}』` },
      { seconds: 8, dialogue: `林晚：『${line}』` },
      { seconds: 8, dialogue: `陆明：『${line}』` },
    ],
  ]);
  const report = checkStoryboardTable(table, { assets: ASSETS, config });
  const gap = report.issues.find((item) => item.category === "容量缺口");
  assert.equal(gap?.severity, "阻塞");
  assert.match(gap?.problem ?? "", /台词净时长下限/);
  assert.match(gap?.problem ?? "", /回剧本删减约/);
  assert.ok((report.dialogueFloorSeconds ?? 0) > 20);
});

test("台词覆盖度：逐字一致 / 拆镜 / 疑似改写 / 缺失 / 额外 五分类", () => {
  const script = [
    "# 测试剧 EP01：对白覆盖",
    "# 原著范围：第1章",
    "",
    "---",
    "",
    "1-1 客厅 日/内",
    "",
    "【信息差类型：观众先知型——场记注释不得计入台词】",
    "",
    "人物：林晚 陆明",
    "",
    "△林晚站在客厅中央，攥住衣角。",
    "",
    "林晚：你说什么？",
    "陆明：我没有别的意思，你先坐下。",
    "林晚：不必了，我不想听。",
    "林晚（目光落到窗外）：你到底想说什么？",
  ].join("\n");

  const table = tableOf([
    [
      { seconds: 8, dialogue: "林晚：『你说什么？』" },
      { seconds: 8, dialogue: "陆明：『我没有别的意思，』" },
    ],
    [
      { seconds: 8, dialogue: "陆明：『你先坐下。』" },
      { seconds: 8, dialogue: "林晚：『不必了，我不想听了。』" },
    ],
    [
      { seconds: 8, dialogue: "VO：三笔转账 · 合计 ¥37,000.00" },
      { seconds: 4 },
    ],
  ]);

  const report = checkStoryboardTable(table, { assets: ASSETS, script: { name: "测试剧 EP01", content: script } });
  const coverage = report.dialogueCoverage;
  assert.ok(coverage);
  assert.equal(coverage?.scriptLines, 4);
  assert.equal(coverage?.verbatim, 1);
  assert.equal(coverage?.split, 1, "同句跨镜承载应判拆分（合规）");
  assert.equal(coverage?.rewritten.length, 1);
  assert.equal(coverage?.missing.length, 1);
  assert.equal(coverage?.extra.length, 1);

  assert.ok(report.issues.some((item) => item.category === "台词覆盖度" && item.severity === "阻塞"));
  assert.ok(report.issues.some((item) => item.category === "台词覆盖度" && item.severity === "骑线"));
  assert.ok(report.issues.some((item) => item.category === "台词覆盖度" && item.severity === "提示"));

  const markdown = storyboardReportToMarkdown(report);
  assert.match(markdown, /单集容量事实层/);
  assert.match(markdown, /台词覆盖度事实层/);
  assert.match(markdown, /逐字一致 1、拆镜承载 1、疑似改写 1、缺失 1、分镜额外 1/);
});

test("接缝：自定义 config 可覆盖档位，默认行为不变", () => {
  const markdown = makeTable({ rows: [shotRow(1, 5, ""), shotRow(2, 5, "")], declared: 10 });
  const defaultReport = checkStoryboardTable(markdown, { assets: ASSETS });
  assert.ok(
    defaultReport.issues.some((item) => item.category === "片段时长档位" && item.severity === "阻塞"),
    "默认档位下 10 秒应判阻塞",
  );

  const customReport = checkStoryboardTable(markdown, {
    assets: ASSETS,
    config: { ...STORYBOARD_CHECK_CONFIG, tiers: [{ min: 9, max: 11, label: "10 秒档" }] },
  });
  assert.equal(customReport.issues.filter((item) => item.category === "片段时长档位").length, 0);
});

/* ==================== 骑线占比与拆集建议 ==================== */

test("骑线占比与拆集建议：字时比整体偏紧时给出提示级建议，不阻塞", () => {
  const segmentLabels = ["一", "二", "三", "四", "五", "六", "七", "八", "九"];
  const segments = segmentLabels.map((label, segmentIndex) => {
    const rows = Array.from({ length: 4 }, (_, shotIndex) => {
      const serial = segmentIndex * 4 + shotIndex + 1;
      return shotRow(serial, 4, `林晚：『这是第${serial}句测试台词，内容不长。』`);
    });
    return [
      `### 片段${label}（约16s）`,
      "**引用资产名称**：[林晚, 客厅]",
      "**引用资产ID**：[1, 2]",
      ...TABLE_HEADER,
      ...rows,
    ].join("\n");
  });
  const markdown = ["## 场1：客厅·日 ｜ 参演角色：林晚", "", segments.join("\n\n")].join("\n");
  const report = checkStoryboardTable(markdown, { assets: ASSETS });

  assert.equal(report.dialogueShots, 36);
  assert.equal(report.dialogueShotsTight, 36, "4 秒配 13 字台词应全部低于安全线");
  assert.equal(report.rideLineRatio, 1);
  assert.ok(report.splitSuggestion, "实测 144s 超预算且字时比偏紧，应给出拆集建议");
  assert.ok((report.splitSuggestion?.count ?? 0) >= 2);

  const advisory = report.issues.filter((item) => item.category === "拆集建议");
  assert.ok(advisory.length > 0, "应产出拆集建议条目");
  assert.ok(
    advisory.every((item) => item.severity === "提示"),
    "拆集建议为提示级，不得阻塞",
  );

  const markdownReport = storyboardReportToMarkdown(report);
  assert.match(markdownReport, /骑线占比/);
  assert.match(markdownReport, /拆集建议（提示级）/);
});

test("素材不足的单集不给拆集建议", () => {
  const markdown = makeTable({
    rows: [shotRow(1, 4, "林晚：『你说什么？』"), shotRow(2, 4, ""), shotRow(3, 4, "")],
    declared: 12,
  });
  const report = checkStoryboardTable(markdown, { assets: ASSETS });
  assert.equal(report.splitSuggestion, undefined);
});
