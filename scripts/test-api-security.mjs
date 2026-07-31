import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { projectDir } from "./db.js";
import { loadExchangeConfig } from "./exchange-config.mjs";

const port = 8797;
const token = "test-write-token";
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "polymarket-api-test-"));
const testDatabasePath = path.join(temporaryDirectory, "api.sqlite");
const deployment = loadExchangeConfig({ requireMarket: true });
const commonEnvironment = {
  ...process.env,
  POLYMARKET_DB_PATH: testDatabasePath,
  HEALTH_REQUIRE_CHAIN_SYNC: "false",
  API_REQUIRE_SIGNED_ORDERS: "false",
};
const importResult = spawnSync("node", ["scripts/db-import-runtime.mjs"], {
  cwd: projectDir,
  env: commonEnvironment,
  encoding: "utf8",
});
assert.equal(importResult.status, 0, importResult.stderr || importResult.stdout);
const child = spawn("node", ["scripts/api-server.mjs"], {
  cwd: projectDir,
  env: {
    ...commonEnvironment,
    API_PORT: String(port),
    API_HOST: "127.0.0.1",
    API_WRITE_TOKEN: token,
    API_READ_RATE_LIMIT_PER_MINUTE: "100",
    API_WRITE_RATE_LIMIT_PER_MINUTE: "6",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

function waitForServer() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("API 启动超时")), 10_000);
    const onData = (chunk) => {
      if (chunk.toString().includes("API 已启动")) {
        clearTimeout(timeout);
        child.stdout.off("data", onData);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`API 提前退出：${code}`));
    });
  });
}

function websocketSnapshot() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new Error("WebSocket snapshot 超时"));
    }, 5_000);
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.type !== "snapshot") return;
      clearTimeout(timeout);
      socket.close();
      resolve(message);
    });
    socket.on("error", reject);
  });
}

try {
  await waitForServer();
  const summary = await fetch(`http://127.0.0.1:${port}/api/summary`);
  assert.equal(summary.status, 200);
  const live = await fetch(`http://127.0.0.1:${port}/api/health/live`);
  assert.equal(live.status, 200);
  assert.equal((await live.json()).ok, true);
  const ready = await fetch(`http://127.0.0.1:${port}/api/health/ready`);
  assert.equal(ready.status, 200);
  assert.equal((await ready.json()).checks.database.ok, true);
  const metrics = await fetch(`http://127.0.0.1:${port}/api/metrics`).then(
    (response) => response.json(),
  );
  assert.equal(metrics.database.health.ok, true);
  const initialStats = await fetch(
    `http://127.0.0.1:${port}/api/orders/stats`,
  ).then((response) => response.json());
  assert.ok(Array.isArray(initialStats.byValidation));

  const order = {
    localOrderId: "api-idempotency-test",
    marketId: deployment.market.marketId,
    maker: deployment.deployer,
    signer: deployment.deployer,
    side: "BUY",
    tokenId: deployment.market.yesTokenId,
    makerAmount: "500000",
    takerAmount: "1000000",
    expiration: 0,
    salt: "8675309",
    signatureType: 0,
    timestamp: "1785474000",
  };
  const created = await fetch(`http://127.0.0.1:${port}/api/orders`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(order),
  });
  assert.equal(created.status, 201);
  const createdOrder = await created.json();
  assert.equal(createdOrder.idempotent, false);
  assert.equal(createdOrder.validation_status, "UNSIGNED");

  const repeated = await fetch(`http://127.0.0.1:${port}/api/orders`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(order),
  });
  assert.equal(repeated.status, 200);
  assert.equal((await repeated.json()).idempotent, true);

  const conflict = await fetch(`http://127.0.0.1:${port}/api/orders`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ ...order, makerAmount: "510000" }),
  });
  assert.equal(conflict.status, 409);

  const invalidToken = await fetch(`http://127.0.0.1:${port}/api/orders`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ ...order, localOrderId: "invalid-token", tokenId: "42" }),
  });
  assert.equal(invalidToken.status, 400);

  const unauthorized = await fetch(
    `http://127.0.0.1:${port}/api/orders/unknown/cancel`,
    { method: "POST" },
  );
  assert.equal(unauthorized.status, 401);

  const authenticatedFailure = await fetch(
    `http://127.0.0.1:${port}/api/orders/unknown/cancel`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    },
  );
  assert.equal(authenticatedFailure.status, 500);

  const rateLimited = await fetch(
    `http://127.0.0.1:${port}/api/orders/unknown/cancel`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    },
  );
  assert.equal(rateLimited.status, 429);

  const snapshot = await websocketSnapshot();
  assert.equal(snapshot.runtime.mode, "official-v2");
  assert.equal(snapshot.orderbook.marketId, snapshot.market.market_id);

  const audit = await fetch(`http://127.0.0.1:${port}/api/audit?limit=5`).then(
    (response) => response.json(),
  );
  assert.ok(audit.some((row) => row.status_code === 401));
  assert.ok(audit.some((row) => row.status_code === 500));
  assert.ok(audit.some((row) => row.status_code === 409));
  console.log("API health, order idempotency, auth, rate limit, audit, and WebSocket tests passed");
} finally {
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
