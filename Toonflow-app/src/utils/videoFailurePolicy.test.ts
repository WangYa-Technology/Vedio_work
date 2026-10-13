import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyVideoFailure,
  isVideoTaskTimedOut,
  resolveVideoTaskTimeoutMs,
  shouldAutoRetryVideoTask,
  DEFAULT_VIDEO_TASK_TIMEOUT_MS,
} from "./videoFailurePolicy";

// 线上样本：Android 平台返回的通用失败文案（2026-10-13 AutoDL 失败镜头）。
const PLATFORM_GENERIC_FAILURE =
  "AutoDL 工作流执行失败：抱歉，任务处理失败，结果未生成。可能原因：显存不足、模型加载失败，或资源链接失效。请尝试：检查资源链接，或稍后重试。如仍失败，请联系客服。";

test("treats the platform generic failure as transient", () => {
  assert.equal(classifyVideoFailure(PLATFORM_GENERIC_FAILURE), "transient");
  assert.equal(classifyVideoFailure("timeout"), "transient");
  assert.equal(classifyVideoFailure("AutoDL 工作流成功但未返回结果 URL"), "transient");
  assert.equal(classifyVideoFailure("socket hang up"), "transient");
  assert.equal(classifyVideoFailure("AutoDL 任务提交失败：服务开小差（InternalError）"), "transient");
});

test("treats parameter, workflow and material problems as permanent", () => {
  assert.equal(classifyVideoFailure("AutoDL 任务提交失败：存在未定义的参数（InvalidParameter）"), "permanent");
  assert.equal(classifyVideoFailure("AutoDL 工作流执行失败：工作流不可用（InternalError）"), "permanent");
  assert.equal(
    classifyVideoFailure("“H3图生视频 · 音频同步”需要 1 张参考图片，请先在参考素材中选择图片"),
    "permanent",
  );
  assert.equal(classifyVideoFailure("请先填写视频提示词"), "permanent");
  assert.equal(classifyVideoFailure("未找到对应的视频片段"), "permanent");
});

test("retries only once and only for transient failures", () => {
  assert.equal(shouldAutoRetryVideoTask(PLATFORM_GENERIC_FAILURE, 0), true);
  assert.equal(shouldAutoRetryVideoTask(PLATFORM_GENERIC_FAILURE, 1), false);
  assert.equal(shouldAutoRetryVideoTask("工作流不可用", 0), false);
  assert.equal(shouldAutoRetryVideoTask("工作流不可用", -3), false);
  assert.equal(shouldAutoRetryVideoTask(undefined, 0), true);
});

test("resolves the hanging task timeout from env with clamping", () => {
  assert.equal(resolveVideoTaskTimeoutMs(undefined), DEFAULT_VIDEO_TASK_TIMEOUT_MS);
  assert.equal(resolveVideoTaskTimeoutMs(""), DEFAULT_VIDEO_TASK_TIMEOUT_MS);
  assert.equal(resolveVideoTaskTimeoutMs("120000"), 120_000);
  assert.equal(resolveVideoTaskTimeoutMs(1), 60_000);
  assert.equal(resolveVideoTaskTimeoutMs(24 * 60 * 60 * 1000), 6 * 60 * 60 * 1000);
});

test("detects hanging tasks at the threshold boundary", () => {
  const startedAt = 1_000_000;
  assert.equal(isVideoTaskTimedOut(startedAt, startedAt + 60_000, 60_000), true);
  assert.equal(isVideoTaskTimedOut(startedAt, startedAt + 59_999, 60_000), false);
  assert.equal(isVideoTaskTimedOut(0, startedAt + 60_000, 60_000), false);
});
