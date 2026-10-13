import assert from "node:assert/strict";
import test from "node:test";
import {
  describeAiError,
  isForcedToolChoice,
  isToolChoiceNeedsNoThinking,
  isToolChoiceRejected,
  isToolChoiceRelaxed,
  markToolChoiceNeedsNoThinking,
  markToolChoiceRelaxed,
  relaxForcedToolChoice,
  resultHasToolCall,
} from "./toolChoiceCompat";

test("recognizes forced tool choice forms", () => {
  assert.equal(isForcedToolChoice("required"), true);
  assert.equal(isForcedToolChoice("any"), true);
  assert.equal(isForcedToolChoice({ type: "tool", toolName: "resultTool" }), true);
  assert.equal(isForcedToolChoice("auto"), false);
  assert.equal(isForcedToolChoice("none"), false);
  assert.equal(isForcedToolChoice(undefined), false);
});

test("detects the thinking-mode tool_choice rejection", () => {
  assert.equal(
    isToolChoiceRejected(
      new Error(
        "Thinking mode does not support this tool_choice (request_id: a2d0a1fd-ae3b-4dea-94f1-e2a41c924c3c)",
      ),
    ),
    true,
  );
  assert.equal(
    isToolChoiceRejected(
      Object.assign(new Error("Bad Request"), {
        responseBody:
          '{"error":{"message":"Thinking mode does not support this tool_choice"}}',
      }),
    ),
    true,
  );
  assert.equal(
    isToolChoiceRejected(
      Object.assign(new Error("Bad Request"), {
        cause: new Error("tool_choice: required is unsupported in thinking mode"),
      }),
    ),
    true,
  );
  assert.equal(isToolChoiceRejected(new Error("Insufficient Balance")), false);
  assert.equal(isToolChoiceRejected(new Error("Request timed out")), false);
});

test("relaxes only forced tool choices", () => {
  const options = { toolChoice: "required", tools: { resultTool: {} } };
  assert.deepEqual(relaxForcedToolChoice(options), {
    ...options,
    toolChoice: "auto",
  });
  // 原始参数不被就地修改
  assert.equal(options.toolChoice, "required");
  assert.equal(relaxForcedToolChoice({ toolChoice: "auto" }), null);
  assert.equal(relaxForcedToolChoice({ toolChoice: "none" }), null);
  assert.equal(relaxForcedToolChoice({}), null);
});

test("detects whether a result actually contains a tool call", () => {
  assert.equal(resultHasToolCall({ steps: [{ toolCalls: [{ toolName: "resultTool" }] }] }), true);
  assert.equal(resultHasToolCall({ toolCalls: [{ toolName: "resultTool" }] }), true);
  assert.equal(resultHasToolCall({ steps: [{ toolCalls: [] }], text: "只有正文" }), false);
  assert.equal(resultHasToolCall({ text: "只有正文" }), false);
  assert.equal(resultHasToolCall(undefined), false);
});

test("keeps a readable description of nested provider errors", () => {
  const description = describeAiError(
    Object.assign(new Error("Bad Request"), {
      cause: new Error("tool_choice: required is unsupported in thinking mode"),
      data: { status: 400 },
    }),
  );
  assert.match(description, /Bad Request/);
  assert.match(description, /unsupported in thinking mode/);
  assert.match(description, /"status":400/);
});

test("remembers the strategy that works per model", () => {
  assert.equal(isToolChoiceRelaxed("deepseek:deepseek-flash"), false);
  assert.equal(isToolChoiceNeedsNoThinking("deepseek:deepseek-flash"), false);
  markToolChoiceRelaxed("deepseek:deepseek-flash");
  assert.equal(isToolChoiceRelaxed("deepseek:deepseek-flash"), true);
  assert.equal(isToolChoiceRelaxed("openai:gpt-5.5"), false);
  markToolChoiceNeedsNoThinking("deepseek:deepseek-flash");
  assert.equal(isToolChoiceNeedsNoThinking("deepseek:deepseek-flash"), true);
  assert.equal(isToolChoiceNeedsNoThinking(""), false);
});
