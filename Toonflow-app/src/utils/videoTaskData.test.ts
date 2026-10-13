import assert from "node:assert/strict";
import test from "node:test";
import {
  extractSpeakerNames,
  groupStoryboardRowsBySegments,
  mapSegmentRowsToDuration,
  parseStoryboardTable,
  resolveTierDuration,
  selectNarrativeContext,
} from "./videoTaskData";

test("selects the source chapter that overlaps the current episode", () => {
  const context = selectNarrativeContext(
    "王胜突然失去降落伞，从高空坠向湖面。",
    [
      {
        id: 1,
        chapterIndex: 1,
        chapter: "初来贵地",
        chapterData:
          "独狼是王胜的代号。王胜刚刚还在夜间突降，降落伞突然消失，身体开始自由落体。",
      },
      {
        id: 2,
        chapterIndex: 2,
        chapter: "城中风波",
        chapterData: "陌生商队进入城门，街上人声嘈杂。",
      },
    ],
  );

  assert.equal(context.sourceChapters.length, 1);
  assert.equal(context.sourceChapters[0].id, 1);
  assert.match(context.sourceChapters[0].content, /夜间突降/);
});

test("parses explicit scene space and expanded shot scale fields", () => {
  const segments = parseStoryboardTable(`
## 场1：宋家禁地上空 ｜ 参演角色：王胜
**空间信息**：地点：宋家禁地；时段：夜；内外：外景；空间层级：高空→湖面
### 片段一（约5s）
| 序号 | 画面描述 | 时长 | 景别 | 景别说明 | 摄影角度 | 运镜 | 台词 | 音效 |
|---|---|---|---|---|---|---|---|---|
| 1 | 王胜向湖面下坠。 | 5 | 大全景 | 人物占画面不到一成，完整交代高空到湖面的坠落路线。 | 极高俯拍 | 缓降 |  | 音效：风声 |
`);

  assert.equal(segments.length, 1);
  assert.equal(segments[0].location, "宋家禁地");
  assert.equal(segments[0].dayPart, "夜");
  assert.equal(segments[0].interiorExterior, "外景");
  assert.equal(segments[0].spatialLayers, "高空→湖面");
  assert.equal(segments[0].rows[0].scale, "大全景");
  assert.match(segments[0].rows[0].scaleDescription, /不到一成/);
  assert.equal(segments[0].rows[0].cameraAngle, "极高俯拍");
  assert.equal(segments[0].rows[0].cameraMovement, "缓降");
});

test("enriches legacy storyboard rows from script scene headings", () => {
  const segments = parseStoryboardTable(
    `
## 场1：高空坠落 ｜ 参演角色：王胜
### 片段一（约3s）
| 序号 | 画面描述 | 时长 | 景别 | 运镜 | 台词 | 音效 |
|---|---|---|---|---|---|---|
| 1 | 王胜向湖面下坠。 | 3 | 远景 | 俯拍缓降 |  | 音效：风声 |
`,
    "1-1 高空坠落 夜/外\n人物：王胜",
  );

  assert.equal(segments[0].location, "高空坠落");
  assert.equal(segments[0].dayPart, "夜");
  assert.equal(segments[0].interiorExterior, "外景");
  assert.equal(segments[0].rows[0].cameraAngle, "俯拍");
  assert.equal(segments[0].rows[0].cameraMovement, "缓降");
  assert.match(segments[0].rows[0].scaleDescription, /落点/);
});

