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
      ? "当前模型不输出声音：overall_soundscape 和 non_diegetic_music 必须写 N/A，不得添加对白或旁白。最终固定以两行结尾：\nnon_diegetic_music: N/A\n只保留同步环境音效和动作音效，不生成背景音乐，不生成字幕。"
      : "对白和旁白只写进时间线；overall_soundscape 使用英文，只写与画面同步的环境声、动作拟音和非语言人声。全程禁止背景音乐、配乐和 BGM。最终固定以两行结尾：\nnon_diegetic_music: N/A\n只保留同步环境音效和动作音效，不生成背景音乐，不生成字幕。";

  if (modeKind === "multiReference" || modeKind === "multimodal") {
    return `# MiniMax H3 Ref2VA 官方输出协议（覆盖模板的通用输出外壳）

当前任务使用 MiniMax H3 全参考/多参考协议。每个 trackId 的最终 prompt 必须严格按以下六个字段输出，字段名和顺序不得改变，不得再包裹为 [参考图] / [视频内容]：

subject_definitions:
summary:
retention_analysis:
detailed_description:
overall_soundscape:
non_diegetic_music:

1. 严格遵循 MiniMax H3 Ref2VA 官方语言规则：六个字段名、subject_definitions、summary、retention_analysis、detailed_description、overall_soundscape 与 non_diegetic_music 的正文全部使用英文；只有 <d>[Chinese] ...</d> 内的中文对白/旁白、场景中确实可见的原文文字，以及资产原名保留原语言。禁止翻译、改写或罗马化中文台词。
2. referenceMap 中每个 ${referenceToken}N 都必须进入 subject_definitions。角色、场景、道具、服装、动作或风格等可复用可见内容默认定义为独立的 <Subject N>，并在同一行保留来源标记、资产原名和稳定特征，例如 "<Subject 1> is the character from ${referenceToken}1 (资产原名), ..."。只有图片确实承担首帧、尾帧、关键帧、构图锚点或分镜规划时，才另建 <Picture N>；不能因为输入是图片就自动把它当关键帧。若定义了 <Picture N>，必须在 detailed_description 的对应镜头中再次引用，并说明它锁定的构图、姿态或状态；禁止定义后弃用。
3. 同一标签在六段中的含义永久不变。<Video N> 只表示整段视频的编辑源、续写起点或全局时序/运镜来源；视频里抽取的人物、动作、场景仍定义为 <Subject N>。<Audio N> 独立编号，仅在确实复制或参考音频信号时建立。
4. summary 使用英文短段落，但开头的协议标记固定使用 [reference generation]、[keyframe completion]、[video editing]、[video continuation]、[audio reuse] 或 [audio reference]；多种真实关系用 " + " 组合。只有真实输入了要直接编辑或续写的视频时才能使用 video editing / video continuation；纯图片参考必须使用 reference generation，不能从剧本上下文虚构任务类型。
5. retention_analysis 必须逐个覆盖 subject_definitions 中的标签。可见内容只使用 fully_preserved / partially_preserved / attribute_transfer / weak_reference；如果使用 partially_preserved，补充可见范围属于 full-body visible with altered action、body-part visible 或 effect residue visible 中的哪一种（仅在事实成立时使用），并说明保留的身份/外观特征。如果参考资产不出现在当前 segment，使用英文写 "not_visible_in_this_segment - retained as an unused reference and not introduced into the generated scene"。音频只使用 fully_copy / partially_copy / reference / weak_reference，并用英文说明出现镜头和保留内容。
6. detailed_description 是主要生成正文，按官方要求使用英文。先用 1-2 句锁定画风，再写时间线：[Shot 1] 不加时间戳；后续切镜严格写 "[Shot N] At MM:SS.mmm, the shot cuts to ..."。切镜时间必须是前面镜头时长的累计和，例如 3s、4s、2s 对应 Shot 1 无时间戳、Shot 2 At 00:03.000、Shot 3 At 00:07.000；禁止每镜重新从 00 秒计时。每次切镜必须带来主体、空间、状态、视点或时间的新信息。
7. 每镜必须明确构图、主体位置、环境光线、动作状态、摄影机运动和同步音效，并在参考项真正出现的镜头调用对应标签。音效只写环境底床、动作拟音、呼吸/喊声、触发点、声场距离和强弱；不得设计任何背景音乐。每镜最多一个微表情变化和一至两项音效变化；夸张张口、瞪眼、喊叫只在输入已有台词/喊声或动作达到临界点时使用。若是坠落，必须写清人物从画面上方向下接近地面/水面，禁止上升、升空或倒飞。禁止毫米级数值、表情堆叠和无依据哭喊。人物位移与摄影机位移分开描述，正文只写应生成的画面和声音。
8. 每个实际说话人按首次发声顺序分配稳定的 (S1)/(S2) 编号。画面角色发声必须写成 "<Subject N> (Sx) says, <d>[Chinese] 实际语句</d>"；<d> 内只能放剧本原句，绝不包含“王胜：”等说话人前缀。旁白写成 "The off-screen narrator (Sx) says, <d>[Chinese] 实际语句</d>"，不绑定画面角色。不得漏词、换词、串台、重复台词或新增语气词。
9. overall_soundscape 用 1-4 句英文概括环境底床、关键动作拟音、非语言人声、声场距离和同步点；只允许概括 detailed_description 中已经明确写出的同步音效，不得凭空新增镜头中没有的声音。non_diegetic_music 无条件写 N/A，不得出现乐器、旋律、节拍、音乐进入/退出或声音桥等配乐描述。N/A 后只允许追加固定句“只保留同步环境音效和动作音效，不生成背景音乐，不生成字幕。”。
10. 全程禁止字幕、标题和对话气泡。对白、旁白只作为声音，绝不渲染为画面文字；场景内实体文字只有 shotFacts 明确指定时才保留。
11. 中景或中远景出现主要人物时，逐镜写明面部锐利对焦，眼睛、鼻子、嘴部与轮廓清晰可辨，不被浅景深、焦点漂移或运动模糊覆盖；优先简化背景、遮挡和快速运动，不改变输入景别。
12. detailed_description 以完整时间线和可执行动作优先，通常写 350-500 个英文单词；对白密集时优先保证完整且精确的发声时间线，不用重复形容词凑长度。
13. ${audioRule}
14. 角色实例唯一：每个有名字的出镜角色必须映射到一个且仅一个角色 <Subject N>，一个角色 <Subject N> 在同一镜头默认只允许一个可见身体。除非 shotFacts 明确要求双胞胎、克隆、镜像或分身，禁止 duplicate person、look-alike、second copy、reflection duplicate、background replica。不得用王胜的角色参考生成宋嫣或戴欢；未绑定角色参考时不得猜测或复用其他人的脸。
15. 每镜明确列出可见角色及精确数量；未在该镜出现的角色不得在背景、倒影、水面、画外入镜或群众中复制出现。多人镜头用各自不同的 <Subject N> 和站位描述，人物身份不因切镜、遮挡或持有道具而互换。
16. 抽象风格词（如 cinematic、beautiful、epic）不能单独承担画面指令，必须绑定可执行的光线、材质、色彩、构图、镜头运动或表演锚点。项目的 artStyle、videoRatio 和 visualStyleManual 优先于参考图的媒介外观；不能仅因参考图是照片就擅自改成真人实拍、电影宽画幅、8K 或品牌摄影机。未被 shotFacts 或参考素材支持的背景人物、群众、道具和事件不得自行补入。
17. 叙事增强只条件触发，不得覆盖事实和技术协议：若当前 segment 的 shotFacts 明确存在危险、目标、阻碍、失控、异常、关键物件变化、紧张关系或未完成结果，应在输入时长和既有构图允许的范围内，把这些要素的最早可见证据放在 Shot 1 的描述前部，并按输入事实清晰呈现“压力变化 → 人物/环境反应 → 当前结果”。不存在这些事实时，保持原有开场，不虚构冲突、悬念、台词或新事件；不得强制三段式节奏、非常规机位或悬而未决结尾。
18. 若输入明确存在压力变化序列或未解决结果，可以在 summary 中用一句英文概括推进关系，并在最后镜头保留该未完成状态；若输入明确完成、抵达、交付或情绪释放，必须如实保留完成状态。overall_soundscape 只能在输入已有音效的基础上说明其与动作/情绪的同步关系，不得新增声音类型。上述增强不得输出分析注释、改变景别、重排镜头时长或改变 H3 字段顺序。
19. 镜头信息密度只通过可观察内容提升：每镜至少写出一个有事实依据的可观察动词和一个视觉锚点（主体、道具、空间位置、光线或参考标签）。静态镜头也必须描述可见状态，不得用 beautiful、cinematic、tense 等抽象词替代画面事实。
20. 只有 shotFacts、对白或动作明确提供情绪信号时，才在对应镜头使用 1-2 个可执行的情绪/表演锚点（如 restrained anger、visible panic、hesitation）；中性画面不得强加情绪，观众感受只能通过可见表情、动作、距离、光线或已有声音表达。
21. 除压力升级外，若输入事实呈现任务推进、发现/揭露或情绪转折，也应按事实顺序突出“变化前状态 → 可见变化 → 当前结果”；不得把不存在的心理动机、信息差或反转写成事实。钩子只表示最早可感知的已有信号，不得添加“本不该出现”等未被输入确认的判断。

## 四模块规划与 H3 映射
先在内部按四个模块组织事实，再序列化为上面的官方字段；H3 最终 prompt 不得直接输出模块标题或 [参考图]/[视频内容] 包装：
【参考素材说明】：按输入顺序编号。通用文本模式使用 @图片1、@视频1、@音频1；每项写明用途、锁定维度，以及不参考的维度（如有）。无素材写“无参考素材（纯文字生成视频）”。人物素材必须区分角色名；音频有人声时完整保留对白/歌词。
【核心创意】：明确时长、画幅、风格、主体、核心事件、光影色调、氛围、运镜总风格和切镜方式。禁止使用“环绕运镜”，需要环绕效果时写 truck left + pan right 或 truck right + pan left。
【画面过程描述】：逐镜使用 [Shot N]，包含时间区间、小标题、景别、场景、主体及参考标签、运镜、动作、台词/旁白、音效、画面文字和转场；只设计音效，不设计配乐。
【不想要】：作为内部负向约束，排除背景音乐、字幕、标题、对话气泡、未定义文字/水印/logo、模糊扭曲、穿模、肢体畸形、错用参考项、反向运动、无依据角色/特效；固定加入“人物远景镜头”（表示人物镜头避免远景/大全景）和“非叙事性音乐：N/A”。
映射关系：参考素材说明 -> subject_definitions + retention_analysis；核心创意 -> summary；画面过程描述 -> detailed_description；音效 -> overall_soundscape；non_diegetic_music 固定 N/A；不想要只作为生成约束，不新增 H3 字段。
高冲突四拍节奏：若输入存在“故障、失控、失去关键道具、暴露或危险逼近”，必须把可见原因放在开场 0-1.5 秒内；随后依次写“失控动作 → 人物主动反应 → 目标/威胁明显逼近 → 未解决结果”。不能用 8 秒连续跟拍或连续推脸代替因果推进；近景/特写最多占片段三分之一，且必须捕捉状态变化，不得重复同一张脸。
通用 Shot 时长规则也必须先校验：中文台词字数 ÷ 3 约为台词镜头最低秒数；纯画面镜头通常 2-5 秒；总时长尽量匹配输入，未指定时默认 10 秒。人物镜头最宽使用全景，远景/大全景只用于无人空镜；避免连续相同景别。中景/中远景主要人物面部必须锐利对焦、五官细节清晰可辨。首尾帧模式必须显式标记首帧/尾帧参考、禁止切镜，并保持人物不被拉到远景。`;
  }

  return `# MiniMax H3 基础模式官方输出协议（覆盖模板的通用输出外壳）

当前任务使用 MiniMax H3 T2VA/I2VA/FL2VA/L2VA 协议。每个 trackId 的最终 prompt 只包含以下三个字段并保持顺序：

integrated_multimodal_description:
overall_soundscape:
non_diegetic_music:

1. 三个字段名及 <Picture N>/<Subject N> 标签保持协议写法；按 H3 官方规则，字段正文、镜头、动作和声音使用英文，只有 <d> 内的对白/旁白和场景中原有文字保留原语言。T2VA 直接从 integrated_multimodal_description 开始，不添加图片对齐指令。
2. I2VA 首行严格写英文对齐句："The target video at 00.00 seconds fully references <Picture 1> from [Shot 1]."，空一行后再写三个字段。
3. FL2VA 首行严格写英文对齐句："Reference alignment: <Picture 1> from [Shot 1] corresponds to 00.00 seconds; <Picture 2> from [Shot N] corresponds to S.SS seconds."，把 N 和 S.SS 替换为实际末镜和两位小数时长。
4. L2VA 首行严格写英文对齐句："Reference alignment: <Picture 1> from [Shot N] corresponds to S.SS seconds."，从可成立的前置状态逐步收敛到末帧。
5. integrated_multimodal_description 中 [Shot 1] 不加时间戳；后续切镜写 "[Shot N] At MM:SS.mmm, the shot cuts to ..."，时间为前面镜头时长的累计和。逐镜描述构图、主体、环境、动作、运镜、对白/旁白和同步画内声音。
6. ${referenceToken}N 与资产原名必须在首次对应的 <Picture N> 或主体描述中保留，以便验证输入映射；关键帧必须说明动作、姿态、构图和物件状态如何连续抵达锚定画面。
7. 对白、旁白使用稳定 (Sx) 编号并写进 <d>[Chinese] ...</d>；<d> 内只放实际语句，不含说话人前缀。旁白标记为 off-screen narrator，不绑定画面角色。每镜只写能推动当前动作的环境声、物理声和非语言人声；禁止任何背景音乐、配乐、BGM 或音乐桥接。
8. overall_soundscape 只承载音效；non_diegetic_music 无条件写 N/A。全程禁止字幕、标题和对话气泡，对白/旁白绝不渲染为文字。中景/中远景主要人物面部必须锐利对焦、五官细节清晰可辨，不被景深或运动模糊覆盖。${audioRule}

## 四模块规划与通用 Shot 规范
先内部组织【参考素材说明】【核心创意】【画面过程描述】【不想要】四模块，再输出 H3 三字段；不要把四个标题原样塞进 H3 字段。素材按输入顺序编号为 @图片N/@视频N/@音频N，每项写用途、锁定维度和不参考维度；无人素材时写“无参考素材（纯文字生成视频）”。画面过程按 [Shot N] 输出景别、场景、主体/参考标签、运镜、动作、台词/旁白、音效、文字和转场。中文台词字数÷3 约为最低台词镜头时长，纯画面 2-5 秒，总时长匹配输入，未指定默认 10 秒。人物镜头最宽为全景，远景/大全景仅用于无人空镜；避免连续同景别。中景/中远景主要人物面部必须锐利对焦、五官细节清晰可辨。禁止“环绕运镜”，用 truck left + pan right 或 truck right + pan left；首尾帧模式明确首帧/尾帧参考且禁止切镜。内部不想要约束固定包含“人物远景镜头、背景音乐、字幕”和“非叙事性音乐：N/A”。`;
}

