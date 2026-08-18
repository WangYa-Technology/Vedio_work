import assert from "node:assert/strict";
import test from "node:test";
import { auditVideoOutput } from "./videoOutputAudit";

test("flags a generated frame ratio that does not match the project", () => {
  const result = auditVideoOutput({
    expectedRatio: "16:9",
    expectedDuration: 10,
    width: 1024,
    height: 768,
    actualDuration: 10.125,
  });
  assert.equal(result.aspectMismatch, true);
  assert.equal(result.durationDriftSeconds, 0.125);
  assert.equal(result.issues.length, 1);
});

test("accepts a matching output with small timing variance", () => {
  const result = auditVideoOutput({
    expectedRatio: "16:9",
    expectedDuration: 10,
    width: 1280,
    height: 720,
    actualDuration: 10.2,
  });
  assert.deepEqual(result.issues, []);
});
