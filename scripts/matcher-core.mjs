import fs from "node:fs";
import path from "node:path";
import { createPublicClient, createWalletClient, fallback, http } from "viem";
import { polygonAmoy } from "viem/chains";
import {
  account,
  assertMatcherLiveAction,
  loadDeployment,
  openResearchDb,
  projectDir,
  readArtifact,
  toContractOrder,
  upsert,
} from "./order-utils.mjs";

export const matcherStatusPath = path.join(projectDir, "data", "matcher-status.json");

export function amoyRpcUrls() {
  const configured = process.env.AMOY_RPC_URLS || process.env.AMOY_RPC_URL;
  const preferred = configured
    ? configured.split(",").map((url) => url.trim()).filter(Boolean)
    : [];
  return [
    ...new Set([
      ...preferred,
      "https://polygon-amoy-bor-rpc.publicnode.com",
      "https://rpc-amoy.polygon.technology",
      "https://polygon-amoy.drpc.org",
    ]),
  ];
}

export function amoyTransport() {
  return fallback(
    amoyRpcUrls().map((url) => http(url, { retryCount: 1, timeout: 10_000 })),
    { rank: false },
  );
}

export function writeMatcherStatus(status) {
  fs.mkdirSync(path.dirname(matcherStatusPath), { recursive: true });
  fs.writeFileSync(
    matcherStatusPath,
    `${JSON.stringify({ updatedAt: new Date().toISOString(), ...status }, null, 2)}\n`,
  );
}

export function readMatcherStatus() {
  if (!fs.existsSync(matcherStatusPath)) {
    return {
      updatedAt: null,
      running: false,
      message: "自动撮合服务尚未写入状态",
    };
  }
  return JSON.parse(fs.readFileSync(matcherStatusPath, "utf8"));
}

export function bestPair(db) {
  const buys = db.prepare(
    `SELECT *
     FROM orders
     WHERE side = 'BUY'
       AND status IN ('OPEN', 'PARTIALLY_FILLED')
       AND signature IS NOT NULL
       AND (expiration = 0 OR expiration > CAST(strftime('%s','now') AS INTEGER))
       AND CAST(filled_maker_amount AS INTEGER) < CAST(maker_amount AS INTEGER)
       AND CAST(filled_taker_amount AS INTEGER) < CAST(taker_amount AS INTEGER)
     ORDER BY price_micros DESC, updated_at ASC`,
  ).all();

  if (!buys.length) return { reason: "没有可撮合的已签名 BUY 订单" };

  const sellStatement = db.prepare(
    `SELECT *
     FROM orders
     WHERE side = 'SELL'
       AND status IN ('OPEN', 'PARTIALLY_FILLED')
       AND signature IS NOT NULL
       AND (expiration = 0 OR expiration > CAST(strftime('%s','now') AS INTEGER))
       AND CAST(filled_maker_amount AS INTEGER) < CAST(maker_amount AS INTEGER)
       AND CAST(filled_taker_amount AS INTEGER) < CAST(taker_amount AS INTEGER)
       AND market_id = :marketId
       AND token_id = :tokenId
       AND price_micros <= :buyPriceMicros
     ORDER BY price_micros ASC, updated_at ASC
     LIMIT 1`,
  );

  for (const buy of buys) {
    const sell = sellStatement.get({
      marketId: buy.market_id,
      tokenId: buy.token_id,
      buyPriceMicros: buy.price_micros,
    });
    if (!sell) continue;

    if (
      BigInt(buy.maker_amount) * BigInt(sell.maker_amount) <
      BigInt(sell.taker_amount) * BigInt(buy.taker_amount)
    ) {
      continue;
    }

    return { buy, sell };
  }

  return {
    reason: "没有价格交叉且支付上限足够的 BUY/SELL 订单",
    bestBuy: buys[0],
  };
}

export function remainingOutcome(row) {
  if (row.side === "SELL") {
    return BigInt(row.maker_amount) - BigInt(row.filled_maker_amount ?? "0");
  }
  return BigInt(row.taker_amount) - BigInt(row.filled_taker_amount ?? "0");
}

export function collateralForOutcome(sell, outcomeAmount) {
  return (outcomeAmount * BigInt(sell.taker_amount)) / BigInt(sell.maker_amount);
}

