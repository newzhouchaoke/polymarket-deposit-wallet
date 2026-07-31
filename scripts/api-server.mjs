import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { URL } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";
import { getAddress, isHex } from "viem";
import { dbMode, dbPath, initSchema, openDatabase, projectDir } from "./db.js";
import { readMatcherStatus } from "./matcher-core.mjs";
import { expireOrders, orderStats } from "./order-maintenance.mjs";
import { orderHashFor, sideNumber } from "./order-utils.mjs";
import { validateSignedOrder } from "./order-validation.mjs";
import { officialModulesStatus } from "./official-modules-status.mjs";
import { readJsonStatus, statusWithLiveness } from "./service-utils.mjs";
import {
  loadExchangeConfig,
  runtimeSummary,
} from "./exchange-config.mjs";

const chainSyncStatusPath = path.join(
  projectDir,
  "data",
  `chain-sync-${dbMode}-status.json`,
);

const host = process.env.API_HOST ?? "127.0.0.1";
const port = Number(process.env.API_PORT ?? "8787");
const db = openDatabase();
initSchema(db);
const exchangeConfig = loadExchangeConfig();
const exchangeRuntime = runtimeSummary(exchangeConfig);
const writeToken = String(process.env.API_WRITE_TOKEN ?? "").trim();
const readRateLimit = Number(process.env.API_READ_RATE_LIMIT_PER_MINUTE ?? "300");
const writeRateLimit = Number(process.env.API_WRITE_RATE_LIMIT_PER_MINUTE ?? "30");
const realtimePollMs = Number(process.env.API_REALTIME_POLL_MS ?? "2000");
const healthRequireChainSync =
  String(process.env.HEALTH_REQUIRE_CHAIN_SYNC ?? "true").toLowerCase() === "true";
const requireSignedOrders =
  String(
    process.env.API_REQUIRE_SIGNED_ORDERS ??
      (exchangeRuntime.mode === "official-v2" ? "true" : "false"),
  ).toLowerCase() === "true";
const validateSignedOrders =
  String(process.env.API_VALIDATE_SIGNED_ORDERS ?? "true").toLowerCase() === "true";
const orderExpirySweepMs = Number(process.env.ORDER_EXPIRY_SWEEP_MS ?? "10000");
const rateWindows = new Map();
const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);

if (!loopbackHosts.has(host) && !writeToken) {
  throw new Error(
    "API 监听非本机地址时必须配置 API_WRITE_TOKEN，避免未授权链上写入",
  );
}
if (!Number.isInteger(realtimePollMs) || realtimePollMs < 500) {
  throw new Error("API_REALTIME_POLL_MS 必须是 >= 500 的整数毫秒");
}
if (!Number.isInteger(orderExpirySweepMs) || orderExpirySweepMs < 1000) {
  throw new Error("ORDER_EXPIRY_SWEEP_MS 必须是 >= 1000 的整数毫秒");
}

function rows(sql, params = {}) {
  return db.prepare(sql).all(params).map(parseJsonColumns);
}

function one(sql, params = {}) {
  const result = db.prepare(sql).get(params);
  return result ? parseJsonColumns(result) : null;
}

function parseJsonColumns(row) {
  const parsed = { ...row };
  for (const key of ["raw_json", "args_json", "details_json"]) {
    if (typeof parsed[key] === "string") {
      try {
        parsed[key] = JSON.parse(parsed[key]);
      } catch {
        // Keep original string if it is not valid JSON.
      }
    }
  }
  return parsed;
}

function remoteAddress(req) {
  return req.socket.remoteAddress ?? "unknown";
}

function consumeRateLimit(req, write) {
  const maximum = write ? writeRateLimit : readRateLimit;
  if (!Number.isInteger(maximum) || maximum < 1) {
    throw new Error("API rate limit 必须是正整数");
  }
  const key = `${remoteAddress(req)}:${write ? "write" : "read"}`;
  const now = Date.now();
  const current = rateWindows.get(key);
  const windowState =
    !current || now - current.startedAt >= 60_000
      ? { startedAt: now, count: 0 }
      : current;
  windowState.count += 1;
  rateWindows.set(key, windowState);
  return {
    allowed: windowState.count <= maximum,
    maximum,
    remaining: Math.max(0, maximum - windowState.count),
    resetAt: windowState.startedAt + 60_000,
  };
}

function suppliedWriteToken(req) {
  const authorization = String(req.headers.authorization ?? "");
  if (/^Bearer\s+/i.test(authorization)) {
    return authorization.replace(/^Bearer\s+/i, "").trim();
  }
  return String(req.headers["x-api-key"] ?? "").trim();
}

function secureEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function authorizeWrite(req) {
  if (!writeToken) {
    const address = remoteAddress(req);
    if (
      address === "127.0.0.1" ||
      address === "::1" ||
      address === "::ffff:127.0.0.1"
    ) {
      return "local";
    }
    throw Object.assign(new Error("未配置 API_WRITE_TOKEN，只允许本机写入"), {
      statusCode: 401,
    });
  }
  if (!secureEqual(suppliedWriteToken(req), writeToken)) {
    throw Object.assign(new Error("缺少或无效的 API 写入令牌"), {
      statusCode: 401,
    });
  }
  return "token";
}

function auditAction(req, url, statusCode, action, actor, body = {}) {
  const safeDetails = {
    confirmation: body.confirmation ?? null,
    outcome: body.outcome ?? null,
    role: body.role ?? null,
    localOrderId: body.localOrderId ?? null,
    marketId: body.marketId ?? null,
  };
  const requestHash = crypto
    .createHash("sha256")
    .update(JSON.stringify(body))
    .digest("hex");
  db.prepare(
    `INSERT INTO api_audit_log(
       remote_address, method, path, action, actor, status_code,
       request_hash, details_json
     ) VALUES(
       :remoteAddress, :method, :path, :action, :actor, :statusCode,
       :requestHash, :detailsJson
     )`,
  ).run({
    remoteAddress: remoteAddress(req),
    method: req.method ?? "UNKNOWN",
    path: url.pathname,
    action,
    actor,
    statusCode,
    requestHash,
    detailsJson: JSON.stringify(safeDetails),
  });
}

function json(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
  });
  res.end(body);
}

