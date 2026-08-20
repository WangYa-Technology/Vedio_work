import assert from "node:assert/strict";
import test from "node:test";
import {
  configuredMirrorUrls,
  runWithMirrorFailover,
  shouldTryNextMirror,
  VendorMirrorPoolManager,
} from "./vendorMirrorPool";

test("normalizes configured mirror URLs in configured order", () => {
  assert.deepEqual(
    configuredMirrorUrls({
      baseUrl: "https://gpu-a.example.com/",
      baseUrls: JSON.stringify([
        "https://gpu-a.example.com/",
        " https://gpu-b.example.com ",
        "https://gpu-a.example.com/",
      ]),
    }),
    ["https://gpu-a.example.com/", "https://gpu-b.example.com"],
  );
});

test("leases different GPUs concurrently and skips an already failed mirror", async () => {
  const manager = new VendorMirrorPoolManager();
  const urls = ["gpu-a", "gpu-b"];
  const first = await manager.acquire("comfy", urls);
  const second = await manager.acquire("comfy", urls);
  assert.equal(first?.state.url, "gpu-a");
  assert.equal(second?.state.url, "gpu-b");

  first?.release();
  const retryPromise = manager.acquire("comfy", urls, new Set(["gpu-a"]));
  second?.release();
  const retry = await retryPromise;
  assert.equal(retry?.state.url, "gpu-b");
  retry?.release();
});

test("hands a released compatible GPU to a waiting task", async () => {
  const manager = new VendorMirrorPoolManager();
  const urls = ["gpu-a", "gpu-b"];
  const first = await manager.acquire("comfy", urls);
  const second = await manager.acquire("comfy", urls);
  const waiting = manager.acquire("comfy", urls, new Set(["gpu-a"]));

  first?.release();
  second?.release();
  const next = await waiting;
  assert.equal(next?.state.url, "gpu-b");
  next?.release();
});

test("only retries before prompt submission when another mirror can help", () => {
  const route404 = {
    isAxiosError: true,
    config: { url: "https://gpu-a.example.com/upload/image" },
    response: { status: 404 },
  };
  assert.equal(shouldTryNextMirror(route404, false), true);
  assert.equal(shouldTryNextMirror(route404, true), false);
  assert.equal(
    shouldTryNextMirror({ isAxiosError: true, config: { url: "https://gpu-a.example.com/prompt" } }, false),
    false,
  );
  assert.equal(shouldTryNextMirror(new Error("请先填写视频提示词"), false), false);
});

test("runs the same task on the next configured GPU after a route failure", async () => {
  const attempts: string[] = [];
  const result = await runWithMirrorFailover({
    vendorId: "comfy-failover-test",
    urls: ["gpu-a", "gpu-b"],
    run: async (attempt) => {
      attempts.push(attempt.url);
      if (attempt.url === "gpu-a") {
        throw {
          isAxiosError: true,
          config: { url: "https://gpu-a.example.com/upload/image" },
          response: { status: 404 },
        };
      }
      return "generated-on-gpu-b";
    },
  });

  assert.equal(result, "generated-on-gpu-b");
  assert.deepEqual(attempts, ["gpu-a", "gpu-b"]);
});

test("does not resubmit after a provider prompt id was received", async () => {
  const attempts: string[] = [];
  await assert.rejects(
    runWithMirrorFailover({
      vendorId: "comfy-no-duplicate-test",
      urls: ["gpu-a", "gpu-b"],
      run: async (attempt) => {
        attempts.push(attempt.url);
        attempt.promptSubmitted = true;
        throw new Error("polling failed");
      },
    }),
    /polling failed/,
  );
  assert.deepEqual(attempts, ["gpu-a"]);
});
