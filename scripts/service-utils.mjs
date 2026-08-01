import fs from "node:fs";
import path from "node:path";

export function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(temporaryPath, filePath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
}

export function readJsonStatus(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return {
      ...fallback,
      statusFileError: error instanceof Error ? error.message : String(error),
    };
  }
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

export function statusWithLiveness(
  status,
  {
    now = Date.now(),
    staleAfterMs = Number(process.env.SERVICE_STATUS_STALE_MS ?? "180000"),
  } = {},
) {
  const updatedAtMs = Date.parse(status?.updatedAt ?? "");
  const ageMs = Number.isFinite(updatedAtMs) ? Math.max(0, now - updatedAtMs) : null;
  const declaredRunning = status?.running === true;
  const processAlive = declaredRunning ? isProcessAlive(status?.pid) : false;
  const stale =
    declaredRunning &&
    (!Number.isInteger(staleAfterMs) ||
      staleAfterMs < 1 ||
      ageMs === null ||
      ageMs > staleAfterMs);
  return {
    ...status,
    declaredRunning,
    processAlive,
    stale,
    ageMs,
    running: declaredRunning && processAlive && !stale,
  };
}

export function backoffDelayMs(
  consecutiveErrors,
  baseMs,
  maxMs,
) {
  const count = Math.max(0, Number(consecutiveErrors) || 0);
  const base = Math.max(1, Number(baseMs) || 1);
  const maximum = Math.max(base, Number(maxMs) || base);
  if (count === 0) return base;
  return Math.min(maximum, base * (2 ** Math.min(count - 1, 20)));
}

export function createInterruptibleSleeper() {
  let timer = null;
  let resolvePending = null;
  return {
    sleep(ms) {
      if (ms <= 0) return Promise.resolve();
      return new Promise((resolve) => {
        resolvePending = resolve;
        timer = setTimeout(() => {
          timer = null;
          resolvePending = null;
          resolve();
        }, ms);
      });
    },
    wake() {
      if (timer) clearTimeout(timer);
      timer = null;
      const resolve = resolvePending;
      resolvePending = null;
      resolve?.();
    },
  };
}
