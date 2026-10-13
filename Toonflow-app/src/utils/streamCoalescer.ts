/**
 * 流式推送合并器（纯逻辑，可单测）。
 *
 * 背景：服务端逐 chunk 通过 socket 推送 content:update；长文本与 thinking 的全量合并
 * 报文会在生成期间产生极高频率、极高体积的推送，既拖累服务端事件循环（心跳 ping 发不出去），
 * 也拖累前端主线程（渲染 + 运行快照），最终表现为生成中途“连接已断开（心跳超时）”。
 *
 * 这里把高频小包按“时间窗 / 体积阈值”合并：
 * - 文本类（TextCoalescer）：拼接合并，语义与逐条 append 完全一致；
 * - 对象类（MergeCoalescer）：浅合并（后到的字段覆盖同名键），语义与逐条 merge 一致。
 * complete()/error() 等收尾动作必须调用 flushNow()，保证顺序与最终态不变。
 */

export interface CoalescerScheduler {
  schedule: (fn: () => void, ms: number) => unknown;
  cancel: (handle: unknown) => void;
}

export interface CoalescerOptions {
  /** 合并时间窗（毫秒），到点自动冲刷 */
  intervalMs?: number;
  /** 缓冲体积阈值（字符数），达到即立即冲刷 */
  maxChars?: number;
  /** 定时器实现，便于单测注入假时钟 */
  scheduler?: CoalescerScheduler;
}

const DEFAULT_INTERVAL_MS = 100;
const DEFAULT_MAX_CHARS = 8 * 1024;

const defaultScheduler: CoalescerScheduler = {
  schedule: (fn, ms) => setTimeout(fn, ms),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** 文本追加类合并器：把多次 append 合并为一次推送 */
export class TextCoalescer {
  private chunks: string[] = [];
  private chars = 0;
  private timer: unknown = null;
  private readonly intervalMs: number;
  private readonly maxChars: number;
  private readonly scheduler: CoalescerScheduler;

  constructor(
    private readonly flush: (text: string) => void,
    options: CoalescerOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
    this.scheduler = options.scheduler ?? defaultScheduler;
  }

  get pendingChars() {
    return this.chars;
  }

  get hasPending() {
    return this.chunks.length > 0;
  }

  push(chunk: string) {
    if (!chunk) return;
    this.chunks.push(chunk);
    this.chars += chunk.length;
    if (this.chars >= this.maxChars) {
      this.flushNow();
      return;
    }
    if (!this.timer) {
      this.timer = this.scheduler.schedule(() => {
        this.timer = null;
        this.flushNow();
      }, this.intervalMs);
    }
  }

  /** 立即冲刷缓冲（收尾与换语义前必须调用，保证顺序） */
  flushNow() {
    if (this.timer) {
      this.scheduler.cancel(this.timer);
      this.timer = null;
    }
    if (!this.chunks.length) return;
    const text = this.chunks.join("");
    this.chunks = [];
    this.chars = 0;
    this.flush(text);
  }

  /** 丢弃缓冲（不发送） */
  dispose() {
    if (this.timer) {
      this.scheduler.cancel(this.timer);
      this.timer = null;
    }
    this.chunks = [];
    this.chars = 0;
  }
}

/** 对象合并类合并器：把多次 merge 浅合并为一次推送 */
export class MergeCoalescer<T extends object> {
  private pending: Partial<T> | null = null;
  private timer: unknown = null;
  private readonly intervalMs: number;
  private readonly scheduler: CoalescerScheduler;

  constructor(
    private readonly flush: (data: Partial<T>) => void,
    options: CoalescerOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.scheduler = options.scheduler ?? defaultScheduler;
  }

  get hasPending() {
    return this.pending !== null;
  }

  push(partial: Partial<T>) {
    if (!partial) return;
    this.pending = { ...(this.pending ?? {}), ...partial } as Partial<T>;
    if (!this.timer) {
      this.timer = this.scheduler.schedule(() => {
        this.timer = null;
        this.flushNow();
      }, this.intervalMs);
    }
  }

  /** 立即冲刷缓冲（收尾与换语义前必须调用，保证顺序） */
  flushNow() {
    if (this.timer) {
      this.scheduler.cancel(this.timer);
      this.timer = null;
    }
    if (this.pending === null) return;
    const data = this.pending;
    this.pending = null;
    this.flush(data);
  }

  /** 丢弃缓冲（不发送） */
  dispose() {
    if (this.timer) {
      this.scheduler.cancel(this.timer);
      this.timer = null;
    }
    this.pending = null;
  }
}
