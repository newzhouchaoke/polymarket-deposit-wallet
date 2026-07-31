import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { getAddress, hashTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { dbPath, initSchema, openDatabase, projectDir, upsert } from "./db.js";
import { CANCEL_TYPES, ORDER_TYPES } from "./erc7739.mjs";
import {
  OFFICIAL_MODE,
  exchangeMode,
  loadExchangeConfig,
  officialDeploymentPath,
  readExchangeArtifact,
  researchDeploymentPath,
} from "./exchange-config.mjs";

dotenv.config({ path: path.join(projectDir, "..", ".env"), quiet: true });
dotenv.config({ path: path.join(projectDir, ".env"), override: true, quiet: true });
delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;

export const deploymentPath =
  exchangeMode() === OFFICIAL_MODE
    ? officialDeploymentPath()
    : researchDeploymentPath();

export { CANCEL_TYPES, ORDER_TYPES };

export function loadDeployment(options = {}) {
  return loadExchangeConfig(options);
}

export function readArtifact(contractName) {
  if (
    contractName === "ResearchCLOBExchange" &&
    exchangeMode() === OFFICIAL_MODE
  ) {
    return readExchangeArtifact();
  }
  return JSON.parse(
    fs.readFileSync(path.join(projectDir, "artifacts", `${contractName}.json`), "utf8"),
  );
}

export function readCurrentExchangeArtifact(deployment = loadDeployment()) {
  return readExchangeArtifact(deployment);
}

export function privateKey() {
  const key =
    process.env.POLYMARKET_PRIVATE_KEY ||
    process.env.ETH_PRIVATE_KEY ||
    process.env.PRIVATE_KEY;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("缺少有效私钥：POLYMARKET_PRIVATE_KEY / ETH_PRIVATE_KEY / PRIVATE_KEY");
  }
  return key;
}

export function account() {
  return privateKeyToAccount(privateKey());
}

export function assertMatcherLiveAction() {
  if (
    process.env.LIVE_ACTION !== "MATCH_ORDERS" &&
    process.env.LIVE_ACTION !== "MATCH_RESEARCH_ORDERS"
  ) {
    throw new Error("链上撮合已拦截：请设置 LIVE_ACTION=MATCH_ORDERS");
  }
  if (process.env.LIVE_CONFIRMATION !== "AMOY_TESTNET_ONLY") {
    throw new Error("测试网写入已拦截：请设置 LIVE_CONFIRMATION=AMOY_TESTNET_ONLY");
  }
}

export function assertCancelLiveAction() {
  if (process.env.LIVE_ACTION !== "CANCEL_RESEARCH_ORDER") {
    throw new Error("链上取消订单已拦截：请设置 LIVE_ACTION=CANCEL_RESEARCH_ORDER");
  }
  if (process.env.LIVE_CONFIRMATION !== "AMOY_TESTNET_ONLY") {
    throw new Error("测试网写入已拦截：请设置 LIVE_CONFIRMATION=AMOY_TESTNET_ONLY");
  }
}

export function openResearchDb() {
  const db = openDatabase();
  initSchema(db);
  return db;
}

export function sideName(side) {
  return Number(side) === 0 ? "BUY" : "SELL";
}

export function sideNumber(side) {
  return String(side).toUpperCase() === "BUY" || Number(side) === 0 ? 0 : 1;
}

export function priceMicros(order) {
  const maker = BigInt(order.makerAmount);
  const taker = BigInt(order.takerAmount);
  return Number(order.side) === 0
    ? Number((maker * 1_000_000n) / taker)
    : Number((taker * 1_000_000n) / maker);
}

export function domainFor(deployment) {
  return {
    name: "Polymarket CTF Exchange",
    version: "2",
    chainId: Number(deployment.chainId),
    verifyingContract: getAddress(deployment.exchange),
  };
}

export function orderHashFor(deployment, order) {
  return hashTypedData({
    domain: domainFor(deployment),
    types: ORDER_TYPES,
    primaryType: "Order",
    message: {
      salt: BigInt(order.salt),
      maker: getAddress(order.maker),
      signer: getAddress(order.signer),
      tokenId: BigInt(order.tokenId),
      makerAmount: BigInt(order.makerAmount),
      takerAmount: BigInt(order.takerAmount),
      side: Number(order.side),
      signatureType: Number(order.signatureType),
      timestamp: BigInt(order.timestamp),
      metadata: order.metadata,
      builder: order.builder,
    },
  });
}

