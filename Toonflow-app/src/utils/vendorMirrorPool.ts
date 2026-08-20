type MirrorState = { url: string; active: boolean };

type MirrorWaiter = {
  excludedUrls: Set<string>;
  resolve: (state: MirrorState) => void;
};

type MirrorPool = { states: MirrorState[]; waiters: MirrorWaiter[] };

export type MirrorLease = {
  state: MirrorState;
  release: () => void;
};

export type MirrorAttempt = {
  url: string;
  promptSubmitted: boolean;
};

export function configuredMirrorUrls(inputValues: Record<string, any>): string[] {
  const raw = inputValues.baseUrls;
  let urls: unknown[] = [];
  if (Array.isArray(raw)) urls = raw;
  else if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) urls = parsed;
    } catch {
      // Keep compatibility with old configurations that only have baseUrl.
    }
  }
  const fallback = String(inputValues.baseUrl || "").trim();
  const normalized = [...new Set([...urls.map((url) => String(url || "").trim()), fallback].filter(Boolean))];
  const bundledExample = "http://127.0.0.1:16006";
  if (fallback && fallback !== bundledExample && normalized.length === 2 && normalized.includes(bundledExample)) {
    return [fallback];
  }
  return normalized;
}

export class VendorMirrorPoolManager {
  private readonly pools = new Map<string, MirrorPool>();

  async acquire(vendorId: string, urls: string[], excludedUrls = new Set<string>()): Promise<MirrorLease | null> {
    const pool = this.getPool(vendorId, urls);
    const candidates = pool.states.filter((state) => !excludedUrls.has(state.url));
    if (!candidates.length) return null;

    const available = candidates.find((state) => !state.active);
    if (available) return this.lease(pool, available);

    const state = await new Promise<MirrorState>((resolve) => {
      pool.waiters.push({ excludedUrls: new Set(excludedUrls), resolve });
    });
    return this.lease(pool, state, true);
  }

  private getPool(vendorId: string, urls: string[]): MirrorPool {
    const existing = this.pools.get(vendorId);
    const stateByUrl = new Map((existing?.states || []).map((state) => [state.url, state]));
    const pool: MirrorPool = existing || { states: [], waiters: [] };
    pool.states = urls.map((url) => stateByUrl.get(url) || { url, active: false });
    this.pools.set(vendorId, pool);
    return pool;
  }

  private lease(pool: MirrorPool, state: MirrorState, alreadyActive = false): MirrorLease {
    if (!alreadyActive) state.active = true;
    let released = false;
    return {
      state,
      release: () => {
        if (released) return;
        released = true;
        this.release(pool, state);
      },
    };
  }

  private release(pool: MirrorPool, state: MirrorState): void {
    state.active = false;
    if (!pool.states.includes(state)) return;
    const waiterIndex = pool.waiters.findIndex((waiter) => !waiter.excludedUrls.has(state.url));
    if (waiterIndex < 0) return;
    const [waiter] = pool.waiters.splice(waiterIndex, 1);
    state.active = true;
    waiter.resolve(state);
  }
}

export function shouldTryNextMirror(error: unknown, promptSubmitted: boolean): boolean {
  if (promptSubmitted) return false;
  const details = error as {
    isAxiosError?: boolean;
    message?: string;
    config?: { url?: string };
    response?: unknown;
  } | null;
  const requestUrl = String(details?.config?.url || "");

  // A lost response from POST /prompt is ambiguous: the remote GPU may already
  // be generating, so retrying elsewhere could create a duplicate paid task.
  if (/\/prompt(?:\?|$)/i.test(requestUrl) && !details?.response) return false;
  if (details?.isAxiosError || requestUrl) return true;

  const message = String(details?.message || error || "");
  return /当前 ComfyUI 镜像|节点清单不可用|缺少云端资源|ComfyUI (?:上传|未返回 prompt_id)/i.test(message);
}

export function formatMirrorFailure(url: string, error: unknown): string {
  const details = error as {
    message?: string;
    code?: string;
    response?: { status?: number };
  } | null;
  const status = details?.response?.status;
  const reason = status ? `HTTP ${status}` : details?.code || details?.message || String(error);
  return `${url}: ${reason}`;
}

export const vendorMirrorPool = new VendorMirrorPoolManager();

export async function runWithMirrorFailover<T>(options: {
  vendorId: string;
  urls: string[];
  run: (attempt: MirrorAttempt) => Promise<T>;
  onRetry?: (failure: string) => void;
}): Promise<T> {
  const attemptedUrls = new Set<string>();
  const failures: string[] = [];

  while (attemptedUrls.size < options.urls.length) {
    const lease = await vendorMirrorPool.acquire(options.vendorId, options.urls, attemptedUrls);
    if (!lease) break;
    const attempt: MirrorAttempt = { url: lease.state.url, promptSubmitted: false };
    try {
      return await options.run(attempt);
    } catch (error) {
      attemptedUrls.add(attempt.url);
      const failure = formatMirrorFailure(attempt.url, error);
      failures.push(failure);
      if (!shouldTryNextMirror(error, attempt.promptSubmitted) || attemptedUrls.size >= options.urls.length) {
        if (failures.length === 1) throw error;
        throw new Error(`已尝试 ${failures.length} 个 ComfyUI 云端镜像，均失败：${failures.join("；")}`);
      }
      options.onRetry?.(failure);
    } finally {
      lease.release();
    }
  }
  throw new Error(`没有可用的 ComfyUI 云端镜像：${options.urls.join("、")}`);
}
