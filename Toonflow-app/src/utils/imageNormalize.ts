import sharp from "sharp";

// 中性浅灰摄影棚底色，与「浅灰色无缝影棚背景」提示词的标准输出保持一致
const STUDIO_GRAY = { r: 178, g: 178, b: 180 };

/**
 * 将 AI 生成的图片统一规范为不透明 JPEG：
 * - 部分供应商（如 gpt-image 的 auto 背景模式）会返回带透明通道的 PNG，
 *   透明区域在不同软件中会渲染成白色或黑色斑块，导致同批图片观感不一致；
 * - 历史实现还会把 PNG 内容直接存成 .jpg 扩展名，导致 MIME 与实际内容不符。
 * 这里统一：有透明通道就压平到中性浅灰影棚底色，并重新编码为 JPEG；
 * 已经是不透明 JPEG 的图片原样返回，避免无意义的二次压缩。
 */
export async function normalizeGeneratedImage(input: string | Buffer): Promise<Buffer> {
  const source = typeof input === "string" ? Buffer.from(input.replace(/^data:[^;]+;base64,/, ""), "base64") : input;
  try {
    const image = sharp(source);
    const meta = await image.metadata();
    if (!meta.hasAlpha && (meta.format === "jpeg" || meta.format === "jpg")) {
      return source;
    }
    return await image.flatten({ background: STUDIO_GRAY }).jpeg({ quality: 92 }).toBuffer();
  } catch (error) {
    console.warn("[imageNormalize] 图片规范化失败，按原始数据保存:", error);
    return source;
  }
}
