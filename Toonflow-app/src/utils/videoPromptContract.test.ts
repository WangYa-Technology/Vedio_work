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
