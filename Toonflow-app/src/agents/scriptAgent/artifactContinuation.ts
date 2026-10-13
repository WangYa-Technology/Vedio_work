import type { ModelMessage } from "ai";

/**
 * 超长产出物的「截断续写」支撑（纯函数，可单测）。
 *
 * 背景：宿主对故事骨架 / 改编策略 / 剧本等产出物的验收口径是"一条完整 XML"。
 * 分集表 + 关键集展开这类长产出很容易触到模型或供应商的单次输出上限，
 * 表现为流式输出到一半就停、缺少闭合标签；旧实现只能整段重生成，再次被同样截断。
 *
 * 这里把"一次超长输出"拆成"多段连续输出"由宿主拼接：
 * 判定截断 → 引导模型从中断处续写 → 按重叠裁剪去重后拼接，
 * 直到出现闭合标签或达到段数上限。协议、格式和下游解析都保持不变。
 */

export interface XmlElement {
  attrs: string;
  content: string;
}

/** 取最后一个开标签及其到对应闭标签之间的内容；开标签缺失或未闭合时返回 undefined */
export function getLastXmlElement(text: string, tag: string): XmlElement | undefined {
  const openPattern = new RegExp(`<${tag}(?:\\s([^>]*))?>`, "g");
  let lastOpen: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  while ((match = openPattern.exec(text)) !== null) lastOpen = match;
  if (!lastOpen) return undefined;

  const contentStart = lastOpen.index + lastOpen[0].length;
  const closeIndex = text.indexOf(`</${tag}>`, contentStart);
  if (closeIndex === -1) return undefined;
  return { attrs: lastOpen[1] ?? "", content: text.slice(contentStart, closeIndex).trim() };
}

/** 是否"已输出开标签、但缺少闭合标签"——即被单次输出上限截断 */
export function isArtifactTruncated(text: string, tag: string): boolean {
  if (!text.trim()) return false;
  if (getLastXmlElement(text, tag)) return false;
  return new RegExp(`<${tag}(?:\\s[^>]*)?>`).test(text);
}

/**
 * 续写片段开头与已生成内容尾部的重叠长度。
 * 模型续写时常常会把最后半句话重抄一遍，拼接前需要裁掉；
 * 低于 minOverlap 的巧合重复不裁，避免误伤正常的相似内容。
 */
export function continuationOverlapLength(previous: string, chunk: string, maxOverlap = 400, minOverlap = 24): number {
  const limit = Math.min(previous.length, chunk.length, maxOverlap);
  for (let length = limit; length >= minOverlap; length -= 1) {
    if (previous.slice(previous.length - length) === chunk.slice(0, length)) return length;
  }
  return 0;
}

/** 把续写片段拼到已生成内容上，返回拼接结果与实际新增的部分（供前端预览保持与后端一致） */
export function spliceContinuation(previous: string, chunk: string, maxOverlap = 400): { text: string; appended: string } {
  const overlap = continuationOverlapLength(previous, chunk, maxOverlap);
  const appended = chunk.slice(overlap);
  return { text: previous + appended, appended };
}

/** 续写指令：明确"从截断处继续"，并回带已输出尾部用于定位 */
export function buildContinuationInstruction(tag: string, previousText: string, tailChars = 500): string {
  const tail = previousText.slice(-tailChars);
  return [
    `上一条回复因单次输出长度上限被中途截断，还没有输出闭合标签 </${tag}>。`,
    `请严格从中断处继续输出后续内容：不要重复已经输出过的任何文字，不要重新开头，不要输出解释、摘要或保存说明，只输出续写部分。`,
    `如需核对后文资料可以调用工具，但不要重复读取已经读过的章节；否则不要调用工具，直接继续输出。`,
    `已输出内容的最后一段如下（仅用于定位接续位置，不要重复它）：`,
    "```",
    tail,
    "```",
  ].join("\n");
}

/**
 * 续写请求的消息序列：保留工具结果上下文，丢弃会被续写文本替代的纯文本 assistant 消息，
 * 最后以"已生成全文（assistant）+ 续写指令（user）"结尾，保证每次请求的输入是线性增长而非重复堆叠。
 */
export function buildContinuationMessages(baseMessages: ModelMessage[], previousText: string, tag: string): ModelMessage[] {
  return [...baseMessages, { role: "assistant", content: previousText }, { role: "user", content: buildContinuationInstruction(tag, previousText) }];
}

/** 续写上下文里只保留工具消息与工具调用消息，纯文本 assistant 消息由续写文本自身替代 */
export function pickContinuationContext(messages: ModelMessage[]): ModelMessage[] {
  return messages.filter((message) => {
    if (message.role === "tool") return true;
    if (message.role !== "assistant") return false;
    return Array.isArray(message.content) && message.content.some((part: any) => typeof part?.type === "string" && part.type.includes("tool"));
  });
}
