import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(__filename);
const Database = require("better-sqlite3") as any;
const dataRoot = path.resolve(process.cwd(), "data");
const dbPath = path.join(dataRoot, "db2.sqlite");
const ossRoot = path.join(dataRoot, "oss");
const allowMissingMedia = process.argv.includes("--allow-missing-media");
const allowUntrackedMedia = process.argv.includes("--allow-untracked-media");

type Issue = { kind: string; detail: string };
const issues: Issue[] = [];

function isTracked(filePath: string) {
  try {
    const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
    const relative = path.relative(repoRoot, filePath);
    execFileSync("git", ["ls-files", "--error-unmatch", "--", relative], { cwd: repoRoot, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

if (!fs.existsSync(dbPath)) {
  console.error(`[runtime-data] missing database: ${dbPath}`);
  process.exit(1);
}
if (fs.statSync(dbPath).size === 0) {
  console.error(`[runtime-data] refusing 0-byte database: ${dbPath}`);
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });
try {
  const integrity = db.pragma("integrity_check", { simple: true });
  if (integrity !== "ok") issues.push({ kind: "database", detail: `integrity_check=${integrity}` });

  const tableExists = db.prepare("select 1 from sqlite_master where type = 'table' and name = ?");
  for (const table of ["o_project", "o_script", "o_assets", "o_image", "o_storyboard", "o_videoTrack", "o_assets2Storyboard"]) {
    if (!tableExists.get(table)) issues.push({ kind: "schema", detail: `missing table ${table}` });
  }

  const projects = db.prepare("select id, name from o_project order by id").all() as Array<{ id: number; name: string }>;
  const mediaRows = db.prepare(`
    select a.id as assetId, a.projectId, a.name, i.filePath
    from o_assets a
    join o_image i on i.id = a.imageId
    where i.filePath is not null and trim(i.filePath) <> ''
  `).all() as Array<{ assetId: number; projectId: number; name: string; filePath: string }>;
  const checkMediaFile = (kind: string, id: number, projectId: number, filePath: string) => {
    if (/^https?:\/\//i.test(filePath)) return;
    const localPath = path.resolve(ossRoot, filePath.replace(/^[/\\]+/, ""));
    if (!localPath.startsWith(`${ossRoot}${path.sep}`) || !fs.existsSync(localPath)) {
      issues.push({ kind: "media", detail: `${kind} ${id} project ${projectId} -> ${filePath}` });
      return;
    }
    if (!allowUntrackedMedia && !isTracked(localPath)) {
      issues.push({ kind: "git", detail: `${kind} ${id} file is not tracked: ${path.relative(process.cwd(), localPath)}` });
    }
  };
  for (const row of mediaRows) {
    checkMediaFile("asset", row.assetId, row.projectId, row.filePath);
  }
  const storyboardMedia = db.prepare("select id, projectId, filePath from o_storyboard where filePath is not null and trim(filePath) <> ''").all() as Array<{ id: number; projectId: number; filePath: string }>;
  for (const row of storyboardMedia) checkMediaFile("storyboard", row.id, row.projectId, row.filePath);
  const videoMedia = db.prepare("select id, projectId, filePath from o_video where filePath is not null and trim(filePath) <> ''").all() as Array<{ id: number; projectId: number; filePath: string }>;
  for (const row of videoMedia) checkMediaFile("video", row.id, row.projectId, row.filePath);

  const invalidBindings = db.prepare(`
    select r.storyboardId, r.assetId
    from o_assets2Storyboard r
    left join o_storyboard s on s.id = r.storyboardId
    left join o_assets a on a.id = r.assetId
    where s.id is null or a.id is null or s.projectId <> a.projectId
  `).all() as Array<{ storyboardId: number; assetId: number }>;
  for (const row of invalidBindings) {
    issues.push({ kind: "binding", detail: `storyboard ${row.storyboardId} <-> asset ${row.assetId} project mismatch/orphan` });
  }

  const unboundStoryboards = db.prepare(`
    select s.id
    from o_storyboard s
    left join o_assets2Storyboard r on r.storyboardId = s.id
    group by s.id
    having count(r.assetId) = 0
  `).all() as Array<{ id: number }>;
  for (const row of unboundStoryboards) {
    issues.push({ kind: "binding", detail: `storyboard ${row.id} has no asset binding` });
  }

  const storyboardRows = db.prepare(`
    select id, projectId, scriptId, videoDesc
    from o_storyboard
    where trim(coalesce(videoDesc, '')) <> ''
  `).all() as Array<{ id: number; projectId: number; scriptId: number; videoDesc: string }>;
  const seenKeys = new Set<string>();
  for (const row of storyboardRows) {
    const header = String(row.videoDesc || "").split(/\r?\n/, 1)[0].trim();
    const match = header.match(/^(.*?)｜(?:\s*参演角色[^｜\n]*\s*｜)?\s*(片段[^｜\n]+?)\s*｜\s*序号/u);
    if (!match) continue;
    const key = `${row.projectId}/${row.scriptId}/${match[1].replace(/\s+/g, "")}/${match[2].replace(/\s+/g, "")}`;
    if (seenKeys.has(key)) issues.push({ kind: "scene", detail: `duplicate scene/segment key ${key}` });
    seenKeys.add(key);
  }

  const trackMismatches = db.prepare(`
    select s.id as storyboardId, s.trackId
    from o_storyboard s
    left join o_videoTrack t on t.id = s.trackId
    where t.id is null or t.projectId <> s.projectId or t.scriptId <> s.scriptId
  `).all() as Array<{ storyboardId: number; trackId: number }>;
  for (const row of trackMismatches) {
    issues.push({ kind: "track", detail: `storyboard ${row.storyboardId} has invalid track ${row.trackId}` });
  }

  console.log(`[runtime-data] projects=${projects.length}, mediaRows=${mediaRows.length}`);
  const blocking = issues.filter((issue) => issue.kind !== "media" || !allowMissingMedia);
  if (blocking.length) {
    for (const issue of blocking.slice(0, 40)) console.error(`[runtime-data] ${issue.kind}: ${issue.detail}`);
    if (blocking.length > 40) console.error(`[runtime-data] ... and ${blocking.length - 40} more`);
    process.exitCode = 1;
  }
} finally {
  db.close();
}