test("groups one formal storyboard row per shot into one task per segment", () => {
  const segments = parseStoryboardTable(`
## 场1：湖岸 ｜ 参演角色：王胜、宋嫣
### 片段一（约5s）
| 序号 | 画面描述 | 时长 | 景别 | 运镜 | 台词 | 音效 |
|---|---|---|---|---|---|---|
| 1 | 王胜浮出水面。 | 2 | 中景 | 固定 | 王胜：这是哪里？ | 水声 |
| 2 | 宋嫣举起玉令。 | 3 | 近景 | 缓推 | 宋嫣：别碰他！ | 玉令震鸣 |
### 片段二（约2s）
| 序号 | 画面描述 | 时长 | 景别 | 运镜 | 台词 | 音效 |
|---|---|---|---|---|---|---|
| 1 | 戴欢停下手。 | 2 | 中景 | 固定 | 无台词 | 风声 |
`);
  const groups = groupStoryboardRowsBySegments(
    [
      { id: 1, videoDesc: "场1：湖岸｜片段一｜序号1" },
      { id: 2, videoDesc: "场1：湖岸｜片段一｜序号2" },
      { id: 3, videoDesc: "场1：湖岸｜片段二｜序号1" },
    ],
    segments,
  );

  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((group) => group.storyboards.map((row) => row.id)), [
    [1, 2],
    [3],
  ]);
});

test("matches restored storyboard rows whose scene header includes participants", () => {
  const segments = parseStoryboardTable(`
## 场1：湖岸 ｜ 参演角色：王胜、宋嫣
### 片段一（约5s）
| 序号 | 画面描述 | 时长 | 景别 | 运镜 | 台词 | 音效 |
|---|---|---|---|---|---|---|
| 1 | 王胜浮出水面。 | 5 | 中景 | 固定 |  | 水声 |
`);

  const groups = groupStoryboardRowsBySegments(
    [{ id: 1, videoDesc: "场1：湖岸 ｜ 参演角色：王胜、宋嫣｜片段一｜序号\n| 1 | 王胜浮出水面。 | 5 | 中景 | 固定 |  | 水声 |" }],
    segments,
  );

  assert.equal(groups.length, 1);
  assert.equal(groups[0].segment?.segmentTitle, "片段一");
  assert.equal(groups[0].storyboards[0].id, 1);
});

test("binds legacy storyboard rows by persisted order when videoDesc markers are absent", () => {
  const segments = parseStoryboardTable(`
## 场1：空天战舰外缘·押解处决 ｜ 参演角色：王胜
### 片段一（约3s）
| 序号 | 画面描述 | 时长 | 景别 | 运镜 | 台词 | 音效 |
|---|---|---|---|---|---|---|
| 1 | 王胜被固定在舱门外侧。 | 3 | 近景 | 固定 |  | 风声 |
### 片段二（约2s）
| 序号 | 画面描述 | 时长 | 景别 | 运镜 | 台词 | 音效 |
|---|---|---|---|---|---|---|
| 1 | 伞绳被切断。 | 2 | 特写 | 跟随 |  | 金属声 |
`);

  const groups = groupStoryboardRowsBySegments(
    [
      { id: 10, index: 0, videoDesc: "场1：空天战舰外缘·押解处决。画面描述：王胜被固定。" },
      { id: 11, index: 1, videoDesc: "场1：空天战舰外缘·押解处决。画面描述：伞绳被切断。" },
    ],
    segments,
  );

  assert.deepEqual(groups.map((group) => group.storyboards.map((row) => row.id)), [[10], [11]]);
  assert.deepEqual(groups.map((group) => group.segment?.segmentTitle), ["片段一", "片段二"]);
});

const H3_DURATIONS = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

function round1(value: number) {
  return Math.round(value * 10) / 10;
}

test("maps the 12s tier to a 10s target and scales shots proportionally", () => {
  const rows = [{ duration: 3 }, { duration: 4 }, { duration: 5 }]; // 合计 12
  const result = mapSegmentRowsToDuration(rows, 12, H3_DURATIONS, 15);

  assert.equal(result.mapping, "tier");
  assert.equal(result.duration, 10);
  assert.equal(round1(Number(result.rows[0].duration)), 2.5);
  assert.equal(
    round1(result.rows.reduce((sum, row) => sum + Number(row.duration), 0)),
    10,
  );
});

test("maps the 17s tier to a 15s target", () => {
  const rows = [{ duration: 5 }, { duration: 6 }, { duration: 6 }]; // 合计 17
  const result = mapSegmentRowsToDuration(rows, 17, H3_DURATIONS, 15);

  assert.equal(result.mapping, "tier");
  assert.equal(result.duration, 15);
  assert.equal(
    round1(result.rows.reduce((sum, row) => sum + Number(row.duration), 0)),
    15,
  );
});

