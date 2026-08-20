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
}

const STYLE_CONTAMINATION = /真人|实拍|IMAX|Arri\s*Alexa|2\.39\s*:\s*1|\b8K\b/i;
const SPOKEN_AUDIO = /(?:台词|对白|说|喊|叫|低语|独白)[：:]\s*[“"「『]?\s*(?!无台词|无对白|无)([^\n；。.!！]{1,80})/i;
const VOICEOVER_AUDIO = /(?:旁白|画外音|voiceover|\bVO\b)[：:]/i;
const VOICEOVER_CONFLICT_TURN = /却|偏偏|竟|反而|谁知|不料|没想到|从未想到|可(?:现在|如今|此刻)|但(?:现在|如今|此刻)|上一(?:刻|秒)[\s\S]{0,80}下一(?:刻|秒)|原本[\s\S]{0,80}(?:现在|如今|此刻)|\bbut\b|\byet\b|\binstead\b|never (?:thought|expected)|a moment ago[\s\S]{0,80}(?:now|the next moment)/i;
const VOICEOVER_PRESSURE = /失去|失控|失能|失重|消失|坠落|坠入|下坠|危险|威胁|阻碍|代价|退路|来不及|活命|能活|活下来|落点|困住|逼近|无法|不能|决定不了|陌生|背叛|失败|暴露|死亡|死路|绝境|los(?:e|es|t)|out of control|unable|cannot|danger|threat|obstacle|cost|trapped|closing in|fall(?:s|ing)?|plung(?:e|es|ing)|death|no escape/i;
const NARRATION_LIP_SYNC_NEGATIVE = /角色闭嘴|角色嘴部紧闭|lips?\s+(?:remain\s+)?(?:completely\s+)?closed|lip[- ]?sync\s+(?:is\s+)?disabled/i;
const SUBTITLE_INSTRUCTION = /(?:生成|添加|显示|出现|叠加|呈现|带有|烧录|嵌入)(?:任何|中文|英文|双语|自动)?字幕|字幕[：:]\s*(?!无|不|禁止|N\/?A|none)[^\n；。]{1,80}|(?:show|add|render|display|burn(?:ed)?[- ]?in)\s+(?:any\s+)?subtitles?/i;
const AFFIRMATIVE_BACKGROUND_MUSIC = /(?:背景音乐|背景配乐|非画内配乐|非叙事性音乐|\bBGM\b|non[-_ ]diegetic[_ ]music|配乐(?:设计)?)[：:]\s*(?!(?:N\/?A|无|none)(?:\s|$))[^\n；。]{1,120}|(?:配乐|背景音乐|\bBGM\b)[^\n；。]{0,18}(?:进入|响起|渐入|铺陈|增强|淡出)|(?:加入|使用|播放)[^\n；。]{0,18}(?:背景音乐|配乐|\bBGM\b)|(?:background|non[- ]diegetic) music[：:]\s*(?!(?:N\/?A|none)(?:\s|$))[^\n.;]{1,100}/i;
const FACE_CLARITY_ANCHOR = /(?:面部|脸部|人脸)[^。；\n]{0,36}(?:清晰|锐利|对焦|五官可辨|细节可辨)|五官[^。；\n]{0,24}(?:清晰|可辨|锐利)|(?:face|facial (?:features|details?))[^.\n]{0,42}(?:clear|sharp|readable|in focus|well-defined)/i;
const ACTION_ANCHORS = /猛然坐起|坐起|起身|踹门|推门|开门|转身|奔跑|跑向|冲向|抬头|低头|挥手|伸手|抓住|拔出|倒下|跌倒|爆炸|递给|拿起|放下|摔倒|拍打|敲门|看向|回头|后退|前进|拥抱|亲吻|殴打|踢|砍|躲|闪避|哭泣|大笑|怒吼|点头|摇头/g;
const ACTION_ANCHOR_TRANSLATIONS: Record<string, RegExp> = {
  猛然坐起: /sits? up (?:suddenly|abruptly)|abruptly sits? up/i,
  坐起: /sits? up/i,
  起身: /(?:stands?|gets?) up|rises? to (?:his|her|their) feet/i,
  踹门: /kicks? (?:open )?(?:the )?door/i,
  推门: /pushes? (?:open )?(?:the )?door/i,
  开门: /opens? (?:the )?door/i,
  转身: /turns? (?:around|back)?/i,
  奔跑: /runs?|sprints?/i,
  跑向: /runs? toward/i,
  冲向: /rushes?|charges?|lunges? toward/i,
  抬头: /raises? (?:his|her|their) head|looks? up/i,
  低头: /lowers? (?:his|her|their) head|looks? down/i,
  挥手: /waves? (?:his|her|their)? ?hand/i,
  伸手: /reaches? (?:out|toward)/i,
  抓住: /grabs?|seizes?|catches? hold/i,
  拔出: /draws?|pulls? out/i,
  倒下: /falls? down|collapses?/i,
  跌倒: /falls? over|stumbles? and falls?/i,
  爆炸: /explodes?|erupts?|detonates?/i,
  递给: /hands?|passes? .{0,30} to/i,
  拿起: /picks? up|lifts?/i,
  放下: /puts? down|sets? down/i,
  摔倒: /falls? over|is knocked down/i,
  拍打: /pats?|slaps?|strikes?/i,
  敲门: /knocks? (?:on|at) (?:the )?door/i,
  看向: /looks? (?:at|toward)/i,
  回头: /looks? back|turns? (?:his|her|their) head back/i,
  后退: /steps? back|retreats?|moves? backward/i,
  前进: /moves? forward|advances?/i,
  拥抱: /embraces?|hugs?/i,
  亲吻: /kisses?/i,
  殴打: /punches?|beats?|strikes?/i,
  踢: /kicks?/i,
  砍: /slashes?|chops?|cuts? at/i,
  躲: /ducks?|dodges?|hides?/i,
  闪避: /dodges?|evades?|sidesteps?/i,
  哭泣: /cries?|weeps?/i,
  大笑: /laughs?/i,
  怒吼: /roars?|shouts?|yells?/i,
  点头: /nods?/i,
  摇头: /shakes? (?:his|her|their) head/i,
};
const DOWNWARD_MOTION = /坠落|坠入|下坠|自由落体|落向|降落|向下落/;
const DOWNWARD_PROMPT = /坠落|坠入|下坠|自由落体|向下落|向下坠|接近(?:湖面|水面|地面)|冲入湖面|砸入湖面|falls? downward|falls? (?:vertically|straight down)|drops? (?:downward|vertically|straight down)|(?:is |continues? )?(?:falling|descending|dropping)(?: toward| toward the| downward| vertically| straight down)?|descends? toward|plunges? toward|free-?falls?|continues? falling|approaches? (?:the )?(?:lake|water|ground)|moves? from (?:the )?top of (?:the )?frame toward (?:the )?(?:lake|water|ground)/i;
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
    return !value || /^(?:无|无台词|暂无|无对白|-)$/i.test(value);
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

/** Return hard contract violations that can be verified without inspecting video pixels. */
export function collectVideoPromptContractViolations(
  task: VideoPromptContractTask,
  prompt: string,
  config: VideoPromptContractConfig = {},
) {
  const violations: string[] = [];
  violations.push(...validateH3Structure(prompt, config));
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
  if (SUBTITLE_INSTRUCTION.test(prompt)) {
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
  if (missingActions.length) {
    violations.push(`分镜关键动作未保留：${missingActions.join("、")}`);
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
  return violations;
}
