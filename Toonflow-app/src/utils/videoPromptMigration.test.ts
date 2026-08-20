import assert from "node:assert/strict";
import test from "node:test";
import {
  enforceVideoPromptOutputConstraints,
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

test("upgrades saved H3 prompts to the current music, text, and face rules", () => {
  const prompt = `integrated_multimodal_description:
[Shot 1] 中远景，人物穿过山林。
overall_soundscape: 风声与衣料摩擦声。
non_diegetic_music:
低沉配乐从开场渐入，在结尾增强。`;
  const upgraded = enforceVideoPromptOutputConstraints(prompt, {
    segmentRows: [{ scale: "中远景", description: "人物穿过山林" }],
  });

  assert.match(upgraded, /画面文字：N\/A，标题：N\/A，对话气泡：N\/A/);
  assert.match(upgraded, /主要人物面部保持锐利对焦[\s\S]*眼睛、鼻子、嘴部与轮廓清晰可辨/);
  assert.match(upgraded, /non_diegetic_music:\s*N\/A\s*$/);
  assert.doesNotMatch(upgraded, /低沉配乐|渐入|增强/);
});

test("does not duplicate output constraints already present in a saved prompt", () => {
  const prompt = `integrated_multimodal_description:
[Shot 1] 中景，主要人物面部锐利对焦，五官细节清晰可辨。画面文字：N/A，标题：N/A，对话气泡：N/A。
overall_soundscape: 环境风声。
non_diegetic_music: N/A`;
  const upgraded = enforceVideoPromptOutputConstraints(prompt, {
    segmentRows: [{ scale: "中景" }],
  });

  assert.equal(upgraded.match(/画面文字：N\/A/g)?.length, 1);
  assert.equal(upgraded.match(/面部锐利对焦/g)?.length, 1);
  assert.equal(upgraded.match(/non_diegetic_music:/g)?.length, 1);
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
  assert.match(migrated, /画面上方持续向下[\s\S]*水面/);
  assert.match(migrated, /\[Shot 2\] 00:03\.000 切至/);
  assert.match(migrated, /\[reference generation\][^\n]*中文提示词/);
  assert.doesNotMatch(migrated, /remain consistent|Preserve the supplied|camera cuts to/);
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
  assert.match(firstLast, /^参考图与目标视频对齐/m);
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

test("migrates the Chinese four-module shell without leaking negative constraints", () => {
  const prompt = `[参考素材说明]\n@图1：王胜（角色）\n\n[核心创意]\n8秒坠落危机。\n\n[画面过程描述]\n0-3秒：降落伞塌陷，王胜向下坠落。\n3-8秒：湖面不断放大。\n\n[不想要]\n人物远景镜头；反向运动。`;
  const migrated = migrateLegacyPromptForH3(prompt, {
    profile: {
      modelFamily: "minimax-h3",
      modeKind: "multiReference",
      referenceToken: "@图",
      referenceLimit: 9,
      maxDuration: 15,
      audioPolicy: "optional",
      requiresStartEnd: false,
    },
    referenceToken: "@图",
  });

  assert.match(migrated, /detailed_description:[\s\S]*降落伞塌陷/);
  assert.doesNotMatch(migrated, /人物远景镜头|反向运动/);
});
