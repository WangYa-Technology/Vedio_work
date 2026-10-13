import assert from "node:assert/strict";
import test from "node:test";
import {
  parseVideoTaskTiming,
  shouldMarkVideoTaskTimedOut,
} from "./videoTaskWatchdog";

const STARTED_AT = 1_700_000_000_000;
const TIMEOUT_MS = 30 * 60 * 1000;

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    videoTrackId: 2,
    state: "生成中",
    createTime: STARTED_AT,
    providerTaskData: JSON.stringify({ startedAt: STARTED_AT, runId: "run" }),
    ...overrides,
  };
}

test("reads timing from providerTaskData and falls back to createTime", () => {
  assert.deepEqual(parseVideoTaskTiming(JSON.stringify({ startedAt: STARTED_AT }), 123), {
    startedAt: STARTED_AT,
    abandonedAt: 0,
    timeoutAt: 0,
    autoRetryCount: 0,
  });
  assert.equal(parseVideoTaskTiming(null, 456).startedAt, 456);
  assert.equal(parseVideoTaskTiming("not-json", 789).startedAt, 789);
  assert.equal(
    parseVideoTaskTiming(JSON.stringify({ autoRetryCount: 1, abandonedAt: 99 }), 0)
      .autoRetryCount,
    1,
  );
});

test("marks only hanging tasks that passed the timeout threshold", () => {
  assert.equal(shouldMarkVideoTaskTimedOut(row(), STARTED_AT + TIMEOUT_MS, TIMEOUT_MS), true);
  assert.equal(
    shouldMarkVideoTaskTimedOut(row(), STARTED_AT + TIMEOUT_MS - 1, TIMEOUT_MS),
    false,
  );
  assert.equal(
    shouldMarkVideoTaskTimedOut(row({ state: "已完成" }), STARTED_AT + TIMEOUT_MS * 2, TIMEOUT_MS),
    false,
  );
});

test("ignores abandoned and already-timed-out records", () => {
  const abandoned = row({
    providerTaskData: JSON.stringify({ startedAt: STARTED_AT, abandonedAt: STARTED_AT + 1000 }),
  });
  assert.equal(
    shouldMarkVideoTaskTimedOut(abandoned, STARTED_AT + TIMEOUT_MS * 2, TIMEOUT_MS),
    false,
  );
  const timedOut = row({
    providerTaskData: JSON.stringify({ startedAt: STARTED_AT, timeoutAt: STARTED_AT + TIMEOUT_MS }),
  });
  assert.equal(
    shouldMarkVideoTaskTimedOut(timedOut, STARTED_AT + TIMEOUT_MS * 2, TIMEOUT_MS),
    false,
  );
});

test("ignores records without a usable start time", () => {
  assert.equal(
    shouldMarkVideoTaskTimedOut(
      { id: 3, state: "生成中", providerTaskData: "{}", createTime: null },
      STARTED_AT,
      TIMEOUT_MS,
    ),
    false,
  );
});