const LEGACY_DEFAULT_VIDEO_PROMPT = `# 视频提示词生成

你负责把输入中同一场次的多个短视频片段分别改写为可直接提交给当前视频模型的高张力提示词。MiniMax H3 必须采用官方格式：结构字段和正文使用英文，只有 <d> 内的对白/旁白与画面中原有文字保留原语言；非 H3 模型按其运行时协议处理。shotFacts 决定画面中实际发生什么，narrativeContext 仅用于提炼原文已有的身份、时空变化、因果、处境落差和旁白。不得补充未提供的情节或穿越机制。

## 输入使用规则
1. 每个 segment 对应一个独立视频，严格保留 trackId；不得把多个 segment 合并成长视频。
2. 以 segment.videoDescription、segment.shotFacts 和 sceneSpace 为内容依据。字段已按镜头顺序包含画面与动作、地点、时段、内外、空间层级、时长、累计起止时间、景别、景别说明、摄影角度、运镜、对白、说话人、实际台词、画内文字和音效，必须完整使用；多镜头严格按累计时间输出，不能让每镜从 0 秒重新开始。
3. 台词不可遗漏、改写、翻译、串台或重复。普通对白、内心独白 OS、画外音 VO 必须保留原类型；H3 的 <d> 内只放 actualDialogue，禁止带 speakerName 和冒号。无台词时明确写“无台词”。
4. 音效不得替代台词；镜头动作、运镜、景别与时长不得相互混淆。
5. 只允许使用当前 segment.referenceMap 中列出的文字资产映射。参考图标记以 contract.referenceToken 为准（例如 @图1 或 @图片1），输出必须逐行保留全部映射，不得改变编号或资产名称，禁止引用故事板图、分镜图或不存在的编号。
6. 角色图只锁定身份、五官、发型和服装；场景图只锁定空间、地标和光影；道具图只锁定外观和材质。不得互换参考项用途，不得新增人物分身、背景结构或无依据特效。每个出镜角色使用独立角色参考和独立 <Subject N>；同一角色在同一镜头默认只有一个可见实例，禁止复制脸、替身、倒影分身和背景重复人物。

## 高冲突核心

1. 每个 segment 都要先找出“双层冲突轴”：外层是当下危险、阻碍、对峙、失控或未完成结果；内层是身份、能力、时间、地点、目标或期待与现实之间的强烈落差。
2. 首个时间段必须让落差和危险同时成立，按“强落差钩子 → 冲突爆发 → 压力升级 → 关键反应/状态改变 → 未解决悬念”推进。不得先写静态环境、资产清单或画风介绍。
3. 没有敌人或打斗时，使用输入已有的“目标 vs 阻碍、期待 vs 结果、人物 vs 环境、行动 vs 代价”制造冲突；不得为了刺激而虚构袭击、爆炸、追杀或新角色。
4. 开场优先采用“原本/上一刻/身为……却/转眼/此刻……”的落差句式。例如身份越强、当下失控越严重，冲突越鲜明；示例只说明结构，不能覆盖输入事实。
5. segment.requiresNarrativeVoiceover 为 true 时，开场只用一句“旁白 VO：实际语句”。旁白必须制造矛盾，不能只介绍身份、经历或复述正在发生的画面；必须把“能力 vs 失能、目标 vs 阻碍、上一刻 vs 下一刻、选择 vs 代价”中的一组压进同一句，使用明确转折并落到当前压力或未解决问题。旁白是 off-screen narrator，画面表演只来自输入要求的角色动作与对白。
6. 旁白先删除画面已经直接展示的信息，再补充 narrativeContext 中画面看不见的优势、预期、隐情、代价或时空错位。旁白必须严格短于契约上限：8 秒最多 14 个汉字，12-15 秒最多 22 个汉字（标点不计入创作字数但仍保持短句）；旁白不能挤掉输入对白；模型不支持音频时禁用旁白。
7. 声音与表情采用最小可执行集：每镜最多一个主要微表情变化和一至两项音效变化，必须由当前动作或冲突触发，并与镜头推进、切换或焦点转移同步。只写环境底床、动作拟音、呼吸/喊声等镜内音效；全程禁止背景音乐、配乐和 BGM。固定输出：non_diegetic_music: N/A；只保留同步环境音效和动作音效，不生成背景音乐，不生成字幕。全程禁止字幕、标题和对话气泡，对白、旁白只作为声音。中景/中远景主要人物面部必须锐利对焦，五官细节清晰可辨，不被景深或运动模糊覆盖。只有输入已有喊声或动作达到临界点时，才写夸张张口、瞪眼、怒吼等表演，且每镜最多一个主表演信号。禁止毫米级数值、表情堆叠和无依据哭喊。
8. 动作冲击力必须来自可见因果：主体、起点、方向、终点、速度/力度、受力反应和环境反馈。人物位移与摄影机运动分开描述，禁止反向动作或用运镜偷换人物方向。
9. 结尾不能只是动作停止，必须停在输入已有的未解决问题、危险逼近、关系变化、关键发现或下一步选择上，让观众产生继续观看的需求。
10. 对存在“关键道具故障、突然失控、身份能力与现实反差、危险逼近”的片段，采用四拍节奏：0-1.5 秒先让故障或威胁在画面中发生；随后写失控的运动变化，再写人物主动反应，最后把目标/威胁推到画面前景并停在未解决结果。不得用“稳定跟拍、缓慢推近、脸部特写”连续占满片段；近景/特写只在表情或状态真正改变时使用，最多占片段三分之一。

## 四模块规划（通用输出）
先按四个模块组织，再写最终提示词。若当前模型是 MiniMax H3，必须将模块映射到运行时注入的官方字段，不得输出方括号包装；非 H3 模型才直接输出四个模块。
【参考素材说明】：素材按发送顺序编号为 @图片1、@视频1、@音频1；每项写用途、锁定维度和不参考维度。人物分别命名，音频有人声时完整保留对白/歌词；无素材写“无参考素材（纯文字生成视频）”。
【核心创意】：时长、画幅、风格、主体、核心事件、光影、氛围、运镜总风格、切镜方式。禁止“环绕运镜”，改写为 truck left + pan right 或 truck right + pan left。
【画面过程描述】：每镜使用累计时间。H3 按官方格式让 Shot 1 无时间戳，后续写 [Shot N] At MM:SS.mmm；其他模型使用 Shot N（起始秒-结束秒）。每镜写地点、时段、内外、空间层级、景别、景别说明、摄影角度、主体/参考项、可见角色及数量、运镜、动作、精确说话人、实际台词/旁白、音效、文字和转场；只设计音效，不设计配乐。
【不想要】：背景音乐、字幕、标题、对话气泡、未定义文字/水印/logo、模糊扭曲、穿模、畸形、错用素材、反向运动和无依据特效；固定写“人物远景镜头”作为人物景别规避项，并写“非叙事性音乐：N/A”。
人物镜头最宽使用全景，远景/大全景仅用于无人空镜；避免连续相同景别。中景/中远景主要人物面部必须锐利对焦，五官细节清晰可辨，不被景深或运动模糊覆盖。中文台词字数÷3 约为最低台词镜头时长，纯画面镜头 2-5 秒，总时长尽量匹配输入，未指定默认 10 秒。首尾帧模式明确 @图片1 为首帧、@图片2 为尾帧，禁止切镜且人物不被拉远。

## 每条提示词格式
[参考素材说明]
{contract.referenceToken}1：资产名称（类型）
...

[核心创意]
...

[画面过程描述]
先写落差冲突钩子，再按时间顺序描述该片段内全部镜头。明确冲突轴、人物动作、物理反馈、表情反应、地点、时段、内外、空间层级、景别、景别说明、摄影角度、运镜、对白/旁白、画内文字、音效和悬念收尾；保持镜头衔接自然，总时长与输入一致且不得超过当前模型限制。只标注与动作同步的音效；背景音乐固定为 N/A。

[不想要]
人物远景镜头；背景音乐、字幕、标题、对话气泡、未定义文字、水印、logo、抽象比喻、模糊扭曲、穿模、肢体畸形、反向运动和无依据特效。

## 输出要求
只调用 resultTool 一次，返回输入中每个 trackId 对应的一条非空 prompt。不要输出分析过程、小说原文、剧本全文或额外说明。`;

