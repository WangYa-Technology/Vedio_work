export type AssetInferenceAssetType = "role" | "scene" | "tool";

export interface AssetInferencePanel {
  label: string;
  view: string;
  camera?: string;
  required?: boolean;
}

export interface AssetInferenceTemplate {
  version: 1;
  name: string;
  summary: string;
  applicableTypes: AssetInferenceAssetType[];
  canvas: {
    aspectRatio: string;
    background: string;
  };
  layout: {
    mode: "single" | "views" | "grid" | "board";
    columns: number;
    rows: number;
    panels: AssetInferencePanel[];
  };
  consistency: string[];
  anatomy: string[];
  styling: string[];
  materials: string[];
  photography: string[];
  negative: string[];
  variables: Array<{
    key: string;
    label: string;
    description: string;
  }>;
  outputRules: string[];
}

export interface StoredAssetInferenceTemplate {
  id: number;
  name: string;
  type: "assetInferenceTemplate" | "imagePromptGeneration";
  data: string;
  source: "official" | "user";
  template: AssetInferenceTemplate | undefined;
}

const sharedNegative = [
  "不要添加剧本未提供的角色、物品、文字、logo、水印或装饰性主体",
  "不要改变资产名称、身份、年龄、性别、关键服装、关键道具和颜色事实",
  "不要出现多余肢体、重复人物、畸形手指、比例失衡、裁切主体或视图间不一致",
];

