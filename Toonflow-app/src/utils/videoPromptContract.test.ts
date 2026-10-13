import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanSpeakerName,
  collectVideoPromptContractIssues,
  collectVideoPromptContractViolations,
  extractDistinctiveStyleAnchors,
  isSameSpeaker,
  speakerKeyCandidates,
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

test("warns about a missing chapter voiceover for an audio-enabled episode opening", () => {
  const issues = collectVideoPromptContractIssues(
    {
      requiresNarrativeVoiceover: true,
      segmentRows: [
        { dialogue: "无台词", description: "王胜失去降落伞后快速坠落" },
      ],
    },
    "[视频内容] 0-3s：王胜失去降落伞，身体快速坠落。",
    { audio: true },
  );
  assert.ok(issues.warnings.some((item) => item.includes("落差旁白")));

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
    collectVideoPromptContractIssues(
      task,
      explanatory,
      { audio: true },
    ).warnings.some((item) => item.includes("只是背景说明")),
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

test("reports negative lip-sync controls in a generated prompt as a warning", () => {
  const issues = collectVideoPromptContractIssues(
    { dialogue: "无台词" },
    "[视频内容] 旁白 VO：退路正在消失。角色闭嘴。",
  );
  assert.ok(issues.warnings.some((item) => item.includes("负向嘴型控制词")));
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

test("accepts multiline role subjects and an explicit English downward anchor", () => {
  const prompt = `subject_definitions:
<Subject 1>
Reference @图1, preserving the source character identity.
name: 王胜
summary:
[reference generation] Wang Sheng loses control above the lake.
retention_analysis:
<Subject 1> is fully_preserved.
detailed_description:
[Shot 1] <Subject 1> is plummeting toward the water as the lake surface rapidly grows larger beneath him.
overall_soundscape:
Synchronized wind and snapping fabric only.
non_diegetic_music:
N/A
只保留同步环境音效和动作音效，不生成背景音乐，不生成字幕。`;

  assert.deepEqual(
    collectVideoPromptContractViolations(
      {
        medias: [{ name: "王胜", type: "role" }],
        segmentRows: [
          { dialogue: "无台词", description: "王胜失控坠落并持续接近水面" },
        ],
      },
      prompt,
      {
        referenceToken: "@图",
        audio: true,
        videoPromptProfile: {
          modelFamily: "minimax-h3",
          modeKind: "multiReference",
        },
      },
    ),
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

test("does not hard-fail a high-stakes segment for its opening hook wording", () => {
  const task = {
    segmentRows: [
      { dialogue: "无台词", description: "降落伞骤然塌陷，人物开始下坠" } as any,
    ],
  };
  const flatPrompt = "[视频内容] 3D动画渲染，山林湖泊远景，冷白日光和雾气铺开。人物服装和场景稳定。0-3s：人物在空中。随后降落伞塌陷，开始下坠。";
  const hookedPrompt = "[视频内容] 0-3s：降落伞骤然塌陷，人物失控下坠；俯拍跟随坠落路线。";

  assert.ok(
    !collectVideoPromptContractViolations(task, flatPrompt).some((item) =>
      item.includes("冲突钩子"),
    ),
  );
  assert.ok(
    !collectVideoPromptContractViolations(task, hookedPrompt).some((item) =>
      item.includes("冲突钩子"),
    ),
  );

  const twoSentenceNarrativeHook = `[视频内容]
开场落差钩子：代号独狼的王胜，是身经百战的最强战士、王牌狙击手。
旁白 VO：上一刻他还在夜间突降，转眼却坠入白昼异界。
0-3s：王胜从画面上方向下坠落，持续接近湖面。`;
  assert.ok(
    !collectVideoPromptContractViolations(task, twoSentenceNarrativeHook).some(
      (item) => item.includes("冲突钩子"),
    ),
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

test("warns when a prompt omits every current-style anchor", () => {
  const issues = collectVideoPromptContractIssues(
    { dialogue: "无台词" },
    "角色站在房间里，温暖色调，电影级光影，无台词",
    {
      artStyle: "3D_anime_render",
      visualStyleManual: animeStyleManual,
    },
  );
  assert.ok(issues.warnings.some((item) => item.includes("可验证锚点")));
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

test("rejects background music but allows synchronized sound effects", () => {
  const task = { segmentRows: [{ dialogue: "无台词", description: "人物推门" }] };
  const violations = collectVideoPromptContractViolations(
    task,
    "[视频内容] 人物推门，门轴声与脚步声同步。配乐设计：低沉弦乐渐入。",
  );
  assert.ok(violations.some((item) => item.includes("背景音乐或配乐设计")));

  assert.deepEqual(
    collectVideoPromptContractViolations(
      task,
      "[视频内容] 人物推门，门轴声与脚步声同步；全程无背景音乐。",
    ),
    [],
  );
});

test("rejects generated subtitles", () => {
  const violations = collectVideoPromptContractViolations(
    { dialogue: "台词：快走" },
    "人物喊：快走。画面底部显示中文字幕：快走。",
  );
  assert.ok(violations.some((item) => item.includes("生成字幕")));
});

test("requires a face clarity anchor for medium and medium-long shots", () => {
  const task = {
    segmentRows: [
      { dialogue: "无台词", description: "人物回头", scale: "中远景" },
    ],
  };
  assert.ok(
    collectVideoPromptContractIssues(task, "人物回头看向门口。").warnings.some(
      (item) => item.includes("人脸清晰度约束"),
    ),
  );
  assert.deepEqual(
    collectVideoPromptContractViolations(
      task,
      "人物回头看向门口，主要人物面部锐利对焦，五官细节清晰可辨。",
    ),
    [],
  );
});

test("accepts exact H3 dialogue bound to distinct role subjects on cumulative cuts", () => {
  const task = {
    medias: [
      { name: "王胜", type: "role" },
      { name: "宋嫣", type: "role" },
      { name: "宋家禁地湖", type: "scene" },
    ],
    segmentRows: [
      { duration: 3, dialogue: "王胜：这什么地方？", description: "王胜浮出水面", scale: "近景" },
      { duration: 4, dialogue: "宋嫣：都别碰他！", description: "宋嫣举起玉令", scale: "近景" },
    ],
  };
  const prompt = `subject_definitions:
<Subject 1> is the character from @图1 (王胜), preserving his identity.
<Subject 2> is the character from @图2 (宋嫣), preserving her identity.
<Subject 3> is the lake environment from @图3 (宋家禁地湖).
summary:
[reference generation] Two distinct characters confront each other by the lake.
retention_analysis:
<Subject 1> (appears in [Shot 1]): fully_preserved - identity retained.
<Subject 2> (appears in [Shot 2]): fully_preserved - identity retained.
<Subject 3> (appears in [Shot 1], [Shot 2]): fully_preserved - environment retained.
detailed_description:
The target video uses a restrained cinematic style.
[Shot 1] <Subject 1> (S1) rises from the water and asks, <d>[Chinese] 这什么地方？</d>
[Shot 2] At 00:03.000, the shot cuts to <Subject 2> (S2), who raises the token and says, <d>[Chinese] 都别碰他！</d>
overall_soundscape:
Water and footsteps remain synchronized with the action.
non_diegetic_music:
N/A`;

  assert.deepEqual(
    collectVideoPromptContractViolations(task, prompt, {
      referenceToken: "@图",
      audio: true,
      videoPromptProfile: {
        modelFamily: "minimax-h3",
        modeKind: "multimodal",
      },
    }),
    [],
  );
});

test("ignores in-frame text labels when validating H3 dialogue and identity", () => {
  const task = {
    medias: [{ name: "陈照野", type: "role" }],
    segmentRows: [
      { duration: 3, dialogue: "陈照野说：『马上！』", description: "陈照野剁串", scale: "近景" },
      { duration: 2.5, dialogue: "VO（摊车灯牌文字）：『照野炸串』", description: "灯牌亮起", scale: "全景" },
    ],
  };
  const config = {
    referenceToken: "@图",
    audio: true,
    videoPromptProfile: {
      modelFamily: "minimax-h3",
      modeKind: "multiReference",
    },
  };
  const prompt = `subject_definitions:
<Subject 1> is the character from @图1 (陈照野).
summary:
[reference generation] Chen Zhaoye keeps chopping skewers under the lit stall sign.
retention_analysis:
<Subject 1> (appears in [Shot 1], [Shot 2]): fully_preserved - identity retained.
detailed_description:
The target video uses a semi-realistic 3D anime rendering.
[Shot 1] <Subject 1> (S1) keeps chopping and says, <d>[Chinese] 马上！</d>
[Shot 2] At 00:03.000, the shot cuts to the glowing sign reading "照野炸串" above the stall.
overall_soundscape:
Chopping and distant market chatter stay synchronized with the action.
non_diegetic_music:
N/A`;

  // 画内文字不需要 H3 说话主体，也不该被要求逐字出现在 <d> 里。
  assert.deepEqual(collectVideoPromptContractViolations(task, prompt, config), []);

  const withSpokenSignText = prompt.replace(
    "<d>[Chinese] 马上！</d>",
    "<d>[Chinese] 马上！</d> A voice says, <d>[Chinese] 照野炸串</d>",
  );
  assert.ok(
    collectVideoPromptContractViolations(task, withSpokenSignText, config).some((item) =>
      item.includes("不存在"),
    ),
  );
});

test("treats an in-frame text only segment as no dialogue", () => {
  const task = {
    medias: [{ name: "陈照野", type: "role" }],
    segmentRows: [
      { duration: 2, dialogue: "VO（手机来电显示）：『许曼青』", description: "手机屏幕亮起", scale: "特写" },
    ],
  };
  assert.ok(
    collectVideoPromptContractViolations(
      task,
      "[视频内容] 手机屏幕亮起，来电显示许曼青。角色说：许曼青。",
    ).some((item) => item.includes("原分镜无对白")),
  );
});

test("keeps narration-labelled lines voiced without requiring a subject", () => {
  const task = {
    medias: [],
    segmentRows: [
      { duration: 3, dialogue: "VO（旁白）：『退路正在消失。』", description: "空镜", scale: "全景" },
    ],
  };
  const config = {
    referenceToken: "@图",
    audio: true,
    videoPromptProfile: {
      modelFamily: "minimax-h3",
      modeKind: "multiReference",
    },
  };
  const prompt = `subject_definitions:
N/A
summary:
[reference generation] An empty night market lane stays still.
retention_analysis:
N/A
detailed_description:
The target video uses a semi-realistic 3D anime rendering.
[Shot 1] The empty lane holds still as the narrator says in an off-screen voiceover: <d>[Chinese] 退路正在消失。</d>
overall_soundscape:
Distant market hum stays synchronized with the action.
non_diegetic_music:
N/A`;

  assert.deepEqual(collectVideoPromptContractViolations(task, prompt, config), []);
  // 旁白是发声台词：漏掉 <d> 仍应判为漏台词（不是画内文字）
  assert.ok(
    collectVideoPromptContractViolations(
      task,
      prompt.replace("<d>[Chinese] 退路正在消失。</d>", ""),
      config,
    ).some((item) => item.includes("逐字")),
  );
});

test("matches speakers written with narrative verbs to the existing role", () => {
  assert.equal(isSameSpeaker("老王问", "老王"), true);
  assert.equal(isSameSpeaker("陈照野答", "陈照野"), true);
  assert.equal(isSameSpeaker("陈照野冷笑道", "陈照野"), true);
  assert.equal(isSameSpeaker("陈照野低声问道", "陈照野"), true);
  assert.equal(isSameSpeaker("许曼青（OS）", "许曼青"), true);
  // 长叙述短语按"角色名 + 叙述尾巴"兜底
  assert.equal(isSameSpeaker("老王拍桌问", "老王"), true);
  assert.equal(isSameSpeaker("陈照野压低声音说", "陈照野"), true);
  assert.equal(isSameSpeaker("陈照野冷笑一声道", "陈照野"), true);
  // 方括号/引号包裹
  assert.equal(isSameSpeaker("【老王】", "老王"), true);
  assert.equal(isSameSpeaker("[陈照野]", "陈照野"), true);
  // 不应误判：前缀相同但不是同一角色、尾巴不含叙述动词
  assert.equal(isSameSpeaker("陈照野", "陈"), false);
  assert.equal(isSameSpeaker("老王隔壁", "老王"), false);
  assert.equal(isSameSpeaker("销售说", "老王"), false);
  assert.equal(cleanSpeakerName("老王问"), "老王");
  // 单字名字不被误剥（"阿道"不应变成"阿"）
  assert.deepEqual(speakerKeyCandidates("阿道"), ["阿道"]);
});

test("binds dialogue written as X问/X答 to the existing role subjects", () => {
  const task = {
    medias: [
      { name: "老王", type: "role" },
      { name: "陈照野", type: "role" },
      { name: "宋家禁地湖", type: "scene" },
    ],
    segmentRows: [
      { duration: 3, dialogue: "老王问：这什么地方？", description: "老王浮出水面", scale: "近景" },
      { duration: 4, dialogue: "陈照野答：都别碰他！", description: "陈照野举起玉令", scale: "近景" },
    ],
  };
  const prompt = `subject_definitions:
<Subject 1> is the character from @图1 (老王), preserving his identity.
<Subject 2> is the character from @图2 (陈照野), preserving his identity.
<Subject 3> is the lake environment from @图3 (宋家禁地湖).
summary:
[reference generation] Two distinct characters confront each other by the lake.
retention_analysis:
<Subject 1> (appears in [Shot 1]): fully_preserved - identity retained.
<Subject 2> (appears in [Shot 2]): fully_preserved - identity retained.
<Subject 3> (appears in [Shot 1], [Shot 2]): fully_preserved - environment retained.
detailed_description:
The target video uses a restrained cinematic style.
[Shot 1] <Subject 1> (S1) rises from the water and asks, <d>[Chinese] 这什么地方？</d>
[Shot 2] At 00:03.000, the shot cuts to <Subject 2> (S2), who raises the token and says, <d>[Chinese] 都别碰他！</d>
overall_soundscape:
Water and footsteps remain synchronized with the action.
non_diegetic_music:
N/A`;

  assert.deepEqual(
    collectVideoPromptContractViolations(task, prompt, {
      referenceToken: "@图",
      audio: true,
      videoPromptProfile: {
        modelFamily: "minimax-h3",
        modeKind: "multimodal",
      },
    }),
    [],
  );
});

test("rejects extra text after the H3 non-diegetic music field", () => {
  const violations = collectVideoPromptContractViolations(
    {
      segmentRows: [],
      medias: [],
    },
    `subject_definitions:
N/A
summary:
[reference generation] Empty test segment.
retention_analysis:
N/A
detailed_description:
[Shot 1] A static empty frame.
overall_soundscape:
N/A
non_diegetic_music:
N/A
只保留同步环境音效，不生成背景音乐。`,
    {
      videoPromptProfile: {
        modelFamily: "minimax-h3",
        modeKind: "multiReference",
      },
    },
  );

  assert.ok(violations.some((item) => item.includes("只能写 N/A")));
});

test("accepts the requested fixed synchronous sound suffix after H3 N/A", () => {
  const violations = collectVideoPromptContractViolations(
    {
      segmentRows: [],
      medias: [],
    },
    `subject_definitions:
N/A
summary:
[reference generation] Empty test segment.
retention_analysis:
N/A
detailed_description:
[Shot 1] A static empty frame.
overall_soundscape:
N/A
non_diegetic_music:
N/A
只保留同步环境音效和动作音效，不生成背景音乐，不生成字幕。`,
    {
      videoPromptProfile: {
        modelFamily: "minimax-h3",
        modeKind: "multiReference",
      },
    },
  );

  assert.deepEqual(violations, []);
});

test("rejects reset shot timing, speaker prefixes, missing identities, and duplicate subjects", () => {
  const violations = collectVideoPromptContractViolations(
    {
      medias: [
        { name: "王胜", type: "role" },
        { name: "宋嫣", type: "role" },
      ],
      segmentRows: [
        { duration: 3, dialogue: "王胜：这什么地方？", description: "王胜抬头", scale: "近景" },
        { duration: 4, dialogue: "宋嫣：都别碰他！", description: "宋嫣抬手", scale: "近景" },
      ],
    },
    `subject_definitions:
<Subject 1> is the character from @图1 (王胜).
<Subject 1> is also the character from @图2 (宋嫣).
summary:
[reference generation] confrontation.
retention_analysis:
<Subject 1>: fully_preserved - identity retained.
detailed_description:
[Shot 1] <Subject 1> (S1) says, <d>[Chinese] 王胜：这什么地方？</d>
[Shot 2] At 00:00.000, <Subject 1> (S2) says, <d>[Chinese] 宋嫣：都别碰他！</d>
overall_soundscape:
Water.
non_diegetic_music:
N/A`,
    {
      referenceToken: "@图",
      audio: true,
      videoPromptProfile: {
        modelFamily: "minimax-h3",
        modeKind: "multimodal",
      },
    },
  );

  assert.ok(violations.some((item) => item.includes("说话人前缀")));
  assert.ok(violations.some((item) => item.includes("同一个 Subject")));
  assert.ok(violations.some((item) => item.includes("累计时间 00:03.000")));
});
