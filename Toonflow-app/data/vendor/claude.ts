const vendor = { id: "claude", version: "2.1", author: "漫橙映画", description: "Anthropic Claude API 直连（文本默认开启扩展思考，最高档）", name: "Claude (Anthropic)", icon: "", inputs: [{ key: "apiKey", label: "API密钥", type: "password", required: true },{ key: "baseUrl", label: "接口地址", type: "url", required: false, placeholder: "https://api.anthropic.com/v1" }], inputValues: { apiKey: "", baseUrl: "https://api.anthropic.com/v1" }, models: [{ name: "Claude Sonnet 4.6", modelName: "claude-sonnet-4-6", type: "text", think: false }, { name: "Claude Opus 4.6", modelName: "claude-opus-4-6", type: "text", think: false }, { name: "Claude Haiku 4.5", modelName: "claude-haiku-4-5-20251001", type: "text", think: false }] };
exports.vendor = vendor;

// 默认按「开启思考 + 最高档」处理：Claude 的扩展思考用 thinking.budget_tokens 而非档位名，
// 且接口要求 max_tokens > budget_tokens；调用方已给出较小 max_tokens 时跳过注入，避免非法请求。
const THINK_BUDGET_MAP = { 1: 8000, 2: 12000, 3: 16000 };
const THINK_MAX_TOKENS = 32000;

const textRequest = (textModel, think, thinkLevel) => {
  if (!vendor.inputValues.apiKey) throw new Error("缺少API Key");
  const level = Number.isFinite(Number(thinkLevel)) ? Number(thinkLevel) : 3;
  const budgetTokens = THINK_BUDGET_MAP[level] || THINK_BUDGET_MAP[3];
  const opts = {
    apiKey: vendor.inputValues.apiKey,
    fetch: async (url, options) => {
      const rawBody = JSON.parse((options?.body as string) ?? "{}");
      const isClaudeModel = /^claude-/i.test(String(textModel?.modelName ?? ""));
      const enableThinking = isClaudeModel && think !== false && level > 0;
      const existingMax = Number(rawBody.max_tokens);
      const hasValidMax = Number.isFinite(existingMax) && existingMax > 0;
      const canEnable = enableThinking && (!hasValidMax || existingMax > budgetTokens);
      const modifiedBody = canEnable
        ? {
          thinking: { type: "enabled", budget_tokens: budgetTokens },
          ...(hasValidMax ? {} : { max_tokens: THINK_MAX_TOKENS }),
          ...rawBody,
        }
        : rawBody;
      return await fetch(url, { ...options, body: JSON.stringify(modifiedBody) });
    },
  };
  if (vendor.inputValues.baseUrl) opts.baseURL = vendor.inputValues.baseUrl;
  return createAnthropic(opts).chat(textModel.modelName);
};
exports.textRequest = textRequest;

const imageRequest = async (imageConfig, imageModel) => { return null; };
exports.imageRequest = imageRequest;

const videoRequest = async (videoConfig, videoModel) => { return null; };
exports.videoRequest = videoRequest;

const ttsRequest = async (ttsConfig, ttsModel) => { return null; };
exports.ttsRequest = ttsRequest;
