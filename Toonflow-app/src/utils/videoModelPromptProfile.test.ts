import assert from "node:assert/strict";
import test from "node:test";
import { resolveVideoModelPromptProfile } from "./videoModelPromptProfile";

test("profiles multi-reference MiniMax models", () => {
  assert.deepEqual(
    resolveVideoModelPromptProfile({
      modelName: "minimax-h3-reference-to-video",
      mode: [["imageReference:9"]],
      durationResolutionMap: [{ duration: [5, 10, 15] }],
      audio: "optional",
    }),
    {
      modelFamily: "minimax-h3",
      modeKind: "multiReference",
      referenceToken: "@图",
      referenceLimit: 9,
      maxDuration: 15,
      audioPolicy: "optional",
      requiresStartEnd: false,
    },
  );
});

test("profiles Seedance first/last-frame models", () => {
  const profile = resolveVideoModelPromptProfile({
    modelName: "seedance-2.0",
    mode: ["singleImage", "startEndRequired"],
    audio: false,
  });
  assert.equal(profile.modelFamily, "seedance");
  assert.equal(profile.modeKind, "firstLastFrame");
  assert.equal(profile.referenceToken, "@图片");
  assert.equal(profile.requiresStartEnd, true);
  assert.equal(profile.audioPolicy, "unsupported");
});

test("profiles mixed image, video, and audio references as multimodal", () => {
  const profile = resolveVideoModelPromptProfile({
    modelName: "MiniMax-H3",
    mode: [["imageReference:9", "videoReference:1", "audioReference:1"]],
  });
  assert.equal(profile.modeKind, "multimodal");
});
