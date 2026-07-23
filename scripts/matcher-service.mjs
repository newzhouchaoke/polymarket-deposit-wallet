import { spawn } from "node:child_process";
import { matchOnce, readMatcherStatus, writeMatcherStatus } from "./matcher-core.mjs";

const intervalMs = Number(process.env.MATCHER_INTERVAL_MS ?? "15000");
const maxMatchesPerTick = Number(process.env.MATCHER_MAX_PER_TICK ?? "3");
const dryRun = process.argv.includes("--dry-run") || process.env.MATCHER_DRY_RUN === "true";
const once = process.argv.includes("--once");

if (!Number.isInteger(intervalMs) || intervalMs < 3000) {
  throw new Error("MATCHER_INTERVAL_MS 必须是 >= 3000 的整数毫秒");
}
if (!Number.isInteger(maxMatchesPerTick) || maxMatchesPerTick < 1 || maxMatchesPerTick > 20) {
  throw new Error("MATCHER_MAX_PER_TICK 必须是 1-20 的整数");
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
  writeMatcherStatus(status);
  return status;
}

let stopped = false;

async function loop() {
  while (!stopped) {
    try {
      const status = await runTick();
      const message = status.matchedCount
        ? `本轮撮合 ${status.matchedCount} 笔`
        : status.lastNoMatch?.dryRun
          ? `dry-run 发现候选订单：${status.lastNoMatch.candidate?.buyOrderId} / ${status.lastNoMatch.candidate?.sellOrderId}`
          : `本轮无成交：${status.lastNoMatch?.reason ?? "unknown"}`;
      console.log(`[matcher] ${new Date().toISOString()} ${message}`);
      if (once) break;
    } catch (error) {
      const previous = readMatcherStatus();
      writeMatcherStatus({
        ...previous,
        running: !once,
        mode: dryRun ? "dry-run" : "live-amoy",
        errorAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      });
      console.error("[matcher] error:", error);
      if (once) {
        process.exitCode = 1;
        break;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
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
});
process.on("SIGTERM", () => {
  stopped = true;
});

await loop();