function html(res, body) {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function javascript(res, body) {
  res.writeHead(200, {
    "content-type": "text/javascript; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function notFound(res, pathname) {
  json(res, 404, {
    error: "NOT_FOUND",
    message: `Unknown endpoint: ${pathname}`,
  });
}

function badRequest(res, message) {
  json(res, 400, {
    error: "BAD_REQUEST",
    message,
  });
}

function internalError(res, error) {
  json(res, 500, {
    error: "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : String(error),
  });
}

function readChainSyncStatus() {
  return statusWithLiveness(
    readJsonStatus(chainSyncStatusPath, {
      updatedAt: null,
      running: false,
      message: "链上事件持续同步服务尚未写入状态",
    }),
  );
}

function limit(url, fallback = 100) {
  const value = Number(url.searchParams.get("limit") ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 1000) return fallback;
  return value;
}

function offset(url) {
  const value = Number(url.searchParams.get("offset") ?? 0);
  if (!Number.isInteger(value) || value < 0) return 0;
  return value;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
      if (body.length > 1_000_000) {
        reject(Object.assign(new Error("Request body too large"), { statusCode: 413 }));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(Object.assign(new Error("Invalid JSON request body"), { statusCode: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function requireString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw Object.assign(new Error(`${name} is required`), { statusCode: 400 });
  }
  return value.trim();
}

function requireAmountString(value, name) {
  const text = requireString(String(value ?? ""), name);
  if (!/^\d+$/.test(text) || BigInt(text) <= 0n) {
    throw Object.assign(
      new Error(`${name} must be a positive integer string`),
      { statusCode: 400 },
    );
  }
  return text;
}

function normalizeSide(value) {
  if (value === 0 || String(value).toUpperCase() === "BUY") return "BUY";
  if (value === 1 || String(value).toUpperCase() === "SELL") return "SELL";
  throw Object.assign(new Error("side must be BUY or SELL"), { statusCode: 400 });
}

function priceMicrosForOrder(side, makerAmount, takerAmount) {
  const maker = BigInt(makerAmount);
  const taker = BigInt(takerAmount);
  const price = side === "BUY"
    ? (maker * 1_000_000n) / taker
    : (taker * 1_000_000n) / maker;
  if (price <= 0n || price >= 1_000_000n) {
    throw Object.assign(new Error("price must be between 0 and 1"), {
      statusCode: 400,
    });
  }
  return Number(price);
}

function addAmount(a, b) {
  return (BigInt(a) + BigInt(b)).toString();
}

function assertFillWithinOrder(order, nextFilledMaker, nextFilledTaker) {
  if (BigInt(nextFilledMaker) > BigInt(order.maker_amount)) {
    throw new Error("filled maker amount exceeds makerAmount");
  }
  if (BigInt(nextFilledTaker) > BigInt(order.taker_amount)) {
    throw new Error("filled taker amount exceeds takerAmount");
  }
}

function localOrderId(order) {
  const raw = JSON.stringify(order);
  return `local-${crypto.createHash("sha256").update(raw).digest("hex")}`;
}

async function insertOrder(order) {
  const marketId = requireString(order.marketId, "marketId");
  const market = one("SELECT * FROM markets WHERE market_id = :marketId", {
    marketId,
  });
  if (!market) {
    throw Object.assign(new Error(`Unknown marketId: ${marketId}`), {
      statusCode: 400,
    });
  }
  if (market.status !== "OPEN") {
    throw Object.assign(new Error(`Market is not OPEN: ${market.status}`), {
      statusCode: 409,
    });
  }

  const side = normalizeSide(order.side);
  const makerAmount = requireAmountString(order.makerAmount, "makerAmount");
  const takerAmount = requireAmountString(order.takerAmount, "takerAmount");
  let maker;
  let signer;
  try {
    maker = getAddress(requireString(order.maker, "maker"));
    signer = getAddress(requireString(order.signer ?? order.maker, "signer"));
  } catch {
    throw Object.assign(new Error("maker and signer must be valid EVM addresses"), {
      statusCode: 400,
    });
  }
  const normalized = {
    marketId,
    maker,
    signer,
    side,
    tokenId: requireString(order.tokenId ?? market.yes_token_id, "tokenId"),
    makerAmount,
    takerAmount,
    expiration: Number(order.expiration ?? 0),
    salt: String(order.salt ?? Date.now()),
    signatureType: Number(order.signatureType ?? 3),
    timestamp: String(order.timestamp ?? Math.floor(Date.now() / 1000)),
    metadata: String(order.metadata ?? `0x${"00".repeat(32)}`),
    builder: String(order.builder ?? `0x${"00".repeat(32)}`),
    signature: typeof order.signature === "string" ? order.signature : null,
    status: String(order.status ?? "OPEN").toUpperCase(),
    filledMakerAmount: String(order.filledMakerAmount ?? order.filled_maker_amount ?? "0"),
    filledTakerAmount: String(order.filledTakerAmount ?? order.filled_taker_amount ?? "0"),
  };
  if (![market.yes_token_id, market.no_token_id].includes(normalized.tokenId)) {
    throw Object.assign(new Error("tokenId does not belong to this market"), {
      statusCode: 400,
    });
  }
  if (!Number.isInteger(normalized.expiration) || normalized.expiration < 0) {
    throw Object.assign(new Error("expiration must be a non-negative integer"), {
      statusCode: 400,
    });
  }
  if (normalized.expiration !== 0 && normalized.expiration <= Math.floor(Date.now() / 1000)) {
    throw Object.assign(new Error("expiration must be zero or in the future"), {
      statusCode: 400,
    });
  }
  if (
    !Number.isInteger(normalized.signatureType) ||
    normalized.signatureType < 0 ||
    normalized.signatureType > 3
  ) {
    throw Object.assign(new Error("signatureType must be 0, 1, 2, or 3"), {
      statusCode: 400,
    });
  }
  if (!/^\d+$/.test(normalized.salt) || !/^\d+$/.test(normalized.timestamp)) {
    throw Object.assign(new Error("salt and timestamp must be uint256 strings"), {
      statusCode: 400,
    });
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized.metadata)) {
    throw Object.assign(new Error("metadata must be bytes32"), { statusCode: 400 });
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized.builder)) {
    throw Object.assign(new Error("builder must be bytes32"), { statusCode: 400 });
  }
  if (
    normalized.signature !== null &&
    (!isHex(normalized.signature) || normalized.signature.length % 2 !== 0)
  ) {
    throw Object.assign(new Error("signature must be an even-length hex value"), {
      statusCode: 400,
    });
  }
  if (normalized.status !== "OPEN") {
    throw Object.assign(new Error("new API orders must start in OPEN status"), {
      statusCode: 400,
    });
  }

  const id = typeof order.localOrderId === "string" && order.localOrderId.trim()
    ? order.localOrderId.trim()
    : localOrderId(normalized);
  const priceMicros = priceMicrosForOrder(side, makerAmount, takerAmount);
  if (!/^\d+$/.test(normalized.filledMakerAmount) || !/^\d+$/.test(normalized.filledTakerAmount)) {
    throw Object.assign(new Error("filled amounts must be integer strings"), {
      statusCode: 400,
    });
  }
  if (normalized.filledMakerAmount !== "0" || normalized.filledTakerAmount !== "0") {
    throw Object.assign(new Error("new API orders must have zero filled amounts"), {
      statusCode: 400,
    });
  }
  assertFillWithinOrder(
    { maker_amount: makerAmount, taker_amount: takerAmount },
    normalized.filledMakerAmount,
    normalized.filledTakerAmount,
  );
  const contractOrder = {
    salt: BigInt(normalized.salt),
    maker: normalized.maker,
    signer: normalized.signer,
    tokenId: BigInt(normalized.tokenId),
    makerAmount: BigInt(normalized.makerAmount),
    takerAmount: BigInt(normalized.takerAmount),
    side: sideNumber(normalized.side),
    signatureType: normalized.signatureType,
    timestamp: BigInt(normalized.timestamp),
    metadata: normalized.metadata,
    builder: normalized.builder,
  };
  const orderHash = orderHashFor(exchangeConfig, contractOrder);
  normalized.orderHash = orderHash;

  const existingById = one(
    "SELECT * FROM orders WHERE chain_id = :chainId AND local_order_id = :id",
    { chainId: market.chain_id, id },
  );
  if (existingById) {
    if (existingById.order_hash?.toLowerCase() === orderHash.toLowerCase()) {
      return { ...existingById, idempotent: true };
    }
    throw Object.assign(
      new Error(`localOrderId already belongs to a different order: ${id}`),
      { statusCode: 409 },
    );
  }
  const existingByHash = one(
    `SELECT * FROM orders
     WHERE chain_id = :chainId AND lower(order_hash) = lower(:orderHash)`,
    { chainId: market.chain_id, orderHash },
  );
  if (existingByHash) return { ...existingByHash, idempotent: true };

  if (requireSignedOrders && !normalized.signature) {
    throw Object.assign(
      new Error(
        "official-v2 API requires a signed order; use the signed-order generator or provide signature",
      ),
      { statusCode: 400 },
    );
  }
  let validation = {
    status: normalized.signature ? "VALIDATION_SKIPPED" : "UNSIGNED",
    error: null,
    validatedAt: null,
  };
  if (normalized.signature && validateSignedOrders) {
    validation = await validateSignedOrder(exchangeConfig, {
      salt: normalized.salt,
      maker: normalized.maker,
      signer: normalized.signer,
      token_id: normalized.tokenId,
      maker_amount: normalized.makerAmount,
      taker_amount: normalized.takerAmount,
      side: normalized.side,
      signature: normalized.signature,
      raw_json: JSON.stringify(normalized),
    });
  }

  db.prepare(
    `INSERT INTO orders(
       chain_id, local_order_id, market_id, maker, signer, side, token_id,
       maker_amount, taker_amount, filled_maker_amount, filled_taker_amount,
       price_micros, status, expiration, salt, signature, order_hash,
       validation_status, validation_error, validated_at, raw_json, updated_at
     )
     VALUES(
       :chainId, :localOrderId, :marketId, :maker, :signer, :side, :tokenId,
       :makerAmount, :takerAmount, :filledMakerAmount, :filledTakerAmount,
       :priceMicros, :status, :expiration, :salt, :signature, :orderHash,
       :validationStatus, :validationError, :validatedAt, :rawJson, CURRENT_TIMESTAMP
     )`,
  ).run({
    chainId: market.chain_id,
    localOrderId: id,
    marketId: normalized.marketId,
    maker: normalized.maker,
    signer: normalized.signer,
    side: normalized.side,
    tokenId: normalized.tokenId,
    makerAmount: normalized.makerAmount,
    takerAmount: normalized.takerAmount,
    filledMakerAmount: normalized.filledMakerAmount,
    filledTakerAmount: normalized.filledTakerAmount,
    priceMicros,
    status: normalized.status,
    expiration: normalized.expiration,
    salt: normalized.salt,
    signature: normalized.signature,
    orderHash,
    validationStatus: validation.status,
    validationError: validation.error,
    validatedAt: validation.validatedAt,
    rawJson: JSON.stringify(normalized),
  });

  return {
    ...one("SELECT * FROM orders WHERE local_order_id = :id", { id }),
    idempotent: false,
  };
}

function orderById(localOrderId) {
  return one("SELECT * FROM orders WHERE local_order_id = :localOrderId", { localOrderId });
}

function cancelOrder(localOrderId) {
  const order = orderById(localOrderId);
  if (!order) throw new Error(`Unknown order: ${localOrderId}`);
  if (!["OPEN", "PARTIALLY_FILLED"].includes(order.status)) {
    throw new Error(`Only OPEN/PARTIALLY_FILLED orders can be cancelled. Current: ${order.status}`);
  }
  db.prepare(
    `UPDATE orders
     SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP
     WHERE local_order_id = :localOrderId`,
  ).run({ localOrderId });
  return orderById(localOrderId);
}

function fillOrder(localOrderId, body) {
  const order = orderById(localOrderId);
  if (!order) throw new Error(`Unknown order: ${localOrderId}`);
  if (!["OPEN", "PARTIALLY_FILLED"].includes(order.status)) {
    throw new Error(`Only OPEN/PARTIALLY_FILLED orders can be filled. Current: ${order.status}`);
  }
  const makerFill = requireAmountString(body.makerFillAmount ?? body.filledMakerAmount, "makerFillAmount");
  const takerFill = requireAmountString(body.takerFillAmount ?? body.filledTakerAmount, "takerFillAmount");
  const nextFilledMaker = addAmount(order.filled_maker_amount ?? "0", makerFill);
  const nextFilledTaker = addAmount(order.filled_taker_amount ?? "0", takerFill);
  assertFillWithinOrder(order, nextFilledMaker, nextFilledTaker);
  const nextStatus =
    BigInt(nextFilledMaker) === BigInt(order.maker_amount) ||
    BigInt(nextFilledTaker) === BigInt(order.taker_amount)
      ? "FILLED"
      : "PARTIALLY_FILLED";

  db.prepare(
    `UPDATE orders
     SET filled_maker_amount = :filledMakerAmount,
         filled_taker_amount = :filledTakerAmount,
         status = :status,
         updated_at = CURRENT_TIMESTAMP
     WHERE local_order_id = :localOrderId`,
  ).run({
    localOrderId,
    filledMakerAmount: nextFilledMaker,
    filledTakerAmount: nextFilledTaker,
    status: nextStatus,
  });
  return orderById(localOrderId);
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
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
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(stderr || stdout || `Command failed with code ${code}`));
      }
    });
  });
}

