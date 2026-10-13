import { extractOnScreenText } from "@/utils/onScreenText";
import { cleanSpeakerName, isSameSpeaker } from "@/utils/videoPromptContract";

/**
 * 说话角色参考检测的共享实现。
 *
 * 视频推理前的"说话角色缺少独立角色参考"校验（generateVideoPrompt）与
 * 工作台"一键修复"的补齐轮询检查（checkSpeakerReferences）共用这套解析与
 * 判定逻辑，保证两处语义完全一致、避免漂移。
 */

/** 一条"说话角色缺少独立角色参考"的结构化记录（400 响应与检查接口共用契约）。 */
export interface MissingSpeakerEntry {
  /** 视频片段轨道 id（对应 o_storyboard.trackId）。 */
  trackId: number;
  /** 该片段全部正式分镜的真实 ID。 */
  storyboardIds: number[];
  sceneTitle: string;
  segmentTitle: string;
  speakerName: string;
}

function stripFieldLabel(value: unknown, label: string) {
  return String(value || "")
    .trim()
    .replace(new RegExp(`^${label}[：:]\\s*`), "")
    .trim();
}

function parseDialogue(value: string) {
  const raw = String(value || "").trim();
  if (!raw || /^(?:无|无台词|无对白|暂无|-)$/i.test(raw)) {
    return {
      dialogueType: "none",
      speakerName: "",
      speakerNames: [] as string[],
      actualDialogue: "",
    };
  }
  const dialogueType = /(?:内心独白|\bOS\b)/i.test(raw)
    ? "inner_monologue_os"
    : /(?:画外音|旁白|\bVO\b)/i.test(raw)
      ? "voiceover_vo"
      : "dialogue";
  // 同一个镜头可能包含多句不同角色的对话（<br> 或换行分隔），逐句解析：
  // 整块解析会把后一句的说话人前缀混进前一句的台词里。
  const segments = raw
    .split(/<br\s*\/?>|\n+/i)
    .map((segment) => segment.trim())
    .filter(Boolean);
  const parsedSegments = (segments.length ? segments : [raw]).map((segment) => {
    const withoutType = segment
      .replace(/^(?:普通对白|对白|内心独白|画外音|旁白)\s*(?:OS|VO)?\s*[：:]?\s*/i, "")
      .trim();
    const speakerMatch = withoutType.match(/^([^：:\n]{1,24})[：:]\s*([\s\S]+)$/);
    const rawSpeaker = speakerMatch?.[1]?.trim() || "";
    // "OS（陈照野，平静）"这类把类型前缀写在括号外的写法：真正的说话人在括号内。
    const typedSpeaker = rawSpeaker.match(
      /^(?:OS|VO|旁白|画外音|内心独白)\s*[（(]\s*([^，,、）)]+)/i,
    );
    return {
      speakerName: cleanSpeakerName(
        typedSpeaker ? typedSpeaker[1].trim() : rawSpeaker,
      ),
      text: (speakerMatch?.[2] || withoutType)
        .replace(/^[“"「『]|[”"」』]$/g, "")
        .trim(),
    };
  });
  const speakerNames = [
    ...new Set(parsedSegments.map((item) => item.speakerName).filter(Boolean)),
  ];
  return {
    dialogueType,
    speakerName: speakerNames[0] || "",
    speakerNames,
    actualDialogue: parsedSegments
      .map((item) => item.text)
      .filter(Boolean)
      .join("；"),
  };
}