export function insertDbOrder(db, deployment, localOrderId, order, signature, status = "OPEN") {
  if (!deployment.market) {
    throw new Error(`${deployment.mode} 尚未配置市场，无法保存订单`);
  }
  const now = new Date().toISOString();
  const orderHash = orderHashFor(deployment, order);
  const rawJson = JSON.stringify(
    {
      maker: order.maker,
      signer: order.signer,
      tokenId: order.tokenId.toString(),
      makerAmount: order.makerAmount.toString(),
      takerAmount: order.takerAmount.toString(),
      side: order.side,
      signatureType: Number(order.signatureType),
      timestamp: order.timestamp.toString(),
      metadata: order.metadata,
      builder: order.builder,
      expiration: String(order.expiration ?? 0),
      salt: order.salt.toString(),
      signature,
      orderHash,
    },
  );
  upsert(
    db,
    `INSERT INTO orders(
       chain_id, local_order_id, market_id, maker, signer, side, token_id,
       maker_amount, taker_amount, filled_maker_amount, filled_taker_amount,
       price_micros, status, expiration, salt, signature, order_hash,
       validation_status, validated_at, raw_json, updated_at
     )
     VALUES(
       :chainId, :localOrderId, :marketId, :maker, :signer, :side, :tokenId,
       :makerAmount, :takerAmount, '0', '0',
       :priceMicros, :status, :expiration, :salt, :signature, :orderHash,
       'LOCALLY_SIGNED', :updatedAt, :rawJson, :updatedAt
     )
     ON CONFLICT(chain_id, local_order_id) DO UPDATE SET
       market_id=excluded.market_id,
       maker=excluded.maker,
       signer=excluded.signer,
       side=excluded.side,
       token_id=excluded.token_id,
       maker_amount=excluded.maker_amount,
       taker_amount=excluded.taker_amount,
       filled_maker_amount=excluded.filled_maker_amount,
       filled_taker_amount=excluded.filled_taker_amount,
       price_micros=excluded.price_micros,
       status=excluded.status,
       expiration=excluded.expiration,
       salt=excluded.salt,
       signature=excluded.signature,
       order_hash=excluded.order_hash,
       validation_status=excluded.validation_status,
       validation_error=NULL,
       validated_at=excluded.validated_at,
       raw_json=excluded.raw_json,
       updated_at=excluded.updated_at`,
    {
      chainId: Number(deployment.chainId),
      localOrderId,
      marketId: deployment.market.marketId,
      maker: order.maker,
      signer: order.signer,
      side: sideName(order.side),
      tokenId: order.tokenId.toString(),
      makerAmount: order.makerAmount.toString(),
      takerAmount: order.takerAmount.toString(),
      priceMicros: priceMicros(order),
      status,
      expiration: Number(order.expiration ?? 0),
      salt: order.salt.toString(),
      signature,
      orderHash,
      rawJson,
      updatedAt: now,
    },
  );
}

export function toContractOrder(row) {
  const raw = typeof row.raw_json === "string" ? JSON.parse(row.raw_json) : row.raw_json;
  return {
    salt: BigInt(row.salt ?? raw?.salt),
    maker: getAddress(row.maker),
    signer: getAddress(row.signer),
    tokenId: BigInt(row.token_id),
    makerAmount: BigInt(row.maker_amount),
    takerAmount: BigInt(row.taker_amount),
    side: sideNumber(row.side),
    signatureType: Number(raw?.signatureType ?? 3),
    timestamp: BigInt(raw?.timestamp ?? Math.floor(Date.now() / 1000)),
    metadata: raw?.metadata ?? `0x${"00".repeat(32)}`,
    builder: raw?.builder ?? `0x${"00".repeat(32)}`,
    signature: row.signature ?? raw?.signature ?? "0x",
  };
}

export { dbPath, projectDir, upsert };
