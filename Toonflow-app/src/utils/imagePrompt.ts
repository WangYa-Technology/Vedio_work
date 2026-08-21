export function appendNegativePrompt(
  prompt: string,
  negativePrompt?: string | null,
) {
  const positive = String(prompt || "").trim();
  const negative = String(negativePrompt || "").trim();
  if (!negative) return positive;
  return `${positive}\n\n负向提示词：\n${negative}`;
}

export function hasPhotorealisticDirection(prompt: string, guidance: string[] = []) {
  return /(真人|实拍|写实|超写实|照片级|photoreal(?:istic)?|live[- ]action|real human|realistic rendering)/i.test(
    [prompt, ...guidance].join("\n"),
  );
}

export function buildAssetGenerationPrompt(input: {
  promptTitle: string;
  promptEnd: string;
  assetLabel: string;
  artStyle?: string | null;
  name: string;
  description?: string | null;
  prompt: string;
  hasReference?: boolean;
  guidance?: string[];
  customTemplate?: boolean;
}) {
  const assetFacts =
    String(input.description || "").trim() ||
    "仅以资产名称和已确认提示词为准，不补写时代、身份或服装设定";
  const referenceRule = input.hasReference
    ? "参考图用于锁定主体身份、五官、体型、结构与构图；若参考图与剧本资产事实冲突，以剧本资产事实为准。"
    : "本次未提供参考图。";
  const templateGuidance = input.guidance || [];
  const templateOverridesAnime = Boolean(input.customTemplate) && hasPhotorealisticDirection(input.prompt, templateGuidance);
  const styleContext = templateOverridesAnime
    ? "当前自定义模板明确要求真人写实/实拍/超写实媒介；项目全局风格仅作为非冲突的构图、色彩和光影参考，禁止加入动漫、卡通、二次元、赛璐珞、手绘平涂或动画渲染媒介。"
    : input.artStyle || "未指定";

  return [
    `请生成${input.promptTitle}。`,
    "",
    "【约束优先级（必须严格遵守）】",
    "1. 剧本提取的资产事实：时代、身份、年龄、外貌、服装、材质、道具和空间属性。",
    "2. 用户确认或修改后的当前提示词。",
    "3. 参考图的一致性约束。",
    "4. 项目风格只控制媒介、构图、光影、色彩和材质表现。",
    "任何较低优先级内容与较高优先级冲突时，必须丢弃冲突内容；严禁因项目风格把古代角色改成现代服装、改变身份或改写资产所属时代。",
    "",
    `【剧本资产事实｜最高优先级】`,
    `${input.assetLabel}名称：${input.name}`,
    `${input.assetLabel}描述：${assetFacts}`,
    "",
    "【用户确认的当前提示词】",
    input.prompt,
    "",
    "【参考图约束】",
    referenceRule,
    "",
    "【项目风格｜仅作视觉表现】",
    styleContext,
    ...(templateGuidance.length
      ? ["", "【生成硬性要求】", ...templateGuidance.map((item) => `- ${item}`)]
      : []),
    "",
    `请严格按照上述优先级生成${input.promptEnd}。`,
  ].join("\n");
}

export const ASSET_FACTS_PRIORITY_RULES = [
  "剧本提取的资产事实是最高优先级，视觉手册、推理模板和项目风格都不得覆盖它。",
  "必须完整保留资产描述中的时代、身份、年龄、性别、外貌、发型、服装、配饰、材质、道具、空间和用途。",
  "视觉手册与推理模板只负责输出结构、画面媒介、构图、光影、色彩和材质表现。",
  "模板示例或风格规则若与资产事实冲突，必须丢弃冲突内容并改写为符合资产事实的表达。",
  "尤其禁止把古代、古风、仙侠或历史角色改成现代西装、职业装、校园装、街头装或其他时代错误的服装，也禁止反向改写现代资产。",
  "最终提示词内部不得保留互相矛盾的时代、身份或服装描述。",
].join("\n");

export function buildAssetPromptFactsMessage(input: {
  assetLabel: string;
  name: string;
  description?: string | null;
  projectIntro?: string | null;
}) {
  return [
    "【最高优先级：剧本资产事实】",
    `${input.assetLabel}名称：${input.name}`,
    `${input.assetLabel}描述：${String(input.description || "无").trim()}`,
    input.projectIntro ? `项目剧情背景：${input.projectIntro}` : "",
    "",
    ASSET_FACTS_PRIORITY_RULES,
    "",
    "请根据以上资产事实生成最终图片提示词，只输出提示词正文。",
  ]
    .filter(Boolean)
    .join("\n");
}
