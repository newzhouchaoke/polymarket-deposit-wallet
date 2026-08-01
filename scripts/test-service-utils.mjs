import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  atomicWriteJson,
  backoffDelayMs,
  readJsonStatus,
  statusWithLiveness,
} from "./service-utils.mjs";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "polymarket-service-test-"));
const statusPath = path.join(directory, "status.json");

try {
  atomicWriteJson(statusPath, {
    updatedAt: new Date().toISOString(),
    running: true,
    pid: process.pid,
  });
  const current = statusWithLiveness(readJsonStatus(statusPath, {}), {
    staleAfterMs: 60_000,
  });
  assert.equal(current.running, true);
  assert.equal(current.processAlive, true);
  assert.equal(current.stale, false);

  const stale = statusWithLiveness(
    {
      updatedAt: "2020-01-01T00:00:00.000Z",
      running: true,
      pid: process.pid,
    },
    { now: Date.parse("2020-01-01T00:02:00.000Z"), staleAfterMs: 60_000 },
  );
  assert.equal(stale.running, false);
  assert.equal(stale.stale, true);

  const dead = statusWithLiveness({
    updatedAt: new Date().toISOString(),
    running: true,
    pid: 999_999_999,
  });
  assert.equal(dead.running, false);
  assert.equal(dead.processAlive, false);

  assert.equal(backoffDelayMs(0, 3_000, 120_000), 3_000);
  assert.equal(backoffDelayMs(1, 3_000, 120_000), 3_000);
  assert.equal(backoffDelayMs(2, 3_000, 120_000), 6_000);
  assert.equal(backoffDelayMs(20, 3_000, 120_000), 120_000);

  console.log("service status, atomic write, liveness, and backoff tests passed");
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
