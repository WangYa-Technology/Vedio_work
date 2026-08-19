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

interface VideoModelPromptProtocolContext {
  modelFamily?: unknown;
  modeKind?: unknown;
  audioPolicy?: unknown;
  requiresStartEnd?: unknown;
  referenceToken?: unknown;
}

const OFFICIAL_VIDEO_PROMPT_ID = 3;

export function buildVideoModelPromptProtocol(
  context: VideoModelPromptProtocolContext = {},
) {
  if (String(context.modelFamily || "") !== "minimax-h3") return "";

  const modeKind = String(context.modeKind || "");
  const referenceToken = String(context.referenceToken || "@图");
  const audioPolicy = String(context.audioPolicy || "optional");
  const audioRule =
    audioPolicy === "unsupported"
      ? "The current model has no audio output. Keep overall_soundscape and non_diegetic_music as N/A, and do not add dialogue or voiceover."
      : "Keep dialogue and voiceover inside the timeline only. Separate each shot's physical/ambient sound cues from the audience-only music layer, and make every cue serve a visible action, pressure change, or story turn.";

  if (modeKind === "multiReference" || modeKind === "multimodal") {
    return `# MiniMax H3 Ref2VA 官方输出协议（覆盖模板的通用输出外壳）

当前任务使用 MiniMax H3 全参考/多参考协议。每个 trackId 的最终 prompt 必须严格按以下六个字段输出，字段名和顺序不得改变，不得再包裹为 [参考图] / [视频内容]：

subject_definitions:
summary:
retention_analysis:
detailed_description:
overall_soundscape:
non_diegetic_music:

1. 六段说明用英文；用户提供的对白、旁白、歌词和可见文字保持原语言，并放入 <d>[Chinese] ...</d> 或对应语言标签。
2. referenceMap 中每个 ${referenceToken}N 都必须进入 subject_definitions。角色、场景、道具、服装、动作或风格等可复用可见内容默认定义为 <Subject N>，并在同一行保留来源标记、资产原名和稳定特征，例如 "<Subject 1> is the character from ${referenceToken}1 (资产原名), ..."。只有图片确实承担首帧、尾帧、关键帧、构图锚点或分镜规划时，才另建 <Picture N>；不能因为输入是图片就自动把它当关键帧。
3. 同一标签在六段中的含义永久不变。<Video N> 只表示整段视频的编辑源、续写起点或全局时序/运镜来源；视频里抽取的人物、动作、场景仍定义为 <Subject N>。<Audio N> 独立编号，仅在确实复制或参考音频信号时建立。
4. summary 用一个短段落，以 [reference generation]、[keyframe completion]、[video editing]、[video continuation]、[audio reuse] 或 [audio reference] 开头；多种真实关系用 " + " 组合，不能因上传了文件就虚构任务类型。
5. retention_analysis 必须逐个覆盖 subject_definitions 中的标签。可见内容只使用 fully_preserved / partially_preserved / attribute_transfer / weak_reference；如果参考资产不出现在当前 segment，写 "not_visible_in_this_segment - retained as an unused reference and introduces no new visual content"。音频只使用 fully_copy / partially_copy / reference / weak_reference，并说明出现镜头和保留内容。
6. detailed_description 是主要生成正文。先用 1-2 句英文锁定画风，再写时间线：[Shot 1] 不加时间戳；后续切镜严格写 "[Shot N] At 00:SS.mmm, the camera cuts to..."。普通切镜必须带来主体、空间、状态、视点或时间的新信息；仅改变距离或小角度时使用运镜，不新增切镜。
7. 每镜必须明确构图、主体外观和画面位置、环境与光线、动作和状态变化、摄影机运动、同步声音，以及实际可见参考标签生效的时点；detailed_description 只呈现 shotFacts 已给出的主体、空间、动作和结果。声音提示分为两层：镜内声音写环境底床、动作拟音、呼吸/喊声及其触发点、声场距离和强弱；配乐只写观众可听的非画内音乐，并标出进入/退出、明确的慢/中/快节奏或节拍密度、音色变化及与剪辑或动作的同步点。每镜最多一个微表情变化和一至两项声音变化；夸张张口、瞪眼、喊叫只在输入已有台词/喊声或动作确实达到临界点时使用，不能作为固定表演。允许用短暂静音、骤降或 J/L 声音桥制造落差，音效与配乐始终分层。若 shotFacts 是坠落/降落，正文必须明确写人物持续从画面上方向下接近地面或水面，且不得将人物写成上升、升空或倒飞。禁止毫米级数值、表情堆叠和无依据哭喊。运镜用“类型 + 必要时的幅度 + 必要时的速度”写成自然英文动作；人物位移与摄影机位移分开描述。最终 detailed_description 只写可见画面、动作、声音和对白，不复述本规则、资产校验语或其他制作说明。
8. 旁白源使用稳定 (S1)/(S2) 编号和固定句式 "the narrator (S1) says in an off-screen voiceover: <d>[Chinese] ...</d>."；旁白始终是离画叙述，画面仅描述输入要求的角色动作与实际对白。对白使用稳定说话人编号；<d> 内只放实际语句，不放语气、动作或说明。
9. overall_soundscape 用 1-4 句英文概括环境底床、关键动作拟音、非语言人声、声场距离和每个主要同步点，不重复对白、旁白、歌唱或配乐；必须能回指 detailed_description 中的动作。non_diegetic_music 用 1-3 句英文描述观众可听、角色不可听的配乐，写清进入/退出时机、音色/乐器、慢/中/快的速度或节拍密度、动态强弱、静音或留白以及至少一个剪辑/动作同步点；没有叙事依据或模型不支持音频才写 N/A。
10. 生成任务的 detailed_description 应足够具体，官方建议通常为 350-500 个英文单词；对白密集或批量输出时优先保证完整时间线、引用覆盖和时长可执行性，不为凑字数重复描述。
11. ${audioRule}`;
  }

  return `# MiniMax H3 基础模式官方输出协议（覆盖模板的通用输出外壳）

当前任务使用 MiniMax H3 T2VA/I2VA/FL2VA/L2VA 协议。每个 trackId 的最终 prompt 只包含以下三个字段并保持顺序：

integrated_multimodal_description:
overall_soundscape:
non_diegetic_music:

1. T2VA 直接从 integrated_multimodal_description 开始，不添加图片对齐指令。
2. I2VA 首行严格写："For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced."，空一行后再写三个字段。
3. FL2VA 首行严格写："How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot N) aligns with the S.SS-second mark of the target video."，把 N 和 S.SS 替换为实际末镜和两位小数时长。
4. L2VA 首行严格写："How the reference pictures align with the target video — <Picture 1> (from [Shot N]) aligns with the S.SS-second mark of the target video."，从可成立的前置状态逐步收敛到末帧。
5. integrated_multimodal_description 中 [Shot 1] 不加时间戳；后续切镜写 "[Shot N] At 00:SS.mmm, ..."。逐镜描述构图、主体、环境、动作、运镜、对白/旁白和同步画内声音。
6. ${referenceToken}N 与资产原名必须在首次对应的 <Picture N> 或主体描述中保留，以便验证输入映射；关键帧必须说明动作、姿态、构图和物件状态如何连续抵达锚定画面。
7. 对白、旁白、歌词使用稳定 (Sx) 编号并写进 <d>[Language] ...</d>；旁白标记为 off-screen narrator，不绑定画面角色，不加入嘴型或 lip-sync 控制说明。每镜分别写能推动当前动作的环境声/物理声层与非画内配乐层；配乐注明进入、退出、节奏、动态或静音点，和声音桥接/剪辑动作的关系。无依据时写 N/A，不把泛化的“cinematic music”当作完整设计。
8. overall_soundscape 和 non_diegetic_music 的职责与 Ref2VA 相同；无对应声音层时写 N/A。${audioRule}`;
}

