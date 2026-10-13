import { monitorEventLoopDelay } from "node:perf_hooks";

/**
 * 事件循环延迟监测。
 *
 * 背景：服务端存在若干同步重计算（确定性检查、SQLite 写入、大 JSON 序列化）。
 * 一旦某段同步逻辑长时间独占事件循环，socket.io 的 ping 就发不出去，
 * 客户端会在 145 秒后以"心跳超时"自断——而现场只留下断连提示，没有根因证据。
 *
 * 这里用 Node 自带的事件循环直方图采样，发现超过阈值的阻塞就打印告警
 * （可附带最近日志作为上下文），配合文件日志即可直接定位是哪一段卡住的。
 */

export interface LoopLagMonitorOptions {
  /** 阻塞告警阈值（毫秒），默认 1000 */
  thresholdMs?: number;
  /** 采样上报间隔（毫秒），默认 2000 */
  reportIntervalMs?: number;
  /** 自定义告警输出；默认 console.warn */
  onLag?: (info: { maxMs: number; meanMs: number }) => void;
  /** 告警时附带的上下文（例如最近日志行） */
  contextProvider?: () => string[];
}

export interface LoopLagMonitorHandle {
  stop: () => void;
}

export function startLoopLagMonitor(options: LoopLagMonitorOptions = {}): LoopLagMonitorHandle {
  const thresholdMs = options.thresholdMs ?? 1000;
  const reportIntervalMs = options.reportIntervalMs ?? 2000;

  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();

  const timer = setInterval(() => {
    const maxMs = Math.round(histogram.max / 1e6);
    const meanMs = Math.round(histogram.mean / 1e6);
    histogram.reset();
    if (maxMs < thresholdMs) return;

    if (options.onLag) {
      options.onLag({ maxMs, meanMs });
      return;
    }
    const context = options.contextProvider?.().filter(Boolean) ?? [];
    const contextText = context.length ? `\n  最近日志：\n  ${context.join("\n  ")}` : "";
    console.warn(`[loopLag] 事件循环阻塞 ${maxMs}ms（均值 ${meanMs}ms）：可能有同步重计算占用主线程，心跳/推送可能延迟${contextText}`);
  }, reportIntervalMs);

  // 不阻止进程退出
  if (typeof timer.unref === "function") timer.unref();

  return {
    stop: () => {
      clearInterval(timer);
      histogram.disable();
    },
  };
}
