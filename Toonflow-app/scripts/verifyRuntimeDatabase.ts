import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";

const require = createRequire(__filename);
const Database = require("better-sqlite3") as any;
const dbPath = path.resolve(process.cwd(), "data", "db2.sqlite");
const allowEmpty = process.argv.includes("--allow-empty");

if (!fs.existsSync(dbPath)) {
  console.error(`[runtime-db] missing: ${dbPath}`);
  process.exit(1);
}

const size = fs.statSync(dbPath).size;
if (size === 0) {
  console.error(`[runtime-db] refusing 0-byte database: ${dbPath}`);
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });
try {
  const integrity = db.pragma("integrity_check", { simple: true });
  if (integrity !== "ok") {
    console.error(`[runtime-db] integrity_check failed: ${integrity}`);
    process.exitCode = 1;
  }

  const requiredTables = ["o_project", "o_script", "o_novel", "o_assets", "o_image", "o_storyboard", "o_video"];
  const tableExists = db.prepare("select 1 from sqlite_master where type = 'table' and name = ?");
  const missingTables = requiredTables.filter((name) => !tableExists.get(name));
  if (missingTables.length) {
    console.error(`[runtime-db] missing tables: ${missingTables.join(", ")}`);
    process.exitCode = 1;
  }

  const count = (table: string) => Number(db.prepare(`select count(*) as count from "${table}"`).get().count);
  const projects = count("o_project");
  const scripts = count("o_script");
  console.log(`[runtime-db] ${dbPath} (${size} bytes): projects=${projects}, scripts=${scripts}`);
  if (!allowEmpty && (projects === 0 || scripts === 0)) {
    console.error("[runtime-db] business database is empty; use --allow-empty only for a new installation");
    process.exitCode = 1;
  }
} finally {
  db.close();
}
