import assert from "node:assert/strict";
import test from "node:test";
import {
  buildVideoModelPromptProtocol,
  DEFAULT_OFFICIAL_VIDEO_PROMPT,
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
  assert.match(prompt, /全程禁止背景音乐、配乐和 BGM/);
  assert.match(prompt, /non_diegetic_music: N\/A/);
  assert.match(prompt, /全程禁止字幕/);
  assert.match(prompt, /non_diegetic_music: N\/A/);
  assert.match(prompt, /只保留同步环境音效和动作音效，不生成背景音乐，不生成字幕/);
  assert.match(prompt, /中景\/中远景主要人物面部必须锐利对焦/);
  assert.match(prompt, /参考素材说明/);
  assert.match(prompt, /核心创意/);
  assert.match(prompt, /画面过程描述/);
  assert.match(prompt, /不想要/);
  assert.match(prompt, /@图片1/);
  assert.match(prompt, /用途、锁定维度/);
  assert.match(prompt, /Shot N/);
  assert.match(prompt, /中文台词字数/);
  assert.match(prompt, /人物远景镜头/);
  assert.match(prompt, /truck left \+ pan right/);
  assert.match(prompt, /结构字段和正文使用英文/);
  assert.match(prompt, /四拍节奏/);
  assert.match(prompt, /近景\/特写只在表情或状态真正改变时使用/);
  assert.doesNotMatch(prompt, /角色闭嘴/);
});

test("custom video template content remains user-controlled", () => {
  const prompt = resolveVideoPromptInstructions(
    { id: 3, name: "高冲突默认推理", useData: "用户自定义模板" },
    {},
  );
  assert.equal(prompt, "用户自定义模板");
});

test("visible official template still receives runtime context", () => {
  const prompt = resolveVideoPromptInstructions(
    {
      id: 3,
      name: "高冲突默认推理",
      data: DEFAULT_OFFICIAL_VIDEO_PROMPT,
      useData: DEFAULT_OFFICIAL_VIDEO_PROMPT,
    },
    {
      modelName: "minimax-h3-reference-to-video",
      mode: ["imageReference:9", "textReference"],
      referenceToken: "@图",
      videoRatio: "9:16",
    },
  );

  assert.match(prompt, /高冲突核心/);
  assert.match(prompt, /当前模型：minimax-h3-reference-to-video/);
  assert.match(prompt, /当前模式：imageReference:9, textReference/);
  assert.match(prompt, /当前画幅：9:16/);
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
  assert.match(protocol, /定义了 <Picture N>，必须在 detailed_description/);
  assert.match(protocol, /partially_preserved/);
  assert.match(protocol, /effect residue visible/);
  assert.match(protocol, /\[Shot 1\] 不加时间戳/);
  assert.match(protocol, /<d>\[Chinese\]/);
  assert.match(protocol, /non_diegetic_music 无条件写 N\/A/);
  assert.match(protocol, /只保留同步环境音效和动作音效，不生成背景音乐，不生成字幕/);
  assert.match(protocol, /全程禁止字幕/);
  assert.match(protocol, /中景或中远景/);
  assert.match(protocol, /面部锐利对焦/);
  assert.match(protocol, /四模块规划与 H3 映射/);
  assert.match(protocol, /不新增 H3 字段/);
  assert.match(protocol, /首尾帧模式必须显式标记/);
  assert.match(protocol, /六个字段名.*正文全部使用英文/);
  assert.match(protocol, /高冲突四拍节奏/);
  assert.match(protocol, /不能用 8 秒连续跟拍或连续推脸/);
  assert.match(protocol, /抽象风格词/);
  assert.match(protocol, /不能仅因参考图是照片就擅自改成真人实拍/);
  assert.match(protocol, /只允许概括 detailed_description 中已经明确写出的同步音效/);
  assert.match(protocol, /叙事增强只条件触发/);
  assert.match(protocol, /不存在这些事实时，保持原有开场/);
  assert.match(protocol, /不得新增声音类型/);
  assert.match(protocol, /不得输出分析注释、改变景别、重排镜头时长/);
  assert.match(protocol, /镜头信息密度只通过可观察内容提升/);
  assert.match(protocol, /只有 shotFacts、对白或动作明确提供情绪信号时/);
  assert.match(protocol, /任务推进、发现\/揭露或情绪转折/);
  assert.match(protocol, /不得添加“本不该出现”等未被输入确认的判断/);
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
  assert.match(protocol, /00\.00 seconds/);
  assert.match(protocol, /两位小数时长/);
  assert.match(protocol, /四模块规划与通用 Shot 规范/);
  assert.match(protocol, /禁止“环绕运镜”/);
  assert.doesNotMatch(protocol, /At 00:SS\.mmm/);
});

test("non-H3 models do not receive an H3 protocol", () => {
  assert.equal(
    buildVideoModelPromptProtocol({ modelFamily: "seedance" }),
    "",
  );
});
