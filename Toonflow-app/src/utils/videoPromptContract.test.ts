import assert from "node:assert/strict";
import test from "node:test";
import {
  collectVideoPromptContractViolations,
  extractDistinctiveStyleAnchors,
} from "./videoPromptContract";

const animeStyleManual = `| **通用多参模式（英文）** | \`3D anime render, cel-shaded 3D, cinematic lighting, warm tones\` |
| **Seedance 2.0（中文）** | \`3D动画渲染，赛璐珞质感，电影级光影，温暖色调\` |`;

test("rejects cinematic contamination for an animation project", () => {
  const violations = collectVideoPromptContractViolations(
    { dialogue: "无台词" },
    "IMAX实拍，Arri Alexa65，2.39:1，8K",
    { artStyle: "3D_anime_render", videoRatio: "16:9" },
  );
  assert.equal(violations.length, 2);
});

test("rejects invented speech and wrong reference token", () => {
  const violations = collectVideoPromptContractViolations(
    { dialogue: "无台词" },
    "@图1：角色；对白：来啊",
    { artStyle: "3D_anime_render", referenceToken: "@图片" },
  );
  assert.equal(violations.length, 2);
});

test("allows a factual voiceover when the original shot has no dialogue", () => {
  const violations = collectVideoPromptContractViolations(
    {
      segmentRows: [
        { dialogue: "无台词", description: "降落伞骤然塌陷，人物开始下坠" } as any,
      ],
    },
    "[视频内容] 0-3s：降落伞骤然塌陷，人物失控下坠。旁白 VO：唯一的退路正在消失。",
  );
  assert.deepEqual(violations, []);
});

test("rejects voiceover when the video model has no audio support", () => {
  const violations = collectVideoPromptContractViolations(
    { dialogue: "无台词" },
    "旁白 VO：退路正在消失。",
    { audio: false },
  );
  assert.ok(violations.some((item) => item.includes("不支持音频")));
});

test("requires chapter voiceover for an audio-enabled episode opening", () => {
  const violations = collectVideoPromptContractViolations(
    {
      requiresNarrativeVoiceover: true,
      segmentRows: [
        { dialogue: "无台词", description: "王胜失去降落伞后快速坠落" },
      ],
    },
    "[视频内容] 0-3s：王胜失去降落伞，身体快速坠落。",
    { audio: true },
  );
  assert.ok(violations.some((item) => item.includes("落差旁白")));

  assert.deepEqual(
    collectVideoPromptContractViolations(
      {
        requiresNarrativeVoiceover: true,
        segmentRows: [
          { dialogue: "无台词", description: "王胜失去降落伞后快速坠落" },
        ],
      },
      "[视频内容]\n旁白 VO：独狼刚结束夜间突降，转眼却失重坠入白昼异界。\n0-3s：王胜从画面上方向下坠落。",
      { audio: true },
    ),
    [],
  );
});

test("rejects explanatory chapter voiceover without an opposing force", () => {
  const task = {
    requiresNarrativeVoiceover: true,
    segmentRows: [
      { dialogue: "无台词", description: "降落伞骤然塌陷，王胜快速下坠" },
    ],
  };

  const explanatory = `[视频内容]
旁白 VO：独狼是王胜的代号，王胜是最强的战士和王牌狙击手。
0-3s：降落伞骤然塌陷，王胜从画面上方向下坠落。`;
  assert.ok(
    collectVideoPromptContractViolations(task, explanatory, { audio: true }).some(
      (item) => item.includes("只是背景说明"),
    ),
  );

  const conflicting = `[视频内容]
旁白 VO：能一枪定生死的王胜，此刻却连自己的落点都决定不了。
0-3s：降落伞骤然塌陷，王胜从画面上方向下坠落。`;
  assert.deepEqual(
    collectVideoPromptContractViolations(task, conflicting, { audio: true }),
    [],
  );
});

test("rejects an overlong opening voiceover when the segment duration is known", () => {
  const violations = collectVideoPromptContractViolations(
    {
      duration: 8,
      requiresNarrativeVoiceover: true,
      segmentRows: [
        { dialogue: "无台词", description: "降落伞骤然塌陷，王胜快速下坠" },
      ],
    },
    `[视频内容]
旁白 VO：能一枪定生死的王胜，此刻却连自己的落点和唯一退路都决定不了。
0-3s：降落伞骤然塌陷，王胜从画面上方向下坠落。`,
    { audio: true },
  );
  assert.ok(violations.some((item) => item.includes("章节旁白过长")));
});

