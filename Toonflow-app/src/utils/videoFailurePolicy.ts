/**
 * 视频生成失败的分类与重试阈值。
 *
 * 视频供应商（尤其云端工作流平台）会把「平台这一跑挂了」和「你的入参不合法」
 * 统一成一句通用文案返回，二者只能靠文案关键词区分：
 * - permanent：参数非法、工作流不可用、参考素材缺失、任务被取消 —— 再提一次只会重复失败/重复扣费；
 * - transient：平台通用失败、超时、网络抖动、5xx、显存/排队类 —— 立即自动重提一次通常能成功。
 *
 * 默认策略：命中 permanent 关键词才算不可重试，其余一律按偶发处理（含未知文案），
 * 与「平台偶发失败自动重试 1 次」的产品约定一致。
 */

export type VideoFailureClass = "transient" | "permanent";

/** 自动重试上限：平台偶发失败只静默重提一次，仍失败才暴露给用户。 */
export const VIDEO_AUTO_RETRY_LIMIT = 1;

/** 生成中任务的超时兜底阈值：默认 30 分钟。 */
export const DEFAULT_VIDEO_TASK_TIMEOUT_MS = 30 * 60 * 1000;
const MIN_VIDEO_TASK_TIMEOUT_MS = 60 * 1000;
const MAX_VIDEO_TASK_TIMEOUT_MS = 6 * 60 * 60 * 1000;

const PERMANENT_RULES: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /未定义的参数|参数不合法|参数校验|参数错误|参数超出|非法的参数/, label: "提交参数不合法" },
  { pattern: /工作流不可用|工作流不存在|workflow\s*(?:not\s*found|unavailable|disabled)/i, label: "工作流不可用" },
  { pattern: /不支持|仅支持/, label: "当前模型不支持该能力" },
  { pattern: /请先(?:填写|选择)|需要\s*\d*\s*(?:张|段|个)参考|缺少参考|参考素材|尚无可用图片|没有可用图片/, label: "参考素材缺失" },
  { pattern: /提示词为空|缺少视频提示词|请先填写视频提示词/, label: "提示词缺失" },
  { pattern: /不存在|未找到|已失效|已被删除|已被下线/, label: "资源或记录已失效" },
  { pattern: /已取消|取消生成|canceled|cancelled/i, label: "任务已被取消" },
];

const TRANSIENT_RULES: RegExp[] = [
  /任务处理失败，结果未生成/, // AutoDL 平台通用失败文案（本次线上样本）
  /工作流执行失败/,
  /工作流成功但未返回结果/,
  /WorkflowExecutionError|InternalError|ServiceUnavailable|ServerError|BadGateway/i,
  /（(?:429|500|502|503|504)）/,
  /timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNABORTED|ECONNREFUSED|EPIPE|socket hang up|network error|EAI_AGAIN|网络错误|请求超时|任务超时/i,
  /显存|OOM|out of memory|模型加载失败/i,
  /排队|队列|繁忙|busy|rate limit|Too Many Requests/i,
  /ComfyUI 生成失败/,
];

function normalizeReason(reason: unknown) {
  return String(reason ?? "").trim();
}

/** 返回命中的「不可重试」原因标签，未命中返回空串（仅用于日志与文案）。 */
export function matchPermanentVideoFailureReason(reason: unknown): string {
  const text = normalizeReason(reason);
  if (!text) return "";
  return PERMANENT_RULES.find((rule) => rule.pattern.test(text))?.label || "";
}

/**
 * 归类一次视频生成失败。
 * @param reason 供应商/管线抛出的错误文案
 * @param provider 供应商 ID（可选，仅用于日志扩展，不影响判定）
 */
export function classifyVideoFailure(
  reason: unknown,
  provider?: string,
): VideoFailureClass {
  void provider;
  const text = normalizeReason(reason);
  if (!text) return "transient";
  if (matchPermanentVideoFailureReason(text)) return "permanent";
  if (TRANSIENT_RULES.some((pattern) => pattern.test(text))) return "transient";
  // 未知文案按偶发处理：平台通用失败常常没有任何可识别关键词。
  return "transient";
}

/** 是否还应该自动重试：仅偶发失败且未达到重试上限。 */
export function shouldAutoRetryVideoTask(
  reason: unknown,
  autoRetryCount: number,
  provider?: string,
): boolean {
  const count = Number.isFinite(autoRetryCount) ? Math.max(0, Math.floor(autoRetryCount)) : 0;
  if (count >= VIDEO_AUTO_RETRY_LIMIT) return false;
  return classifyVideoFailure(reason, provider) === "transient";
}

/** 生成中任务的超时阈值（env `VIDEO_TASK_TIMEOUT_MS`，默认 30 分钟，限制在 1 分钟~6 小时）。 */
export function resolveVideoTaskTimeoutMs(
  raw: unknown = process.env.VIDEO_TASK_TIMEOUT_MS,
): number {
  const configured = Number(raw);
  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_VIDEO_TASK_TIMEOUT_MS;
  }
  return Math.min(
    Math.max(Math.round(configured), MIN_VIDEO_TASK_TIMEOUT_MS),
    MAX_VIDEO_TASK_TIMEOUT_MS,
  );
}

/** 超时判定：到达阈值即认为这一跑已经卡死（供看门狗与手动标记共用）。 */
export function isVideoTaskTimedOut(
  startedAt: number,
  now: number,
  timeoutMs = resolveVideoTaskTimeoutMs(),
): boolean {
  if (!Number.isFinite(startedAt) || startedAt <= 0) return false;
  if (!Number.isFinite(now) || now <= 0) return false;
  return now - startedAt >= timeoutMs;
}
