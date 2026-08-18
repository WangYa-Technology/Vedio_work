import assert from "node:assert/strict";
import test from "node:test";
import { probeVideoFile } from "./videoOutputProbe";

test("returns null for a missing media file without throwing", async () => {
  assert.equal(await probeVideoFile("/tmp/does-not-exist-chengying.mp4"), null);
});
