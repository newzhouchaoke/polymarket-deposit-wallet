import fs from "node:fs";
import path from "node:path";
import { backup } from "node:sqlite";
import {
  dbMode,
  dbPath,
  initSchema,
  openDatabase,
  projectDir,
} from "./db.js";

const createBackup = process.argv.includes("--backup");
const db = openDatabase();

try {
  initSchema(db);
  const integrity = db.prepare("PRAGMA integrity_check").all();
  const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all();
  const integrityOk =
    integrity.length === 1 && integrity[0]?.integrity_check === "ok";
  const result = {
    ok: integrityOk && foreignKeyViolations.length === 0,
    checkedAt: new Date().toISOString(),
    mode: dbMode,
    database: dbPath,
    integrity,
    foreignKeyViolations,
    backup: null,
  };

  if (!result.ok) {
    console.error(JSON.stringify(result, null, 2));
    process.exitCode = 1;
  } else if (createBackup) {
    const backupDirectory = path.join(projectDir, "data", "backups");
    fs.mkdirSync(backupDirectory, { recursive: true });
    const timestamp = new Date().toISOString().replaceAll(":", "-");
    const destination = path.join(
      backupDirectory,
      `${dbMode}-${timestamp}.sqlite`,
    );
    db.prepare("PRAGMA wal_checkpoint(PASSIVE)").all();
    await backup(db, destination);
    result.backup = {
      path: destination,
      bytes: fs.statSync(destination).size,
    };
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
} finally {
  db.close();
}
