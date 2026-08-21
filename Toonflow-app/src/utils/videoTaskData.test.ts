import assert from "node:assert/strict";
import test from "node:test";
import {
  groupStoryboardRowsBySegments,
  parseStoryboardTable,
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
