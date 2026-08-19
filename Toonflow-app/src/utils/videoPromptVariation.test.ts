import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveVideoPromptVariation,
  trimPreviousVideoPrompt,
} from "./videoPromptVariation";

test("rotates the controlled creative direction after each saved generation", () => {
  const first = resolveVideoPromptVariation([], "request-a");
  assert.equal(first.round, 1);
  assert.equal(first.key, "threat-first");

  const second = resolveVideoPromptVariation(
    [{ promptInferenceSnapshot: JSON.stringify({ creativeVariation: { round: 1 } }) }],
    "request-b",
  );
  assert.equal(second.round, 2);
  assert.equal(second.key, "capability-collapse");
  assert.equal(second.requestNonce, "request-b");
});

test("keeps the prior prompt bounded before it is supplied as a no-repeat baseline", () => {
  assert.equal(trimPreviousVideoPrompt("  previous prompt  "), "previous prompt");
  assert.equal(trimPreviousVideoPrompt("abcdefgh", 5), "abcde\n[上一稿后文已省略]");
});
