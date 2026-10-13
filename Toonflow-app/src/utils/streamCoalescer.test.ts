import assert from "node:assert/strict";
import test from "node:test";
import { MergeCoalescer, TextCoalescer, type CoalescerScheduler } from "./streamCoalescer";

/** 假时钟：手动触发到点的定时器，保证单测确定性 */
function createFakeScheduler() {
  const tasks = new Map<number, () => void>();
  let seq = 0;
  const scheduler: CoalescerScheduler = {
    schedule: (fn) => {
      const handle = ++seq;
      tasks.set(handle, fn);
      return handle;
    },
    cancel: (handle) => {
      tasks.delete(handle as number);
    },
  };
  return {
    scheduler,
    get pendingCount() {
      return tasks.size;
    },
    runAll() {
      const entries = [...tasks.entries()];
      tasks.clear();
      for (const [, fn] of entries) fn();
    },
  };
}

test("文本合并：时间窗内多次 append 合并为一次，顺序不变", () => {
  const flushed: string[] = [];
  const clock = createFakeScheduler();
  const coalescer = new TextCoalescer((text) => flushed.push(text), { intervalMs: 100, scheduler: clock.scheduler });

  coalescer.push("第一段");
  coalescer.push("第二段");
  coalescer.push("第三段");

  assert.deepEqual(flushed, [], "未到时间窗不应推送");
  assert.equal(coalescer.pendingChars, 9);
  assert.equal(clock.pendingCount, 1, "只应有一个待触发的定时器");

  clock.runAll();
  assert.deepEqual(flushed, ["第一段第二段第三段"]);
  assert.equal(coalescer.hasPending, false);
});

test("文本合并：达到体积阈值立即冲刷，并取消已排定的定时器", () => {
  const flushed: string[] = [];
  const clock = createFakeScheduler();
  const coalescer = new TextCoalescer((text) => flushed.push(text), { intervalMs: 100, maxChars: 10, scheduler: clock.scheduler });

  coalescer.push("12345");
  assert.equal(clock.pendingCount, 1);
  coalescer.push("67890");
  assert.deepEqual(flushed, ["1234567890"], "达到阈值应立即推送");
  assert.equal(clock.pendingCount, 0, "立即冲刷后不应再留下定时器");

  clock.runAll();
  assert.deepEqual(flushed, ["1234567890"], "不应重复推送");
});

test("文本合并：flushNow 立即推送并清理缓冲", () => {
  const flushed: string[] = [];
  const clock = createFakeScheduler();
  const coalescer = new TextCoalescer((text) => flushed.push(text), { intervalMs: 100, scheduler: clock.scheduler });

  coalescer.push("增量一");
  coalescer.flushNow();
  assert.deepEqual(flushed, ["增量一"]);
  assert.equal(clock.pendingCount, 0);

  coalescer.flushNow();
  assert.deepEqual(flushed, ["增量一"], "无缓冲时不应产生空推送");

  coalescer.push("增量二");
  coalescer.dispose();
  clock.runAll();
  assert.deepEqual(flushed, ["增量一"], "dispose 后不得再推送");
});

test("对象合并：多次 merge 浅合并为一次，后到字段覆盖同名键且不丢其它键", () => {
  const flushed: Array<Partial<{ title: string; text: string }>> = [];
  const clock = createFakeScheduler();
  const coalescer = new MergeCoalescer<{ title: string; text: string }>((data) => flushed.push(data), {
    intervalMs: 150,
    scheduler: clock.scheduler,
  });

  coalescer.push({ text: "第一版全文" });
  coalescer.push({ title: "思考中..." });
  coalescer.push({ text: "第二版全文" });

  assert.deepEqual(flushed, []);
  clock.runAll();
  assert.deepEqual(flushed, [{ text: "第二版全文", title: "思考中..." }]);

  coalescer.push({ title: "思考完毕（1.0秒）" });
  coalescer.flushNow();
  assert.equal(flushed.length, 2);
  assert.deepEqual(flushed[1], { title: "思考完毕（1.0秒）" });
});

test("对象合并：无缓冲时 flushNow 不推送，dispose 丢弃缓冲", () => {
  const flushed: Array<Partial<{ text: string }>> = [];
  const clock = createFakeScheduler();
  const coalescer = new MergeCoalescer<{ text: string }>((data) => flushed.push(data), { intervalMs: 150, scheduler: clock.scheduler });

  coalescer.flushNow();
  assert.deepEqual(flushed, []);

  coalescer.push({ text: "不应发送" });
  coalescer.dispose();
  clock.runAll();
  assert.deepEqual(flushed, []);
});
