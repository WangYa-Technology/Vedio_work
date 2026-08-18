import { createRequire } from "node:module";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { auditVideoOutput } from "../src/utils/videoOutputAudit";

const require = createRequire(__filename);
const Database = require("better-sqlite3") as any;
const appRoot = process.cwd();
const shouldPersist = process.argv.includes("--write");
const db = new Database(path.join(appRoot, "data", "db2.sqlite"), { readonly: !shouldPersist });
const videoColumns = db.prepare("pragma table_info(o_video)").all() as Array<{ name: string }>;
const outputAuditColumn = videoColumns.some((column) => column.name === "outputAudit")
  ? "v.outputAudit"
  : "null as outputAudit";
const rows = db
  .prepare(
    `select v.id, v.videoTrackId, v.time, v.filePath, v.model,
            v.promptSnapshot, v.generationConfig, ${outputAuditColumn}, p.videoRatio,
            t.duration as trackDuration
       from o_video v
       left join o_project p on p.id = v.projectId
       left join o_videoTrack t on t.id = v.videoTrackId
      where v.filePath is not null and v.filePath != ''
      order by v.createTime desc`,
  )
  .all();

function expectedDuration(row: any) {
  const storedTime = Number(row.time);
  if (Number.isFinite(storedTime) && storedTime >= 1 && storedTime <= 120) {
    return storedTime;
  }
  const trackDuration = Number(row.trackDuration);
  return Number.isFinite(trackDuration) && trackDuration >= 1 && trackDuration <= 120
    ? trackDuration
    : null;
}

const report: Array<Record<string, any>> = rows.map((row: any) => {
  const filePath = path.join(appRoot, "data", "oss", String(row.filePath).replace(/^[/\\]+/, ""));
  let metadata: { width?: number; height?: number; duration?: number } = {};
  try {
    metadata = JSON.parse(
      execFileSync(
        "ffprobe",
        [
          "-v", "error",
          "-select_streams", "v:0",
          "-show_entries", "stream=width,height,duration",
          "-of", "json",
          filePath,
        ],
        { encoding: "utf8" },
      ),
    ).streams?.[0] || {};
  } catch {
    return { id: row.id, filePath: row.filePath, issues: ["无法读取视频媒体元数据"] };
  }
  const audit = auditVideoOutput({
    expectedRatio: row.videoRatio || "16:9",
    expectedDuration: expectedDuration(row) || undefined,
    width: Number(metadata.width),
    height: Number(metadata.height),
    actualDuration: Number(metadata.duration),
  });
  return {
    id: row.id,
    videoTrackId: row.videoTrackId,
    model: row.model || "未记录",
    filePath: row.filePath,
    expectedRatio: row.videoRatio || "16:9",
    actualRatio: audit.actualRatio,
    actualWidth: Number(metadata.width) || null,
    actualHeight: Number(metadata.height) || null,
    expectedDuration: expectedDuration(row),
    actualDuration: Number(metadata.duration) || null,
    durationDriftSeconds: audit.durationDriftSeconds,
    hasPromptSnapshot: Boolean(row.promptSnapshot),
    hasGenerationConfig: Boolean(row.generationConfig),
    hasOutputAudit: Boolean(row.outputAudit),
    issues: audit.issues,
  };
});

let persistedOutputAudits = 0;
if (shouldPersist && videoColumns.some((column) => column.name === "outputAudit")) {
  const updateAudit = db.prepare(
    "update o_video set outputAudit = ? where id = ? and outputAudit is null",
  );
  const writeAudits = db.transaction((items: Array<Record<string, any>>) => {
    for (const item of items) {
      if (item.hasOutputAudit || !item.actualRatio) continue;
      const result = updateAudit.run(
        JSON.stringify({
          schemaVersion: 1,
          source: "retroactive-audit",
          auditedAt: Date.now(),
          width: item.actualWidth,
          height: item.actualHeight,
          actualDuration: item.actualDuration,
          actualRatio: item.actualRatio,
          durationDriftSeconds: item.durationDriftSeconds,
          aspectMismatch: item.issues.some((issue: string) => issue.includes("画幅")),
          issues: item.issues,
        }),
        item.id,
      );
      persistedOutputAudits += result.changes;
    }
  });
  writeAudits(report);
}

console.log(
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      total: report.length,
      persistedOutputAudits,
      summary: {
        aspectMismatch: report.filter((item) => item.issues.some((issue: string) => issue.includes("画幅"))).length,
        durationDrift: report.filter((item) => item.issues.some((issue: string) => issue.includes("时长"))).length,
        missingPromptSnapshots: report.filter((item) => !item.hasPromptSnapshot).length,
        missingGenerationConfigs: report.filter((item) => !item.hasGenerationConfig).length,
        missingOutputAudits: Math.max(
          0,
          report.filter((item) => !item.hasOutputAudit).length - persistedOutputAudits,
        ),
      },
      report,
    },
    null,
    2,
  ),
);
db.close();
