/**
 * 「H3 3D仿真人短剧推理」模板三处同步 / 一致性校验。
 *
 * 三处指：源码常量（src/constants/h3VideoPromptTemplate.ts）
 *      → DB 行（data/db2.sqlite → o_prompt id=1790420000000 的 data/useData）
 *      → 运行包（data/serve/app.js 内嵌的转义副本，esbuild charset=ascii）。
 *
 * 用法：
 *   npx tsx scripts/syncH3TemplateRuntime.ts           # 补丁运行包 + 同步 DB 行 + 校验
 *   npx tsx scripts/syncH3TemplateRuntime.ts --check   # 只校验（不改任何文件），不一致时退出码 1
 *
 * 注意：运行包是 esbuild 产物且带历史手工补丁，因此这里只替换模板字面量本身，
 * 不做 `npm run build` 全量重建。改前请自行备份 data/serve/app.js 与 DB 行。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(__filename);
// 与 scripts/verifyRuntimeDatabase.ts 一致：better-sqlite3 无类型声明，按 any 使用。
const Database = require("better-sqlite3") as any;

const ROOT = process.cwd();
const TS_SOURCE = path.join(ROOT, "src", "constants", "h3VideoPromptTemplate.ts");
const BUNDLE = path.join(ROOT, "data", "serve", "app.js");
const DB_FILE = path.join(ROOT, "data", "db2.sqlite");
const TEMPLATE_ID = 1790420000000;
const MARKER = "H3_VIDEO_PROMPT_TEMPLATE_CONTENT = `";

const checkOnly = process.argv.includes("--check");

function unescapeTemplateLiteral(raw: string) {
  return raw.replace(/\\\$\{/g, "${").replace(/\\`/g, "`").replace(/\\\\/g, "\\");
}

function decodeEscaped(raw: string) {
  return unescapeTemplateLiteral(
    raw
      .replace(/\\u([0-9A-Fa-f]{4})/g, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\x([0-9A-Fa-f]{2})/g, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16))),
  );
}

/**
 * esbuild（charset=ascii）的转义规则：0x80~0xFF → \xHH，更高 → \uXXXX（大写四位），
 * 非 BMP → 代理对；反引号、反斜杠、${ 转义；换行/制表保留。
 */
function escapeForBundle(content: string) {
  return content.replace(/\\|`|\$\{|[^\x00-\x7F]/g, (match) => {
    if (match === "\\") return "\\\\";
    if (match === "`") return "\\`";
    if (match === "${") return "\\${";
    const code = match.codePointAt(0) ?? 0;
    if (code <= 0xff) return `\\x${code.toString(16).toUpperCase().padStart(2, "0")}`;
    if (code <= 0xffff) return `\\u${code.toString(16).toUpperCase().padStart(4, "0")}`;
    const high = Math.floor((code - 0x10000) / 0x400) + 0xd800;
    const low = ((code - 0x10000) % 0x400) + 0xdc00;
    return `\\u${high.toString(16).toUpperCase().padStart(4, "0")}\\u${low
      .toString(16)
      .toUpperCase()
      .padStart(4, "0")}`;
  });
}

/** 取出模板字面量正文（含转义原文），返回起止下标。 */
function locateLiteral(source: string, marker: string) {
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`未找到标记：${marker}`);
  const from = start + marker.length;
  const end = source.indexOf("\n`;", from);
  if (end < 0) throw new Error("未找到模板字面量结束标记（\\n`;）");
  return { from, end };
}

function sha256(text: string) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function normalizeLineEndings(text: string) {
  return text.replace(/\r\n/g, "\n");
}

function main() {
  const source = fs.readFileSync(TS_SOURCE, "utf8");
  const sourceLiteral = locateLiteral(source, MARKER);
  const constantContent = unescapeTemplateLiteral(source.slice(sourceLiteral.from, sourceLiteral.end));

  const db = new Database(DB_FILE, { readonly: checkOnly });
  const row = db
    .prepare("select id, name, data, useData from o_prompt where id = ?")
    .get(TEMPLATE_ID) as { id: number; name: string; data: string; useData: string } | undefined;
  if (!row) throw new Error(`DB 中未找到模板行 id=${TEMPLATE_ID}`);

  let bundle = fs.readFileSync(BUNDLE, "utf8");
  let bundleLiteral = locateLiteral(bundle, MARKER);
  const bundleContentBefore = decodeEscaped(bundle.slice(bundleLiteral.from, bundleLiteral.end));

  const results: { label: string; text: string }[] = [
    { label: "源码常量", text: constantContent },
    { label: "DB useData", text: row.useData || "" },
    { label: "DB data", text: row.data || "" },
    { label: "运行包", text: bundleContentBefore },
  ];

  const mismatched = results.filter(
    (item) => sha256(normalizeLineEndings(item.text)) !== sha256(normalizeLineEndings(constantContent)),
  );

  if (!checkOnly && mismatched.length) {
    const escaped = escapeForBundle(constantContent);
    bundle =
      bundle.slice(0, bundleLiteral.from) + escaped + bundle.slice(bundleLiteral.end);
    fs.writeFileSync(BUNDLE, bundle, "utf8");

    if (row.useData !== constantContent || row.data !== constantContent) {
      const writable = new Database(DB_FILE);
      writable
        .prepare("update o_prompt set data = ?, useData = ? where id = ?")
        .run(constantContent, constantContent, TEMPLATE_ID);
      writable.close();
    }

    bundle = fs.readFileSync(BUNDLE, "utf8");
    bundleLiteral = locateLiteral(bundle, MARKER);
    results[2] = { label: "DB useData", text: constantContent };
    results[3] = { label: "DB data", text: constantContent };
    results[1] = { label: "运行包", text: decodeEscaped(bundle.slice(bundleLiteral.from, bundleLiteral.end)) };
  }

  db.close();

  const baseHash = sha256(normalizeLineEndings(constantContent));
  console.log(`模板 id=${TEMPLATE_ID}（${row.name}），正文 ${constantContent.length} 字符`);
  let failed = false;
  for (const item of results) {
    const hash = sha256(normalizeLineEndings(item.text));
    const ok = hash === baseHash;
    if (!ok) failed = true;
    console.log(
      `${ok ? "✔" : "✘"} ${item.label}：${item.text.length} 字符 / sha256 ${hash.slice(0, 12)}`,
    );
  }
  console.log(failed ? "存在不一致 ✘" : "三处一致 ✔");
  if (failed) process.exitCode = 1;
}

main();
