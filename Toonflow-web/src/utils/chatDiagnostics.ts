/**
 * 断连现场诊断（纯前端，轻量）。
 *
 * 目的：把"心跳超时"这一类断连的现场信息留下来，用来区分两种根因：
 * - 前端卡住：主线程被长任务占满 / 页面被后台节流（可见性 + 长任务记录能看出来）；
 * - 后端卡住：长时间收不到任何服务端数据（最后收包时间能看出来）。
 *
 * 不依赖任何后端改动，只往控制台输出；不影响业务逻辑。
 */

interface LongTaskRecord {
  at: number;
  durationMs: number;
}

const LONG_TASK_LIMIT = 10;

let lastPacketAt = 0;
let disconnectCount = 0;
let reconnectCount = 0;
let longTaskObserver: PerformanceObserver | null = null;
const longTasks: LongTaskRecord[] = [];

/** 安装长任务观测（浏览器不支持则静默跳过） */
export function installLongTaskObserver() {
  if (longTaskObserver) return;
  if (typeof PerformanceObserver === "undefined") return;
  try {
    longTaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration < 1000) continue;
        longTasks.push({ at: Math.round(entry.startTime), durationMs: Math.round(entry.duration) });
      }
      if (longTasks.length > LONG_TASK_LIMIT) longTasks.splice(0, longTasks.length - LONG_TASK_LIMIT);
    });
    longTaskObserver.observe({ entryTypes: ["longtask"] });
  } catch {
    longTaskObserver = null;
  }
}

/** 每收到一条服务端推送就调用：记录"最后活跃时间" */
export function noteSocketPacket() {
  lastPacketAt = Date.now();
  installLongTaskObserver();
}

/** 距最后一次收到服务端数据过了多少毫秒（从未收到过返回 -1） */
export function getLastActivityAgoMs(now: number = Date.now()): number {
  return lastPacketAt ? now - lastPacketAt : -1;
}

export interface DisconnectSnapshot {
  reason: string;
  at: string;
  visibility: string;
  online: boolean | null;
  lastPacketAgoMs: number;
  disconnects: number;
  reconnects: number;
  longTasks: LongTaskRecord[];
}

/** 断连时输出现场快照（可见性 / 是否离线 / 最后收包 / 近期长任务） */
export function recordSocketDisconnect(reason: string): DisconnectSnapshot {
  disconnectCount += 1;
  const snapshot: DisconnectSnapshot = {
    reason,
    at: new Date().toISOString(),
    visibility: typeof document !== "undefined" ? document.visibilityState : "unknown",
    online: typeof navigator !== "undefined" ? navigator.onLine : null,
    lastPacketAgoMs: getLastActivityAgoMs(),
    disconnects: disconnectCount,
    reconnects: reconnectCount,
    longTasks: longTasks.slice(-5),
  };
  console.warn("[Chat Diagnostics] 断连现场:", snapshot);
  return snapshot;
}

/** 重连成功时输出恢复快照 */
export function recordSocketReconnect(): void {
  reconnectCount += 1;
  console.log("[Chat Diagnostics] 重连成功:", {
    lastPacketAgoMs: getLastActivityAgoMs(),
    reconnects: reconnectCount,
    longTasks: longTasks.slice(-3),
  });
}