async function cancelOrderOnchain(localOrderId, body = {}) {
  if (body.confirmation !== "AMOY_TESTNET_ONLY") {
    throw new Error("链上取消需要 confirmation=AMOY_TESTNET_ONLY");
  }
  const before = orderById(localOrderId);
  if (!before) throw new Error(`Unknown order: ${localOrderId}`);
  if (!before.signature) throw new Error(`Order has no signature: ${localOrderId}`);

  const result = await runCommand(
    "node",
    ["scripts/cancel-research-order.mjs", localOrderId],
    {
      cwd: new URL("..", import.meta.url).pathname,
      env: {
        ...process.env,
        LIVE_ACTION: "CANCEL_RESEARCH_ORDER",
        LIVE_CONFIRMATION: "AMOY_TESTNET_ONLY",
      },
    },
  );
  return {
    order: orderById(localOrderId),
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

async function manageOfficialOrder(localOrderId, action, body = {}) {
  if (exchangeRuntime.mode !== "official-v2") {
    throw new Error("预批准管理只适用于 official-v2");
  }
  if (body.confirmation !== "AMOY_TESTNET_ONLY") {
    throw new Error("链上预批准管理需要 confirmation=AMOY_TESTNET_ONLY");
  }
  const result = await runCommand(
    "node",
    ["scripts/manage-official-order.mjs", action, localOrderId],
    {
      cwd: new URL("..", import.meta.url).pathname,
      env: {
        ...process.env,
        LIVE_ACTION: "MANAGE_OFFICIAL_ORDER",
        LIVE_CONFIRMATION: "AMOY_TESTNET_ONLY",
      },
    },
  );
  return {
    order: orderById(localOrderId),
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

async function manageOfficialUser(role, action, body = {}) {
  if (exchangeRuntime.mode !== "official-v2") {
    throw new Error("用户暂停只适用于 official-v2");
  }
  if (body.confirmation !== "AMOY_TESTNET_ONLY") {
    throw new Error("用户暂停管理需要 confirmation=AMOY_TESTNET_ONLY");
  }
  const normalizedRole = String(role).toUpperCase();
  if (!["BUYER", "SELLER"].includes(normalizedRole)) {
    throw new Error("role 必须是 BUYER 或 SELLER");
  }
  const result = await runCommand(
    "node",
    ["scripts/manage-official-user.mjs", action, normalizedRole],
    {
      cwd: new URL("..", import.meta.url).pathname,
      env: {
        ...process.env,
        LIVE_ACTION: "MANAGE_OFFICIAL_USER",
        LIVE_CONFIRMATION: "AMOY_TESTNET_ONLY",
      },
    },
  );
  return {
    role: normalizedRole,
    action,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

async function runMarketLifecycle(marketId, action, body = {}) {
  if (exchangeRuntime.mode !== "official-v2") {
    throw new Error("官方市场生命周期接口只适用于 official-v2");
  }
  if (marketId !== exchangeRuntime.marketId) {
    throw new Error(`当前运行时未配置该市场：${marketId}`);
  }
  const args = ["scripts/official-market-lifecycle.mjs", action];
  const env = { ...process.env };
  if (action === "resolve") {
    if (body.confirmation !== "AMOY_TESTNET_ONLY") {
      throw new Error("链上结算需要 confirmation=AMOY_TESTNET_ONLY");
    }
    const outcome = String(body.outcome ?? "").toUpperCase();
    if (!["YES", "NO"].includes(outcome)) throw new Error("outcome 必须是 YES 或 NO");
    args.push(outcome);
    env.LIVE_ACTION = "RESOLVE_OFFICIAL_MARKET";
    env.LIVE_CONFIRMATION = "AMOY_TESTNET_ONLY";
  } else if (action === "redeem") {
    if (body.confirmation !== "AMOY_TESTNET_ONLY") {
      throw new Error("链上赎回需要 confirmation=AMOY_TESTNET_ONLY");
    }
    const role = String(body.role ?? "").toUpperCase();
    if (!["BUYER", "SELLER"].includes(role)) {
      throw new Error("role 必须是 BUYER 或 SELLER");
    }
    args.push(role);
    env.LIVE_ACTION = "REDEEM_OFFICIAL_MARKET";
    env.LIVE_CONFIRMATION = "AMOY_TESTNET_ONLY";
  }
  const result = await runCommand("node", args, {
    cwd: new URL("..", import.meta.url).pathname,
    env,
  });
  return {
    market: one("SELECT * FROM markets WHERE market_id = :marketId", { marketId }),
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

async function seedSignedOrders() {
  const result = await runCommand("node", ["scripts/seed-signed-orders.mjs"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: process.env,
  });
  const match = result.stdout.match(/\{[\s\S]*\}/);
  const created = match ? JSON.parse(match[0]) : null;
  return {
    created,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    recentOrders: rows(
      "SELECT local_order_id, side, price_micros, status, updated_at FROM orders ORDER BY updated_at DESC LIMIT 6",
    ),
  };
}

async function matchOrdersOnchain(body = {}) {
  if (body.confirmation !== "AMOY_TESTNET_ONLY") {
    throw new Error("链上撮合需要 confirmation=AMOY_TESTNET_ONLY");
  }
  const projectDir = new URL("..", import.meta.url).pathname;
  const match = await runCommand("node", ["scripts/match-orders.mjs"], {
    cwd: projectDir,
    env: {
      ...process.env,
      LIVE_ACTION: "MATCH_ORDERS",
      LIVE_CONFIRMATION: "AMOY_TESTNET_ONLY",
    },
  });
  const syncEvents = await runCommand("node", ["scripts/db-sync-events.mjs"], {
    cwd: projectDir,
    env: process.env,
  });
  const syncBalances = await runCommand("node", ["scripts/db-sync-balances.mjs"], {
    cwd: projectDir,
    env: process.env,
  });
  return {
    stdout: [match.stdout, syncEvents.stdout, syncBalances.stdout].map((item) => item.trim()).filter(Boolean).join("\n\n"),
    stderr: [match.stderr, syncEvents.stderr, syncBalances.stderr].map((item) => item.trim()).filter(Boolean).join("\n\n"),
    orderbook: routes["/api/orderbook"](new URL("http://local/api/orderbook")),
    trades: routes["/api/trades"](new URL("http://local/api/trades?limit=5")),
  };
}

async function syncDatabaseFromChain() {
  const projectDir = new URL("..", import.meta.url).pathname;
  const syncEvents = await runCommand("node", ["scripts/db-sync-events.mjs"], {
    cwd: projectDir,
    env: process.env,
  });
  const syncBalances = await runCommand("node", ["scripts/db-sync-balances.mjs"], {
    cwd: projectDir,
    env: process.env,
  });
  return {
    stdout: [syncEvents.stdout, syncBalances.stdout].map((item) => item.trim()).filter(Boolean).join("\n\n"),
    stderr: [syncEvents.stderr, syncBalances.stderr].map((item) => item.trim()).filter(Boolean).join("\n\n"),
    summary: routes["/api/summary"](),
  };
}

function indexPage() {
  const summary = {
    contracts: one("SELECT COUNT(*) AS count FROM contracts").count,
    wallets: one("SELECT COUNT(*) AS count FROM wallets").count,
    markets: one("SELECT COUNT(*) AS count FROM markets").count,
    orders: one("SELECT COUNT(*) AS count FROM orders").count,
    trades: one("SELECT COUNT(*) AS count FROM trades").count,
    balances: one("SELECT COUNT(*) AS count FROM token_balances").count,
    events: one("SELECT COUNT(*) AS count FROM chain_events").count,
  };

  const links = [
    ["/dashboard", "可视化 Dashboard"],
    ["/trade", "下单页面"],
    ["/api/summary", "摘要"],
    ["/api/contracts", "合约地址"],
    ["/api/wallets", "Deposit Wallet"],
    ["/api/markets", "市场"],
    ["/api/orders", "订单"],
    ["/api/orders/stats", "订单状态与签名校验统计"],
    ["/api/markets/:id/orderbook", "指定市场订单簿"],
    ["/api/orderbook", "订单簿"],
    ["/api/trades", "成交"],
    ["/api/order-fills", "逐订单链上成交"],
    ["/api/audit", "API 写操作审计"],
    ["/api/modules", "Standard / Neg Risk / UMA 状态"],
    ["/api/health/live", "API 存活检查"],
    ["/api/health/ready", "数据库/运行时/同步就绪检查"],
    ["/api/metrics", "服务与数据库指标"],
    ["/api/balances", "余额"],
    ["/api/events", "链上事件"],
    ["/api/matcher/status", "自动撮合状态"],
    ["/api/chain-sync/status", "链上持续同步状态"],
  ];

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Polymarket ${escapeHtml(exchangeRuntime.mode)} API</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif; margin: 36px; color: #17212b; }
    h1 { color: #0d47a1; }
    code { background: #f6f8fa; padding: 2px 6px; border-radius: 4px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; max-width: 920px; }
    .card { border: 1px solid #d0d7de; border-radius: 10px; padding: 14px; background: #fff; }
    .count { font-size: 28px; font-weight: 700; color: #1565c0; }
    a { color: #1565c0; text-decoration: none; }
    a:hover { text-decoration: underline; }
    li { margin: 8px 0; }
  </style>
</head>
<body>
  <h1>Polymarket ${escapeHtml(exchangeRuntime.mode)} 数据 API</h1>
  <p>运行模式：<code>${exchangeRuntime.mode}</code> · Exchange：
    <code>${exchangeRuntime.exchange}</code></p>
  <p>数据库：<code>${dbPath}</code></p>
  <div class="grid">
    ${Object.entries(summary).map(([key, value]) => `<div class="card"><div>${key}</div><div class="count">${value}</div></div>`).join("")}
  </div>
  <h2>浏览器查看入口</h2>
  <ul>
    ${links.map(([href, label]) => `<li><a href="${href}">${label}</a> <code>${href}</code></li>`).join("")}
  </ul>
  <h2>常用筛选</h2>
  <ul>
    <li><code>/api/events?eventName=TradeExecuted</code></li>
    <li><code>/api/orders?status=FILLED</code></li>
    <li><code>/api/orderbook?marketId=0x2b51dd486618b7916d54d258f84332f888934ba546dd37171cea2a25e14b3691</code></li>
    <li><code>/api/markets/0x2b51dd486618b7916d54d258f84332f888934ba546dd37171cea2a25e14b3691/orderbook</code></li>
    <li><code>/api/balances?wallet=0xb2E67683d5C3a3EA40ebB343F87AE3E46a1aC8D7</code></li>
  </ul>
</body>
</html>`;
}

function tradePage() {
  const markets = routes["/api/markets"]();
  const wallets = routes["/api/wallets"]();
  const officialRuntime = exchangeRuntime.mode === "official-v2";
  const market = markets[0];
  const buyer = wallets.find((wallet) => wallet.wallet_role === "buyer")?.wallet_address ?? "";
  const seller = wallets.find((wallet) => wallet.wallet_role === "seller")?.wallet_address ?? "";
  const orderbookPath = market ? `/api/markets/${market.market_id}/orderbook` : "/api/orderbook";
  const marketOptions = markets.map((item) =>
    `<option value="${escapeHtml(item.market_id)}">${escapeHtml(item.question)} · ${escapeHtml(short(item.market_id, 8))}</option>`,
  ).join("");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Polymarket ${escapeHtml(exchangeRuntime.mode)} 交易控制台</title>
  <style>
    :root { color-scheme: light; --blue:#1565c0; --deep:#0d47a1; --line:#dfe5ec; --muted:#667085; --bg:#f5f7fb; --danger:#b42318; --green:#1b5e20; --orange:#8a4b00; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif; margin: 0; background: var(--bg); color: #17212b; }
    header { background: linear-gradient(135deg, #0d47a1, #1565c0); color: white; padding: 26px 32px; }
    main { max-width: 1360px; margin: 0 auto; padding: 24px 30px 46px; }
    h1 { margin: 0 0 8px; }
    h2 { color: var(--deep); margin: 0 0 12px; font-size: 18px; }
    h3 { margin: 14px 0 8px; color: #344054; font-size: 15px; }
    label { display: block; margin-top: 12px; font-weight: 650; }
    input, select, textarea { width: 100%; box-sizing: border-box; padding: 9px 10px; border: 1px solid #ccd5df; border-radius: 8px; font-family: Consolas, "Microsoft YaHei", monospace; }
    button { margin: 8px 8px 0 0; padding: 10px 14px; border: 0; border-radius: 8px; background: #1565c0; color: white; font-weight: 700; cursor: pointer; }
    button:hover { background: #0d47a1; }
    button.warn { background: #b42318; }
    button.warn:hover { background: #7a271a; }
    button.secondary { background: #475467; }
    button.secondary:hover { background: #344054; }
    button.mini { padding: 6px 9px; font-size: 12px; margin: 0 4px 4px 0; }
    code, pre { background: #f6f8fa; padding: 2px 6px; border-radius: 4px; }
    pre { padding: 12px; white-space: pre-wrap; overflow: auto; max-height: 360px; }
    .topline { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 12px; align-items: center; }
    header a { color: white; border: 1px solid rgba(255,255,255,.5); padding: 6px 10px; border-radius: 999px; text-decoration: none; }
    header a:hover { background: rgba(255,255,255,.12); }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; }
    .layout { display: grid; grid-template-columns: minmax(320px, 420px) 1fr; gap: 16px; align-items: start; }
    @media (max-width: 980px) { .layout { grid-template-columns: 1fr; } }
    .card { background: white; border: 1px solid #dfe5ec; border-radius: 12px; padding: 16px; box-shadow: 0 1px 2px rgba(16,24,40,.04); }
    .card + .card { margin-top: 14px; }
    .muted { color: #667085; }
    .small { font-size: 12px; }
    .mono { font-family: Consolas, "Microsoft YaHei", monospace; }
    .metric { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; margin: 16px 0; }
    .metric .card { margin: 0; }
    .label { color: var(--muted); font-size: 12px; }
    .value { font-weight: 800; font-size: 18px; color: var(--blue); margin-top: 4px; word-break: break-all; }
    table { border-collapse: collapse; width: 100%; background: white; }
    th, td { padding: 9px 10px; border-bottom: 1px solid #edf1f5; text-align: left; font-size: 13px; vertical-align: top; }
    th { background: #f8fafc; }
    .table-wrap { overflow-x: auto; border: 1px solid #dfe5ec; border-radius: 12px; }
    .status { margin-top: 12px; padding: 10px 12px; background: #eef4ff; border: 1px solid #b2ccff; border-radius: 8px; color: #1849a9; font-weight: 650; }
    .status.error { background: #fff1f3; border-color: #fda29b; color: #b42318; }
    .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; background: #e3f2fd; color: var(--deep); font-weight: 700; font-size: 12px; }
    .pill.green { background: #e8f5e9; color: var(--green); }
    .pill.orange { background: #fff4e5; color: var(--orange); }
    .pill.red { background: #fff1f3; color: var(--danger); }
    .section { margin-top: 16px; }
    .split { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
    @media (max-width: 760px) { .split { grid-template-columns: 1fr; } }
    .right { text-align: right; }
    .nowrap { white-space: nowrap; }
    button:disabled { opacity: .6; cursor: wait; }
    a { color: #1565c0; }
  </style>
</head>
<body>
  <header>
    <h1>Polymarket ${escapeHtml(exchangeRuntime.mode)} 交易页面</h1>
    <div>当前 Exchange：<span class="mono">${escapeHtml(exchangeRuntime.exchange)}</span></div>
    <div>市场、订单簿、签名订单、链上撮合、取消订单和余额监控。</div>
    <div class="topline">
      <a href="/dashboard">Dashboard</a>
      <a href="${escapeHtml(orderbookPath)}">订单簿 JSON</a>
      <a href="/api/matcher/status">撮合服务状态</a>
      <a href="/api/chain-sync/status">链上同步状态</a>
      <a href="/api/events?eventName=OrdersMatched">撮合事件</a>
      <a href="/api/events?eventName=OrderCancelled">取消事件</a>
    </div>
  </header>

  <main>
  <section class="metric">
    <div class="card"><div class="label">当前市场</div><div class="value" id="metric-market">加载中</div></div>
    <div class="card"><div class="label">买方钱包</div><div class="value mono" id="metric-buyer">${escapeHtml(short(buyer, 8))}</div></div>
    <div class="card"><div class="label">卖方钱包</div><div class="value mono" id="metric-seller">${escapeHtml(short(seller, 8))}</div></div>
    <div class="card"><div class="label">自动撮合</div><div class="value" id="metric-matcher">加载中</div></div>
    <div class="card"><div class="label">链上同步</div><div class="value" id="metric-chain-sync">加载中</div></div>
    <div class="card"><div class="label">实时推送</div><div class="value" id="metric-realtime">连接中</div></div>
  </section>

  <section class="layout">
    <div>
      <div class="card">
        <h2>市场选择</h2>
        <label>Market</label>
        <select id="market-select">${marketOptions}</select>
        <div class="status" id="market-info">加载市场信息...</div>
        ${
          officialRuntime
            ? `<div class="topline">
                <button id="market-close" type="button" class="secondary">关闭本地订单簿</button>
                <button id="market-resolve-yes" type="button" class="warn">结算 YES</button>
                <button id="market-resolve-no" type="button" class="warn">结算 NO</button>
                <button id="market-redeem-buyer" type="button">买方赎回</button>
                <button id="market-redeem-seller" type="button">卖方赎回</button>
              </div>
              <p class="muted small">关闭仅更新本地订单簿；结算调用 CTF reportPayouts，且不可逆。赎回调用 CtfCollateralAdapter。</p>`
            : ""
        }
        <div class="topline">
          <label><input id="auto-refresh" type="checkbox" checked style="width:auto" /> 自动刷新 5 秒</label>
        </div>
      </div>

      <div class="card">
        <h2>MetaMask / 浏览器钱包</h2>
        <p class="muted small">连接后自动切换 Polygon Amoy。浏览器 EIP-712 签名支持 EOA(0) 和官方 Proxy(1)，不会发送链上交易。</p>
        <button id="connect-wallet" type="button">连接 MetaMask</button>
        <button id="refresh-wallet-assets" type="button" class="secondary">刷新余额/授权</button>
        <div id="wallet-status" class="status">尚未连接钱包</div>
        <pre id="wallet-assets">连接后显示账户 POL、Maker pUSD、结果代币余额和 Exchange 授权。</pre>
      </div>

      <div class="card">
        <h2>快捷操作</h2>
        <p class="muted small">${
          officialRuntime
            ? "生成签名订单只写官方模式数据库；撮合会调用官方 V2 ABI，取消只作用于本地订单簿。"
            : "生成签名订单只写数据库；链上撮合/取消会发 Amoy 测试网交易。"
        }</p>
        <label>API 写入令牌（仅在服务器配置 API_WRITE_TOKEN 时填写）</label>
        <input id="api-write-token" type="password" autocomplete="off" placeholder="保存在当前浏览器 localStorage" />
        <button id="save-api-token" type="button" class="secondary">保存令牌</button>
        <button id="seed-signed" type="button">生成签名订单</button>
        <button id="match-chain" type="button" class="warn">撮合一轮</button>
        <button id="sync-db" type="button" class="secondary">同步事件/余额</button>
        <div id="action-status" class="status">等待操作</div>
      </div>

      ${
        officialRuntime
          ? `<div class="card">
              <h2>官方 V2 Operator 预批准</h2>
              <label>local_order_id</label>
              <input id="preapproval-id" placeholder="点击订单行可自动填入" />
              <button id="preapprove-order" type="button">链上预批准</button>
              <button id="invalidate-order" type="button" class="warn">使预批准失效</button>
              <p class="muted small">失效只撤销 Operator 的预批准，不会使原始用户签名失效；系统会同时本地取消该订单。</p>
              <h3>用户级全部订单暂停</h3>
              <button id="pause-buyer" type="button" class="warn">暂停 BUYER</button>
              <button id="unpause-buyer" type="button">恢复 BUYER</button>
              <button id="pause-seller" type="button" class="warn">暂停 SELLER</button>
              <button id="unpause-seller" type="button">恢复 SELLER</button>
              <p class="muted small">pauseUser 会阻止该 maker 的全部订单；不是单订单取消。</p>
            </div>`
          : ""
      }

      <div class="card">
        <h2>提交订单到数据库</h2>
        <div>
          <button id="preset-buy" type="button" class="secondary">填入 BUY 示例</button>
          <button id="preset-sell" type="button" class="secondary">填入 SELL 示例</button>
        </div>
        <form id="order-form">
          <label>Market ID</label>
          <input name="marketId" value="${escapeHtml(market?.market_id ?? "")}" required />
          <div class="grid">
            <div>
              <label>方向</label>
              <select name="side">
                <option value="BUY">BUY 买入 YES</option>
                <option value="SELL">SELL 卖出 YES</option>
              </select>
            </div>
            <div>
              <label>Token</label>
              <select id="token-kind">
                <option value="YES">YES</option>
                <option value="NO">NO</option>
              </select>
            </div>
          </div>
          <label>Maker</label>
          <input name="maker" value="${escapeHtml(buyer)}" required />
          <label>Signer</label>
          <input name="signer" value="${escapeHtml(buyer)}" required />
          <label>Token ID</label>
          <input name="tokenId" value="${escapeHtml(market?.yes_token_id ?? "")}" required />
          <div class="grid">
            <div>
              <label>makerAmount</label>
              <input name="makerAmount" value="600000" required />
            </div>
            <div>
              <label>takerAmount</label>
              <input name="takerAmount" value="1000000" required />
            </div>
          </div>
          <div class="grid">
            <div>
              <label>expiration</label>
              <input name="expiration" value="0" />
            </div>
            <div>
              <label>salt</label>
              <input name="salt" value="${Date.now()}" />
            </div>
          </div>
          <label>签名类型</label>
          <select name="signatureType">
            <option value="0">0 - EOA</option>
            <option value="1" ${officialRuntime ? "selected" : ""}>1 - POLY_PROXY</option>
            <option value="2">2 - POLY_GNOSIS_SAFE</option>
            <option value="3" ${officialRuntime ? "" : "selected"}>3 - POLY_1271</option>
          </select>
          <label>signature（${officialRuntime ? "官方模式默认必填，入库前调用 validateOrder" : "可选；无签名订单不能链上撮合"}）</label>
          <input name="signature" value="" />
          <button type="submit">${officialRuntime ? "校验并提交签名订单" : "提交订单"}</button>
          <button id="sign-submit-order" type="button">MetaMask 签名并提交</button>
        </form>
      </div>

      <div class="card">
        <h2>${officialRuntime ? "本地取消订单" : "链上取消订单"}</h2>
        <label>local_order_id</label>
        <input id="cancel-id" placeholder="点击订单行可自动填入" />
        <button id="cancel-order" type="button" class="warn">${
          officialRuntime ? "从本地订单簿取消" : "链上取消"
        }</button>
        ${
          officialRuntime
            ? '<p class="muted small">官方 V2 模式下此操作只更新本地订单簿，不调用研究合约的签名取消函数。</p>'
            : ""
        }
      </div>
    </div>

    <div>
      <div class="card">
        <h2>余额</h2>
        <div class="table-wrap"><table id="balances-table"><thead><tr><th>钱包</th><th>资产</th><th>Token ID</th><th class="right">余额</th></tr></thead><tbody></tbody></table></div>
      </div>

      <div class="card section">
        <h2>订单簿</h2>
        <div class="split">
          <div>
            <h3>Bids 买单</h3>
            <div class="table-wrap"><table id="bids-table"><thead><tr><th>价格</th><th class="right">数量</th><th class="right">订单</th></tr></thead><tbody></tbody></table></div>
          </div>
          <div>
            <h3>Asks 卖单</h3>
            <div class="table-wrap"><table id="asks-table"><thead><tr><th>价格</th><th class="right">数量</th><th class="right">订单</th></tr></thead><tbody></tbody></table></div>
          </div>
        </div>
      </div>

      <div class="card section">
        <h2>最近订单</h2>
        <div class="table-wrap"><table id="orders-table"><thead><tr><th>ID</th><th>方向</th><th>价格</th><th>成交进度</th><th>状态</th><th>签名</th><th>校验</th><th>操作</th></tr></thead><tbody></tbody></table></div>
      </div>

      <div class="card section">
        <h2>最近成交</h2>
        <div class="table-wrap"><table id="trades-table"><thead><tr><th>Tx</th><th>Buyer</th><th>Seller</th><th class="right">YES/NO</th><th class="right">${escapeHtml(exchangeRuntime.collateralSymbol)}</th></tr></thead><tbody></tbody></table></div>
      </div>

      <div class="card section">
        <h2>执行结果</h2>
        <pre id="result">等待操作...</pre>
      </div>
    </div>
  </section>
  </main>
  <script type="module">
    import {
      AMOY_CHAIN_HEX,
      buildOrderForWallet,
      connectWallet as connectBrowserWallet,
      isAmoyChainId,
      normalizeChainId,
      readWalletAssets,
      signOrderTypedData,
    } from "/assets/trade-wallet.js";

    const markets = ${JSON.stringify(markets)};
    const runtimeMode = ${JSON.stringify(exchangeRuntime.mode)};
    const runtime = ${JSON.stringify(exchangeRuntime)};
    const buyerWallet = "${escapeHtml(buyer)}";
    const sellerWallet = "${escapeHtml(seller)}";
    const form = document.querySelector("#order-form");
    const result = document.querySelector("#result");
    const marketSelect = document.querySelector("#market-select");
    const tokenKind = document.querySelector("#token-kind");
    const marketInfo = document.querySelector("#market-info");
    const bidsBody = document.querySelector("#bids-table tbody");
    const asksBody = document.querySelector("#asks-table tbody");
    const ordersBody = document.querySelector("#orders-table tbody");
    const tradesBody = document.querySelector("#trades-table tbody");
    const balancesBody = document.querySelector("#balances-table tbody");
    const actionStatus = document.querySelector("#action-status");
    const actionButtons = Array.from(document.querySelectorAll("button"));
    const walletStatus = document.querySelector("#wallet-status");
    const walletAssets = document.querySelector("#wallet-assets");
    let connectedAccount = null;

    function shortText(value, size = 8) {
      const text = String(value || "");
      return text.length <= size * 2 + 3 ? text : text.slice(0, size) + "..." + text.slice(-size);
    }

    function activeMarket() {
      return markets.find((item) => item.market_id === marketSelect.value) || markets[0] || {};
    }

    function tokenIdFor(kind) {
      const market = activeMarket();
      return kind === "NO" ? market.no_token_id : market.yes_token_id;
    }

    function setTokenFromKind() {
      form.elements.tokenId.value = tokenIdFor(tokenKind.value) || "";
    }

    function setPreset(side) {
      const market = activeMarket();
      form.elements.marketId.value = market.market_id || "";
      form.elements.side.value = side;
      tokenKind.value = "YES";
      form.elements.tokenId.value = market.yes_token_id || "";
      form.elements.salt.value = String(Date.now());
      form.elements.signature.value = "";
      const browserSignatureType = Number(form.elements.signatureType.value);
      if (side === "BUY") {
        form.elements.maker.value = buyerWallet;
        form.elements.signer.value = connectedAccount || buyerWallet;
        form.elements.makerAmount.value = "600000";
        form.elements.takerAmount.value = "1000000";
      } else {
        form.elements.maker.value = sellerWallet;
        form.elements.signer.value = connectedAccount || sellerWallet;
        form.elements.makerAmount.value = "1000000";
        form.elements.takerAmount.value = "560000";
      }
      if (connectedAccount && browserSignatureType === 0) {
        form.elements.maker.value = connectedAccount;
        form.elements.signer.value = connectedAccount;
      }
    }

    function statusPill(status) {
      const s = String(status || "");
      const cls = s === "OPEN" ? "green" : s === "PARTIALLY_FILLED" ? "orange" : s === "CANCELLED" || s === "FAILED" ? "red" : "";
      return '<span class="pill ' + cls + '">' + s + '</span>';
    }

    function sidePill(side) {
      return '<span class="pill ' + (side === "BUY" ? "green" : "orange") + '">' + side + '</span>';
    }

    function emptyRow(cols, text) {
      return '<tr><td colspan="' + cols + '" class="muted">' + text + '</td></tr>';
    }

    async function postJson(url, body = {}) {
      const token = localStorage.getItem("polymarketApiWriteToken") || "";
      const headers = { "content-type": "application/json" };
      if (token) headers.authorization = "Bearer " + token;
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      const json = await response.json();
      if (!response.ok || json.error) throw new Error(JSON.stringify(json, null, 2));
      return json;
    }

    function updateConnectedAccount(account) {
      connectedAccount = account || null;
      walletStatus.className = "status";
      walletStatus.textContent = connectedAccount
        ? "已连接 Amoy：" + connectedAccount
        : "尚未连接钱包";
      if (!connectedAccount) return;
      form.elements.signer.value = connectedAccount;
      if (Number(form.elements.signatureType.value) === 0) {
        form.elements.maker.value = connectedAccount;
      }
      form.elements.signature.value = "";
    }

    async function refreshBrowserWalletAssets() {
      if (!connectedAccount) throw new Error("请先连接 MetaMask");
      const maker = form.elements.maker.value.trim();
      const snapshot = await readWalletAssets(
        window.ethereum,
        runtime,
        maker,
        connectedAccount,
        form.elements.tokenId.value,
      );
      walletAssets.textContent = JSON.stringify({
        connectedAccount,
        maker,
        tokenId: form.elements.tokenId.value,
        collateralSymbol: runtime.collateralSymbol,
        ...snapshot,
      }, null, 2);
      return snapshot;
    }

    async function connectAndRefreshWallet() {
      const account = await connectBrowserWallet(window.ethereum);
      updateConnectedAccount(account);
      await refreshBrowserWalletAssets();
      return {
        account,
        chainId: AMOY_CHAIN_HEX,
        message: "MetaMask 已连接 Polygon Amoy",
      };
    }

    async function signAndSubmitBrowserOrder() {
      if (!connectedAccount) {
        updateConnectedAccount(await connectBrowserWallet(window.ethereum));
      }
      const formValues = Object.fromEntries(new FormData(form).entries());
      const { typedData, payload } = buildOrderForWallet(
        runtime,
        formValues,
        connectedAccount,
      );
      const signature = await signOrderTypedData(
        window.ethereum,
        connectedAccount,
        typedData,
      );
      form.elements.maker.value = payload.maker;
      form.elements.signer.value = payload.signer;
      form.elements.signature.value = signature;
      const created = await postJson("/api/orders", {
        ...payload,
        signature,
      });
      return {
        account: connectedAccount,
        typedData,
        created,
      };
    }

    async function refresh() {
      const market = activeMarket();
      const marketId = encodeURIComponent(market.market_id || "");
      const [book, orders, trades, balances, matcher, chainSync, latestMarkets] = await Promise.all([
        fetch("/api/orderbook?marketId=" + marketId).then((r) => r.json()),
        fetch("/api/orders?marketId=" + marketId + "&limit=30").then((r) => r.json()),
        fetch("/api/trades?marketId=" + marketId + "&limit=20").then((r) => r.json()),
        fetch("/api/balances").then((r) => r.json()),
        fetch("/api/matcher/status").then((r) => r.json()),
        fetch("/api/chain-sync/status").then((r) => r.json()),
        fetch("/api/markets").then((r) => r.json()),
      ]);
      const latestMarket = latestMarkets.find((item) => item.market_id === market.market_id);
      if (latestMarket) Object.assign(market, latestMarket);
      document.querySelector("#metric-market").textContent = shortText(market.market_id || "无市场", 8);
      document.querySelector("#metric-matcher").textContent = matcher.running ? "运行中" : "未运行";
      document.querySelector("#metric-chain-sync").textContent = chainSync.running ? "运行中" : "未运行";
      marketInfo.innerHTML = '<div><b>' + (market.question || "无市场") + '</b></div>'
        + '<div class="small muted">状态：' + (market.status || "-") + ' · YES ' + shortText(market.yes_token_id, 10) + ' · NO ' + shortText(market.no_token_id, 10) + '</div>'
        + '<div class="small muted">撮合状态：' + (matcher.mode || "-") + ' · 最近 ' + (matcher.updatedAt || "-") + '</div>'
        + '<div class="small muted">链上同步：' + (chainSync.running ? "运行中" : "未运行") + ' · 最近 ' + (chainSync.updatedAt || "-") + '</div>';

      bidsBody.innerHTML = book.bids?.length ? book.bids.map((item) =>
        '<tr><td>' + item.price_micros + '</td><td class="right">' + item.total_size + '</td><td class="right">' + item.order_count + '</td></tr>'
      ).join("") : emptyRow(3, "暂无买单");
      asksBody.innerHTML = book.asks?.length ? book.asks.map((item) =>
        '<tr><td>' + item.price_micros + '</td><td class="right">' + item.total_size + '</td><td class="right">' + item.order_count + '</td></tr>'
      ).join("") : emptyRow(3, "暂无卖单");

      ordersBody.innerHTML = orders.map((item) => {
        const filled = item.filled_maker_amount + "/" + item.maker_amount + " | " + item.filled_taker_amount + "/" + item.taker_amount;
        const signature = item.signature ? "yes" : "no";
        const validation = item.validation_status || "UNVERIFIED";
        const canCancel = (item.status === "OPEN" || item.status === "PARTIALLY_FILLED") && item.signature;
        const cancelButton = canCancel ? '<button class="mini warn cancel-row" data-id="' + item.local_order_id + '">取消</button>' : '';
        const copyButton = '<button class="mini secondary use-row" data-id="' + item.local_order_id + '">选中</button>';
        return "<tr><td><code>" + item.local_order_id + "</code></td><td>" + sidePill(item.side) + "</td><td>" + item.price_micros + "</td><td>" + filled + "</td><td>" + statusPill(item.status) + "</td><td>" + signature + "</td><td>" + validation + "</td><td class='nowrap'>" + copyButton + cancelButton + "</td></tr>";
      }).join("") || emptyRow(8, "暂无订单");

      tradesBody.innerHTML = trades.map((item) =>
        '<tr><td><a target="_blank" rel="noreferrer" href="https://amoy.polygonscan.com/tx/' + item.tx_hash + '">' + shortText(item.tx_hash, 8) + '</a></td><td class="mono">' + shortText(item.buyer, 8) + '</td><td class="mono">' + shortText(item.seller, 8) + '</td><td class="right">' + item.outcome_amount + '</td><td class="right">' + item.collateral_amount + '</td></tr>'
      ).join("") || emptyRow(5, "暂无成交");

      balancesBody.innerHTML = balances.map((item) =>
        '<tr><td class="mono">' + shortText(item.wallet_address, 8) + '</td><td>' + item.token_symbol + '</td><td class="mono">' + shortText(item.token_id, 8) + '</td><td class="right">' + item.balance_decimal + '</td></tr>'
      ).join("") || emptyRow(4, "暂无余额");
    }

    async function runAction(label, fn) {
      actionStatus.className = "status";
      actionStatus.textContent = label + " 执行中...";
      result.textContent = label + " 执行中...";
      actionButtons.forEach((button) => { button.disabled = true; });
      try {
        const json = await fn();
        actionStatus.className = "status";
        actionStatus.textContent = label + " 完成";
        result.textContent = JSON.stringify(json, null, 2);
        await refresh();
      } catch (error) {
        actionStatus.className = "status error";
        actionStatus.textContent = label + " 失败，详情见下方结果区域";
        result.textContent = String(error);
      } finally {
        actionButtons.forEach((button) => { button.disabled = false; });
      }
    }

    document.querySelector("#connect-wallet").addEventListener("click", () => {
      runAction("连接 MetaMask", connectAndRefreshWallet);
    });
    document.querySelector("#refresh-wallet-assets").addEventListener("click", () => {
      runAction("读取钱包余额/授权", refreshBrowserWalletAssets);
    });
    document.querySelector("#sign-submit-order").addEventListener("click", () => {
      runAction("MetaMask EIP-712 签名并提交", signAndSubmitBrowserOrder);
    });
    form.elements.signatureType.addEventListener("change", () => {
      form.elements.signature.value = "";
      if (!connectedAccount) return;
      const signatureType = Number(form.elements.signatureType.value);
      form.elements.signer.value = connectedAccount;
      if (signatureType === 0) {
        form.elements.maker.value = connectedAccount;
      } else if (signatureType === 1) {
        form.elements.maker.value =
          form.elements.side.value === "SELL" ? sellerWallet : buyerWallet;
      }
    });
    if (window.ethereum?.on) {
      window.ethereum.on("accountsChanged", (accounts) => {
        updateConnectedAccount(accounts?.[0] || null);
        if (connectedAccount) {
          refreshBrowserWalletAssets().catch((error) => {
            walletAssets.textContent = String(error);
          });
        }
      });
      window.ethereum.on("chainChanged", (chainId) => {
        const onAmoy = isAmoyChainId(chainId);
        const numericChainId = normalizeChainId(chainId);
        walletStatus.className = onAmoy ? "status" : "status error";
        walletStatus.textContent =
          (connectedAccount ? connectedAccount + " · " : "") +
          (onAmoy
            ? "Polygon Amoy · chainId 80002"
            : "当前 chainId " + (numericChainId ?? chainId) +
              "，请重新连接并切换到 Polygon Amoy (80002)");
        form.elements.signature.value = "";
      });
    }

    document.querySelector("#seed-signed").addEventListener("click", () => {
      runAction("生成签名订单", () => postJson("/api/orders/seed-signed"));
    });
    const apiTokenInput = document.querySelector("#api-write-token");
    apiTokenInput.value = localStorage.getItem("polymarketApiWriteToken") || "";
    document.querySelector("#save-api-token").addEventListener("click", () => {
      const token = apiTokenInput.value.trim();
      if (token) localStorage.setItem("polymarketApiWriteToken", token);
      else localStorage.removeItem("polymarketApiWriteToken");
      actionStatus.textContent = token ? "API 写入令牌已保存在当前浏览器" : "API 写入令牌已清除";
    });
    document.querySelector("#match-chain").addEventListener("click", () => {
      if (!confirm("确认在 Amoy 测试网上发起链上撮合交易？")) return;
      runAction("链上撮合", () => postJson("/api/orders/match-chain", { confirmation: "AMOY_TESTNET_ONLY" }));
    });
    document.querySelector("#sync-db").addEventListener("click", () => {
      runAction("同步事件/余额", () => postJson("/api/sync"));
    });
    if (runtimeMode === "official-v2") {
      const marketAction = (action, body, label) => {
        const market = activeMarket();
        return runAction(
          label,
          () => postJson(
            "/api/markets/" + encodeURIComponent(market.market_id) + "/" + action,
            body,
          ),
        );
      };
      document.querySelector("#market-close").addEventListener("click", () => {
        if (!confirm("关闭后，本地订单簿将不再接受新订单。确认关闭？")) return;
        marketAction("close", {}, "关闭市场");
      });
      document.querySelector("#market-resolve-yes").addEventListener("click", () => {
        if (!confirm("不可逆操作：确认在 Amoy 将结果结算为 YES？")) return;
        marketAction("resolve", { outcome: "YES", confirmation: "AMOY_TESTNET_ONLY" }, "结算 YES");
      });
      document.querySelector("#market-resolve-no").addEventListener("click", () => {
        if (!confirm("不可逆操作：确认在 Amoy 将结果结算为 NO？")) return;
        marketAction("resolve", { outcome: "NO", confirmation: "AMOY_TESTNET_ONLY" }, "结算 NO");
      });
      for (const role of ["buyer", "seller"]) {
        document.querySelector("#market-redeem-" + role).addEventListener("click", () => {
          if (!confirm("确认让 " + role.toUpperCase() + " 在 Amoy 赎回胜出头寸？")) return;
          marketAction(
            "redeem",
            { role: role.toUpperCase(), confirmation: "AMOY_TESTNET_ONLY" },
            role.toUpperCase() + " 赎回",
          );
        });
      }
      document.querySelector("#preapprove-order").addEventListener("click", () => {
        const id = document.querySelector("#preapproval-id").value.trim();
        if (!id) return alert("请输入 local_order_id");
        if (!confirm("确认由本测试 Exchange Operator 链上预批准该订单？")) return;
        runAction("链上预批准", () => postJson(
          "/api/orders/" + encodeURIComponent(id) + "/preapprove-chain",
          { confirmation: "AMOY_TESTNET_ONLY" },
        ));
      });
      document.querySelector("#invalidate-order").addEventListener("click", () => {
        const id = document.querySelector("#preapproval-id").value.trim();
        if (!id) return alert("请输入 local_order_id");
        if (!confirm("确认撤销该订单的 Operator 预批准，并从本地订单簿取消？")) return;
        runAction("预批准失效", () => postJson(
          "/api/orders/" + encodeURIComponent(id) + "/invalidate-chain",
          { confirmation: "AMOY_TESTNET_ONLY" },
        ));
      });
      for (const role of ["buyer", "seller"]) {
        for (const action of ["pause", "unpause"]) {
          document.querySelector("#" + action + "-" + role).addEventListener("click", () => {
            const verb = action === "pause" ? "暂停" : "恢复";
            if (!confirm("确认在 Amoy " + verb + " " + role.toUpperCase() + " 的全部订单？")) return;
            runAction(verb + " " + role.toUpperCase(), () => postJson(
              "/api/users/" + role + "/" + action,
              { confirmation: "AMOY_TESTNET_ONLY" },
            ));
          });
        }
      }
    }
    document.querySelector("#cancel-order").addEventListener("click", () => {
      const id = document.querySelector("#cancel-id").value.trim();
      if (!id) return alert("请输入 local_order_id");
      if (runtimeMode === "official-v2") {
        if (!confirm("确认从本地订单簿取消订单 " + id + "？")) return;
        runAction("本地取消", () => postJson("/api/orders/" + encodeURIComponent(id) + "/cancel"));
        return;
      }
      if (!confirm("确认在 Amoy 测试网上链上取消订单 " + id + "？")) return;
      runAction("链上取消", () => postJson("/api/orders/" + encodeURIComponent(id) + "/cancel-chain", { confirmation: "AMOY_TESTNET_ONLY" }));
    });
    document.querySelector("#preset-buy").addEventListener("click", () => setPreset("BUY"));
    document.querySelector("#preset-sell").addEventListener("click", () => setPreset("SELL"));
    marketSelect.addEventListener("change", () => {
      form.elements.marketId.value = activeMarket().market_id || "";
      setTokenFromKind();
      if (realtimeSocket?.readyState === WebSocket.OPEN) {
        realtimeSocket.send(JSON.stringify({
          type: "subscribe",
          marketId: activeMarket().market_id,
        }));
      }
      refresh().catch((error) => { result.textContent = String(error); });
    });
    tokenKind.addEventListener("change", setTokenFromKind);
    ordersBody.addEventListener("click", (event) => {
      const target = event.target;
      if (!target?.dataset?.id) return;
      document.querySelector("#cancel-id").value = target.dataset.id;
      const preapprovalId = document.querySelector("#preapproval-id");
      if (preapprovalId) preapprovalId.value = target.dataset.id;
      if (target.classList.contains("cancel-row")) {
        document.querySelector("#cancel-order").click();
      }
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(form).entries());
      if (!data.signature) delete data.signature;
      runAction("提交数据库订单", () => postJson("/api/orders", data));
    });
    let realtimeRefreshTimer;
    let realtimeSocket;
    function connectRealtime() {
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const marketId = encodeURIComponent(activeMarket().market_id || "");
      const socket = new WebSocket(protocol + "//" + location.host + "/ws?marketId=" + marketId);
      realtimeSocket = socket;
      socket.addEventListener("open", () => {
        document.querySelector("#metric-realtime").textContent = "已连接";
      });
      socket.addEventListener("message", (event) => {
        try {
          const message = JSON.parse(event.data);
          if (message.type !== "snapshot") return;
          document.querySelector("#metric-realtime").textContent = "实时";
          clearTimeout(realtimeRefreshTimer);
          realtimeRefreshTimer = setTimeout(() => {
            refresh().catch((error) => { result.textContent = String(error); });
          }, 100);
        } catch {
          document.querySelector("#metric-realtime").textContent = "消息错误";
        }
      });
      socket.addEventListener("close", () => {
        document.querySelector("#metric-realtime").textContent = "重连中";
        setTimeout(connectRealtime, 2000);
      });
      socket.addEventListener("error", () => {
        document.querySelector("#metric-realtime").textContent = "连接失败";
      });
    }
    setPreset("BUY");
    refresh().catch((error) => { result.textContent = String(error); });
    connectRealtime();
    setInterval(() => {
      if (document.querySelector("#auto-refresh").checked) {
        refresh().catch((error) => { result.textContent = String(error); });
      }
    }, 5000);
  </script>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function short(value, size = 10) {
  const text = String(value ?? "");
  if (text.length <= size * 2 + 3) return text;
  return `${text.slice(0, size)}...${text.slice(-size)}`;
}

function explorerTx(hash) {
  if (!hash || hash === "already-approved") return escapeHtml(hash ?? "");
  return `<a href="https://amoy.polygonscan.com/tx/${escapeHtml(hash)}" target="_blank" rel="noreferrer">${escapeHtml(short(hash, 8))}</a>`;
}

function explorerAddress(address) {
  if (!address || !String(address).startsWith("0x")) return escapeHtml(address ?? "");
  return `<a href="https://amoy.polygonscan.com/address/${escapeHtml(address)}" target="_blank" rel="noreferrer">${escapeHtml(short(address, 8))}</a>`;
}

function tableHtml(headers, tableRows) {
  return `<div class="table-wrap"><table>
    <thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead>
    <tbody>
      ${tableRows.length
        ? tableRows.map((row) => `<tr>${row.map((value) => `<td>${value}</td>`).join("")}</tr>`).join("")
        : `<tr><td colspan="${headers.length}" class="muted">暂无数据</td></tr>`}
    </tbody>
  </table></div>`;
}

function dashboardPage() {
  const summary = routes["/api/summary"]();
  const contracts = routes["/api/contracts"]();
  const wallets = routes["/api/wallets"]();
  const markets = routes["/api/markets"]();
  const orders = rows("SELECT * FROM orders ORDER BY updated_at DESC LIMIT 50");
  const firstMarketId = markets[0]?.market_id;
  const orderbook = firstMarketId
    ? orderbookForMarket(firstMarketId)
    : { marketId: null, bids: [], asks: [] };
  const trades = rows("SELECT * FROM trades ORDER BY created_at DESC LIMIT 50");
  const balances = routes["/api/balances"](new URL("http://local/api/balances"));
  const events = rows(
    "SELECT * FROM chain_events ORDER BY block_number DESC, log_index DESC LIMIT 50",
  );

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Polymarket ${escapeHtml(exchangeRuntime.mode)} Dashboard</title>
  <style>
    :root { color-scheme: light; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif; margin: 0; background: #f5f7fb; color: #17212b; }
    header { background: linear-gradient(135deg, #0d47a1, #1565c0); color: white; padding: 28px 36px; }
    main { padding: 24px 36px 48px; }
    h1 { margin: 0 0 8px; }
    h2 { margin-top: 30px; color: #0d47a1; }
    a { color: #1565c0; text-decoration: none; }
    a:hover { text-decoration: underline; }
    code { background: #eef2f7; padding: 2px 6px; border-radius: 4px; }
    .sub { opacity: .9; }
    .nav { margin-top: 14px; display: flex; gap: 10px; flex-wrap: wrap; }
    .nav a { color: white; border: 1px solid rgba(255,255,255,.45); padding: 6px 10px; border-radius: 999px; }
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-top: 18px; }
    .card { background: white; border: 1px solid #dfe5ec; border-radius: 12px; padding: 14px; box-shadow: 0 1px 2px rgba(16,24,40,.04); }
    .label { color: #5b6777; font-size: 13px; }
    .count { font-size: 28px; font-weight: 750; color: #1565c0; margin-top: 4px; }
    .table-wrap { overflow-x: auto; background: white; border: 1px solid #dfe5ec; border-radius: 12px; box-shadow: 0 1px 2px rgba(16,24,40,.04); }
    table { border-collapse: collapse; width: 100%; min-width: 860px; }
    th, td { padding: 10px 12px; border-bottom: 1px solid #edf1f5; text-align: left; font-size: 13px; vertical-align: top; }
    th { background: #f8fafc; color: #455468; position: sticky; top: 0; }
    tr:last-child td { border-bottom: none; }
    .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; background: #e3f2fd; color: #0d47a1; font-weight: 650; }
    .pill.green { background: #e8f5e9; color: #1b5e20; }
    .pill.orange { background: #fff4e5; color: #8a4b00; }
    .muted { color: #667085; }
  </style>
</head>
<body>
  <header>
    <h1>Polymarket ${escapeHtml(exchangeRuntime.mode)} Dashboard</h1>
    <div class="sub">当前 Exchange：<code>${escapeHtml(exchangeRuntime.exchange)}</code></div>
    <div class="sub">浏览 SQLite 数据库与 Amoy 链上同步事件</div>
    <div class="sub">数据库：<code>${escapeHtml(dbPath)}</code></div>
    <div class="nav">
      <a href="/">API 首页</a>
      <a href="/api/summary">JSON 摘要</a>
      <a href="/trade">下单页面</a>
      <a href="/api/orderbook${firstMarketId ? `?marketId=${escapeHtml(firstMarketId)}` : ""}">订单簿 JSON</a>
      <a href="/api/events?eventName=OrdersMatched">OrdersMatched JSON</a>
      <a href="/api/matcher/status">自动撮合状态</a>
      <a href="https://amoy.polygonscan.com/" target="_blank" rel="noreferrer">Amoy Polygonscan</a>
    </div>
  </header>
  <main>
    <section class="cards">
      ${Object.entries(summary.counts).map(([key, value]) => `<div class="card"><div class="label">${escapeHtml(key)}</div><div class="count">${escapeHtml(value)}</div></div>`).join("")}
    </section>

    <h2>合约</h2>
    ${tableHtml(["名称", "角色", "地址", "备注"], contracts.map((item) => [
      escapeHtml(item.name),
      escapeHtml(item.role),
      explorerAddress(item.address),
      escapeHtml(item.notes),
    ]))}

    <h2>Deposit Wallet</h2>
    ${tableHtml(["角色", "钱包地址", "Owner", "类型"], wallets.map((item) => [
      `<span class="pill">${escapeHtml(item.wallet_role)}</span>`,
      explorerAddress(item.wallet_address),
      explorerAddress(item.owner_address),
      escapeHtml(item.wallet_type),
    ]))}

    <h2>市场</h2>
    ${tableHtml(["状态", "胜出", "创建者", "Market ID", "问题", "YES tokenId", "NO tokenId", "创建交易"], markets.map((item) => [
      `<span class="pill green">${escapeHtml(item.status)}</span>`,
      escapeHtml(item.winning_outcome || 0),
      explorerAddress(item.creator),
      escapeHtml(short(item.market_id, 10)),
      escapeHtml(item.question),
      escapeHtml(short(item.yes_token_id, 12)),
      escapeHtml(short(item.no_token_id, 12)),
      explorerTx(item.created_tx),
    ]))}

    <h2>订单</h2>
    ${tableHtml(["订单ID", "方向", "Maker", "价格 micros", "makerAmount", "takerAmount", "状态"], orders.map((item) => [
      escapeHtml(item.local_order_id),
      `<span class="pill ${item.side === "BUY" ? "green" : "orange"}">${escapeHtml(item.side)}</span>`,
      explorerAddress(item.maker),
      escapeHtml(item.price_micros),
      escapeHtml(item.maker_amount),
      escapeHtml(item.taker_amount),
      `<span class="pill green">${escapeHtml(item.status)}</span>`,
    ]))}

    <h2>订单簿</h2>
    <div class="grid">
      <div>
        <h3>Bids 买单</h3>
        ${tableHtml(["价格 micros", "数量", "订单数"], orderbook.bids.map((item) => [
          escapeHtml(item.price_micros),
          escapeHtml(item.total_size),
          escapeHtml(item.order_count),
        ]))}
      </div>
      <div>
        <h3>Asks 卖单</h3>
        ${tableHtml(["价格 micros", "数量", "订单数"], orderbook.asks.map((item) => [
          escapeHtml(item.price_micros),
          escapeHtml(item.total_size),
          escapeHtml(item.order_count),
        ]))}
      </div>
    </div>

    <h2>成交</h2>
    ${tableHtml(["交易", "Buyer", "Seller", "OutcomeAmount", "CollateralAmount"], trades.map((item) => [
      explorerTx(item.tx_hash),
      explorerAddress(item.buyer),
      explorerAddress(item.seller),
      escapeHtml(item.outcome_amount),
      escapeHtml(item.collateral_amount),
    ]))}

    <h2>余额</h2>
    ${tableHtml(["钱包", "资产", "Token ID", "余额"], balances.map((item) => [
      explorerAddress(item.wallet_address),
      escapeHtml(item.token_symbol),
      escapeHtml(short(item.token_id, 12)),
      escapeHtml(item.balance_decimal),
    ]))}

    <h2>链上事件</h2>
    ${tableHtml(["区块", "LogIndex", "事件", "合约", "交易", "参数"], events.map((item) => [
      escapeHtml(item.block_number),
      escapeHtml(item.log_index),
      `<span class="pill">${escapeHtml(item.event_name)}</span>`,
      explorerAddress(item.contract_address),
      explorerTx(item.tx_hash),
      `<code>${escapeHtml(JSON.stringify(item.args_json))}</code>`,
    ]))}
  </main>
</body>
</html>`;
}

function orderbookForMarket(marketId) {
  const activeStatuses = ["OPEN", "PARTIALLY_FILLED"];
  const bids = rows(
    `SELECT
       price_micros,
       SUM(CAST(taker_amount AS INTEGER) - CAST(filled_taker_amount AS INTEGER)) AS total_size,
       COUNT(*) AS order_count
     FROM orders
     WHERE market_id = :marketId
       AND side = 'BUY'
       AND status IN ('OPEN', 'PARTIALLY_FILLED')
     GROUP BY price_micros
     ORDER BY price_micros DESC`,
    { marketId },
  );
  const asks = rows(
    `SELECT
       price_micros,
       SUM(CAST(maker_amount AS INTEGER) - CAST(filled_maker_amount AS INTEGER)) AS total_size,
       COUNT(*) AS order_count
     FROM orders
     WHERE market_id = :marketId
       AND side = 'SELL'
       AND status IN ('OPEN', 'PARTIALLY_FILLED')
     GROUP BY price_micros
     ORDER BY price_micros ASC`,
    { marketId },
  );
  return { marketId, activeStatuses, bids, asks };
}

function databaseHealth() {
  try {
    const result = db.prepare("PRAGMA quick_check").get();
    return {
      ok: result?.quick_check === "ok",
      result: result?.quick_check ?? "unknown",
    };
  } catch (error) {
    return {
      ok: false,
      result: error instanceof Error ? error.message : String(error),
    };
  }
}

function readiness() {
  const database = databaseHealth();
  const chainSync = readChainSyncStatus();
  const checks = {
    database,
    exchange: {
      ok: Boolean(exchangeRuntime.exchange && exchangeRuntime.chainId === 80002),
      mode: exchangeRuntime.mode,
      chainId: exchangeRuntime.chainId,
      address: exchangeRuntime.exchange,
    },
    market: {
      ok: Boolean(exchangeRuntime.marketConfigured && exchangeRuntime.marketId),
      marketId: exchangeRuntime.marketId,
    },
    chainSync: {
      required: healthRequireChainSync,
      ok: !healthRequireChainSync || chainSync.running,
      running: chainSync.running,
      processAlive: chainSync.processAlive,
      stale: chainSync.stale,
      updatedAt: chainSync.updatedAt,
    },
  };
  return {
    ok: Object.values(checks).every((check) => check.ok),
    checkedAt: new Date().toISOString(),
    checks,
  };
}

function serviceMetrics() {
  const memory = process.memoryUsage();
  return {
    generatedAt: new Date().toISOString(),
    api: {
      pid: process.pid,
      uptimeSeconds: Math.floor(process.uptime()),
      websocketClients: websocketServer.clients.size,
      rateLimitBuckets: rateWindows.size,
      memoryBytes: {
        rss: memory.rss,
        heapUsed: memory.heapUsed,
        heapTotal: memory.heapTotal,
      },
    },
    database: {
      path: dbPath,
      health: databaseHealth(),
      orders: one("SELECT COUNT(*) AS count FROM orders").count,
      openOrders: one(
        `SELECT COUNT(*) AS count FROM orders
         WHERE status IN ('OPEN', 'PARTIALLY_FILLED')`,
      ).count,
      trades: one("SELECT COUNT(*) AS count FROM trades").count,
      chainEvents: one("SELECT COUNT(*) AS count FROM chain_events").count,
      orderStats: orderStats(db),
    },
    matcher: readMatcherStatus(),
    chainSync: readChainSyncStatus(),
  };
}

const routes = {
  "/api/health/live": () => ({
    ok: true,
    checkedAt: new Date().toISOString(),
    pid: process.pid,
    uptimeSeconds: Math.floor(process.uptime()),
  }),
  "/api/summary": () => ({
    dbPath,
    runtime: exchangeRuntime,
    counts: {
      contracts: one("SELECT COUNT(*) AS count FROM contracts").count,
      wallets: one("SELECT COUNT(*) AS count FROM wallets").count,
      markets: one("SELECT COUNT(*) AS count FROM markets").count,
      orders: one("SELECT COUNT(*) AS count FROM orders").count,
      trades: one("SELECT COUNT(*) AS count FROM trades").count,
      orderFills: one("SELECT COUNT(*) AS count FROM order_fills").count,
      apiAudit: one("SELECT COUNT(*) AS count FROM api_audit_log").count,
      tokenBalances: one("SELECT COUNT(*) AS count FROM token_balances").count,
      chainEvents: one("SELECT COUNT(*) AS count FROM chain_events").count,
    },
    syncState: rows("SELECT * FROM sync_state ORDER BY chain_id, name"),
  }),
  "/api/contracts": () =>
    rows("SELECT * FROM contracts ORDER BY chain_id, name"),
  "/api/wallets": () =>
    rows("SELECT * FROM wallets ORDER BY chain_id, wallet_role, wallet_address"),
  "/api/markets": () =>
    rows("SELECT * FROM markets ORDER BY chain_id, updated_at DESC"),
  "/api/orders": (url) => {
    const status = url.searchParams.get("status");
    const marketId = url.searchParams.get("marketId");
    const side = url.searchParams.get("side");
    const clauses = [];
    const params = { limit: limit(url), offset: offset(url) };
    if (status) {
      clauses.push("status = :status");
      params.status = status;
    }
    if (marketId) {
      clauses.push("market_id = :marketId");
      params.marketId = marketId;
    }
    if (side) {
      clauses.push("side = :side");
      params.side = side.toUpperCase();
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return rows(
      `SELECT * FROM orders ${where} ORDER BY updated_at DESC LIMIT :limit OFFSET :offset`,
      params,
    );
  },
  "/api/orders/stats": () => orderStats(db),
  "/api/orderbook": (url) => {
    const requestedMarketId = url.searchParams.get("marketId");
    const market = requestedMarketId
      ? one("SELECT market_id FROM markets WHERE market_id = :marketId", {
          marketId: requestedMarketId,
        })
      : one("SELECT market_id FROM markets ORDER BY updated_at DESC LIMIT 1");
    if (!market) {
      return { marketId: requestedMarketId, bids: [], asks: [] };
    }
    return orderbookForMarket(market.market_id);
  },
  "/api/trades": (url) => {
    const marketId = url.searchParams.get("marketId");
    const clauses = [];
    const params = { limit: limit(url), offset: offset(url) };
    if (marketId) {
      clauses.push("market_id = :marketId");
      params.marketId = marketId;
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return rows(
      `SELECT * FROM trades ${where} ORDER BY created_at DESC LIMIT :limit OFFSET :offset`,
      params,
    );
  },
  "/api/order-fills": (url) => {
    const orderHash = url.searchParams.get("orderHash");
    const localOrderId = url.searchParams.get("localOrderId");
    const clauses = [];
    const params = { limit: limit(url), offset: offset(url) };
    if (orderHash) {
      clauses.push("lower(order_hash) = lower(:orderHash)");
      params.orderHash = orderHash;
    }
    if (localOrderId) {
      clauses.push("local_order_id = :localOrderId");
      params.localOrderId = localOrderId;
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return rows(
      `SELECT * FROM order_fills ${where}
       ORDER BY block_number DESC, log_index DESC
       LIMIT :limit OFFSET :offset`,
      params,
    );
  },
  "/api/audit": (url) =>
    rows(
      `SELECT * FROM api_audit_log
       ORDER BY id DESC LIMIT :limit OFFSET :offset`,
      { limit: limit(url), offset: offset(url) },
    ),
  "/api/balances": (url) => {
    const wallet = url.searchParams.get("wallet");
    const symbol = url.searchParams.get("symbol");
    const clauses = [];
    const params = {};
    if (wallet) {
      clauses.push("lower(wallet_address) = lower(:wallet)");
      params.wallet = wallet;
    }
    if (symbol) {
      clauses.push("token_symbol = :symbol");
      params.symbol = symbol;
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return rows(
      `SELECT * FROM token_balances ${where} ORDER BY wallet_address, token_symbol, token_id`,
      params,
    );
  },
  "/api/events": (url) => {
    const eventName = url.searchParams.get("eventName");
    const txHash = url.searchParams.get("txHash");
    const contract = url.searchParams.get("contract");
    const clauses = [];
    const params = { limit: limit(url), offset: offset(url) };
    if (eventName) {
      clauses.push("event_name = :eventName");
      params.eventName = eventName;
    }
    if (txHash) {
      clauses.push("lower(tx_hash) = lower(:txHash)");
      params.txHash = txHash;
    }
    if (contract) {
      clauses.push("lower(contract_address) = lower(:contract)");
      params.contract = contract;
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return rows(
      `SELECT * FROM chain_events ${where} ORDER BY block_number DESC, log_index DESC LIMIT :limit OFFSET :offset`,
      params,
    );
  },
  "/api/matcher/status": () => readMatcherStatus(),
  "/api/chain-sync/status": () => readChainSyncStatus(),
  "/api/metrics": () => serviceMetrics(),
};

const websocketServer = new WebSocketServer({ noServer: true });

function realtimeSnapshot(marketId) {
  const market = marketId
    ? one("SELECT * FROM markets WHERE market_id = :marketId", { marketId })
    : one("SELECT * FROM markets ORDER BY updated_at DESC LIMIT 1");
  const selectedMarketId = market?.market_id ?? null;
  return {
    type: "snapshot",
    generatedAt: new Date().toISOString(),
    runtime: exchangeRuntime,
    market,
    orderbook: selectedMarketId
      ? orderbookForMarket(selectedMarketId)
      : { marketId: null, bids: [], asks: [] },
    recentOrders: selectedMarketId
      ? rows(
          `SELECT local_order_id, order_hash, side, price_micros, status,
                  filled_maker_amount, filled_taker_amount, updated_at
           FROM orders
           WHERE market_id = :marketId
           ORDER BY updated_at DESC LIMIT 20`,
          { marketId: selectedMarketId },
        )
      : [],
    recentTrades: selectedMarketId
      ? rows(
          `SELECT * FROM trades
           WHERE market_id = :marketId
           ORDER BY created_at DESC LIMIT 20`,
          { marketId: selectedMarketId },
        )
      : [],
  };
}

function sendRealtime(socket, reason = "snapshot") {
  if (socket.readyState !== 1) return;
  socket.send(
    JSON.stringify({
      ...realtimeSnapshot(socket.marketId),
      reason,
    }),
  );
}

function broadcastRealtime(reason) {
  for (const socket of websocketServer.clients) {
    sendRealtime(socket, reason);
  }
}

websocketServer.on("connection", (socket, request) => {
  const url = new URL(request.url ?? "/ws", `http://${request.headers.host ?? "localhost"}`);
  socket.marketId = url.searchParams.get("marketId") ?? exchangeRuntime.marketId;
  socket.isAlive = true;
  socket.on("pong", () => {
    socket.isAlive = true;
  });
  socket.on("message", (message) => {
    try {
      const parsed = JSON.parse(message.toString());
      if (parsed.type === "subscribe" && typeof parsed.marketId === "string") {
        socket.marketId = parsed.marketId;
        sendRealtime(socket, "subscribed");
      }
    } catch {
      socket.send(JSON.stringify({
        type: "error",
        message: "WebSocket 消息必须是 JSON",
      }));
    }
  });
  sendRealtime(socket, "connected");
});

function marketOrderbookPath(pathname) {
  const match = pathname.match(/^\/api\/markets\/(.+)\/orderbook$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function orderActionPath(pathname) {
  const match = pathname.match(
    /^\/api\/orders\/(.+)\/(cancel|fill|cancel-chain|preapprove-chain|invalidate-chain)$/,
  );
  return match
    ? { localOrderId: decodeURIComponent(match[1]), action: match[2] }
    : null;
}

function marketActionPath(pathname) {
  const match = pathname.match(/^\/api\/markets\/(.+)\/(close|resolve|redeem)$/);
  return match
    ? { marketId: decodeURIComponent(match[1]), action: match[2] }
    : null;
}

function userActionPath(pathname) {
  const match = pathname.match(/^\/api\/users\/(buyer|seller)\/(pause|unpause)$/i);
  return match ? { role: match[1], action: match[2].toLowerCase() } : null;
}

const server = http.createServer(async (req, res) => {
  let requestUrl;
  let actor = "anonymous";
  let requestBody = {};
  let audited = false;
  try {
    if (!req.url) return badRequest(res, "Missing URL");
    const url = new URL(req.url, `http://${req.headers.host ?? `${host}:${port}`}`);
    requestUrl = url;

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type, authorization, x-api-key",
      });
      res.end();
      return;
    }

    const rate = consumeRateLimit(req, req.method === "POST");
    if (!rate.allowed) {
      res.setHeader("retry-after", String(Math.ceil((rate.resetAt - Date.now()) / 1000)));
      return json(res, 429, {
        error: "RATE_LIMITED",
        message: `请求过于频繁，每分钟最多 ${rate.maximum} 次`,
        resetAt: new Date(rate.resetAt).toISOString(),
      });
    }

    if (req.method === "POST") {
      actor = authorizeWrite(req);
      const respondAction = (statusCode, action, data) => {
        auditAction(req, url, statusCode, action, actor, requestBody);
        audited = true;
        json(res, statusCode, data);
        queueMicrotask(() => broadcastRealtime(action));
      };
      if (url.pathname === "/api/orders/seed-signed") {
        return respondAction(200, "ORDER_SEED_SIGNED", await seedSignedOrders());
      }
      if (url.pathname === "/api/orders/match-chain") {
        requestBody = await readJsonBody(req);
        return respondAction(
          200,
          "ORDER_MATCH_CHAIN",
          await matchOrdersOnchain(requestBody),
        );
      }
      if (url.pathname === "/api/sync") {
        return respondAction(200, "DATABASE_SYNC", await syncDatabaseFromChain());
      }
      if (url.pathname === "/api/orders") {
        requestBody = await readJsonBody(req);
        const result = await insertOrder(requestBody);
        return respondAction(
          result.idempotent ? 200 : 201,
          result.idempotent ? "ORDER_CREATE_IDEMPOTENT" : "ORDER_CREATE",
          result,
        );
      }
      const marketAction = marketActionPath(url.pathname);
      if (marketAction) {
        requestBody = {
          ...(await readJsonBody(req)),
          marketId: marketAction.marketId,
        };
        return respondAction(
          200,
          `MARKET_${marketAction.action.toUpperCase()}`,
          await runMarketLifecycle(
            marketAction.marketId,
            marketAction.action,
            requestBody,
          ),
        );
      }
      const userAction = userActionPath(url.pathname);
      if (userAction) {
        requestBody = {
          ...(await readJsonBody(req)),
          role: userAction.role,
        };
        return respondAction(
          200,
          `USER_${userAction.action.toUpperCase()}`,
          await manageOfficialUser(userAction.role, userAction.action, requestBody),
        );
      }
      const action = orderActionPath(url.pathname);
      if (action?.action === "cancel") {
        requestBody = { localOrderId: action.localOrderId };
        return respondAction(200, "ORDER_CANCEL_LOCAL", cancelOrder(action.localOrderId));
      }
      if (action?.action === "fill") {
        requestBody = {
          ...(await readJsonBody(req)),
          localOrderId: action.localOrderId,
        };
        return respondAction(
          200,
          "ORDER_FILL_LOCAL",
          fillOrder(action.localOrderId, requestBody),
        );
      }
      if (action?.action === "cancel-chain") {
        requestBody = {
          ...(await readJsonBody(req)),
          localOrderId: action.localOrderId,
        };
        return respondAction(
          200,
          "ORDER_CANCEL_CHAIN",
          await cancelOrderOnchain(action.localOrderId, requestBody),
        );
      }
      if (action?.action === "preapprove-chain") {
        requestBody = {
          ...(await readJsonBody(req)),
          localOrderId: action.localOrderId,
        };
        return respondAction(
          200,
          "ORDER_PREAPPROVE",
          await manageOfficialOrder(
            action.localOrderId,
            "preapprove",
            requestBody,
          ),
        );
      }
      if (action?.action === "invalidate-chain") {
        requestBody = {
          ...(await readJsonBody(req)),
          localOrderId: action.localOrderId,
        };
        return respondAction(
          200,
          "ORDER_PREAPPROVAL_INVALIDATE",
          await manageOfficialOrder(
            action.localOrderId,
            "invalidate",
            requestBody,
          ),
        );
      }
      auditAction(req, url, 404, "UNKNOWN_WRITE_ROUTE", actor, requestBody);
      audited = true;
      return notFound(res, url.pathname);
    }

    if (req.method !== "GET") {
      return badRequest(res, "Only GET/POST is supported");
    }

    if (url.pathname === "/assets/trade-wallet.js") {
      return javascript(
        res,
        fs.readFileSync(
          path.join(projectDir, "public", "trade-wallet.js"),
          "utf8",
        ),
      );
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return html(res, indexPage());
    }
    if (url.pathname === "/dashboard") {
      return html(res, dashboardPage());
    }
    if (url.pathname === "/trade") {
      return html(res, tradePage());
    }

    const marketId = marketOrderbookPath(url.pathname);
    if (marketId) {
      return json(res, 200, orderbookForMarket(marketId));
    }

    const route = routes[url.pathname];
    if (url.pathname === "/api/health/ready") {
      const result = readiness();
      return json(res, result.ok ? 200 : 503, result);
    }
    if (url.pathname === "/api/modules") {
      return json(res, 200, await officialModulesStatus());
    }
    if (!route) return notFound(res, url.pathname);
    return json(res, 200, route(url));
  } catch (error) {
    const statusCode = Number(error?.statusCode ?? 500);
    if (
      req.method === "POST" &&
      requestUrl &&
      !audited
    ) {
      auditAction(
        req,
        requestUrl,
        statusCode,
        "WRITE_FAILED",
        actor,
        requestBody,
      );
    }
    if (statusCode === 401) {
      return json(res, 401, {
        error: "UNAUTHORIZED",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    if ([400, 409, 413, 422].includes(statusCode)) {
      const names = {
        400: "BAD_REQUEST",
        409: "CONFLICT",
        413: "PAYLOAD_TOO_LARGE",
        422: "ORDER_VALIDATION_FAILED",
      };
      return json(res, statusCode, {
        error: names[statusCode],
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return internalError(res, error);
  }
});

server.on("upgrade", (request, socket, head) => {
  try {
    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? `${host}:${port}`}`,
    );
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      websocketServer.emit("connection", websocket, request);
    });
  } catch {
    socket.destroy();
  }
});

let realtimeFingerprint = "";
function currentRealtimeFingerprint() {
  const state = one(
    `SELECT
       (SELECT COUNT(*) FROM orders) AS order_count,
       (SELECT COALESCE(MAX(updated_at), '') FROM orders) AS order_updated,
       (SELECT COUNT(*) FROM trades) AS trade_count,
       (SELECT COALESCE(MAX(created_at), '') FROM trades) AS trade_updated,
       (SELECT COUNT(*) FROM chain_events) AS event_count,
       (SELECT COALESCE(MAX(block_number), 0) FROM chain_events) AS event_block`,
  );
  return JSON.stringify(state);
}
const realtimePoll = setInterval(() => {
  const next = currentRealtimeFingerprint();
  if (realtimeFingerprint && next !== realtimeFingerprint) {
    broadcastRealtime("database-updated");
  }
  realtimeFingerprint = next;
}, realtimePollMs);
realtimePoll.unref();

const websocketHeartbeat = setInterval(() => {
  for (const socket of websocketServer.clients) {
    if (!socket.isAlive) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
}, 30_000);
websocketHeartbeat.unref();

const rateLimitCleanup = setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [key, value] of rateWindows) {
    if (value.startedAt < cutoff) rateWindows.delete(key);
  }
}, 60_000);
rateLimitCleanup.unref();

const orderExpirySweep = setInterval(() => {
  try {
    const changes = expireOrders(db);
    if (changes > 0) broadcastRealtime("orders-expired");
  } catch (error) {
    console.error("[api] 订单过期维护失败：", error);
  }
}, orderExpirySweepMs);
orderExpirySweep.unref();
expireOrders(db);

server.listen(port, host, () => {
  console.log(
    `Polymarket ${exchangeRuntime.mode} API 已启动：http://${host}:${port}`,
  );
  console.log(`数据库：${dbPath}`);
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(realtimePoll);
  clearInterval(websocketHeartbeat);
  clearInterval(rateLimitCleanup);
  clearInterval(orderExpirySweep);
  for (const socket of websocketServer.clients) socket.close(1001, "server shutdown");
  websocketServer.close();
  const forceExit = setTimeout(() => {
    db.close();
    process.exit(1);
  }, 5_000);
  forceExit.unref();
  server.close(() => {
    clearTimeout(forceExit);
    db.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