test("keeps out-of-tier segments untouched", () => {
  const rows = [{ duration: 7 }, { duration: 7 }]; // 合计 14，不属于任何档位
  const result = mapSegmentRowsToDuration(rows, 14, H3_DURATIONS, 15);

  assert.equal(result.mapping, null);
  assert.equal(result.duration, 14);
  assert.deepEqual(result.rows.map((row) => row.duration), [7, 7]);
});

test("skips tier mapping when the model does not support the target duration", () => {
  const rows = [{ duration: 6 }, { duration: 6 }]; // 12 秒档，但模型只有 15 秒档
  const result = mapSegmentRowsToDuration(rows, 12, [15], 15);

  assert.equal(result.mapping, null);
  assert.equal(result.duration, 12);
  assert.deepEqual(result.rows.map((row) => row.duration), [6, 6]);
});

test("falls back to overflow compression above the model limit", () => {
  const rows = [{ duration: 10 }, { duration: 10 }]; // 合计 20，超过模型上限
  const result = mapSegmentRowsToDuration(rows, 20, H3_DURATIONS, 15);

  assert.equal(result.mapping, "overflow");
  assert.equal(result.duration, 15);
  assert.equal(
    round1(result.rows.reduce((sum, row) => sum + Number(row.duration), 0)),
    15,
  );
});

test("keeps the scaled total exactly on target after rounding", () => {
  const rows = Array.from({ length: 8 }, () => ({ duration: 1.5 })); // 合计 12
  const result = mapSegmentRowsToDuration(rows, 12, H3_DURATIONS, 15);

  assert.equal(result.mapping, "tier");
  assert.equal(
    round1(result.rows.reduce((sum, row) => sum + Number(row.duration), 0)),
    10,
  );
});

test("resolves tier targets only for supported durations", () => {
  assert.equal(resolveTierDuration(11, H3_DURATIONS, 15), 10);
  assert.equal(resolveTierDuration(13, [10], 15), 10);
  assert.equal(resolveTierDuration(16, H3_DURATIONS, 15), 15);
  assert.equal(resolveTierDuration(18, [15], 15), 15);
  assert.equal(resolveTierDuration(14, H3_DURATIONS, 15), null);
  assert.equal(resolveTierDuration(19, H3_DURATIONS, 15), null);
  // 模型未声明档位时按上限保守判断
  assert.equal(resolveTierDuration(12, [], 15), 10);
  assert.equal(resolveTierDuration(12, [], 8), null);
});

test("strips narrative verbs from extracted speaker names", () => {
  assert.deepEqual(extractSpeakerNames("老王问：『这酒多少钱？』"), ["老王"]);
  assert.deepEqual(extractSpeakerNames("陈照野答：知道了"), ["陈照野"]);
  assert.deepEqual(extractSpeakerNames("销售说：二位看的是婚房吧？"), ["销售"]);
  assert.deepEqual(extractSpeakerNames("许曼青（OS）：我先进去"), ["许曼青"]);
  assert.deepEqual(extractSpeakerNames("OS（陈照野，平静）：别出声"), ["陈照野"]);
  // 单字名字不被误剥
  assert.deepEqual(extractSpeakerNames("阿道：走"), ["阿道"]);
  assert.deepEqual(extractSpeakerNames("无台词"), []);
});

test("skips in-frame text labels when collecting speaker names", () => {
  // 画内文字不是说话人：否则自动补全会拿"摊车灯牌文字"这类来源标签去匹配角色资产。
  assert.deepEqual(extractSpeakerNames("VO（摊车灯牌文字）：『照野炸串』"), []);
  assert.deepEqual(extractSpeakerNames("VO（手机来电显示）：『许曼青』"), []);
  assert.deepEqual(extractSpeakerNames("屏幕文字：营业中"), []);
  assert.deepEqual(
    extractSpeakerNames("陈照野说：『马上！』<br>VO（摊车灯牌文字）：『照野炸串』"),
    ["陈照野"],
  );
});