test("rejects negative lip-sync controls in a generated prompt", () => {
  const violations = collectVideoPromptContractViolations(
    { dialogue: "无台词" },
    "[视频内容] 旁白 VO：退路正在消失。角色闭嘴。",
  );
  assert.ok(violations.some((item) => item.includes("负向嘴型控制词")));
});

test("accepts MiniMax H3 shot timing and conflict voiceover syntax", () => {
  const task = {
    requiresNarrativeVoiceover: true,
    segmentRows: [
      { dialogue: "无台词", description: "降落伞骤然塌陷，王胜快速下坠" },
      { dialogue: "无台词", description: "王胜调整身体方向" },
    ],
  };
  const prompt = `subject_definitions:
<Subject 1> is Wang Sheng from @图1 (王胜).
summary:
[reference generation] Wang Sheng loses control above the lake.
retention_analysis:
<Subject 1> (appears in [Shot 1], [Shot 2]): fully_preserved - identity retained.
detailed_description:
The target video uses semi-realistic 3D anime rendering.
[Shot 1] The parachute suddenly collapses and <Subject 1> falls downward toward the enlarging lake. The narrator (S1) says in an off-screen voiceover: <d>[Chinese] 能一枪定生死的王胜，此刻却连自己的落点都决定不了。</d>.
[Shot 2] At 00:03.000, the camera cuts to <Subject 1> as he reaches out and continues falling toward the water.
overall_soundscape: Strong wind and snapping fabric.
non_diegetic_music: N/A`;

  assert.deepEqual(
    collectVideoPromptContractViolations(task, prompt, {
      audio: true,
      videoPromptProfile: {
        modelFamily: "minimax-h3",
        modeKind: "multiReference",
      },
    }),
    [],
  );
});

test("rejects an incomplete MiniMax H3 Ref2VA structure", () => {
  const violations = collectVideoPromptContractViolations(
    { segmentRows: [] },
    "detailed_description: [Shot 1] A character runs. overall_soundscape: Wind.",
    {
      videoPromptProfile: {
        modelFamily: "minimax-h3",
        modeKind: "multiReference",
      },
    },
  );
  assert.ok(violations.some((item) => item.includes("官方六段结构")));
});

test("does not treat H3 shot timestamps as aspect ratios", () => {
  const violations = collectVideoPromptContractViolations(
    { segmentRows: [{ description: "王胜持续下坠" }] },
    `subject_definitions:\n<Subject 1> is the character from @图1.\nsummary: falling.\nretention_analysis: retained.\ndetailed_description: [Shot 1] At 00:03.000, <Subject 1> continues falling toward the lake.\noverall_soundscape: wind.\nnon_diegetic_music: N/A`,
    {
      videoRatio: "16:9",
      videoPromptProfile: {
        modelFamily: "minimax-h3",
        modeKind: "multiReference",
      },
    },
  );
  assert.ok(!violations.some((item) => item.includes("画幅 16:9")));
});

test("allows an H3 reference asset to remain absent when the segment never shows it", () => {
  const prompt = `subject_definitions:
<Subject 1> is the character from @图1 (王胜).
<Picture 1> is the keyframe from @图2 (湖面构图).
summary: [reference generation] A falling sequence.
retention_analysis: <Subject 1> and <Picture 1> are fully_preserved.
detailed_description: [Shot 1] <Subject 1> falls toward the lake.
overall_soundscape: Strong wind.
non_diegetic_music: N/A`;
  const violations = collectVideoPromptContractViolations(
    { segmentRows: [] },
    prompt,
    {
      videoPromptProfile: {
        modelFamily: "minimax-h3",
        modeKind: "multiReference",
      },
    },
  );
  assert.deepEqual(violations, []);
});

test("accepts English equivalents of Chinese shot action anchors", () => {
  const violations = collectVideoPromptContractViolations(
    { segmentRows: [{ dialogue: "无台词", description: "王胜伸手抓住绳索" }] },
    "[视频内容] Wang Sheng suddenly reaches out and grabs the rope.",
  );
  assert.deepEqual(violations, []);
});

