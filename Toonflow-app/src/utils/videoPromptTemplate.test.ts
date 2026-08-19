import assert from "node:assert/strict";
import test from "node:test";
import {
  buildVideoModelPromptProtocol,
  resolveVideoPromptInstructions,
} from "./videoPromptTemplate";

test("official default video template includes the high-conflict core", () => {
  const prompt = resolveVideoPromptInstructions(
    { id: 3, name: "高冲突默认推理", data: "", useData: "" },
    {
      modelName: "minimax-h3-reference-to-video",
      mode: ["imageReference:9", "textReference"],
      referenceToken: "@图",
      videoRatio: "16:9",
    },
  );

  assert.match(prompt, /高冲突核心/);
  assert.match(prompt, /强落差钩子/);
  assert.match(prompt, /冲突爆发/);
  assert.match(prompt, /压力升级/);
  assert.match(prompt, /状态改变/);
  assert.match(prompt, /未解决悬念/);
  assert.match(prompt, /requiresNarrativeVoiceover/);
  assert.match(prompt, /旁白必须制造矛盾/);
  assert.match(prompt, /不能只介绍身份、经历或复述/);
  assert.match(prompt, /严格短于契约上限/);
  assert.match(prompt, /声音与表情采用最小可执行集/);
  assert.match(prompt, /音效与配乐必须分开标注/);
  assert.match(prompt, /J\/L 声音桥/);
  assert.doesNotMatch(prompt, /角色闭嘴/);
});

test("custom video template content remains user-controlled", () => {
  const prompt = resolveVideoPromptInstructions(
    { id: 3, name: "高冲突默认推理", useData: "用户自定义模板" },
    {},
  );
  assert.equal(prompt, "用户自定义模板");
});

test("MiniMax H3 multi-reference mode uses the official Ref2VA six-section protocol", () => {
  const protocol = buildVideoModelPromptProtocol({
    modelFamily: "minimax-h3",
    modeKind: "multiReference",
    audioPolicy: "optional",
    referenceToken: "@图",
  });

  const fields = [
    "subject_definitions:",
    "summary:",
    "retention_analysis:",
    "detailed_description:",
    "overall_soundscape:",
    "non_diegetic_music:",
  ];
  let previous = -1;
  for (const field of fields) {
    const current = protocol.indexOf(field);
    assert.ok(current > previous, `${field} should preserve official order`);
    previous = current;
  }
  assert.match(protocol, /<Subject N>/);
  assert.match(protocol, /<Picture N>/);
  assert.match(protocol, /\[Shot 1\] 不加时间戳/);
  assert.match(protocol, /<d>\[Chinese\]/);
  assert.match(protocol, /进入\/退出时机/);
  assert.match(protocol, /静音或留白/);
});

test("MiniMax H3 base mode uses the official three-field protocol", () => {
  const protocol = buildVideoModelPromptProtocol({
    modelFamily: "minimax-h3",
    modeKind: "firstLastFrame",
    audioPolicy: "unsupported",
    referenceToken: "@图",
  });

  assert.match(protocol, /integrated_multimodal_description:/);
  assert.match(protocol, /overall_soundscape:/);
  assert.match(protocol, /non_diegetic_music:/);
  assert.doesNotMatch(protocol, /subject_definitions:/);
  assert.match(protocol, /0\.00 seconds/);
  assert.match(protocol, /两位小数时长/);
});

test("non-H3 models do not receive an H3 protocol", () => {
  assert.equal(
    buildVideoModelPromptProtocol({ modelFamily: "seedance" }),
    "",
  );
});
