import {
  extractOnScreenText,
  isNarrationSourceLabel,
} from "@/utils/onScreenText";

export interface VideoPromptContractConfig {
  artStyle?: string;
  videoRatio?: string;
  referenceToken?: string;
  visualStyleManual?: string;
  audio?: boolean;
  audioSupported?: boolean;
  videoPromptProfile?: {
    modelFamily?: string;
    modeKind?: string;
  } | null;
}

export interface VideoPromptContractTask {
  segmentTitle?: string;
  duration?: number;
  dialogue?: string;
  segmentRows?: Array<{
    dialogue?: string;
    description?: string;
    visualAndAction?: string;
    duration?: number;
    scale?: string;
    shotScale?: string;
  }>;
  isEpisodeOpening?: boolean;
  requiresNarrativeVoiceover?: boolean;
  medias?: Array<{
    name?: unknown;
    type?: unknown;
  }>;
}

const STYLE_CONTAMINATION = /真人|实拍|IMAX|Arri\s*Alexa|2\.39\s*:\s*1|\b8K\b/i;
const SPOKEN_AUDIO = /(?:台词|对白|说|喊|叫|低语|独白)[：:]\s*[“"「『]?\s*(?!无台词|无对白|无)([^\n；。.!！]{1,80})/i;
const VOICEOVER_AUDIO = /(?:旁白|画外音|voiceover|\bVO\b)[：:]/i;
const VOICEOVER_CONFLICT_TURN = /却|偏偏|竟|反而|谁知|不料|没想到|从未想到|可(?:现在|如今|此刻)|但(?:现在|如今|此刻)|上一(?:刻|秒)[\s\S]{0,80}下一(?:刻|秒)|原本[\s\S]{0,80}(?:现在|如今|此刻)|\bbut\b|\byet\b|\binstead\b|never (?:thought|expected)|a moment ago[\s\S]{0,80}(?:now|the next moment)/i;
const VOICEOVER_PRESSURE = /失去|失控|失能|失重|消失|坠落|坠入|下坠|危险|威胁|阻碍|代价|退路|来不及|活命|能活|活下来|落点|困住|逼近|无法|不能|决定不了|陌生|背叛|失败|暴露|死亡|死路|绝境|los(?:e|es|t)|out of control|unable|cannot|danger|threat|obstacle|cost|trapped|closing in|fall(?:s|ing)?|plung(?:e|es|ing)|death|no escape/i;
const NARRATION_LIP_SYNC_NEGATIVE = /角色闭嘴|角色嘴部紧闭|lips?\s+(?:remain\s+)?(?:completely\s+)?closed|lip[- ]?sync\s+(?:is\s+)?disabled/i;
const SUBTITLE_INSTRUCTION = /(?:生成|添加|显示|出现|叠加|呈现|带有|烧录|嵌入)(?:任何|中文|英文|双语|自动)?字幕|字幕[：:]\s*(?!无|不|禁止|N\/?A|none)[^\n；。]{1,80}|(?:show|add|render|display|burn(?:ed)?[- ]?in)\s+(?:any\s+)?subtitles?/i;
const AFFIRMATIVE_BACKGROUND_MUSIC = /(?:背景音乐|背景配乐|非画内配乐|非叙事性音乐|\bBGM\b|non[-_ ]diegetic[_ ]music|配乐(?:设计)?)[：:]\s*(?!(?:N\/?A|无|none)(?:\s|$))[^\n；。]{1,120}|(?:配乐|背景音乐|\bBGM\b)[^\n；。]{0,18}(?:进入|响起|渐入|铺陈|增强|淡出)|(?:加入|使用|播放)[^\n；。]{0,18}(?:背景音乐|配乐|\bBGM\b)|(?:background|non[- ]diegetic) music[：:]\s*(?!(?:N\/?A|none)(?:\s|$))[^\n.;]{1,100}/i;
const FACE_CLARITY_ANCHOR = /(?:面部|脸部|人脸)[^。；\n]{0,36}(?:清晰|锐利|对焦|五官可辨|细节可辨)|五官[^。；\n]{0,24}(?:清晰|可辨|锐利)|(?:faces?|facial (?:features?|details?)|features?)[^.\n]{0,48}(?:clear|sharp|crisp|readable|legible|discernible|recognizable|defined|resolved|in focus|focused)/i;
const ACTION_ANCHORS = /猛然坐起|坐起|起身|踹门|推门|开门|转身|奔跑|跑向|冲向|抬头|低头|挥手|伸手|抓住|拔出|倒下|跌倒|爆炸|递给|拿起|放下|摔倒|拍打|敲门|看向|回头|后退|前进|拥抱|亲吻|殴打|踢|砍|躲|闪避|哭泣|大笑|怒吼|点头|摇头/g;
// H3 正文强制英文，同一动作有多种合法写法（进行时/过去式/名词化），
// 正则过窄会把"写对了但换了说法"误判为漏写，因此每条都覆盖常见变体。
const ACTION_ANCHOR_TRANSLATIONS: Record<string, RegExp> = {
  猛然坐起: /sits? up (?:suddenly|abruptly)|abruptly sits? up|suddenly sits? up|bolts? upright|jerks? upright/i,
  坐起: /sits? up|sitting up|sit up/i,
  起身: /(?:stands?|standing|stood|gets?|getting|got) up|rises? to (?:his|her|their) feet|rising to (?:his|her|their) feet|on (?:his|her|their) feet/i,
  踹门: /kicks? (?:open )?(?:the )?door|kicking (?:open )?(?:the )?door|kick(?:s|ed|ing)? (?:in |open )?(?:the )?door/i,
  推门: /pushes? (?:open )?(?:the )?door|pushing (?:open )?(?:the )?door|push(?:es|ed|ing)? (?:the )?door/i,
  开门: /opens? (?:the )?door|opening (?:the )?door|open(?:s|ed|ing)? (?:the )?door/i,
  转身: /turns?|turning|turned|spins? around|spinning around|pivots?|pivoting|swivels?/i,
  奔跑: /runs?|running|ran|sprints?|sprinting|dashes?|dashing/i,
  跑向: /runs? (?:toward|over to|up to)|running (?:toward|over to|up to)|sprints? (?:toward|over to)|dashes? (?:toward|over to)/i,
  冲向: /rushes?|rushing|charged?|charges?|charging|lunges?|lunging|dashes? (?:at|toward)|darts? (?:at|toward)/i,
  抬头: /looks? up|looking up|looked up|gazes? up|gazing up|glances? up|glancing up|raises? (?:his|her|their)? ?heads?|raising (?:his|her|their)? ?heads?|raised (?:his|her|their)? ?heads?|lifts? (?:his|her|their)? ?heads?|lifting (?:his|her|their)? ?heads?|tilts? (?:his|her|their)? ?heads? (?:up|back)|tilting (?:his|her|their)? ?heads? (?:up|back)|heads? (?:tilts?|raises?|lifts?|comes? up)|chin (?:lifts?|raises?|tilts?)|looks? upward|looking upward|gazes? upward|eyes? (?:look|turn)s? up/i,
  低头: /looks? down|looking down|looked down|gazes? down|gazing down|glances? down|glancing down|lowers? (?:his|her|their)? ?heads?|lowering (?:his|her|their)? ?heads?|drops? (?:his|her|their)? ?heads?|dropping (?:his|her|their)? ?heads?|tilts? (?:his|her|their)? ?heads? down|tilting (?:his|her|their)? ?heads? down|heads? (?:drops?|lowers?|bows?)|chin (?:drops?|tucks?)|looks? downward|looking downward/i,
  挥手: /waves? (?:his|her|their)? ?hands?|waving (?:his|her|their)? ?hands?|gestures? (?:with )?(?:his|her|their)? ?hands?|flaps? (?:his|her|their)? ?hands?/i,
  伸手: /reaches? (?:out|toward|for)|reaching (?:out|toward|for)|extends? (?:his|her|their)? ?hands?|extends? (?:an|his|her|their)? ?arms?|puts? out (?:his|her|their)? ?hands?/i,
  抓住: /grabs?|grabbing|grabbed|seizes?|seizing|seized|catches? hold|catches?|caught hold|clutches?|clutching|grips?|gripping/i,
  拔出: /draws?|drawing|drew|pulls? out|pulling out|pulled out|unsheathes?|unsheathing/i,
  倒下: /falls? down|falling down|collapses?|collapsing|collapsed|crumples?|crumpling|drops? to the (?:ground|floor)/i,
  跌倒: /falls? over|falling over|stumbles?|stumbling|stumbled|trips?|tripping|tumbles?|tumbling/i,
  爆炸: /explodes?|exploding|exploded|erupts?|erupting|detonates?|detonating|blows? up|blown up|bursts?/i,
  递给: /hands?|handing|handed|passes? .{0,30} to|passing .{0,30} to|offers? .{0,20} to|extends? .{0,20} to/i,
  拿起: /picks? up|picking up|picked up|lifts?|lifting|lifted|scoops? up|scooping up|takes? (?:up|hold)/i,
  放下: /puts? down|putting down|sets? down|setting down|places? .{0,20}down|lays? down/i,
  摔倒: /falls? over|falling over|is knocked down|knocked down|topples?|toppling/i,
  拍打: /pats?|patting|slaps?|slapping|slapped|strikes?|striking|swats?|swatting/i,
  敲门: /knocks? (?:on|at) (?:the )?door|knocking (?:on|at) (?:the )?door|raps? (?:on|at) (?:the )?door|rapping (?:on|at)/i,
  看向: /looks? (?:at|toward)|looking (?:at|toward)|looked (?:at|toward)|gazes? (?:at|toward)|gazing (?:at|toward)|glances? (?:at|toward)|glancing (?:at|toward)|watches?|watching|eyes? (?:fixed|locked|trained) on/i,
  回头: /looks? back|looking back|looked back|gazes? back|glances? back|turns? (?:his|her|their)? ?heads? (?:back|over)|turning (?:his|her|their)? ?heads? back|turns? (?:around|back)/i,
  后退: /steps? back|stepping back|stepped back|retreats?|retreating|back(?:s|ing|ed)? away|moves? backward|recoils?|recoiling/i,
  前进: /moves? forward|moving forward|moved forward|steps? forward|stepping forward|advances?|advancing|walk(?:s|ing|ed)? forward/i,
  拥抱: /embraces?|embracing|hugs?|hugging|hugged|wraps? (?:his|her|their)? ?arms? around|wrapping (?:his|her|their)? ?arms? around/i,
  亲吻: /kisses?|kissing|kissed/i,
  殴打: /punches?|punching|punched|beats?|beating|strikes?|striking|hits?|hitting/i,
  踢: /kicks?|kicking|kicked/i,
  砍: /slashes?|slashing|slashed|chops?|chopping|chopped|cuts? at|cutting at|swings? (?:the )?(?:blade|knife|sword|cleaver|axe)/i,
  躲: /ducks?|ducking|ducked|dodges?|dodging|hides?|hiding|hid|takes? cover|taking cover/i,
  闪避: /dodges?|dodging|dodged|evades?|evading|sidesteps?|sidestepping|twists? (?:away|aside)|twisting (?:away|aside)/i,
  哭泣: /cries?|crying|cried|weeps?|weeping|sobs?|sobbing|tears? (?:stream|roll|fall|well)/i,
  大笑: /laughs?|laughing|laughed|bursts? (?:out )?(?:into )?laugh|roars? with laughter/i,
  怒吼: /roars?|roaring|roared|shouts?|shouting|shouted|yells?|yelling|yelled|bellows?|bellowing/i,
  点头: /nods?|nodding|nodded/i,
  摇头: /shakes? (?:his|her|their)? ?heads?|shaking (?:his|her|their)? ?heads?|shook (?:his|her|their)? ?heads?|turns? (?:his|her|their)? ?heads? (?:from )?side to side/i,
};

// 动作丢失是否会改变观众对剧情的理解：高危动作继续硬阻断；其余（表演/位移
// 细节）降级为警告，避免英文长尾表达被误判后卡住整批生成。
const CRITICAL_ACTION_ANCHORS = new Set([
  "爆炸",
  "倒下",
  "跌倒",
  "摔倒",
  "踹门",
  "踢",
  "砍",
  "殴打",
  "拔出",
  "抓住",
]);

// 自动修复重试时给模型的明确英文写法提示：模型只看到"某动作未保留"的中文
// 报错时，无法判断该补什么表达，容易再次写漏。
const ACTION_ANCHOR_HINTS: Record<string, string> = {
  猛然坐起: "sits up suddenly / bolts upright",
  坐起: "sits up / sitting up",
  起身: "stands up / gets up / rises to his feet",
  踹门: "kicks the door open",
  推门: "pushes the door open",
  开门: "opens the door",
  转身: "turns / turning around",
  奔跑: "runs / running / sprints",
  跑向: "runs toward ...",
  冲向: "rushes toward / charges toward",
  抬头: "looks up / gazing up / raises his head",
  低头: "looks down / lowers his head",
  挥手: "waves his hand / waving",
  伸手: "reaches out / extends his hand",
  抓住: "grabs / seizes / catches hold of",
  拔出: "draws / pulls out",
  倒下: "falls down / collapses",
  跌倒: "falls over / stumbles",
  爆炸: "explodes / erupts",
  递给: "hands ... over / passes ... to",
  拿起: "picks up / lifts",
  放下: "puts down / sets down",
  摔倒: "falls over / is knocked down",
  拍打: "pats / slaps",
  敲门: "knocks on the door",
  看向: "looks at / gazes toward",
  回头: "looks back / turns his head back",
  后退: "steps back / retreats",
  前进: "moves forward / advances",
  拥抱: "embraces / hugs",
  亲吻: "kisses",
  殴打: "punches / strikes",
  踢: "kicks",
  砍: "slashes / chops",
  躲: "ducks / dodges / takes cover",
  闪避: "dodges / evades / sidesteps",
  哭泣: "cries / weeps / sobs",
  大笑: "laughs / laughing",
  怒吼: "roars / shouts / yells",
  点头: "nods / nodding",
  摇头: "shakes his head / shaking his head",
};
const DOWNWARD_MOTION = /坠落|坠入|下坠|自由落体|落向|降落|向下落/;
const DOWNWARD_PROMPT = /坠落|坠入|下坠|自由落体|落向|降落|向下落|向下坠|接近(?:湖面|水面|地面)|冲入湖面|砸入湖面|falls? (?:downward|into|toward)|falls? (?:vertically|straight down)|drops? (?:downward|into|toward|vertically|straight down)|(?:is |continues? )?(?:falling|descending|dropping)(?: into| toward| toward the| downward| vertically| straight down)?|descends? (?:into|toward)|plunges? (?:into|toward)|plummets?|plummeting|tumbles? (?:downward|into|toward)|tumbling (?:downward|into|toward)|hurtl(?:e|es|ing) (?:downward|into|toward)|dives? (?:downward|into|toward)|free-?falls?|continues? falling|approaches? (?:the )?(?:lake|water|ground)|moves? from (?:the )?top of (?:the )?frame toward (?:the )?(?:lake|water|ground)|(?:lake|water|ground)(?: surface)? (?:rapidly )?(?:expands|grows larger|rushes closer) (?:below|beneath)/i;
// Only reject a reverse movement performed by the subject itself. Camera rises or
// ambient elements moving upward must not invalidate a correctly descending actor.
const REVERSED_DOWNWARD_MOTION = /(?:人物|角色|主体|王胜|他|她)(?:的身体)?[^。；\n]{0,18}(?:向上飞|向上升|上升|升空|倒飞(?:回|向)?高处|飞回高空)|(?:从|由)(?:地面|水面|湖面)[^。；\n]{0,12}(?:飞向|冲向|升向)(?:天空|高空)|\b(?:character|subject|he|she|wang\s+sheng)\b(?:\s+(?:is|was|begins? to|starts? to|continues? to|then|suddenly|abruptly|quickly|slowly|straight|directly|back|upward|up|into|toward|the|a|an|his|her|their|body|figure|whole|entire)){0,12}\s+(?:flies?\s+upward|rises?|ascends?|returns?\s+to\s+the\s+sky)\b|(?:from|off) (?:the )?(?:ground|water|lake)[^.\n]{0,30}(?:toward|into) (?:the )?(?:sky|air|high altitude)/i;

const GENERIC_STYLE_ANCHORS = new Set(
  [
    "cinematic",
    "cinematic lighting",
    "natural lighting",
    "warm tones",
    "cool tones",
    "clean lines",
    "vivid colors",
    "high detail",
    "ultra-fine detail",
    "shallow depth of field",
    "电影风格",
    "电影级光影",
    "自然光照",
    "温暖色调",
    "冷色调",
    "清晰线条",
    "色彩鲜明",
    "极致细节",
    "浅景深",
  ].map((value) => value.toLowerCase()),
);

function normalizeStyleAnchor(value: unknown) {
  return String(value || "")
    .replace(/^[`'“”\s]+|[`'“”\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * The style manuals use a Markdown table with English and Chinese label rows.
 * The first two non-generic labels in each row carry the medium/style identity;
 * later labels are usually reusable lighting and quality terms.
 */
export function extractDistinctiveStyleAnchors(manual: unknown) {
  const anchors: string[] = [];
  for (const line of String(manual || "").split(/\r?\n/)) {
    const match = line.match(/^\|[^|]+\|\s*`([^`]+)`\s*\|?\s*$/);
    if (!match) continue;
    const rowAnchors = match[1]
      .split(/[,，;；]/)
      .map(normalizeStyleAnchor)
      .filter(
        (value) =>
          value.length >= 3 &&
          !GENERIC_STYLE_ANCHORS.has(value),
      )
      .slice(0, 2);
    anchors.push(...rowAnchors);
  }
  return [...new Set(anchors)];
}

function normalizeRatio(value: unknown) {
  return String(value || "").replace(/\s/g, "").trim();
}

function hasNoDialogue(task: VideoPromptContractTask) {
  const rows = task.segmentRows?.length
    ? task.segmentRows
    : [{ dialogue: task.dialogue }];
  return rows.every((row) => {
    const value = String(row.dialogue || "").trim();
    if (!value || /^(?:无|无台词|暂无|无对白|-)$/i.test(value)) return true;
    // 整格都是画内文字（"屏幕文字：…""VO（灯牌文字）：…"）时同样视为无对白：
    // 它只在画面里出现，不允许模型因此添加角色对白或独白。
    return value
      .split(/<br\s*\/?>|\n+/i)
      .map((segment) => segment.trim())
      .filter(Boolean)
      .every((segment) => Boolean(extractOnScreenText(segment)));
  });
}

function actionAnchors(task: VideoPromptContractTask) {
  const descriptions = (task.segmentRows || [])
    .map((row: any) => String(row.description || row.visualAndAction || ""))
    .join(" ");
  return [...new Set(descriptions.match(ACTION_ANCHORS) || [])];
}

function hasDownwardMotion(task: VideoPromptContractTask) {
  const descriptions = (task.segmentRows || [])
    .map((row) => String(row.description || row.visualAndAction || ""))
    .join(" ");
  return DOWNWARD_MOTION.test(descriptions);
}

function hasMediumOrMediumLongCharacterShot(task: VideoPromptContractTask) {
  return (task.segmentRows || []).some((row) =>
    /中景|中远景|medium(?:[- ]long)? shot/i.test(
      String(row.scale || row.shotScale || ""),
    ),
  );
}

function hasAffirmativeBackgroundMusic(prompt: string) {
  const normalized = prompt
    .replace(/non[-_ ]diegetic[_ ]music[：:]\s*(?:N\/?A|none|无)(?=\s|$)/gi, "")
    .replace(/(?:背景音乐|背景配乐|非画内配乐|非叙事性音乐|\bBGM\b|配乐)[^。；\n]{0,20}(?:固定|必须|只能)(?:写|为)?\s*N\/?A/gi, "")
    .replace(/(?:全程)?(?:禁止|无|不加入|不使用|不出现|不得添加|不要添加)[^。；\n]{0,40}(?:背景音乐|背景配乐|非画内配乐|非叙事性音乐|\bBGM\b|配乐)[^。；\n]*/gi, "");
  return AFFIRMATIVE_BACKGROUND_MUSIC.test(normalized);
}

function promptContainsAction(prompt: string, action: string) {
  return prompt.includes(action) || Boolean(ACTION_ANCHOR_TRANSLATIONS[action]?.test(prompt));
}

function hasH3SpokenDialogue(prompt: string) {
  for (const match of prompt.matchAll(/<d>\[[^\]]+\][\s\S]*?<\/d>/gi)) {
    const prefix = prompt.slice(Math.max(0, (match.index || 0) - 180), match.index);
    if (/off-screen voiceover/i.test(prefix)) continue;
    if (/\b(?:says?|shouts?|asks?|replies?|whispers?|sings?|exclaims?)\b/i.test(prefix)) {
      return true;
    }
  }
  return false;
}

function parseSingleExpectedDialogue(raw: string) {
  const withoutType = raw
    .replace(/^(?:普通对白|对白|内心独白|画外音|旁白)\s*(?:OS|VO)?\s*[：:]?\s*/i, "")
    .trim();
  const match = withoutType.match(/^([^：:\n]{1,24})[：:]\s*([\s\S]+)$/);
  const rawSpeaker = match?.[1]?.trim() || "";
  // "OS（陈照野，平静）"这类把类型前缀写在括号外的写法：真正的说话人在括号内。
  const typedSpeaker = rawSpeaker.match(
    /^(?:OS|VO|旁白|画外音|内心独白)\s*[（(]\s*([^，,、）)]+)/i,
  );
  // 归一化到展示名："旁白""内心独白""心跳声"这类朗读/音效来源没有说话人，
  // 否则会被当成角色要求独立参考图。
  const speaker = cleanSpeakerName(
    typedSpeaker ? typedSpeaker[1].trim() : rawSpeaker,
  );
  return {
    speaker,
    text: (match?.[2] || withoutType)
      .replace(/^[“"「『]|[”"」』]$/g, "")
      .trim(),
  };
}

// 同一个镜头可能包含多句不同角色的对话（用 <br> 或换行分隔），必须逐句解析：
// 否则会拼成一句参与校验，模型正确拆分反而被判成"改写台词"。
function parseExpectedDialogues(value: unknown) {
  const raw = String(value || "")
    .trim()
    .replace(/^台词[：:]\s*/, "");
  if (!raw || /^(?:无|无台词|无对白|暂无|-)$/i.test(raw)) {
    return [] as Array<{ speaker: string; text: string }>;
  }
  const segments = raw
    .split(/<br\s*\/?>|\n+/i)
    .map((segment) => segment.trim())
    .filter(Boolean)
    // 画内文字（"屏幕文字：…""VO（摊车灯牌文字）：…"）不是对白：既不该被要求绑定
    // H3 说话主体，也不该被要求逐字出现在 <d> 里（台词列里它只是画面文字内容）。
    .filter((segment) => !extractOnScreenText(segment));
  if (!segments.length) return [] as Array<{ speaker: string; text: string }>;
  return segments
    .map((segment) => parseSingleExpectedDialogue(segment))
    .filter((item) => item.speaker || item.text);
}

// "许曼青（OS）/（视频内）/（小声）"这类表演或媒介标注不属于角色身份的一部分，
// 说话人匹配先精确、再按归一化名字兜底，避免已绑定角色被误判为缺少参考。
export function normalizeSpeakerKey(value: unknown) {
  const raw = String(value || "").trim();
  // "OS（陈照野，平静）"这类把类型前缀写在括号外的写法：真正的说话人在括号内。
  const typed = raw.match(
    /^(?:OS|VO|旁白|画外音|内心独白)\s*[（(]\s*([^，,、）)]+)/i,
  );
  if (typed) return typed[1].replace(/\s+/g, "").trim();
  return raw
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/\s+/g, "")
    .replace(/^[【\[「『“‘]+/, "")
    .replace(/[】\]」』”’]+$/, "")
    .trim();
}

// 分镜表的台词列常写成"老王问：""陈照野答："，叙述动词会被并进说话人；
// 偶尔还带短状语（"陈照野冷笑道："）。若只做字面比较，已建资产的角色会被误判成
// "缺少独立角色参考"直接终止推理，因此这里给出带兜底的说话人候选名。
// 后缀按"长词在前"排列并逐个尝试，避免"笑道"吃掉"冷笑"这类组合
// （"陈照野冷笑道"需要先剥"道"得到"陈照野冷笑"，而不是剥"笑道"得到"陈照野冷"）。
const SPEECH_SUFFIXES = [
  // 句尾状语
  "冷笑",
  "微笑",
  "苦笑",
  "大笑",
  "低声",
  "轻声",
  "大声",
  "沉声",
  "冷冷",
  "淡淡",
  "轻轻",
  "平静",
  "笑着",
  "哭着",
  "摇头",
  "点头",
  // 内心/独白类标注（"OS（陈照野内心，低沉）：…"）
  "内心",
  "心声",
  "自语",
  "独白",
  // 叙述动词
  "说道",
  "问道",
  "答道",
  "喊道",
  "叫道",
  "笑道",
  "吼道",
  "喝道",
  "应道",
  "劝道",
  "骂道",
  "叹道",
  "说",
  "问",
  "答",
  "喊",
  "叫",
  "笑",
  "吼",
  "喝",
  "应",
  "劝",
  "骂",
  "叹",
  "念",
  "读",
  "唱",
  "道",
];
// 剥到只剩单字就停：避免把"阿道"这类真实名字误剥成"阿"。
const MIN_SPEAKER_STEM_LENGTH = 2;

/** 说话人的可信变体：归一化后逐层剥掉句尾状语与叙述动词。 */
export function speakerKeyCandidates(value: unknown): string[] {
  const base = normalizeSpeakerKey(value);
  if (!base) return [];
  const candidates = new Set<string>([base]);
  let frontier = [base];
  // 两轮足够覆盖"陈照野冷笑道"："…冷笑道"→"…冷笑"→"陈照野"。
  for (let round = 0; round < 2 && frontier.length; round += 1) {
    const next: string[] = [];
    for (const item of frontier) {
      for (const suffix of SPEECH_SUFFIXES) {
        if (!item.endsWith(suffix)) continue;
        const stem = item.slice(0, -suffix.length);
        if (stem.length < MIN_SPEAKER_STEM_LENGTH || candidates.has(stem)) {
          continue;
        }
        candidates.add(stem);
        next.push(stem);
      }
    }
    frontier = next;
  }
  return [...candidates];
}

/** 说话人的规范展示名（用于提示词与描述文本）。 */
export function cleanSpeakerName(value: unknown): string {
  // "VO（旁白）：…""OS（内心独白）：…""VO（心跳声）：…"：朗读/播报/音效来源不是角色，
  // 归一化到空说话人（台词仍按画外旁白发声），不参与角色参考绑定。
  if (isNarrationSourceLabel(normalizeSpeakerKey(value))) return "";
  const candidates = speakerKeyCandidates(value);
  return candidates.length ? candidates[candidates.length - 1] : "";
}

// 兜底规则：说话人 = 角色名 + 一段叙述尾巴（"老王拍桌问""陈照野压低声音说"）。
// 尾巴必须含叙述动词且长度受限，否则"陈"会被误判成"陈照野"。
const NARRATIVE_TAIL_PATTERN = /(?:说|问|答|道|喊|叫|笑|吼|喝|劝|骂|叹|念|读|唱)/;
const MAX_NARRATIVE_TAIL_LENGTH = 6;

/** 说话人是否指向该角色：先精确，再按候选名与叙述尾巴兜底匹配。 */
export function isSameSpeaker(speaker: unknown, roleName: unknown): boolean {
  const speakerKeys = speakerKeyCandidates(speaker);
  if (!speakerKeys.length) return false;
  const roleKeys = speakerKeyCandidates(roleName);
  if (roleKeys.some((key) => speakerKeys.includes(key))) return true;
  return roleKeys.some((roleKey) =>
    speakerKeys.some((speakerKey) => {
      if (!speakerKey.startsWith(roleKey)) return false;
      const tail = speakerKey.slice(roleKey.length);
      return (
        tail.length > 0 &&
        tail.length <= MAX_NARRATIVE_TAIL_LENGTH &&
        NARRATIVE_TAIL_PATTERN.test(tail)
      );
    }),
  );
}

function findSubjectTagBySpeaker(
  subjectByRole: Map<string, string>,
  speaker: string,
) {
  const direct = subjectByRole.get(speaker);
  if (direct) return direct;
  for (const [name, tag] of subjectByRole) {
    if (isSameSpeaker(speaker, name)) return tag;
  }
  return undefined;
}

function normalizeSpokenText(value: unknown) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\s，。！？、；：,.!?;:'"“”‘’「」『』]/g, "")
    .toLowerCase();
}

function validateH3DialogueAndIdentity(
  task: VideoPromptContractTask,
  prompt: string,
  config: VideoPromptContractConfig,
) {
  if (
    config.videoPromptProfile?.modelFamily !== "minimax-h3" ||
    !["multiReference", "multimodal"].includes(
      String(config.videoPromptProfile.modeKind || ""),
    )
  ) {
    return [];
  }

  const violations: string[] = [];
  const expected = (task.segmentRows || []).flatMap((row) =>
    parseExpectedDialogues(row.dialogue),
  );
  const spoken = Array.from(
    prompt.matchAll(/<d>\[([^\]]+)\]\s*([\s\S]*?)<\/d>/gi),
    (match) => ({ language: match[1], text: match[2].trim() }),
  );
  const expectedCounts = new Map<string, number>();
  for (const item of expected) {
    const key = normalizeSpokenText(item.text);
    expectedCounts.set(key, (expectedCounts.get(key) || 0) + 1);
    if (item.speaker && new RegExp(`^${item.speaker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[：:]`).test(item.text)) {
      violations.push(`台词内容仍包含说话人前缀：${item.speaker}`);
    }
  }
  const actualCounts = new Map<string, number>();
  for (const item of spoken) {
    const key = normalizeSpokenText(item.text);
    actualCounts.set(key, (actualCounts.get(key) || 0) + 1);
    if (/^[^：:\n]{1,24}[：:]/.test(item.text)) {
      violations.push("H3 <d> 内包含说话人前缀，可能导致角色名被朗读");
    }
  }
  for (const [key, count] of expectedCounts) {
    if ((actualCounts.get(key) || 0) !== count) {
      const source = expected.find((item) => normalizeSpokenText(item.text) === key);
      violations.push(`台词必须逐字且仅出现 ${count} 次：${source?.text || key}`);
    }
  }
  const unexpected = [...actualCounts.keys()].filter(
    (key) => !expectedCounts.has(key),
  );
  if (unexpected.length && !task.requiresNarrativeVoiceover) {
    violations.push("提示词新增、改写或串入了分镜中不存在的台词");
  }

  const roleReferences = (task.medias || [])
    .map((media, index) => ({
      index: index + 1,
      name: String(media.name || "").trim(),
      type: String(media.type || "").toLowerCase(),
    }))
    .filter((media) => /role|character|人物|角色/.test(media.type) && media.name);
  const subjectDefinitions = prompt.split(/^\s*summary\s*:/im)[0];
  const subjectBlocks = Array.from(
    subjectDefinitions.matchAll(
      /(<Subject\s+\d+>)[\s\S]*?(?=<Subject\s+\d+>|$)/gi,
    ),
    (match) => ({ tag: match[1], body: match[0] }),
  );
  const subjectByRole = new Map<string, string>();
  for (const role of roleReferences) {
    const referenceToken = String(config.referenceToken || "@图").replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&",
    );
    const referencePattern = new RegExp(`${referenceToken}\\s*${role.index}(?!\\d)`, "i");
    const block =
      subjectBlocks.find((candidate) => referencePattern.test(candidate.body)) ||
      // Some H3 responses spell the reference as "reference image 1" or
      // omit the token while still naming the role. Keep the identity check
      // useful without rejecting an otherwise unique Subject mapping.
      subjectBlocks.find((candidate) =>
        new RegExp(`(?:^|[^\\p{L}])${role.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^\\p{L}])`, "u").test(
          candidate.body,
        ),
      ) ||
      // If the model omitted all reference tokens but preserved one Subject
      // block per role, use the stable input order as a compatibility mapping.
      (subjectBlocks.length === roleReferences.length
        ? subjectBlocks[roleReferences.indexOf(role)]
        : undefined);
    const tag = block?.tag || "";
    if (!tag) {
      violations.push(`角色参考未建立独立 Subject：${role.name}`);
      continue;
    }
    subjectByRole.set(role.name, tag);
  }
  const assignedTags = [...subjectByRole.values()].map((tag) => tag.toLowerCase());
  if (new Set(assignedTags).size !== assignedTags.length) {
    violations.push("多个角色被映射到同一个 Subject，存在复制脸或身份混用风险");
  }
  for (const item of expected.filter((dialogue) => dialogue.speaker)) {
    const subject = findSubjectTagBySpeaker(subjectByRole, item.speaker);
    if (!subject) {
      violations.push(`说话角色缺少独立参考主体：${item.speaker}`);
      continue;
    }
    const escapedSubject = subject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escapedDialogue = item.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const dialogueBlock = `<d>\\[Chinese\\]\\s*${escapedDialogue}\\s*<\\/d>`;
    // H3 的 (Sx) 发声编号与 Subject 编号互相独立（官方规则 32），模型也常把
    // 主体描述与 (Sx) 分开写：先严格邻接匹配，再退到"同一镜头段落内"匹配。
    const strictlyBound = new RegExp(
      `${escapedSubject}\\s*\\(S\\d+\\)[\\s\\S]{0,320}${dialogueBlock}`,
      "i",
    ).test(prompt);
    const dialogueRegex = new RegExp(dialogueBlock, "i");
    const dialogueHit = prompt.match(dialogueRegex);
    let bound = strictlyBound;
    if (!bound && dialogueHit?.index != null) {
      // 只在台词所属的 [Shot N] 段落内检查主体标签，避免把 subject_definitions
      // 等前置字段里的定义误当成正文绑定。
      const beforeDialogue = prompt.slice(0, dialogueHit.index);
      const shotStart = beforeDialogue.lastIndexOf("[Shot ");
      if (shotStart >= 0) {
        const segment = prompt.slice(
          shotStart,
          dialogueHit.index + dialogueHit[0].length,
        );
        bound = new RegExp(escapedSubject, "i").test(segment);
      }
    }
    if (!bound) {
      const snippet =
        dialogueHit?.index != null
          ? prompt
              .slice(
                Math.max(0, dialogueHit.index - 90),
                dialogueHit.index + dialogueHit[0].length,
              )
              .replace(/\s+/g, " ")
              .trim()
          : "";
      violations.push(
        `台词未绑定到正确的 H3 说话主体：${item.speaker}${
          snippet
            ? `（提示词实际写法：「…${snippet}…」）`
            : "（提示词中未找到该台词的 <d> 块，可能被改写）"
        }`,
      );
    }
  }
  return violations;
}

function validateH3ShotTiming(
  task: VideoPromptContractTask,
  prompt: string,
  config: VideoPromptContractConfig,
) {
  if (config.videoPromptProfile?.modelFamily !== "minimax-h3") return [];
  const rows = task.segmentRows || [];
  if (rows.length <= 1) return [];
  let elapsed = 0;
  let cumulativeTimingKnown = true;
  const violations: string[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    if (index > 0) {
      const marker = prompt.match(
        new RegExp(
          `\\[Shot\\s+${index + 1}\\]\\s+At\\s+(\\d{2}):(\\d{2}\\.\\d{3})`,
          "i",
        ),
      );
      const actual = marker
        ? Number(marker[1]) * 60 + Number(marker[2])
        : Number.NaN;
      if (
        !Number.isFinite(actual) ||
        (cumulativeTimingKnown && Math.abs(actual - elapsed) > 0.05)
      ) {
        violations.push(
          `Shot ${index + 1} 的 H3 切镜时间必须是累计时间 ${String(
            Math.floor(elapsed / 60),
          ).padStart(2, "0")}:${(elapsed % 60).toFixed(3).padStart(6, "0")}`,
        );
      }
    }
    const duration = Number(rows[index].duration);
    if (!Number.isFinite(duration) || duration <= 0) cumulativeTimingKnown = false;
    else elapsed += duration;
  }
  return violations;
}

function validateH3Structure(prompt: string, config: VideoPromptContractConfig) {
  if (config.videoPromptProfile?.modelFamily !== "minimax-h3") return [];

  const modeKind = config.videoPromptProfile.modeKind;
  const fields =
    modeKind === "multiReference" || modeKind === "multimodal"
      ? [
          "subject_definitions:",
          "summary:",
          "retention_analysis:",
          "detailed_description:",
          "overall_soundscape:",
          "non_diegetic_music:",
        ]
      : [
          "integrated_multimodal_description:",
          "overall_soundscape:",
          "non_diegetic_music:",
        ];
  const positions = fields.map((field) => prompt.toLowerCase().indexOf(field));
  if (
    positions.some((position) => position < 0) ||
    positions.some((position, index) => index > 0 && position <= positions[index - 1])
  ) {
    return [
      modeKind === "multiReference" || modeKind === "multimodal"
        ? "MiniMax H3 Ref2VA 提示词缺少官方六段结构或字段顺序错误"
        : "MiniMax H3 基础模式提示词缺少官方三段结构或字段顺序错误",
    ];
  }

  const musicBody = prompt
    .slice(positions[positions.length - 1] + fields[fields.length - 1].length)
    .trim();
  const allowedMusicBodies = new Set([
    "N/A",
    "N/A\n只保留同步环境音效和动作音效，不生成背景音乐，不生成字幕。",
  ]);
  if (!allowedMusicBodies.has(musicBody)) {
    return [
      "MiniMax H3 的 non_diegetic_music 只能写 N/A，并可追加指定的同步音效固定句",
    ];
  }

  if (modeKind === "multiReference" || modeKind === "multimodal") {
    const detailedStart = positions[3] + fields[3].length;
    const detailedBody = prompt.slice(detailedStart, positions[4]);
    const soundBody = prompt.slice(positions[4]);
    const subjectDefinitions = prompt.slice(
      positions[0] + fields[0].length,
      positions[1],
    );
    const audioLabels = [
      ...new Set(
        Array.from(subjectDefinitions.matchAll(/<Audio\s+\d+>/gi), (match) =>
          match[0].toLowerCase(),
        ),
      ),
    ];
    const normalizedAudioUsage = `${detailedBody}\n${soundBody}`.toLowerCase();
    const omittedAudio = audioLabels.filter(
      (label) => !normalizedAudioUsage.includes(label),
    );
    // An input reference may be deliberately absent from a segment. Requiring
    // it in detailed_description would invent a visual event, so only audio
    // references must be consumed when they are explicitly defined.
    if (omittedAudio.length) {
      return [
        `MiniMax H3 参考标签未在生成正文中实际调用：${[
          ...omittedAudio,
        ].join("、")}`,
      ];
    }
  }
  return [];
}

function extractVoiceover(prompt: string) {
  const h3Match = prompt.match(
    /(?:says in an off-screen voiceover|旁白|画外音|voiceover)[^<]{0,100}<d>\[[^\]]+\]\s*([\s\S]{1,180}?)<\/d>/i,
  );
  if (h3Match?.[1]) return h3Match[1].trim();

  const match = prompt.match(
    /(?:旁白|画外音|voiceover|\bVO\b)[：:]\s*([\s\S]{1,180}?)(?=\n\s*(?:\d+(?:\.\d+)?\s*(?:秒|s)|\[?Shot\s*\d+\]?|[A-Za-z_]+:)|$)/i,
  );
  return String(match?.[1] || "")
    .replace(/[“”"「」『』]/g, "")
    .trim();
}

function hasConflictVoiceover(prompt: string) {
  const voiceover = extractVoiceover(prompt);
  return (
    Boolean(voiceover) &&
    (VOICEOVER_CONFLICT_TURN.test(voiceover) || /却|但|偏偏|竟|反而/.test(voiceover)) &&
    (VOICEOVER_PRESSURE.test(voiceover) || /活|落|失|危|险|退/.test(voiceover))
  );
}

export interface VideoPromptContractIssues {
  /** Hard violations: block generation and trigger the repair retry. */
  violations: string[];
  /** Non-blocking findings: prompts are saved, but worth a human look. */
  warnings: string[];
}

/** Collect blocking violations plus non-blocking warnings without inspecting video pixels. */
export function collectVideoPromptContractIssues(
  task: VideoPromptContractTask,
  prompt: string,
  config: VideoPromptContractConfig = {},
): VideoPromptContractIssues {
  const violations: string[] = [];
  const warnings: string[] = [];
  violations.push(...validateH3Structure(prompt, config));
  violations.push(...validateH3DialogueAndIdentity(task, prompt, config));
  violations.push(...validateH3ShotTiming(task, prompt, config));
  const artStyle = String(config.artStyle || "").toLowerCase();
  const isRealisticStyle = /realpeople|realistic|documentary|写实|真人/.test(artStyle);
  if (!isRealisticStyle && STYLE_CONTAMINATION.test(prompt)) {
    violations.push("提示词包含与当前非真人画风冲突的摄影/画质标签");
  }

  const styleAnchors = extractDistinctiveStyleAnchors(
    config.visualStyleManual,
  );
  const normalizedPrompt = normalizeStyleAnchor(prompt);
  if (
    styleAnchors.length &&
    !styleAnchors.some((anchor) => normalizedPrompt.includes(anchor))
  ) {
    violations.push(
      `提示词缺少当前画风的可验证锚点（例如：${styleAnchors.slice(0, 4).join("、")}）`,
    );
  }

  const expectedRatio = normalizeRatio(config.videoRatio);
  // H3 shot markers use timestamps such as `At 00:03.000`; do not treat
  // those timestamps as aspect-ratio declarations.
  const ratioMatches = Array.from(
    prompt.matchAll(
      /(?<![\d.:])\b(\d+(?:\.\d+)?\s*:\s*\d+(?:\.\d+)?)\b(?![\d.:])/g,
    ),
  )
    // `00:03.000` is H3's timestamp syntax, not a 00:03 aspect ratio.
    .filter((match) => !/^\d{2}:\d{2}\.\d{3}$/.test(normalizeRatio(match[1])))
    .map((match) => normalizeRatio(match[1]));
  if (expectedRatio && ratioMatches.some((ratio) => ratio !== expectedRatio)) {
    violations.push(`提示词包含与项目画幅 ${expectedRatio} 冲突的比例`);
  }

  if (hasNoDialogue(task) && (SPOKEN_AUDIO.test(prompt) || hasH3SpokenDialogue(prompt))) {
    violations.push("原分镜无对白，但提示词添加了角色对白或独白");
  }

  const audioSupported = config.audioSupported ?? config.audio;
  if (audioSupported === false && VOICEOVER_AUDIO.test(prompt)) {
    violations.push("当前视频模型不支持音频，但提示词添加了旁白");
  }
  if (NARRATION_LIP_SYNC_NEGATIVE.test(prompt)) {
    violations.push("提示词泄露了负向嘴型控制词：旁白应使用非画内叙述，不写闭嘴或 lip-sync 指令");
  }
  const promptWithoutRequestedSoundSuffix = prompt.replace(
    /N\/A\s*\n只保留同步环境音效和动作音效，不生成背景音乐，不生成字幕。\s*$/,
    "N/A",
  );
  if (SUBTITLE_INSTRUCTION.test(promptWithoutRequestedSoundSuffix)) {
    violations.push("提示词要求生成字幕：视频必须全程无字幕，对白和旁白只能作为声音");
  }
  if (hasAffirmativeBackgroundMusic(prompt)) {
    violations.push("提示词包含背景音乐或配乐设计：只允许环境声、动作拟音等音效，背景音乐必须为 N/A");
  }
  if (hasMediumOrMediumLongCharacterShot(task) && !FACE_CLARITY_ANCHOR.test(prompt)) {
    violations.push("中景或中远景缺少人脸清晰度约束：主要人物面部需锐利对焦、五官细节可辨");
  }
  if (
    audioSupported !== false &&
    task.requiresNarrativeVoiceover &&
    !VOICEOVER_AUDIO.test(prompt)
  ) {
    violations.push("章节开场提示词缺少身份或时空落差旁白");
  } else if (
    audioSupported !== false &&
    task.requiresNarrativeVoiceover &&
    !hasConflictVoiceover(prompt)
  ) {
    violations.push(
      "章节旁白只是背景说明：必须在同一句中用明确转折连接原有优势/预期与当前阻碍/代价",
    );
  }
  const narrationDuration = Number(task.duration || 0);
  if (task.requiresNarrativeVoiceover && audioSupported !== false && narrationDuration > 0) {
    const voiceover = extractVoiceover(prompt);
    const chineseCount = voiceover.replace(/[^\u3400-\u9fff]/g, "").length;
    const maxNarrationChars = Math.min(Math.max(Math.floor(narrationDuration * 2), 8), 24);
    if (chineseCount > maxNarrationChars) {
      violations.push(`章节旁白过长：${chineseCount}字，当前片段最多 ${maxNarrationChars} 字`);
    }
  }

  const missingActions = actionAnchors(task).filter(
    (action) => !promptContainsAction(prompt, action),
  );
  const missingCriticalActions = missingActions.filter((action) =>
    CRITICAL_ACTION_ANCHORS.has(action),
  );
  const missingMinorActions = missingActions.filter(
    (action) => !CRITICAL_ACTION_ANCHORS.has(action),
  );
  if (missingCriticalActions.length) {
    violations.push(`分镜关键动作未保留：${missingCriticalActions.join("、")}`);
  }
  if (missingMinorActions.length) {
    warnings.push(
      `动作细节未显式写出（已放行，建议核对提示词）：${missingMinorActions.join("、")}`,
    );
  }

  if (hasDownwardMotion(task) && REVERSED_DOWNWARD_MOTION.test(prompt)) {
    violations.push("人物降落方向与分镜相反：不得上升、升空或从水面倒飞回高空");
  }
  if (hasDownwardMotion(task) && !DOWNWARD_PROMPT.test(prompt)) {
    violations.push("降落动作缺少明确的向下运动锚点：必须写明接近地面/水面或自由落体");
  }

  const shotCount = task.segmentRows?.length || 0;
  const timedMarkers = prompt.match(/\d+(?:\.\d+)?\s*(?:秒|s)(?!\w)/gi) || [];
  const h3ShotMarkers = prompt.match(/\[Shot\s+\d+\]/gi) || [];
  if (
    shotCount > 1 &&
    Math.max(timedMarkers.length, h3ShotMarkers.length) < shotCount
  ) {
    violations.push("多镜头提示词缺少逐镜时间分段，无法稳定控制动作节奏");
  }

  const token = String(config.referenceToken || "");
  if (token && prompt.includes("@图") && token !== "@图") {
    violations.push(`当前模型要求使用 ${token}，提示词仍使用 @图`);
  }
  return splitContractIssues(violations, warnings);
}

// 质量类（只警告、不阻断）：措辞与画质增强项。校验对象是模型生成的自然语言，
// 同一语义有大量合法写法，把这类差异做成硬阻断会让整批生成反复失败；
// 保真类（台词逐字、角色身份、音画禁区、时长与结构）仍保持硬阻断。
const ADVISORY_VIOLATION_PATTERNS: RegExp[] = [
  /^中景或中远景缺少人脸清晰度约束/,
  /^提示词缺少当前画风的可验证锚点/,
  /^提示词泄露了负向嘴型控制词/,
  /^章节开场提示词缺少身份或时空落差旁白/,
  /^章节旁白只是背景说明/,
];

function splitContractIssues(violations: string[], warnings: string[]) {
  const blocking: string[] = [];
  const advisory: string[] = [];
  for (const violation of violations) {
    if (
      ADVISORY_VIOLATION_PATTERNS.some((pattern) => pattern.test(violation))
    ) {
      advisory.push(`${violation}（已放行，建议核对）`);
    } else {
      blocking.push(violation);
    }
  }
  return { violations: blocking, warnings: [...warnings, ...advisory] };
}

/** Return hard contract violations only; kept for existing callers and tests. */
export function collectVideoPromptContractViolations(
  task: VideoPromptContractTask,
  prompt: string,
  config: VideoPromptContractConfig = {},
) {
  return collectVideoPromptContractIssues(task, prompt, config).violations;
}

/** Build actionable English hints for actions the model failed to preserve. */
export function buildMissingActionRetentionHints(
  task: VideoPromptContractTask,
  prompt: string,
): string[] {
  return actionAnchors(task)
    .filter((action) => !promptContainsAction(prompt, action))
    .map(
      (action) =>
        `${action} → 必须在英文正文中写出：${ACTION_ANCHOR_HINTS[action] || action}`,
    );
}
