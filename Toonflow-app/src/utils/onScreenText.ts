/**
 * 台词列里的「非角色来源标签」识别：画内文字（屏幕/招牌/短信等）与朗读/音效来源。
 *
 * 分镜表把纯文字信息写在台词列的 VO 位置，常见写法：
 *   - `屏幕文字：营业中`、`短信：『你先别激动。』`
 *   - `VO（摊车灯牌文字）：『照野炸串』`
 *   - `（VO）银行流水文字：『收款人：许曼青。材料费。』`
 *   - `VO（手机来电显示）：『许曼青』`
 *   - `VO（旁白）：『退路正在消失。』`、`OS（内心独白）：『我不能再等了。』`
 *   - `VO（心跳声）：『咚、咚。』`
 *
 * 这些内容都不是说话人：一旦照搬"冒号前 = 说话人"的解析，来源标签
 * （"摊车灯牌文字""刘鹏消息文字""手机来电显示""旁白""内心独白"）就会变成假角色，
 * 触发"说话角色缺少独立角色参考"拦截，或在 H3 契约里被要求建立独立说话主体。
 *
 * 识别入口统一放在这里，供说话人校验（speakerReferences）、说话人自动补全
 * （videoTaskData）与 H3 契约校验（videoPromptContract）共用，避免语义漂移。
 *
 * 三类判定：
 *   1. 朗读/播报/音效来源 → `isNarrationSourceLabel` 为真：不绑定角色，但台词照常发声（画外旁白）；
 *   2. 屏幕/招牌/文档等文字来源 → `extractOnScreenText` 返回正文：只作为画面文字，不发声、不要参考；
 *   3. 其余 → 角色（保持原有说话人解析，缺参考图仍会被拦截）。
 */

const VOICE_TYPE_LABEL = "(?:OS|VO|旁白|画外音|内心独白)";

/** 类型前缀两种写法："VO（…）" 与 "（VO）…"。 */
const TYPE_WRAPPER_PATTERN = new RegExp(
  `^(?:${VOICE_TYPE_LABEL}\\s*[（(]\\s*|[（(]\\s*${VOICE_TYPE_LABEL}\\s*[）)]\\s*)`,
  "i",
);

/** 去掉类型前缀后的「来源标签：正文」。 */
const LABEL_AND_BODY_PATTERN = /^([^：:（）()\n]{1,24}?)\s*[）)]?\s*[：:]\s*([\s\S]+)$/;

/**
 * 朗读/播报/系统类来源标签：属于"声音"而不是"画面文字"，也不是角色本身。
 * 这类台词保留发声（画外旁白处理），但不参与角色参考绑定。
 */
const NARRATION_SOURCE_LABELS =
  /^(?:旁白|画外音|内心独白|独白|内心|心声|自语|系统|系统播报|系统提示|播报|广播|电台|新闻播报|解说|叙述|叙述者)$/;

/**
 * 音效类来源标签（"心跳声""提示音""钟摆响"）：同样不是角色。
 * 用"声音修饰词 + 声/响/音"限定，避免把"李美音""苏晚声"这类角色名误判成音效来源。
 */
const SOUND_SOURCE_LABEL =
  /^(?:心跳|呼吸|脚步|敲门|开门|关门|雨|风|雷|铃|钟|鼓|掌声|笑声|哭声|叫声|响声|杂|噪|回|鸣|爆|电流|警报|震动|玻璃|金属|碰撞|摩擦|翻页|键盘|鼠标|水流|海浪|喷溅|提示|广播|机器|风扇|空调|电话铃)[^，。、\s]{0,4}(?:声|响|音)$/;

/**
 * 屏幕/设备/界面/文书类来源标签前缀：这些词都不是人名，裸写（`短信：…`）与写在
 * VO/OS 标签里（`VO（手机来电显示）：…`）都按画内文字处理。
 */
const SCREEN_TEXT_SOURCE_PREFIXES = [
  "来电显示",
  "通话界面",
  "通话记录",
  "手机",
  "屏幕",
  "显示器",
  "平板",
  "电视",
  "监控",
  "投影",
  "短信",
  "微信",
  "聊天记录",
  "聊天",
  "消息",
  "弹幕",
  "评论",
  "面板",
  "界面",
  "字幕",
  "标题",
  "招牌",
  "灯牌",
  "牌匾",
  "海报",
  "横幅",
  "标语",
  "菜单",
  "价目表",
  "账单",
  "报表",
  "流水",
  "截图",
  "转账",
  "备注",
  "信件",
  "信纸",
  "纸条",
  "便签",
  "笔记",
  "日记",
  "账本",
  "告示",
  "贴纸",
  "标签",
  "日历",
  "文件",
  "合同",
  "报纸",
  "书页",
  "画面",
];

function stripWrappingQuotes(value: string) {
  const trimmed = value.trim();
  const match = trimmed.match(/^([『「“‘"'])([\s\S]+)([』」”’"'])$/);
  return match ? match[2].trim() : trimmed;
}

/** 归一化标签：去空白。 */
function normalizeLabel(value: unknown) {
  return String(value || "")
    .replace(/\s+/g, "")
    .trim();
}

/** 剥离类型前缀，取出来源标签与正文；写法不匹配时返回 null。 */
function splitLabelAndBody(value: unknown) {
  let rest = String(value || "").trim();
  const wrapper = rest.match(TYPE_WRAPPER_PATTERN);
  if (wrapper) rest = rest.slice(wrapper[0].length).trim();
  const match = rest.match(LABEL_AND_BODY_PATTERN);
  if (!match) return null;
  return { label: normalizeLabel(match[1]), body: match[2] };
}

/** 该来源标签是否指"朗读/播报/音效"而非角色（"旁白""内心独白""心跳声"）。 */
export function isNarrationSourceLabel(value: unknown) {
  const label = normalizeLabel(value);
  if (!label) return false;
  return NARRATION_SOURCE_LABELS.test(label) || SOUND_SOURCE_LABEL.test(label);
}

function isScreenTextSourceLabel(label: string) {
  if (!label) return false;
  // 文字信息类：任意前缀 + "文字"（"屏幕文字""摊车灯牌文字""备注栏文字"）。
  if (/文字$/.test(label)) return true;
  return SCREEN_TEXT_SOURCE_PREFIXES.some((prefix) => label.startsWith(prefix));
}

/**
 * 返回该段台词对应的画内文字正文（已去掉来源标签与包裹引号）；
 * 不是画内文字时返回空串。入参为单段文本（多句台词请先按 `<br>`/换行拆分）。
 */
export function extractOnScreenText(value: unknown): string {
  const part = splitLabelAndBody(value);
  if (!part) return "";
  // 朗读/播报/音效来源是声音，不是画面文字。
  if (isNarrationSourceLabel(part.label)) return "";
  if (!isScreenTextSourceLabel(part.label)) return "";
  return stripWrappingQuotes(part.body);
}
