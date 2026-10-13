import assert from "node:assert/strict";
import test from "node:test";
import { parseStoryboardTable } from "./storyboardChecks";
import {
  buildRepairScopesFromHistory,
  buildStoryboardSupervisionInjection,
  buildSupervisionVerdict,
  computeConvergence,
  consumeSupervisionStream,
  createSupervisionStreamState,
  extendRepairScopes,
  flushSupervisionStream,
  parseStoryboardSupervisionMeta,
  stripSupervisionMeta,
  type SupervisionRoundRecord,
} from "./supervisionLog";

const SAMPLE_TABLE = [
  "## 场1：客厅·日 ｜ 参演角色：林晚",
  "",
  "### 片段一（约12s）",
  "**引用资产名称**：[林晚, 客厅]",
  "**引用资产ID**：[1, 2]",
  "| 序号 | 画面描述 | 时长 | 景别 | 运镜 | 台词 | 音效 |",
  "|------|------|------|------|------|------|------|",
  "| 1 | 林晚站在窗边攥住衣角看着门外 | 6 | 近景 | 固定 | 林晚：『你说什么？』 | 音效：风声 |",
  "| 2 | 林晚转身走向门口脚步放轻 | 6 | 中景 | 缓推 |  | 音效：脚步声 |",
  "",
  "## 场4：走廊·夜 ｜ 参演角色：林晚",
  "",
  "### 片段一（约12s）",
  "**引用资产名称**：[林晚, 客厅]",
  "**引用资产ID**：[1, 2]",
  "| 序号 | 画面描述 | 时长 | 景别 | 运镜 | 台词 | 音效 |",
  "|------|------|------|------|------|------|------|",
  "| 1 | 走廊里空无一人林晚贴着墙根向前 | 6 | 近景 | 固定 |  | 音效：风声 |",
  "| 2 | 林晚推开消防门门轴发出一声轻响 | 6 | 中景 | 固定 |  | 音效：门轴声 |",
].join("\n");

function makeRecord(overrides: Partial<SupervisionRoundRecord> = {}): SupervisionRoundRecord {
  return {
    at: 1,
    scope: "分镜表",
    rating: "C",
    blockingCount: 1,
    mediumCount: 2,
    lightCount: 0,
    newBlockingCount: 0,
    closedCount: 0,
    passed: false,
    issues: [
      {
        id: "1",
        severity: "严重",
        category: "台词镜时长",
        location: "场4·片段二·镜5",
        problem: "35 字台词仅 3 秒",
        suggestion: "按语义拆镜",
        source: "真实新缺陷",
      },
    ],
    ...overrides,
  };
}

test("流式拦截：meta 块不进入可见输出，且支持跨 chunk 拆分", () => {
  const state = createSupervisionStreamState();
  const chunks = ["# 审核报告\n\n总评：C", "\n\n<supervis", "ionMeta>{\"blockingCount\":0}</supervision", "Meta>"];
  const visible = chunks.map((chunk) => consumeSupervisionStream(chunk, state)).join("") + flushSupervisionStream(state);
  assert.ok(visible.includes("审核报告"));
  assert.ok(!visible.includes("supervisionMeta"));
  assert.equal(state.metaText, "<supervisionMeta>{\"blockingCount\":0}</supervisionMeta>");
});

test("meta 解析：合法 JSON、字段容错与非法内容", () => {
  const text = "# 报告\n\n<supervisionMeta>```json\n{\"scope\":\"分镜表\",\"rating\":\"B\",\"blockingCount\":0,\"mediumCount\":1,\"issues\":[{\"id\":\"1\",\"item\":\"台词镜时长\",\"location\":\"场4·片段二·镜5\",\"problem\":\"p\",\"suggestion\":\"s\"}]}\n```</supervisionMeta>";
  const record = parseStoryboardSupervisionMeta(text);
  assert.ok(record);
  assert.equal(record?.rating, "B");
  assert.equal(record?.passed, true);
  assert.equal(record?.issues[0].category, "台词镜时长");
  assert.equal(record?.issues[0].location, "场4·片段二·镜5");

  assert.equal(parseStoryboardSupervisionMeta("没有 meta 的文本"), undefined);
  assert.equal(parseStoryboardSupervisionMeta("<supervisionMeta>不是JSON</supervisionMeta>"), undefined);
  assert.equal(stripSupervisionMeta(text).includes("supervisionMeta"), false);
});

test("注入构建：包含检查结论、上轮清单与判定要求", () => {
  const history = [makeRecord(), makeRecord({ blockingCount: 0, newBlockingCount: 0, passed: true, issues: [] })];
  const injection = buildStoryboardSupervisionInjection("## 确定性检查结果\n- 阻塞 0 项", history);
  assert.ok(injection.includes("确定性检查结果"));
  assert.ok(injection.includes("上一轮审核清单"));
  assert.ok(injection.includes("严重问题 = 0 即通过"));
  assert.ok(injection.includes("连续无新增严重问题轮数：1"));
  assert.deepEqual(computeConvergence(history), { cleanRounds: 1 });
});

test("修复范围推导：location 场号映射到场序号", () => {
  const parsed = parseStoryboardTable(SAMPLE_TABLE);
  assert.equal(parsed.scenes.length, 2);

  const scopes = buildRepairScopesFromHistory([makeRecord()], parsed);
  assert.deepEqual(scopes, [{ sceneOrder: 2 }], "场4 对应文档第 2 个场块");

  assert.equal(buildRepairScopesFromHistory([], parsed), null);
  assert.equal(
    buildRepairScopesFromHistory([makeRecord({ issues: [] })], parsed),
    null,
    "无问题时不做守卫",
  );

  const extended = extendRepairScopes([{ sceneOrder: 2 }], parsed, [1, 4]);
  assert.deepEqual(extended, [{ sceneOrder: 1 }, { sceneOrder: 2 }]);
});

test("宿主判定：0 严重放行、有严重未通过", () => {
  assert.ok(buildSupervisionVerdict(undefined, 0).includes("机器校验 0 阻塞"));
  const verdictPass = buildSupervisionVerdict(makeRecord({ blockingCount: 0, passed: true, issues: [] }), 0);
  assert.ok(verdictPass.includes("审核通过"));
  const verdictFail = buildSupervisionVerdict(makeRecord(), 0);
  assert.ok(verdictFail.includes("未通过"));
  const verdictMachine = buildSupervisionVerdict(makeRecord({ blockingCount: 0, passed: true, issues: [] }), 2);
  assert.ok(verdictMachine.includes("仍有 2 项"));
});