export const DEFAULT_ASSET_INFERENCE_TEMPLATES: AssetInferenceTemplate[] = [
  {
    version: 1,
    name: "人物标准四视图",
    summary: "适合角色资产：头像特写 + 正面、侧面、背面全身，强调身份一致性。",
    applicableTypes: ["role"],
    canvas: { aspectRatio: "16:9", background: "中性浅灰摄影棚背景" },
    layout: {
      mode: "views",
      columns: 2,
      rows: 2,
      panels: [
        { label: "头像特写", view: "正面面部特写", camera: "近景", required: true },
        { label: "正面", view: "正面全身站姿", camera: "平视全身", required: true },
        { label: "侧面", view: "右侧面全身站姿", camera: "平视全身", required: true },
        { label: "背面", view: "背面全身站姿", camera: "平视全身", required: true },
      ],
    },
    consistency: [
      "四个面板必须是同一角色、同一时间状态、同一套服装和配饰",
      "面部五官、发型轮廓、服装结构、纹样、鞋履和道具位置在所有视图中保持一致",
    ],
    anatomy: ["角色比例以约九头身为基准，完整露出双脚，不夸张大头或缩短腿部"],
    styling: ["高精度三维半写实角色设定图，兼具动画设计与实体模型质感"],
    materials: ["清晰表现皮肤、布料、金属、皮革、木质或宝石等剧本中出现的材质"],
    photography: ["柔和棚拍主光、轮廓光和低对比阴影，细节清晰，避免戏剧性遮挡"],
    negative: sharedNegative,
    variables: [
      { key: "identity", label: "身份与气质", description: "从剧本抽取角色身份、年龄、性格和情绪基调" },
      { key: "wardrobe", label: "服装与配饰", description: "只使用剧本或用户明确提供的服装、发型、配饰" },
      { key: "signature", label: "识别锚点", description: "选择最能维持跨视图一致性的脸部、发型、纹样或道具" },
    ],
    outputRules: ["先输出剧本事实，再输出版式和视觉要素；不得用模板常量替换剧本事实", "仅输出一条可直接用于图片生成的完整提示词"],
  },
  {
    version: 1,
    name: "人物多区域设定板",
    summary: "适合需要细节交付的角色：三视图、脸部、发饰、服装、配饰和鞋履分区。",
    applicableTypes: ["role"],
    canvas: { aspectRatio: "16:9", background: "干净的中性浅灰背景" },
    layout: {
      mode: "board",
      columns: 4,
      rows: 2,
      panels: [
        { label: "主肖像", view: "面部与上半身肖像", camera: "近景", required: true },
        { label: "三视图", view: "正面、侧面、背面全身", camera: "平视全身", required: true },
        { label: "脸部细节", view: "眼睛、眉形、妆容和表情细节", camera: "特写" },
        { label: "发饰细节", view: "发型、发饰或头部道具细节", camera: "特写" },
        { label: "服装细节", view: "衣领、纹样、结构和材质", camera: "局部特写" },
        { label: "配饰细节", view: "项链、手持物或关键配件", camera: "局部特写" },
        { label: "鞋履细节", view: "鞋型、鞋底和装饰", camera: "局部特写" },
      ],
    },
    consistency: ["主肖像和所有细节面板必须可追溯到同一个角色，不得引入第二套设计"],
    anatomy: ["三视图保持完整人体比例；局部面板只放大已有元素，不创造新元素"],
    styling: ["高精度角色设计资料板，清晰、规整、便于后续建模和绘制"],
    materials: ["用局部特写交代剧本中关键材质的纹理、反光和磨损"],
    photography: ["统一棚拍光线和中性背景，各区域有足够留白且互不遮挡"],
    negative: sharedNegative,
    variables: [
      { key: "detailPriority", label: "细节优先级", description: "按剧本重要性决定哪些元素进入细节面板" },
      { key: "signature", label: "识别锚点", description: "保持脸部、发型、服装和关键道具的跨面板一致" },
    ],
    outputRules: ["面板数量由模板定义，允许少于预设面板但不得凭空补充剧本外细节", "仅输出一条可直接用于图片生成的完整提示词"],
  },
  {
    version: 1,
    name: "道具多角度四宫格",
    summary: "适合道具资产：正面、侧面、背面和结构细节，默认四宫格但可被案例模板替换。",
    applicableTypes: ["tool"],
    canvas: { aspectRatio: "1:1", background: "中性浅灰产品摄影背景" },
    layout: {
      mode: "grid",
      columns: 2,
      rows: 2,
      panels: [
        { label: "正面", view: "道具正面主视图", camera: "产品平视", required: true },
        { label: "侧面", view: "道具侧面轮廓", camera: "产品平视", required: true },
        { label: "背面", view: "道具背面结构", camera: "产品平视", required: true },
        { label: "细节", view: "关键机关、纹理或材质细节", camera: "局部特写", required: true },
      ],
    },
    consistency: ["所有格子展示同一件道具，尺寸、颜色、纹理、磨损和结构必须一致"],
    anatomy: ["保持道具真实可制造的比例、连接关系和可见结构"],
    styling: ["高精度产品概念设计图，轮廓明确，便于后续建模和动画引用"],
    materials: ["突出剧本指定的金属、木材、皮革、陶瓷、宝石或发光材质"],
    photography: ["均匀柔光和轻微接触阴影，四格边界清晰，细节可辨"],
    negative: sharedNegative,
    variables: [{ key: "construction", label: "结构重点", description: "抽取道具的功能、开合、连接和关键部件" }],
    outputRules: ["道具只呈现模板面板要求的角度和细节，不添加场景或人物", "仅输出一条可直接用于图片生成的完整提示词"],
  },
  {
    version: 1,
    name: "场景单幅主视图",
    summary: "适合场景资产：单幅建立镜头，优先交代剧本空间关系、时间和气氛。",
    applicableTypes: ["scene"],
    canvas: { aspectRatio: "16:9", background: "由剧本环境决定" },
    layout: {
      mode: "single",
      columns: 1,
      rows: 1,
      panels: [{ label: "主视图", view: "完整场景建立镜头", camera: "由剧本景别决定", required: true }],
    },
    consistency: ["空间结构、时间、天气和剧本明确的地标必须准确且可用于后续分镜"],
    anatomy: ["保持透视、尺度和前中后景关系自然"],
    styling: ["高质量影视场景概念图，服务于剧本叙事，不做无关装饰"],
    materials: ["准确表现环境中出现的地面、墙体、植被、雾气或水面材质"],
    photography: ["按剧本选择广角或中焦建立镜头，光线服务于时间和情绪"],
    negative: sharedNegative,
    variables: [{ key: "space", label: "空间锚点", description: "抽取场景的地点、地标、时间、天气和关键物件" }],
    outputRules: ["不强制套用角色四视图或道具四宫格，场景按单幅主视图输出", "仅输出一条可直接用于图片生成的完整提示词"],
  },
];

