interface FallbackReference {
  name?: unknown;
  type?: unknown;
}

interface FallbackTask {
  segmentTitle?: unknown;
  duration?: unknown;
  isEpisodeOpening?: boolean;
  requiresNarrativeVoiceover?: boolean;
  medias?: FallbackReference[];
  segmentRows?: Array<{
    serial?: unknown;
    description?: unknown;
    duration?: unknown;
    scale?: unknown;
    cameraMovement?: unknown;
    dialogue?: unknown;
    sound?: unknown;
  }>;
}

function clean(value: unknown, fallback = "未标注") {
  const text = String(value || "").trim();
  return text || fallback;
}

function stripLabel(value: unknown, label: string) {
  return clean(value, "无").replace(new RegExp(`^${label}[：:]\\s*`), "").trim() || "无";
}

function referenceType(value: unknown) {
  const normalized = String(value || "").toLowerCase();
  if (/role|character|人物|角色/.test(normalized)) return "角色";
  if (/scene|场景/.test(normalized)) return "场景";
  if (/prop|props|道具|tool/.test(normalized)) return "道具";
  return "资产";
}

/**
 * Last-resort prompt recovery. It is intentionally factual: it serializes the
 * already approved shot rows and asset map, so it cannot invent a new event.
 */
export function buildChineseVideoPromptFallback(
  task: FallbackTask,
  projectConfig: { referenceToken?: unknown; videoRatio?: unknown; artStyle?: unknown } = {},
) {
  const token = clean(projectConfig.referenceToken, "@图");
  const duration = Number(task.duration) || 10;
  const ratio = clean(projectConfig.videoRatio, "16:9");
  const style = clean(projectConfig.artStyle, "半写实3D动漫风格");
  const references = task.medias || [];
  const subjectDefinitions = references.length
    ? references
        .map(
          (reference, index) =>
            `<Subject ${index + 1}> 是来自 ${token}${index + 1} 的${referenceType(reference.type)}参考“${clean(reference.name)}”；锁定其身份、外观、材质和空间职责。`,
        )
        .join("\n")
    : "无参考素材（纯文字生成视频）。";
  const retention = references.length
    ? references
        .map(
          (_reference, index) =>
            `<Subject ${index + 1}>：fully_preserved - 在当前片段中保持参考身份和视觉职责。`,
        )
        .join("\n")
    : "无参考素材。";
  const rows = task.segmentRows || [];
  const hasDownwardMotion = rows.some((row) =>
    /坠落|坠入|下坠|自由落体|落向|降落|向下落/.test(String(row.description || "")),
  );
  const openingHook = hasDownwardMotion
    ? "开场第一帧降落伞骤然塌陷，王胜失去控制并开始下坠；湖面成为唯一落点，危险立即逼近。"
    : "开场立即呈现分镜中已有的阻碍和人物压力，不增加新事件。";
  let elapsed = 0;
  const shots = rows.length
    ? rows
        .map((row, index) => {
          const shotDuration = Number(row.duration) || 2;
          const start = elapsed;
          elapsed += shotDuration;
          const end = elapsed;
          const dialogue = stripLabel(row.dialogue, "台词");
          const sound = stripLabel(row.sound, "音效");
          const spoken = dialogue !== "无" && !/无台词|无对白/.test(dialogue)
            ? `台词：${dialogue}。`
            : "无台词。";
          const opening = index === 0 ? `${openingHook} ` : "";
          const scale = clean(row.scale, "中景");
          const faceClarity = /中景|中远景|medium(?:[- ]long)? shot/i.test(scale)
            ? "主要人物面部保持锐利对焦，眼睛、鼻子、嘴部与轮廓清晰可辨，不被景深或运动模糊覆盖。"
            : "";
          return `[Shot ${index + 1}] ${start}-${end}秒，${scale}，${clean(row.cameraMovement, "稳定跟拍")}。${opening}${clean(row.description)}。${faceClarity}${spoken}音效：${sound}。`;
        })
        .join("\n")
    : `[Shot 1] 0-${duration}秒，中景，固定。保持当前片段的主体、场景和动作连续。无台词。音效：无。`;
  const voiceover = task.requiresNarrativeVoiceover
    ? "旁白 VO：王牌狙击手，却失去降落伞。"
    : "";
  const visualStyle = "半写实3D动漫渲染，符合人体结构的动漫比例，柔和风格化皮肤明暗，细致织物材质，克制轮廓线，电影式光线衰减";
  const referenceUsage = references.length
    ? `本片段实际使用参考：${references.map((_reference, index) => `<Subject ${index + 1}>`).join("、")}。`
    : "";
  return `subject_definitions:\n${subjectDefinitions}\nsummary:\n[reference generation] ${duration}秒，${ratio}画幅，${style}。严格依据当前片段完成动作，${openingHook}\nretention_analysis:\n${retention}\ndetailed_description:\n${visualStyle}。${referenceUsage}画面保持角色、道具、场景和光线连续。全程无字幕、无标题、无对话气泡、无水印、无 logo；对白和旁白只作为声音。${voiceover}\n${shots}\noverall_soundscape:\n仅按时间线保留环境底床、动作拟音、呼吸、风声和撞击等已提供的镜内音效，并与对应动作同步；不加入任何背景音乐。\nnon_diegetic_music:\nN/A`;
}
