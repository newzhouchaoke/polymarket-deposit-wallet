import path from "node:path";
import { spawn } from "node:child_process";
import { dbMode, projectDir } from "./db.js";
import {
  atomicWriteJson,
  backoffDelayMs,
  createInterruptibleSleeper,
  readJsonStatus,
  statusWithLiveness,
} from "./service-utils.mjs";

export const chainSyncStatusPath = path.join(
  projectDir,
  "data",
  `chain-sync-${dbMode}-status.json`,
);

const intervalMs = Number(process.env.CHAIN_SYNC_INTERVAL_MS ?? "12000");
const syncChunkSize = String(process.env.SYNC_CHUNK_SIZE ?? "200");
const syncMaxBlocksPerRun = String(process.env.SYNC_MAX_BLOCKS_PER_RUN ?? "1000");
const once = process.argv.includes("--once");
const maxBackoffMs = Number(process.env.CHAIN_SYNC_MAX_BACKOFF_MS ?? "120000");

if (!Number.isInteger(intervalMs) || intervalMs < 3000) {
  throw new Error("CHAIN_SYNC_INTERVAL_MS 必须是 >= 3000 的整数毫秒");
}
if (!Number.isInteger(maxBackoffMs) || maxBackoffMs < intervalMs) {
  throw new Error("CHAIN_SYNC_MAX_BACKOFF_MS 必须是 >= CHAIN_SYNC_INTERVAL_MS 的整数毫秒");
}

function writeStatus(status) {
  atomicWriteJson(
    chainSyncStatusPath,
    { updatedAt: new Date().toISOString(), ...status },
  );
}

function readStatus() {
  return statusWithLiveness(
    readJsonStatus(chainSyncStatusPath, {
      updatedAt: null,
      running: false,
      message: "链上事件持续同步服务尚未写入状态",
    }),
  );
}

function runCommand(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectDir,
      env,
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      else reject(new Error(stderr || stdout || `Command failed with code ${code}`));
    });
  });
}

async function runTick() {
  const startedAt = new Date().toISOString();
  const events = await runCommand("node", ["scripts/db-sync-events.mjs"], {
    ...process.env,
    FULL_SYNC: "true",
    SYNC_CHUNK_SIZE: syncChunkSize,
    SYNC_MAX_BLOCKS_PER_RUN: syncMaxBlocksPerRun,
  });
  const balances = await runCommand("node", ["scripts/db-sync-balances.mjs"]);
  const status = {
    running: true,
    intervalMs,
    syncChunkSize: Number(syncChunkSize),
    syncMaxBlocksPerRun: Number(syncMaxBlocksPerRun),
    startedAt,
    finishedAt: new Date().toISOString(),
    events,
    balances,
  };
  return status;
}

let stopped = false;
let consecutiveErrors = 0;
const sleeper = createInterruptibleSleeper();

async function loop() {
  while (!stopped) {
    let delayMs = intervalMs;
    try {
      const status = await runTick();
      consecutiveErrors = 0;
      const eventLine =
        status.events.stdout.split("\n").find((line) => line.includes("同步完成")) ??
        status.events.stdout.split("\n").find((line) => line.includes("已是最新")) ??
        "同步完成";
      console.log(`[chain-sync] ${new Date().toISOString()} ${eventLine}`);
      writeStatus({
        ...status,
        pid: process.pid,
        consecutiveErrors,
        lastSuccessAt: new Date().toISOString(),
      });
      if (once) break;
    } catch (error) {
      consecutiveErrors += 1;
      delayMs = backoffDelayMs(consecutiveErrors, intervalMs, maxBackoffMs);
      const previous = readStatus();
      writeStatus({
        ...previous,
        running: !once,
        pid: process.pid,
        intervalMs,
        consecutiveErrors,
        retryDelayMs: delayMs,
        nextRetryAt: once ? null : new Date(Date.now() + delayMs).toISOString(),
        errorAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      });
      console.error("[chain-sync] error:", error);
      if (once) {
        process.exitCode = 1;
        break;
      }
    }
    if (!once && !stopped) await sleeper.sleep(delayMs);
  }
  const previous = readStatus();
  writeStatus({
    ...previous,
    running: false,
    stoppedAt: new Date().toISOString(),
  });
}

writeStatus({
  running: true,
  intervalMs,
  syncChunkSize: Number(syncChunkSize),
  syncMaxBlocksPerRun: Number(syncMaxBlocksPerRun),
  pid: process.pid,
  startedAt: new Date().toISOString(),
  message: "链上事件持续同步服务启动",
});

process.on("SIGINT", () => {
  stopped = true;
  sleeper.wake();
});
process.on("SIGTERM", () => {
  stopped = true;
  sleeper.wake();
});

await loop();