const multiRegionTemplate = DEFAULT_ASSET_INFERENCE_TEMPLATES.find((template) => template.name === "人物多区域设定板");
if (multiRegionTemplate) {
  DEFAULT_ASSET_INFERENCE_TEMPLATES.push({
    ...multiRegionTemplate,
    name: "多细节",
    summary: "适合需要多细节交付的角色：主肖像、三视图、脸部、发饰、服装、配饰和鞋履分区。",
  });
}

export function parseAssetInferenceTemplate(value: unknown): AssetInferenceTemplate | null {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (!parsed || parsed.version !== 1 || !parsed.name || !parsed.layout?.panels?.length) return null;
    return parsed as AssetInferenceTemplate;
  } catch {
    return null;
  }
}

export function isAssetInferenceTemplateApplicable(
  template: AssetInferenceTemplate | null | undefined,
  assetType: AssetInferenceAssetType,
) {
  return Boolean(template?.applicableTypes?.includes(assetType));
}

export function buildAssetInferenceTemplatePrompt(template: AssetInferenceTemplate) {
  const panels = template.layout.panels
    .map((panel, index) => `${index + 1}. ${panel.label}：${panel.view}${panel.camera ? `；镜头：${panel.camera}` : ""}${panel.required ? "；必须保留" : ""}`)
    .join("\n");
  const list = (items: string[]) => items.map((item) => `- ${item}`).join("\n");
  const variables = template.variables.map((item) => `- ${item.label}（${item.key}）：${item.description}`).join("\n");
  return [
    `模板名称：${template.name}`,
    `模板摘要：${template.summary}`,
    `适用资产类型：${template.applicableTypes.join("、")}`,
    `画布：${template.canvas.aspectRatio}；背景：${template.canvas.background}`,
    `版式模式：${template.layout.mode}；列数：${template.layout.columns}；行数：${template.layout.rows}`,
    `版式面板：\n${panels}`,
    `一致性要求：\n${list(template.consistency)}`,
    `比例与结构：\n${list(template.anatomy)}`,
    `风格表达：\n${list(template.styling)}`,
    `材质表达：\n${list(template.materials)}`,
    `摄影与光线：\n${list(template.photography)}`,
    `负面约束：\n${list(template.negative)}`,
    `可变要素：\n${variables}`,
    `输出规则：\n${list(template.outputRules)}`,
  ].join("\n\n");
}

export function createTemplateAnalysisPrompt(caseText: string, requestedName?: string) {
  return [
    "你是视觉资产推理模板分析器。请从用户提供的案例中总结可复用的要素和版式规则，输出严格 JSON，不要 Markdown，不要解释。",
    "模板必须是数据驱动的：视图数量、宫格行列、面板标签、画布比例都必须写入 layout，不能假设固定四视图或固定四宫格。",
    "模板只抽取结构、视觉约束、材质、摄影和负面约束；不要把案例中的具体人物姓名、具体道具名称当成固定事实。",
    `期望名称：${requestedName || "请根据案例生成简短名称"}`,
    `JSON 结构：${JSON.stringify({
      version: 1,
      name: "",
      summary: "",
      applicableTypes: ["role"],
      canvas: { aspectRatio: "16:9", background: "" },
      layout: { mode: "single", columns: 1, rows: 1, panels: [{ label: "", view: "", camera: "", required: true }] },
      consistency: [],
      anatomy: [],
      styling: [],
      materials: [],
      photography: [],
      negative: [],
      variables: [{ key: "", label: "", description: "" }],
      outputRules: [],
    })}`,
    "案例内容：",
    caseText,
  ].join("\n\n");
}