export function normalizeShot(row: Record<string, any>) {
  const rawDialogue = stripFieldLabel(row.dialogue, "台词");
  // 画内文字（"屏幕文字：…""VO（摊车灯牌文字）：…"）不是对白：逐段剔除后再解析说话人，
  // 避免"摊车灯牌文字""刘鹏消息文字""手机来电显示"这类来源标签被当成角色名。
  const segments = rawDialogue
    .split(/<br\s*\/?>|\n+/i)
    .map((segment) => segment.trim())
    .filter(Boolean);
  const onScreenTexts: string[] = [];
  const spokenSegments: string[] = [];
  for (const segment of segments) {
    const onScreenText = extractOnScreenText(segment);
    if (onScreenText) onScreenTexts.push(onScreenText);
    else spokenSegments.push(segment);
  }
  const onScreenText = onScreenTexts.join("；");
  const dialogue = onScreenTexts.length
    ? spokenSegments.join("<br>") || "无台词"
    : rawDialogue || "无台词";
  const speech = parseDialogue(dialogue);
  return {
    sequence: String(row.serial || ""),
    visualAndAction: String(row.description || "").trim(),
    durationSeconds: Number(row.duration) || 0,
    shotScale: String(row.scale || "").trim() || "未标注",
    shotScaleDescription: String(row.scaleDescription || "").trim() || "未标注",
    cameraAngle: String(row.cameraAngle || "").trim() || "未标注",
    cameraMovement: String(row.cameraMovement || "").trim() || "未标注",
    location: String(row.location || "").trim() || "未标注",
    dayPart: String(row.dayPart || "").trim() || "未标注",
    interiorExterior: String(row.interiorExterior || "").trim() || "未标注",
    spatialLayers: String(row.spatialLayers || "").trim() || "未标注",
    dialogue,
    ...speech,
    onScreenText,
    speechAllowed: dialogue !== "无台词",
    sound: stripFieldLabel(row.sound, "音效") || "无音效",
  };
}

export function normalizeShots(rows: Record<string, any>[]) {
  let elapsed = 0;
  return rows.map((row) => {
    const shot = normalizeShot(row);
    const startSeconds = elapsed;
    elapsed += shot.durationSeconds;
    return {
      ...shot,
      startSeconds,
      endSeconds: elapsed,
      h3CutTimestamp:
        startSeconds > 0
          ? `At ${String(Math.floor(startSeconds / 60)).padStart(2, "0")}:${(
              startSeconds % 60
            )
              .toFixed(3)
              .padStart(6, "0")}`
          : "opening shot - no timestamp",
    };
  });
}

export function missingSpeakerReferences(task: Record<string, any>) {
  const roleNames = [
    ...new Set(
      (task.medias || [])
        .filter((media: any) => /role|character|人物|角色/i.test(String(media.type || "")))
        .map((media: any) => String(media.name || "").trim())
        .filter(Boolean),
    ),
  ];
  // 一个镜头可能包含多句不同角色的对话，全部说话人都要检查。
  const speakers = new Set<string>();
  for (const shot of normalizeShots(task.segmentRows || [])) {
    const names: string[] =
      Array.isArray(shot.speakerNames) && shot.speakerNames.length
        ? shot.speakerNames
        : shot.speakerName
          ? [shot.speakerName]
          : [];
    for (const name of names) speakers.add(name);
  }
  // 说话人带叙述动词（"老王问""陈照野答"）或表演标注（"（OS）（小声）"）时不视为缺少参考。
  return [...speakers].filter(
    (speakerName) =>
      Boolean(speakerName) &&
      !roleNames.some((roleName) => isSameSpeaker(speakerName, roleName)),
  );
}

/** 把多个片段任务的缺失说话人汇总为结构化条目（供 400 载荷与检查接口使用）。 */
export function collectMissingSpeakerEntries(tasks: Record<string, any>[]): MissingSpeakerEntry[] {
  return tasks.flatMap((task) =>
    missingSpeakerReferences(task).map((speakerName) => ({
      trackId: Number(task.id),
      storyboardIds: (Array.isArray(task.storyboardIds) ? task.storyboardIds : [])
        .map((id: unknown) => Number(id))
        .filter(Number.isFinite),
      sceneTitle: String(task.sceneTitle || ""),
      segmentTitle: String(task.segmentTitle || ""),
      speakerName,
    })),
  );
}
