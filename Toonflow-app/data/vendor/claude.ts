const vendor = { id: "claude", author: "漫橙映画", description: "Anthropic Claude API 直连", name: "Claude (Anthropic)", icon: "", inputs: [{ key: "apiKey", label: "API密钥", type: "password", required: true },{ key: "baseUrl", label: "接口地址", type: "url", required: false, placeholder: "https://api.anthropic.com/v1" }], inputValues: { apiKey: "", baseUrl: "https://api.anthropic.com/v1" }, models: [{ name: "Claude Sonnet 4.6", modelName: "claude-sonnet-4-6", type: "text", think: false }, { name: "Claude Opus 4.6", modelName: "claude-opus-4-6", type: "text", think: false }, { name: "Claude Haiku 4.5", modelName: "claude-haiku-4-5-20251001", type: "text", think: false }] };
exports.vendor = vendor;

const textRequest = (textModel) => {
  if (!vendor.inputValues.apiKey) throw new Error("缺少API Key");
  const opts = { apiKey: vendor.inputValues.apiKey };
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