/** Visible bundled default. Runtime context is appended by the resolver. */
export const DEFAULT_OFFICIAL_VIDEO_PROMPT = `# MiniMax H3 视频提示词生成

你负责将每个独立 segment 改写为可直接提交给 MiniMax H3 Ref2VA 的视频提示词。结构字段和正文使用英文，只有原始对白、旁白、资产原名和场景中确实可见的文字保留原语言。严格以当前 segment 的 shotFacts、referenceMap、对白和音效为事实来源，不合并片段，不补写未提供的剧情、角色、资产或穿越机制。

${buildVideoModelPromptProtocol({
  modelFamily: "minimax-h3",
  modeKind: "multiReference",
  audioPolicy: "optional",
  referenceToken: "@图",
})}

## 输入与生成约束
1. 每个 segment 对应一条独立 prompt，严格保留 trackId、画幅、总时长和镜头顺序。
2. 先识别高冲突核心：强落差钩子、冲突爆发、压力升级、状态改变和未解决悬念；只从输入事实提炼，不凭空制造袭击、爆炸、追杀或新角色。近景/特写只在表情或状态真正改变时使用，不能连续推脸或重复同一张脸。
3. requiresNarrativeVoiceover 为 true 时才生成一句短促的 off-screen narrator；旁白必须制造矛盾，不能只介绍身份、经历或复述可见动作，且严格短于契约上限。
4. 所有台词逐字保留、只出现一次、绑定正确说话人；H3 的 <d> 内只放实际语句，不放角色名、冒号、字幕或嘴型控制指令。
5. 所有角色、场景和道具必须使用当前 referenceMap 的独立映射；一名角色对应一个稳定 Subject，同一镜头禁止重复脸、替身、镜像、倒影分身或背景复制人物。
6. H3 的 Shot 1 不写时间戳，后续使用累计 [Shot N] At MM:SS.mmm；不得每镜从 00 秒重新计时。
7. overall_soundscape 只描述同步环境声、动作拟音、呼吸和非语言人声；固定结尾为：
non_diegetic_music: N/A
只保留同步环境音效和动作音效，不生成背景音乐，不生成字幕。
8. 声音与表情采用最小可执行集；中景/中远景主要人物面部必须锐利对焦，眼睛、鼻子、嘴部与轮廓清晰可辨；全程禁止字幕、标题和对话气泡。
9. 不输出分析过程、小说原文、剧本全文或额外说明，只调用一次 resultTool 返回全部 trackId 的非空 prompt。

### 四模块内部规划
参考素材说明 -> subject_definitions + retention_analysis；核心创意 -> summary；画面过程描述 -> detailed_description；音效 -> overall_soundscape；不想要只作为内部约束，不新增 H3 字段。`;

void LEGACY_DEFAULT_VIDEO_PROMPT;

function hasCustomOfficialContent(template: VideoPromptTemplateRecord) {
  const raw = String(template.useData || template.data || "").trim();
  return Boolean(raw && raw !== DEFAULT_OFFICIAL_VIDEO_PROMPT.trim());
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
  return `${DEFAULT_OFFICIAL_VIDEO_PROMPT}\n\n当前模型：${context.modelName || "未标注"}\n当前模式：${mode || "未标注"}\n当前参考图标记：${context.referenceToken || "@图"}\n当前画幅：${context.videoRatio || "16:9"}`;
}
