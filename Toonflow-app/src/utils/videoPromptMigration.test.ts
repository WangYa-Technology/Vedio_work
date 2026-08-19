import assert from "node:assert/strict";
import test from "node:test";
import {
  migrateLegacyPromptForH3,
  removeNarrationLipSyncInstructions,
} from "./videoPromptMigration";

test("removes negative lip-sync controls from prompts", () => {
  const prompt = "旁白 VO：他本来能掌控一切，却失去了退路；角色闭嘴。";
  assert.equal(removeNarrationLipSyncInstructions(prompt), "旁白 VO：他本来能掌控一切，却失去了退路。");
  assert.doesNotMatch(
    removeNarrationLipSyncInstructions(
      "The narrator says in an off-screen voiceover: <d>[Chinese] 他失去了退路。</d> while the on-screen character's lips remain completely closed.",
    ),
    /lips remain completely closed/i,
  );
});

test("migrates a legacy reference prompt into H3 Ref2VA at generation time", () => {
  const prompt = `[参考图]\n@图1：王胜（角色）\n@图2：降落伞（道具）\n@图3：远处装备仓（道具）\n@图4：宋家禁地（场景）\n\n[视频内容]\n旁白 VO：王牌战士王胜刚失去降落伞，正从宋家禁地上空失控坠落；角色闭嘴。\n0-3s：降落伞骤然塌陷，王胜身体持续下坠；下方湖面迅速放大。\n3-6s：王胜调整身体方向，继续接近湖面。`;
  const migrated = migrateLegacyPromptForH3(prompt, {
    profile: {
      modelFamily: "minimax-h3",
      modeKind: "multimodal",
      referenceToken: "@图",
      referenceLimit: 9,
      maxDuration: 15,
      audioPolicy: "supported",
      requiresStartEnd: false,
    },
    referenceToken: "@图",
    task: {
      segmentRows: [
        { dialogue: "无台词", description: "王胜身体持续下坠，接近湖面" },
      ],
    },
  });
  assert.match(migrated, /subject_definitions:/);
  assert.match(migrated, /<Subject 3>/);
  assert.match(migrated, /<Subject 3>[\s\S]*detailed_description:/);
  assert.match(migrated, /moves continuously downward[\s\S]*water surface/);
  assert.match(migrated, /\[Shot 2\] At 00:03\.000/);
  assert.doesNotMatch(migrated, /\[参考图\]/);
  assert.doesNotMatch(migrated, /角色闭嘴|lips remain completely closed/i);
});

test("does not rewrite prompts for non-H3 models or already migrated prompts", () => {
  const legacy = "[参考图] @图1：角色\n[视频内容] 0-3s：角色奔跑";
  assert.equal(
    migrateLegacyPromptForH3(legacy, {
      profile: {
        modelFamily: "seedance",
        modeKind: "multiReference",
        referenceToken: "@图片",
        referenceLimit: 9,
        maxDuration: 15,
        audioPolicy: "supported",
        requiresStartEnd: false,
      },
    }),
    legacy,
  );
  const current = "subject_definitions:\n<Subject 1> is stable.";
  assert.equal(
    migrateLegacyPromptForH3(current, {
      profile: {
        modelFamily: "minimax-h3",
        modeKind: "multiReference",
        referenceToken: "@图",
        referenceLimit: 9,
        maxDuration: 15,
        audioPolicy: "optional",
        requiresStartEnd: false,
      },
    }),
    current,
  );
});

test("uses the H3 base protocol for first-last-frame and text-only workflows", () => {
  const legacy = `[参考图]\n@图1：王胜（角色）\n@图2：湖面（场景）\n@图3：降落伞（道具）\n\n[视频内容]\n0-3s：王胜持续向下坠落，湖面不断放大。`;
  const firstLast = migrateLegacyPromptForH3(legacy, {
    profile: {
      modelFamily: "minimax-h3",
      modeKind: "firstLastFrame",
      referenceToken: "@图",
      referenceLimit: null,
      maxDuration: 15,
      audioPolicy: "unsupported",
      requiresStartEnd: true,
    },
    referenceToken: "@图",
  });
  assert.match(firstLast, /^How the reference pictures align/m);
  assert.match(firstLast, /integrated_multimodal_description:/);
  assert.match(firstLast, /@图1.*王胜/);
  assert.match(firstLast, /@图2.*湖面/);
  assert.doesNotMatch(firstLast, /@图3/);
  assert.match(firstLast, /overall_soundscape: N\/A/);

  const textOnly = migrateLegacyPromptForH3("[视频内容]\n0-3s：山林在风中起伏。", {
    profile: {
      modelFamily: "minimax-h3",
      modeKind: "text",
      referenceToken: "@图",
      referenceLimit: null,
      maxDuration: 15,
      audioPolicy: "unsupported",
      requiresStartEnd: false,
    },
  });
  assert.match(textOnly, /^integrated_multimodal_description:/);
  assert.doesNotMatch(textOnly, /<Picture/);
});
