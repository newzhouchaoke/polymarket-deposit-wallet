import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import { projectDir } from "./db.js";

const port = 8797;
const token = "test-write-token";
const child = spawn("node", ["scripts/api-server.mjs"], {
  cwd: projectDir,
  env: {
    ...process.env,
    API_PORT: String(port),
    API_HOST: "127.0.0.1",
    API_WRITE_TOKEN: token,
    API_READ_RATE_LIMIT_PER_MINUTE: "100",
    API_WRITE_RATE_LIMIT_PER_MINUTE: "2",
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
  console.log("API auth, rate limit, audit, and WebSocket tests passed");
} finally {
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}
