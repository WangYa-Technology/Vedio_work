import assert from "node:assert/strict";
import test from "node:test";
import { formatModelReference, parseModelReference } from "./modelRef";

test("preserves colons inside a model name", () => {
  assert.deepEqual(parseModelReference("comfyui:minimax-h3:pro"), {
    vendorId: "comfyui",
    modelName: "minimax-h3:pro",
  });
});

test("handles an unconfigured model without inventing a name", () => {
  assert.deepEqual(parseModelReference(""), {
    vendorId: "",
    modelName: "",
  });
  assert.equal(
    formatModelReference({ vendorId: "comfyui", modelName: "minimax-h3:pro" }),
    "comfyui:minimax-h3:pro",
  );
});
