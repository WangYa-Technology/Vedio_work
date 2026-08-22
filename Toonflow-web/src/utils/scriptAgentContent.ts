const SECTION_LABELS: Record<string, string> = {
  思路: "创作思路",
  故事核: "故事核",
  隐线: "隐线",
  人物小传: "人物小传",
  三幕结构: "三幕结构",
  分集决策: "分集决策",
  全局删减决策记录: "全局删减决策记录",
  剧情卡点设计: "剧情卡点设计",
  股价级反转登记表: "反转登记表",
};

function cleanProtocolText(value: string) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<\/?[\w\u0080-\uFFFF-]+(?:\s[^>]*)?>/g, "")
    .replace(/^[ \t]+|[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Converts stored XML/CDATA protocol text into reader-facing Markdown. */
export function normalizeScriptAgentContent(value: unknown): string {
  const source = typeof value === "string" ? value.replace(/\r\n/g, "\n").trim() : "";
  if (!source) return "";

  const blocks: string[] = [];
  const blockPattern = /<([^\s<>/]+)>\s*([\s\S]*?)\s*<\/\1>/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = blockPattern.exec(source))) {
    const prefix = cleanProtocolText(source.slice(cursor, match.index));
    if (prefix) blocks.push(prefix);

    const tag = match[1];
    const content = cleanProtocolText(match[2]);
    if (tag === "title") {
      if (content) blocks.push(`# ${content}`);
    } else if (content) {
      blocks.push(`## ${SECTION_LABELS[tag] || tag}\n\n${content}`);
    }
    cursor = blockPattern.lastIndex;
  }

  const tail = cleanProtocolText(source.slice(cursor));
  if (tail) blocks.push(tail);

  return blocks.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}