test("rejects reversed character motion for a falling shot", () => {
  const task = {
    segmentRows: [
      { dialogue: "无台词", description: "王胜从高空向湖面自由落体" },
    ],
  };
  const violations = collectVideoPromptContractViolations(
    task,
    "[视频内容] 王胜突然从湖面升空，倒飞回高空，湖面逐渐缩小。",
  );
  assert.ok(violations.some((item) => item.includes("降落方向")));

  assert.deepEqual(
    collectVideoPromptContractViolations(
      task,
      "[视频内容] 王胜突然从画面上方向下坠落，持续接近湖面，湖面快速放大。",
    ),
    [],
  );

  assert.deepEqual(
    collectVideoPromptContractViolations(
      task,
      "[视频内容] <Subject 1> drops vertically from the upper frame as the lake grows larger below. The camera rises slightly to keep the shoreline in view.",
    ),
    [],
  );

  assert.ok(
    collectVideoPromptContractViolations(
      task,
      "[视频内容] 王胜在空中调整姿势，镜头跟随他的表情变化。",
    ).some((item) => item.includes("向下运动锚点")),
  );
});

test("allows explicit dialogue and matching ratio", () => {
  const violations = collectVideoPromptContractViolations(
    { dialogue: "台词：我回来了" },
    "16:9；对白：我回来了",
    { artStyle: "3D_anime_render", videoRatio: "16:9" },
  );
  assert.deepEqual(violations, []);
});

test("detects omitted action anchors", () => {
  const violations = collectVideoPromptContractViolations(
    {
      segmentRows: [
        { dialogue: "无台词", description: "人物猛然坐起，随后踹门冲出" } as any,
      ],
    },
    "角色坐在床上，房间内景",
    { artStyle: "3D_anime_render" },
  );
  assert.ok(violations.some((item) => item.includes("踹门")));
});

test("requires timing markers when a segment contains multiple shots", () => {
  const violations = collectVideoPromptContractViolations(
    {
      segmentRows: [
        { dialogue: "无台词", description: "起身" } as any,
        { dialogue: "无台词", description: "推门" } as any,
      ],
    },
    "角色起身并推门，画面连续",
    { artStyle: "3D_anime_render" },
  );
  assert.ok(violations.some((item) => item.includes("逐镜时间分段")));
});

test("requires a tension hook at the start of a high-stakes segment", () => {
  const task = {
    segmentRows: [
      { dialogue: "无台词", description: "降落伞骤然塌陷，人物开始下坠" } as any,
    ],
  };
  const flatPrompt = "[视频内容] 3D动画渲染，山林湖泊远景，冷白日光和雾气铺开。人物服装和场景稳定。0-3s：人物在空中。随后降落伞塌陷，开始下坠。";
  const hookedPrompt = "[视频内容] 0-3s：降落伞骤然塌陷，人物失控下坠；俯拍跟随坠落路线。";

  assert.ok(
    collectVideoPromptContractViolations(task, flatPrompt).some((item) =>
      item.includes("冲突钩子"),
    ),
  );
  assert.deepEqual(
    collectVideoPromptContractViolations(task, hookedPrompt),
    [],
  );

  const twoSentenceNarrativeHook = `[视频内容]
开场落差钩子：代号独狼的王胜，是身经百战的最强战士、王牌狙击手。
旁白 VO：上一刻他还在夜间突降，转眼却坠入白昼异界。
0-3s：王胜从画面上方向下坠落，持续接近湖面。`;
  assert.deepEqual(
    collectVideoPromptContractViolations(task, twoSentenceNarrativeHook),
    [],
  );
});

test("extracts distinctive style anchors and ignores generic lighting labels", () => {
  assert.deepEqual(extractDistinctiveStyleAnchors(animeStyleManual), [
    "3d anime render",
    "cel-shaded 3d",
    "3d动画渲染",
    "赛璐珞质感",
  ]);
});

test("rejects a prompt that omits every current-style anchor", () => {
  const violations = collectVideoPromptContractViolations(
    { dialogue: "无台词" },
    "角色站在房间里，温暖色调，电影级光影，无台词",
    {
      artStyle: "3D_anime_render",
      visualStyleManual: animeStyleManual,
    },
  );
  assert.ok(violations.some((item) => item.includes("可验证锚点")));
});

test("accepts either language variant of a current-style anchor", () => {
  for (const prompt of [
    "3D anime render，角色站在房间里，无台词",
    "3D动画渲染，角色站在房间里，无台词",
  ]) {
    const violations = collectVideoPromptContractViolations(
      { dialogue: "无台词" },
      prompt,
      {
        artStyle: "3D_anime_render",
        visualStyleManual: animeStyleManual,
      },
    );
    assert.deepEqual(violations, []);
  }
});
