const CJK_CHARACTERS = /[\u3400-\u9fff]/g;
const LATIN_WORDS = /[A-Za-z]{2,}/g;

/**
 * H3 keeps a small set of protocol keys and enum tokens in English, but the
 * generated visual/audio description must be Chinese. This check deliberately
 * ignores those fixed tokens and measures the actual prompt body instead.
 */
export function isPredominantlyChineseVideoPrompt(value: unknown) {
  const prompt = String(value || "")
    .replace(/<\/?(?:Subject|Picture|Audio)\s*\d+>/gi, " ")
    .replace(/^[A-Za-z_]+:\s*/gm, " ")
    .replace(/\b(?:fully_preserved|partially_preserved|attribute_transfer|weak_reference|fully_copy|partially_copy|reference|imageReference|textReference|multiReference|multimodal)\b/gi, " ")
    .replace(/\[reference generation\]|\[keyframe completion\]|\[video editing\]|\[video continuation\]|\[audio reuse\]|\[audio reference\]/gi, " ");
  const chineseCount = (prompt.match(CJK_CHARACTERS) || []).length;
  const latinWordCount = (prompt.match(LATIN_WORDS) || []).length;
  return chineseCount >= 30 && chineseCount >= latinWordCount * 2;
}
