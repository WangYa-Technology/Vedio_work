import assert from "node:assert/strict";
import test from "node:test";
import {
  buildContinuationInstruction,
  buildContinuationMessages,
  continuationOverlapLength,
  getLastXmlElement,
  isArtifactTruncated,
  pickContinuationContext,
  spliceContinuation,
} from "./artifactContinuation";

const FULL = [
  "<storySkeleton>",
  "### 故事核",
  "摆摊青年靠一手复刻味道逆袭，核心爽点是当众揭穿仿冒者。",
  "### 隐线（人物弧）",
  "被否定的手艺人 → 用味道自证 → 发现认可来自自己。",
  "### 人物小传",
  "**【主角】陈照野**：五要素齐全，说话风格短句、口头禅「下一位」。",
  "### 三幕结构",
  "第一幕绝境与觉醒，第二幕反击与高潮，第三幕新关系与新战场。",
  "### 分集决策",
  "### 集1：开局（第1章）",
  "**场景核心：** 摊前被砸场，主角先忍后立威。",
  "**集末钩子：** 摊前站定，我来立个规矩。",
  "### 集2：反击（第2章）",
  "**场景核心：** 用一份盲测配方打脸仿冒者。",
  "**集末钩子：** 明天见。",
  "### 股价级反转登记表",
  "| # | 反转类型 | 一句话描述 |",
  "</storySkeleton>",
].join("\n");

test("取最后一个开闭标签之间的内容，未闭合时返回 undefined", () => {
  const element = getLastXmlElement(`说明\n<storySkeleton part="1">\n内容A\n</storySkeleton>`, "storySkeleton");
  assert.equal(element?.attrs, 'part="1"');
  assert.equal(element?.content, "内容A");

  assert.equal(getLastXmlElement("<storySkeleton>半截内容", "storySkeleton"), undefined);
  assert.equal(getLastXmlElement("没有标签", "storySkeleton"), undefined);
});

test("截断判定：有开标签无闭合标签才算截断", () => {
  assert.equal(isArtifactTruncated(FULL, "storySkeleton"), false);
  assert.equal(isArtifactTruncated(FULL.slice(0, FULL.indexOf("</storySkeleton>")), "storySkeleton"), true);
  assert.equal(isArtifactTruncated("模型只输出了思路，没有标签", "storySkeleton"), false);
  assert.equal(isArtifactTruncated("   ", "storySkeleton"), false);
  // 已闭合但内容为空：属于格式问题而非截断，不应触发续写
  assert.equal(isArtifactTruncated("<storySkeleton></storySkeleton>", "storySkeleton"), false);
});

test("重叠裁剪：模型重抄的尾部被裁掉，正常内容不误伤", () => {
  const shared = "钩子是：摊前站定，等我立完规矩再说下一句台词，别急。";
  const previous = `第一段结束。${shared}`;
  const duplicate = `${shared}第二段开始。`;
  assert.equal(continuationOverlapLength(previous, duplicate), shared.length);

  const spliced = spliceContinuation(previous, duplicate);
  assert.equal(spliced.text, `${previous}第二段开始。`);
  assert.equal(spliced.appended, "第二段开始。");

  // 低于最小重叠长度的巧合重复不裁剪
  const noOverlap = spliceContinuation("甲乙丙丁戊己庚辛壬癸", "甲乙丙丁戊己庚辛壬癸后续内容后续内容");
  assert.equal(noOverlap.appended, "甲乙丙丁戊己庚辛壬癸后续内容后续内容");
});

test("截断 + 续写拼接后得到完整产出物", () => {
  const cut = Math.floor(FULL.length * 0.6);
  const truncated = FULL.slice(0, cut);
  const continuationChunk = FULL.slice(cut - 40); // 续写片段重抄了尾部 40 字
  const { text, appended } = spliceContinuation(truncated, continuationChunk);

  assert.equal(appended, FULL.slice(cut));
  assert.equal(text, FULL);
  assert.equal(isArtifactTruncated(text, "storySkeleton"), false);
  assert.match(getLastXmlElement(text, "storySkeleton")?.content ?? "", /集末钩子/);
});

test("续写指令：带闭合标签名与已输出尾部，且明确禁止重复", () => {
  const instruction = buildContinuationInstruction("storySkeleton", FULL.slice(0, 80), 40);
  assert.match(instruction, /<\/storySkeleton>/);
  assert.match(instruction, /不要重复/);
  assert.match(instruction, new RegExp(FULL.slice(40, 80).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("续写消息：以「已生成全文 + 续写指令」结尾，消息数线性增长", () => {
  const base = [
    { role: "user", content: "生成故事骨架" },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "t1", toolName: "get_novel_events", input: {} }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "t1", toolName: "get_novel_events", output: "事件表" }] },
  ] as any;
  const messages = buildContinuationMessages(base, FULL.slice(0, 60), "storySkeleton") as any[];
  assert.equal(messages.length, base.length + 2);
  assert.equal(messages[messages.length - 2].role, "assistant");
  assert.equal(messages[messages.length - 2].content, FULL.slice(0, 60));
  assert.equal(messages[messages.length - 1].role, "user");
  assert.match(messages[messages.length - 1].content, /继续输出/);
});

test("续写上下文：保留工具消息，丢弃会被续写文本替代的纯文本回复", () => {
  const messages = [
    { role: "user", content: "生成故事骨架" },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "t1", toolName: "get_novel_events", input: {} }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "t1", toolName: "get_novel_events", output: "事件表" }] },
    { role: "assistant", content: "<storySkeleton>半截内容" },
  ] as any;
  const picked = pickContinuationContext(messages);
  assert.equal(picked.length, 2);
  assert.equal(picked[0].role, "assistant");
  assert.equal(picked[1].role, "tool");
});
