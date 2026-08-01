import { spawn } from "node:child_process";
import { matchOnce, readMatcherStatus, writeMatcherStatus } from "./matcher-core.mjs";
import {
  backoffDelayMs,
  createInterruptibleSleeper,
} from "./service-utils.mjs";

const intervalMs = Number(process.env.MATCHER_INTERVAL_MS ?? "15000");
const maxMatchesPerTick = Number(process.env.MATCHER_MAX_PER_TICK ?? "3");
const dryRun = process.argv.includes("--dry-run") || process.env.MATCHER_DRY_RUN === "true";
const once = process.argv.includes("--once");
const maxBackoffMs = Number(process.env.MATCHER_MAX_BACKOFF_MS ?? "120000");

if (!Number.isInteger(intervalMs) || intervalMs < 3000) {
  throw new Error("MATCHER_INTERVAL_MS 必须是 >= 3000 的整数毫秒");
}
if (!Number.isInteger(maxMatchesPerTick) || maxMatchesPerTick < 1 || maxMatchesPerTick > 20) {
  throw new Error("MATCHER_MAX_PER_TICK 必须是 1-20 的整数");
}
if (!Number.isInteger(maxBackoffMs) || maxBackoffMs < intervalMs) {
  throw new Error("MATCHER_MAX_BACKOFF_MS 必须是 >= MATCHER_INTERVAL_MS 的整数毫秒");
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: new URL("..", import.meta.url).pathname,
      env: process.env,
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

async function syncAfterMatch() {
  const [events, balances] = await Promise.all([
    runCommand("node", ["scripts/db-sync-events.mjs"]),
    runCommand("node", ["scripts/db-sync-balances.mjs"]),
  ]);
  return { events, balances };
}

async function runTick() {
  const startedAt = new Date().toISOString();
  const matches = [];
  let lastNoMatch = null;
  let lastSync = null;

  for (let i = 0; i < maxMatchesPerTick; i += 1) {
    const result = await matchOnce({ dryRun });
    if (!result.matched) {
      lastNoMatch = result;
      break;
    }
    matches.push(result);
    if (!dryRun) {
      lastSync = await syncAfterMatch();
    }
  }

  const status = {
    running: true,
    mode: dryRun ? "dry-run" : "live-amoy",
    intervalMs,
    maxMatchesPerTick,
    startedAt,
    finishedAt: new Date().toISOString(),
    matchedCount: matches.length,
    matches,
    lastNoMatch,
    lastSync,
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
      const message = status.matchedCount
        ? `本轮撮合 ${status.matchedCount} 笔`
        : status.lastNoMatch?.dryRun
          ? `dry-run 发现候选订单：${status.lastNoMatch.candidate?.buyOrderId} / ${status.lastNoMatch.candidate?.sellOrderId}`
          : `本轮无成交：${status.lastNoMatch?.reason ?? "unknown"}`;
      console.log(`[matcher] ${new Date().toISOString()} ${message}`);
      writeMatcherStatus({
        ...status,
        pid: process.pid,
        consecutiveErrors,
        lastSuccessAt: new Date().toISOString(),
      });
      if (once) break;
    } catch (error) {
      consecutiveErrors += 1;
      delayMs = backoffDelayMs(consecutiveErrors, intervalMs, maxBackoffMs);
      const previous = readMatcherStatus();
      writeMatcherStatus({
        ...previous,
        running: !once,
        pid: process.pid,
        mode: dryRun ? "dry-run" : "live-amoy",
        consecutiveErrors,
        retryDelayMs: delayMs,
        nextRetryAt: once ? null : new Date(Date.now() + delayMs).toISOString(),
        errorAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      });
      console.error("[matcher] error:", error);
      if (once) {
        process.exitCode = 1;
        break;
      }
    }
    if (!once && !stopped) await sleeper.sleep(delayMs);
  }
  const previous = readMatcherStatus();
  writeMatcherStatus({
    ...previous,
    running: false,
    stoppedAt: new Date().toISOString(),
  });
}

writeMatcherStatus({
  running: true,
  mode: dryRun ? "dry-run" : "live-amoy",
  intervalMs,
  maxMatchesPerTick,
  pid: process.pid,
  startedAt: new Date().toISOString(),
  message: "自动撮合服务启动",
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
