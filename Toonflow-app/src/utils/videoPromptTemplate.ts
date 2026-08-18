import { isUserPromptId } from "@/utils/promptTemplate";

interface VideoPromptTemplateRecord {
  id?: unknown;
  name?: unknown;
  data?: unknown;
  useData?: unknown;
}

interface VideoPromptContext {
  modelName?: string;
  mode?: string | string[];
  referenceToken?: string;
  videoRatio?: string;
}

const OFFICIAL_VIDEO_PROMPT_ID = 3;

const OFFICIAL_MULTI_REFERENCE_INSTRUCTIONS = `# 视频提示词生成

你负责把输入中同一场次的多个短视频片段分别改写为可直接提交给当前视频模型的提示词。输入中的 segments 是唯一事实来源，不得补充小说全文、剧本全文或未提供的情节。

## 输入使用规则
1. 每个 segment 对应一个独立视频，严格保留 trackId；不得把多个 segment 合并成长视频。
2. 以 segment.videoDescription 和 segment.shotFacts 为内容依据。字段已按镜头顺序包含画面与动作、时长、景别、运镜、对白、画内文字和音效，必须完整使用；多镜头必须输出逐镜时间段，不能只写一个总时长。
3. 台词不可遗漏、改写或翻译。普通对白、内心独白 OS、画外音 VO 必须保留原类型；无台词时明确写“无台词”。
4. 音效不得替代台词；镜头动作、运镜、景别与时长不得相互混淆。
5. 只允许使用当前 segment.referenceMap 中列出的文字资产映射。参考图标记以 contract.referenceToken 为准（例如 @图1 或 @图片1），输出必须逐行保留全部映射，不得改变编号或资产名称，禁止引用故事板图、分镜图或不存在的编号。

## 每条提示词格式
[参考图]
{contract.referenceToken}1：资产名称（类型）
...

[视频内容]
按时间顺序描述该片段内全部镜头。明确人物动作、表情、场景、景别、运镜、对白、画内文字与音效；保持镜头衔接自然，总时长与输入一致且不得超过当前模型限制。

## 输出要求
只调用 resultTool 一次，返回输入中每个 trackId 对应的一条非空 prompt。不要输出分析过程、小说原文、剧本全文或额外说明。`;

function hasCustomOfficialContent(template: VideoPromptTemplateRecord) {
  return Boolean(String(template.useData || "").trim());
}

export function resolveVideoPromptInstructions(
  template: VideoPromptTemplateRecord,
  context: VideoPromptContext,
) {
  const raw = String(template.useData || template.data || "").trim();
  const isUnmodifiedOfficial =
    Number(template.id) === OFFICIAL_VIDEO_PROMPT_ID &&
    !isUserPromptId(template.id) &&
    !hasCustomOfficialContent(template);

  if (!isUnmodifiedOfficial) return raw;

  const mode = Array.isArray(context.mode)
    ? context.mode.join(", ")
    : String(context.mode || "");
  return `${OFFICIAL_MULTI_REFERENCE_INSTRUCTIONS}\n\n当前模型：${context.modelName || "未标注"}\n当前模式：${mode || "未标注"}\n当前参考图标记：${context.referenceToken || "@图"}\n当前画幅：${context.videoRatio || "16:9"}`;
}
