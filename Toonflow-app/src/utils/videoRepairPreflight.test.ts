import assert from "node:assert/strict";
import test from "node:test";
import {
  alignVideoPromptPictures,
  parseVideoPictureBindings,
  preflightVideoSubmission,
  resolveClosestDuration,
  resolveClosestResolution,
  type VideoRepairReference,
} from "./videoRepairPreflight";

// 线上样本：2026-10-13 失败镜头（track 1791713681846）的提示词实际引用
// <Picture 1/8/10/11>，但本次只提交了 4 张参考图，编号必须被重排为 1..4。
const SAMPLE_PROMPT = [
  "subject_definitions:",
  "<Subject 1> is Chen Zhaoye (@图1：陈照野), the character referenced from <Picture 1>, a lean, upright man in his late twenties.",
  "<Subject 2> is the night-time night-market back alley (@图2：夜市后巷·夜晚), the environment referenced from <Picture 8>, an outdoor narrow service alley at night.",
  "<Subject 3> is the vegetable cleaver (@图3：剁辣椒的菜刀), the prop referenced from <Picture 10>, a stainless-steel kitchen knife.",
  "<Subject 4> is the smartphone (@图4：智能手机), the prop referenced from <Picture 11>, a dark metal-framed device.",
  "",
  "summary:",
  "[reference generation] The target video is a 13-second live-action urban sequence.",
  "",
  "retention_analysis:",
  "<Picture 1>, <Picture 8>, <Picture 10> and <Picture 11> must be fully preserved.",
].join("\n");

const SAMPLE_REFERENCES: VideoRepairReference[] = [
  { index: 0, id: 1, sources: "assets", fileType: "image", filePath: "role/a.jpg", name: "陈照野" },
  { index: 1, id: 8, sources: "assets", fileType: "image", filePath: "scene/b.jpg", name: "夜市后巷·夜晚" },
  { index: 2, id: 10, sources: "assets", fileType: "image", filePath: "props/c.jpg", name: "剁辣椒的菜刀" },
  { index: 3, id: 11, sources: "assets", fileType: "image", filePath: "props/d.jpg", name: "智能手机" },
];

const H3_PROFILE = {
  modelFamily: "minimax-h3",
  modeKind: "multimodal" as const,
  referenceToken: "@图" as const,
  referenceLimit: 9,
  maxDuration: 15,
  audioPolicy: "optional" as const,
  requiresStartEnd: false,
};

test("reorders <Picture n> to the submitted reference order without touching other text", async () => {
  const result = await preflightVideoSubmission({
    prompt: SAMPLE_PROMPT,
    references: SAMPLE_REFERENCES,
    generationConfig: {
      resolution: "768p横",
      duration: 10,
      audio: true,
      mode: ["imageReference:9", "audioReference:3", "textReference"],
    },
    projectConfig: {
      durationResolutionMap: [
        {
          duration: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
          resolution: ["480p竖", "768p竖", "480p横", "768p横"],
        },
      ],
      videoPromptProfile: H3_PROFILE,
      referenceToken: "@图",
    },
  });

  const expected = SAMPLE_PROMPT
    .replace("<Picture 8>", "<Picture 2>")
    .replace("<Picture 10>", "<Picture 3>")
    .replace("<Picture 11>", "<Picture 4>")
    .replace("<Picture 8>, ", "<Picture 2>, ")
    .replace("<Picture 10> and <Picture 11>", "<Picture 3> and <Picture 4>");

  assert.deepEqual(result.blockers, []);
  assert.equal(result.prompt, expected);
  assert.ok(!/<Picture (?:8|10|11)>/.test(result.prompt));
  assert.equal(result.fixed.length, 1);
  assert.match(result.fixed[0], /<Picture 8> → <Picture 2>/);
  assert.equal(result.duration, 10);
  assert.equal(result.resolution, "768p横");
  assert.equal(result.audio, true);
});

test("keeps <Picture n> when the prompt references a reference that was not submitted", async () => {
  const result = await preflightVideoSubmission({
    prompt: SAMPLE_PROMPT,
    references: SAMPLE_REFERENCES.slice(0, 1),
    generationConfig: { resolution: "768p横", duration: 10, audio: false },
    projectConfig: { videoPromptProfile: H3_PROFILE, referenceToken: "@图" },
  });

  assert.equal(result.prompt, SAMPLE_PROMPT);
  const mismatch = result.blockers.find((blocker) => blocker.code === "PICTURE_REFERENCE_MISMATCH");
  assert.ok(mismatch);
  assert.equal(mismatch?.action, "regeneratePrompt");
  assert.match(mismatch?.message || "", /夜市后巷·夜晚/);
});

