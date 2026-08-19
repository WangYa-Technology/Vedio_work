import assert from "node:assert/strict";
import test from "node:test";
import { selectNarrativeContext } from "./videoTaskData";

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
