export function appendNegativePrompt(prompt: string, negativePrompt?: string | null) {
  const positive = String(prompt || "").trim();
  const negative = String(negativePrompt || "").trim();
  if (!negative) return positive;
  return `${positive}\n\n负向提示词：\n${negative}`;
}