export function updateFill(db, row, makerFill, takerFill) {
  const nextFilledMaker = BigInt(row.filled_maker_amount ?? "0") + makerFill;
  const nextFilledTaker = BigInt(row.filled_taker_amount ?? "0") + takerFill;
  const status =
    nextFilledMaker >= BigInt(row.maker_amount) || nextFilledTaker >= BigInt(row.taker_amount)
      ? "FILLED"
      : "PARTIALLY_FILLED";
  db.prepare(
    `UPDATE orders
     SET status = :status,
         filled_maker_amount = :filledMakerAmount,
         filled_taker_amount = :filledTakerAmount,
         updated_at = CURRENT_TIMESTAMP
     WHERE chain_id = :chainId AND local_order_id = :localOrderId`,
  ).run({
    chainId: row.chain_id,
    localOrderId: row.local_order_id,
    status,
    filledMakerAmount: nextFilledMaker.toString(),
    filledTakerAmount: nextFilledTaker.toString(),
  });
  return {
    status,
    filledMakerAmount: nextFilledMaker.toString(),
    filledTakerAmount: nextFilledTaker.toString(),
  };
}

export async function matchOnce(options = {}) {
  const { dryRun = false, assertLiveAction = true } = options;
  const deployment = loadDeployment();
  const db = openResearchDb();
  try {
    const pair = bestPair(db);
    if (pair.reason) {
      return {
        matched: false,
        reason: pair.reason,
        bestBuy: pair.bestBuy?.local_order_id,
      };
    }

    const outcomeAmount = remainingOutcome(pair.buy) < remainingOutcome(pair.sell)
      ? remainingOutcome(pair.buy)
      : remainingOutcome(pair.sell);
    const collateralAmount = collateralForOutcome(pair.sell, outcomeAmount);
    const summary = {
      buyOrderId: pair.buy.local_order_id,
      sellOrderId: pair.sell.local_order_id,
      buyPriceMicros: pair.buy.price_micros,
      sellPriceMicros: pair.sell.price_micros,
      marketId: pair.buy.market_id,
      tokenId: pair.buy.token_id,
      outcomeAmount: outcomeAmount.toString(),
      collateralAmount: collateralAmount.toString(),
    };

    if (dryRun) {
      return {
        matched: false,
        dryRun: true,
        candidate: summary,
      };
    }

    if (assertLiveAction) assertMatcherLiveAction();

    const signer = account();
    const publicClient = createPublicClient({
      chain: polygonAmoy,
      transport: amoyTransport(),
    });
    const walletClient = createWalletClient({
      account: signer,
      chain: polygonAmoy,
      transport: amoyTransport(),
    });
    const exchangeArtifact = readArtifact("ResearchCLOBExchange");

    const buyOrder = toContractOrder(pair.buy);
    const sellOrder = toContractOrder(pair.sell);
    const hash = await walletClient.writeContract({
      account: signer,
      chain: polygonAmoy,
      address: deployment.exchange,
      abi: exchangeArtifact.abi,
      functionName: "matchOrders",
      args: [buyOrder, pair.buy.signature, sellOrder, pair.sell.signature, outcomeAmount],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`撮合交易失败：${hash}`);

    const buyFill = updateFill(db, pair.buy, collateralAmount, outcomeAmount);
    const sellFill = updateFill(db, pair.sell, outcomeAmount, collateralAmount);
    upsert(
      db,
      `INSERT INTO trades(
         chain_id, tx_hash, market_id, buyer, seller, token_id,
         outcome_amount, collateral_amount, buy_order_id, sell_order_id, raw_json
       )
       VALUES(
         :chainId, :txHash, :marketId, :buyer, :seller, :tokenId,
         :outcomeAmount, :collateralAmount, :buyOrderId, :sellOrderId, :rawJson
       )
       ON CONFLICT(chain_id, tx_hash) DO UPDATE SET
         market_id=excluded.market_id,
         buyer=excluded.buyer,
         seller=excluded.seller,
         token_id=excluded.token_id,
         outcome_amount=excluded.outcome_amount,
         collateral_amount=excluded.collateral_amount,
         buy_order_id=excluded.buy_order_id,
         sell_order_id=excluded.sell_order_id,
         raw_json=excluded.raw_json`,
      {
        chainId: Number(deployment.chainId),
        txHash: hash,
        marketId: pair.buy.market_id,
        buyer: pair.buy.maker,
        seller: pair.sell.maker,
        tokenId: pair.buy.token_id,
        outcomeAmount: outcomeAmount.toString(),
        collateralAmount: collateralAmount.toString(),
        buyOrderId: pair.buy.local_order_id,
        sellOrderId: pair.sell.local_order_id,
        rawJson: JSON.stringify({
          source: "matcher-core",
          ...summary,
          txHash: hash,
          blockNumber: receipt.blockNumber.toString(),
        }),
      },
    );

    return {
      matched: true,
      txHash: hash,
      blockNumber: receipt.blockNumber.toString(),
      explorer: `https://amoy.polygonscan.com/tx/${hash}`,
      ...summary,
      buyFill,
      sellFill,
    };
  } finally {
    db.close();
  }
}