test("drops references whose local file is missing", async () => {
  const result = await preflightVideoSubmission({
    prompt: "subject_definitions:\n<Subject 1> is (@图1：陈照野) from <Picture 1>.",
    references: [
      ...SAMPLE_REFERENCES,
      { index: 4, id: 12, sources: "assets", fileType: "image", filePath: "props/e.jpg", name: "多余道具" },
      { index: 5, id: 13, sources: "assets", fileType: "audio", filePath: "audio/f.mp3", name: "人声参考" },
    ],
    generationConfig: {
      resolution: "768p横",
      duration: 10,
      audio: true,
      mode: ["imageReference:9", "audioReference:3", "textReference"],
    },
    projectConfig: { videoPromptProfile: H3_PROFILE, referenceToken: "@图" },
    fileExists: async (filePath) => filePath !== "props/e.jpg",
  });

  assert.deepEqual(
    result.references.map((reference) => reference.filePath),
    ["role/a.jpg", "scene/b.jpg", "props/c.jpg", "props/d.jpg", "audio/f.mp3"],
  );
  assert.ok(result.fixed.some((item) => /已移除参考素材「多余道具」/.test(item)));
  assert.deepEqual(result.blockers, []);
});

test("truncates references beyond the declared model limit", async () => {
  const result = await preflightVideoSubmission({
    prompt: "subject_definitions:\n<Subject 1> is (@图1：陈照野) from <Picture 1>.",
    references: [
      ...SAMPLE_REFERENCES,
      { index: 4, id: 12, sources: "assets", fileType: "image", filePath: "props/e.jpg", name: "多余道具" },
      { index: 5, id: 13, sources: "assets", fileType: "image", filePath: "props/f.jpg", name: "额外场景" },
      { index: 6, id: 14, sources: "assets", fileType: "audio", filePath: "audio/g.mp3", name: "人声参考" },
    ],
    generationConfig: {
      resolution: "768p横",
      duration: 10,
      audio: true,
      mode: ["imageReference:4", "audioReference:3", "textReference"],
    },
    projectConfig: { videoPromptProfile: H3_PROFILE, referenceToken: "@图" },
  });

  assert.deepEqual(
    result.references.map((reference) => reference.filePath),
    ["role/a.jpg", "scene/b.jpg", "props/c.jpg", "props/d.jpg", "audio/g.mp3"],
  );
  assert.ok(result.fixed.some((item) => /已按模型上限移除 2 张超出的参考图/.test(item)));
  assert.deepEqual(result.blockers, []);
});

test("clamps resolution and duration into the declared tiers", async () => {
  const result = await preflightVideoSubmission({
    prompt: "",
    references: SAMPLE_REFERENCES,
    generationConfig: { resolution: "1080p横", duration: 13, audio: true, mode: ["imageReference:9"] },
    projectConfig: {
      durationResolutionMap: [{ duration: [5, 10], resolution: ["480p横", "768p竖"] }],
      videoPromptProfile: H3_PROFILE,
      referenceToken: "@图",
    },
  });

  assert.equal(result.resolution, "480p横");
  assert.equal(result.duration, 10);
  assert.ok(result.fixed.some((item) => /清晰度 1080p横/.test(item)));
  assert.ok(result.fixed.some((item) => /时长 13s/.test(item)));
  assert.ok(result.blockers.some((blocker) => blocker.code === "PROMPT_EMPTY"));
});

test("requires two references for first/last frame mode and disables unsupported audio", async () => {
  const result = await preflightVideoSubmission({
    prompt: "subject_definitions:\n<Subject 1> is (@图1：陈照野) from <Picture 1>.",
    references: SAMPLE_REFERENCES,
    generationConfig: { resolution: "768p横", duration: 10, audio: true },
    projectConfig: {
      videoPromptProfile: { ...H3_PROFILE, modeKind: "firstLastFrame", audioPolicy: "unsupported" },
      referenceToken: "@图",
    },
  });

  assert.equal(result.references.length, 2);
  assert.equal(result.audio, false);
  assert.ok(result.fixed.some((item) => /关闭音频/.test(item)));
  assert.equal(result.blockers.length, 0);
});

test("extracts picture bindings line by line", () => {
  const bindings = parseVideoPictureBindings(SAMPLE_PROMPT);
  assert.deepEqual(bindings, [
    { label: "陈照野", picture: 1 },
    { label: "夜市后巷·夜晚", picture: 8 },
    { label: "剁辣椒的菜刀", picture: 10 },
    { label: "智能手机", picture: 11 },
  ]);
});

test("reports conflicting picture numbers for the same <Picture n>", () => {
  const alignment = alignVideoPromptPictures(
    "<Subject 1> (@图1：陈照野) from <Picture 5>.\n<Subject 2> (@图2：夜市后巷) from <Picture 5>.",
    [
      { label: "陈照野", picture: 5 },
      { label: "夜市后巷", picture: 5 },
    ],
    [{ name: "陈照野" }, { name: "夜市后巷" }],
  );
  assert.equal(alignment.conflicts.length, 1);
  assert.equal(alignment.conflicts[0].picture, 5);
});

test("picks closest tier values", () => {
  assert.equal(resolveClosestResolution("1080p横", ["480p横", "768p竖", "768p(1:1)"]), "480p横");
  assert.equal(resolveClosestResolution("768p横", ["480p横", "768p竖"]), "480p横");
  assert.equal(resolveClosestDuration(13, [5, 10, 15]), 15);
  assert.equal(resolveClosestDuration(12.5, [5, 10, 15]), 10);
});
