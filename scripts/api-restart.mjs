import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const host = process.env.API_HOST ?? "127.0.0.1";
const port = Number(process.env.API_PORT ?? "8787");

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function pidsFromSs(output) {
  const pids = new Set();
  for (const match of output.matchAll(/pid=(\d+)/g)) {
    pids.add(Number(match[1]));
  }
  return [...pids];
}

async function stopPort() {
  const result = await run("ss", ["-ltnp", `sport = :${port}`]);
  const pids = pidsFromSs(`${result.stdout}\n${result.stderr}`);
  if (pids.length === 0) {
    console.log(`${host}:${port} 未被占用`);
    return;
  }

  console.log(`${host}:${port} 被占用，停止进程：${pids.join(", ")}`);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process may have already exited.
    }
  }
  await delay(800);

  const check = await run("ss", ["-ltnp", `sport = :${port}`]);
  const remaining = pidsFromSs(`${check.stdout}\n${check.stderr}`);
  for (const pid of remaining) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Process may have already exited.
    }
  }
  if (remaining.length > 0) {
    await delay(300);
  }
}

await stopPort();

console.log(`启动 API：http://${host}:${port}`);
const child = spawn("node", ["scripts/api-server.mjs"], {
  stdio: "inherit",
  env: {
    ...process.env,
    API_HOST: host,
    API_PORT: String(port),
  },
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