const OFFICIAL_MULTI_REFERENCE_INSTRUCTIONS = `# 视频提示词生成

你负责把输入中同一场次的多个短视频片段分别改写为可直接提交给当前视频模型的高张力提示词。shotFacts 决定画面中实际发生什么；narrativeContext 仅用于提炼原文已有的身份、时空变化、因果、处境落差和旁白。不得补充未提供的情节或穿越机制。

## 输入使用规则
1. 每个 segment 对应一个独立视频，严格保留 trackId；不得把多个 segment 合并成长视频。
2. 以 segment.videoDescription 和 segment.shotFacts 为内容依据。字段已按镜头顺序包含画面与动作、时长、景别、运镜、对白、画内文字和音效，必须完整使用；多镜头必须输出逐镜时间段，不能只写一个总时长。
3. 台词不可遗漏、改写或翻译。普通对白、内心独白 OS、画外音 VO 必须保留原类型；无台词时明确写“无台词”。
4. 音效不得替代台词；镜头动作、运镜、景别与时长不得相互混淆。
5. 只允许使用当前 segment.referenceMap 中列出的文字资产映射。参考图标记以 contract.referenceToken 为准（例如 @图1 或 @图片1），输出必须逐行保留全部映射，不得改变编号或资产名称，禁止引用故事板图、分镜图或不存在的编号。
6. 角色图只锁定身份、五官、发型和服装；场景图只锁定空间、地标和光影；道具图只锁定外观和材质。不得互换参考项用途，不得新增人物分身、背景结构或无依据特效。

## 高冲突核心

1. 每个 segment 都要先找出“双层冲突轴”：外层是当下危险、阻碍、对峙、失控或未完成结果；内层是身份、能力、时间、地点、目标或期待与现实之间的强烈落差。
2. 首个时间段必须让落差和危险同时成立，按“强落差钩子 → 冲突爆发 → 压力升级 → 关键反应/状态改变 → 未解决悬念”推进。不得先写静态环境、资产清单或画风介绍。
3. 没有敌人或打斗时，使用输入已有的“目标 vs 阻碍、期待 vs 结果、人物 vs 环境、行动 vs 代价”制造冲突；不得为了刺激而虚构袭击、爆炸、追杀或新角色。
4. 开场优先采用“原本/上一刻/身为……却/转眼/此刻……”的落差句式。例如身份越强、当下失控越严重，冲突越鲜明；示例只说明结构，不能覆盖输入事实。
5. segment.requiresNarrativeVoiceover 为 true 时，开场只用一句“旁白 VO：实际语句”。旁白必须制造矛盾，不能只介绍身份、经历或复述正在发生的画面；必须把“能力 vs 失能、目标 vs 阻碍、上一刻 vs 下一刻、选择 vs 代价”中的一组压进同一句，使用明确转折并落到当前压力或未解决问题。旁白是 off-screen narrator，画面表演只来自输入要求的角色动作与对白。
6. 旁白先删除画面已经直接展示的信息，再补充 narrativeContext 中画面看不见的优势、预期、隐情、代价或时空错位。旁白必须严格短于契约上限：8 秒最多 14 个汉字，12-15 秒最多 22 个汉字（标点不计入创作字数但仍保持短句）；旁白不能挤掉输入对白；模型不支持音频时禁用旁白。
7. 声音与表情采用最小可执行集：每镜最多一个主要微表情变化和一至两项声音变化，必须由当前动作或冲突触发，并与镜头推进、切换或焦点转移同步。把环境/动作拟音与配乐分层写出；配乐可以用进入、退出、骤降、静音或 J/L 声音桥强化落差，但必须有剧情依据。只有输入已有喊声或动作达到临界点时，才写夸张张口、瞪眼、怒吼等表演，且每镜最多一个主表演信号。禁止毫米级数值、表情堆叠和无依据哭喊。
8. 动作冲击力必须来自可见因果：主体、起点、方向、终点、速度/力度、受力反应和环境反馈。人物位移与摄影机运动分开描述，禁止反向动作或用运镜偷换人物方向。
9. 结尾不能只是动作停止，必须停在输入已有的未解决问题、危险逼近、关系变化、关键发现或下一步选择上，让观众产生继续观看的需求。

## 每条提示词格式
[参考图]
{contract.referenceToken}1：资产名称（类型）
...

[视频内容]
先写落差冲突钩子，再按时间顺序描述该片段内全部镜头。明确冲突轴、人物动作、物理反馈、表情反应、场景、景别、运镜、对白/旁白、画内文字、音效、配乐设计和悬念收尾；保持镜头衔接自然，总时长与输入一致且不得超过当前模型限制。每镜的音效与配乐必须分开标注，不能用泛化音乐词替代同步点。

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
