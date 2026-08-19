import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_IMAGE_NEGATIVE_PROMPT } from "@/constants/imagePromptDefaults";
import { appendNegativePrompt } from "./imagePrompt";

test("appends the project negative prompt to an image prompt", () => {
  const result = appendNegativePrompt("一名站在雨中的角色", "text, watermark");

  assert.equal(result, "一名站在雨中的角色\n\n负向提示词：\ntext, watermark");
});

test("keeps the image prompt unchanged when the negative prompt is empty", () => {
  assert.equal(appendNegativePrompt("  一座古城  ", "  "), "一座古城");
});

test("the default negative prompt includes the configured quality and anatomy constraints", () => {
  assert.match(DEFAULT_IMAGE_NEGATIVE_PROMPT, /\(nsfw:1\.5\)/);
  assert.match(DEFAULT_IMAGE_NEGATIVE_PROMPT, /worst quality/);
  assert.match(DEFAULT_IMAGE_NEGATIVE_PROMPT, /bad anatomy/);
  assert.match(DEFAULT_IMAGE_NEGATIVE_PROMPT, /\(\(repeating hair\)\)/);
});
