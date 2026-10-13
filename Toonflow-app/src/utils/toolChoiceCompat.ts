/**
 * 思考模式下的强制工具选择兼容层。
 *
 * 文本请求统一开启思考（见 `ai.ts` 的 TEXT_THINK_DEFAULT），但部分供应商在思考模式下
 * 不接受"强制工具选择"：DeepSeek 会直接返回
 * `Thinking mode does not support this tool_choice (request_id: ...)`；
 * 换成 `auto` 后虽然可用，但提示词很长时模型可能只回正文、不调工具，
 * 于是"必须有工具结果"的调用方（视频提示词推理）拿不到数据。
 *
 * 实测结论（deepseek-v4-flash，直连官方接口）：
 *   thinking=enabled  + required → 400 上述错误
 *   thinking=enabled  + auto     → 200，工具调用不保证
 *   thinking=disabled + required → 200 且稳定返回工具调用
 *
 * 因此这里只提供"判定 + 进程内记忆"，由 `ai.ts` 组织降级链：
 *   思考+强制 → （被拒）思考+auto → （仍无工具调用）关思考+强制。
 */

const TOOL_CHOICE_REJECTED =
  /(?:does not support|not supported|unsupported|不支持|无法使用)[^。\n]{0,24}tool_choice|tool_choice[^。\n]{0,24}(?:not supported|unsupported|does not support|不支持)/i;

/** 已知"思考模式不支持强制工具选择"的模型（进程内记忆，避免每次都先失败一次）。 */
const relaxedToolChoiceModels = new Set<string>();
/** 已知"auto 下不保证调用工具"的模型：直接改用"关思考 + 强制"一次成功。 */
const noThinkingToolChoiceModels = new Set<string>();

export function isForcedToolChoice(value: unknown) {
  return (
    value === "required" ||
    value === "any" ||
    Boolean(value && typeof value === "object")
  );
}

/** 把可能包了一层的供应商错误压成可匹配的文本。 */
export function describeAiError(error: unknown) {
  const raw = error as {
    message?: unknown;
    responseBody?: unknown;
    data?: unknown;
    cause?: unknown;
  };
  return [
    String(raw?.message || error || ""),
    String(raw?.responseBody || ""),
    JSON.stringify(raw?.data ?? ""),
    String((raw?.cause as { message?: unknown })?.message || raw?.cause || ""),
  ].join(" ");
}

/** 供应商是否因"思考模式不支持该 tool_choice"而拒绝。 */
export function isToolChoiceRejected(error: unknown) {
  return TOOL_CHOICE_REJECTED.test(describeAiError(error));
}

/** 把强制工具选择放宽为 `auto`；本来就不是强制形态时返回 null。 */
export function relaxForcedToolChoice<T extends { toolChoice?: unknown }>(
  options: T,
): T | null {
  if (!isForcedToolChoice(options.toolChoice)) return null;
  return { ...options, toolChoice: "auto" };
}

/** generateText 结果里是否真的产生了工具调用（客户端工具会在此步执行）。 */
export function resultHasToolCall(result: unknown) {
  const value = result as {
    steps?: Array<{ toolCalls?: unknown[] }>;
    toolCalls?: unknown[];
  };
  if (Array.isArray(value?.steps) && value.steps.some((step) => (step?.toolCalls || []).length > 0)) {
    return true;
  }
  return Array.isArray(value?.toolCalls) && value.toolCalls.length > 0;
}

export function markToolChoiceRelaxed(modelKey: string) {
  if (modelKey) relaxedToolChoiceModels.add(modelKey);
}

export function isToolChoiceRelaxed(modelKey: string) {
  return Boolean(modelKey) && relaxedToolChoiceModels.has(modelKey);
}

export function markToolChoiceNeedsNoThinking(modelKey: string) {
  if (modelKey) noThinkingToolChoiceModels.add(modelKey);
}

export function isToolChoiceNeedsNoThinking(modelKey: string) {
  return Boolean(modelKey) && noThinkingToolChoiceModels.has(modelKey);
}
