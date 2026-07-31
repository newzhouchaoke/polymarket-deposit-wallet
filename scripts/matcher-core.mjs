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
  readCurrentExchangeArtifact,
  toContractOrder,
  upsert,
} from "./order-utils.mjs";
import { dbMode } from "./db.js";

export const matcherStatusPath = path.join(
  projectDir,
  "data",
  `matcher-${dbMode}-status.json`,
);

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

function compactError(error) {
  const message =
    error && typeof error === "object" && typeof error.shortMessage === "string"
      ? error.shortMessage
      : error instanceof Error
        ? error.message
        : String(error);
  return message.replace(/\s+/g, " ").trim();
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

export function bestMatch(db, maxMakers = Number(process.env.MATCHER_MAX_MAKERS ?? "5")) {
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
     LIMIT :limit`,
  );

  for (const buy of buys) {
    const candidates = sellStatement.all({
      marketId: buy.market_id,
      tokenId: buy.token_id,
      buyPriceMicros: buy.price_micros,
      limit: Math.max(1, Math.min(50, Number(maxMakers) || 5)),
    });
    if (!candidates.length) continue;

    let remainingBuyOutcome = remainingOutcome(buy);
    let remainingBuyCollateral =
      BigInt(buy.maker_amount) - BigInt(buy.filled_maker_amount ?? "0");
    const makers = [];
    for (const sell of candidates) {
      if (
        BigInt(buy.maker_amount) * BigInt(sell.maker_amount) <
        BigInt(sell.taker_amount) * BigInt(buy.taker_amount)
      ) {
        continue;
      }
      let outcomeAmount =
        remainingBuyOutcome < remainingOutcome(sell)
          ? remainingBuyOutcome
          : remainingOutcome(sell);
      let collateralAmount = collateralForOutcome(sell, outcomeAmount);
      if (collateralAmount > remainingBuyCollateral) {
        outcomeAmount =
          (remainingBuyCollateral * BigInt(sell.maker_amount)) /
          BigInt(sell.taker_amount);
        collateralAmount = collateralForOutcome(sell, outcomeAmount);
      }
      if (outcomeAmount <= 0n || collateralAmount <= 0n) continue;
      makers.push({ sell, outcomeAmount, collateralAmount });
      remainingBuyOutcome -= outcomeAmount;
      remainingBuyCollateral -= collateralAmount;
      if (remainingBuyOutcome === 0n || remainingBuyCollateral === 0n) break;
    }
    if (makers.length) return { buy, makers };
  }

  return {
    reason: "没有价格交叉且支付上限足够的 BUY/SELL 订单",
    bestBuy: buys[0],
  };
}

export function bestPair(db) {
  const match = bestMatch(db, 1);
  if (match.reason) return match;
  return { buy: match.buy, sell: match.makers[0].sell };
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
  const deployment = loadDeployment({ requireMarket: true });
  const db = openResearchDb();
  try {
    const match = bestMatch(db);
    if (match.reason) {
      return {
        matched: false,
        reason: match.reason,
        bestBuy: match.bestBuy?.local_order_id,
      };
    }

    const outcomeAmount = match.makers.reduce(
      (total, maker) => total + maker.outcomeAmount,
      0n,
    );
    const collateralAmount = match.makers.reduce(
      (total, maker) => total + maker.collateralAmount,
      0n,
    );
    const summary = {
      buyOrderId: match.buy.local_order_id,
      sellOrderIds: match.makers.map(({ sell }) => sell.local_order_id),
      makerCount: match.makers.length,
      buyPriceMicros: match.buy.price_micros,
      sellPriceMicros: match.makers.map(({ sell }) => sell.price_micros),
      marketId: match.buy.market_id,
      tokenId: match.buy.token_id,
      outcomeAmount: outcomeAmount.toString(),
      collateralAmount: collateralAmount.toString(),
      makerFills: match.makers.map(({ sell, outcomeAmount: outcome, collateralAmount: collateral }) => ({
        sellOrderId: sell.local_order_id,
        outcomeAmount: outcome.toString(),
        collateralAmount: collateral.toString(),
      })),
    };

    if (dryRun) {
      const publicClient = createPublicClient({
        chain: polygonAmoy,
        transport: amoyTransport(),
      });
      const exchangeArtifact = readCurrentExchangeArtifact(deployment);
      const validation = {};
      for (const [side, row] of [
        ["buy", match.buy],
        ...match.makers.map(({ sell }, index) => [`sell-${index + 1}`, sell]),
      ]) {
        try {
          await publicClient.readContract({
            address: deployment.exchange,
            abi: exchangeArtifact.abi,
            functionName: "validateOrder",
            args: [toContractOrder(row)],
          });
          validation[side] = { valid: true };
        } catch (error) {
          validation[side] = {
            valid: false,
            error: compactError(error),
          };
        }
      }
      let settlementSimulation;
      try {
        await publicClient.simulateContract({
          account: account(),
          address: deployment.exchange,
          abi: exchangeArtifact.abi,
          functionName: "matchOrders",
          args: [
            deployment.market.conditionId ?? deployment.market.marketId,
            toContractOrder(match.buy),
            match.makers.map(({ sell }) => toContractOrder(sell)),
            collateralAmount,
            match.makers.map(({ outcomeAmount: amount }) => amount),
            0n,
            match.makers.map(() => 0n),
          ],
        });
        settlementSimulation = { ready: true };
      } catch (error) {
        settlementSimulation = {
          ready: false,
          error: compactError(error),
        };
      }
      return {
        matched: false,
        dryRun: true,
        candidate: summary,
        onchainOrderValidation: validation,
        settlementSimulation,
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
    const exchangeArtifact = readCurrentExchangeArtifact(deployment);

    const buyOrder = toContractOrder(match.buy);
    const sellOrders = match.makers.map(({ sell }) => toContractOrder(sell));
    const matchArgs = [
      deployment.market.conditionId ?? deployment.market.marketId,
      buyOrder,
      sellOrders,
      collateralAmount,
      match.makers.map(({ outcomeAmount: amount }) => amount),
      0n,
      match.makers.map(() => 0n),
    ];
    const { request } = await publicClient.simulateContract({
      account: signer,
      address: deployment.exchange,
      abi: exchangeArtifact.abi,
      functionName: "matchOrders",
      args: matchArgs,
    });
    const hash = await walletClient.writeContract(request);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`撮合交易失败：${hash}`);

    const buyFill = updateFill(db, match.buy, collateralAmount, outcomeAmount);
    const sellFills = match.makers.map(({ sell, outcomeAmount: outcome, collateralAmount: collateral }) => ({
      localOrderId: sell.local_order_id,
      ...updateFill(db, sell, outcome, collateral),
    }));
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
        marketId: match.buy.market_id,
        buyer: match.buy.maker,
        seller: match.makers[0].sell.maker,
        tokenId: match.buy.token_id,
        outcomeAmount: outcomeAmount.toString(),
        collateralAmount: collateralAmount.toString(),
        buyOrderId: match.buy.local_order_id,
        sellOrderId: match.makers[0].sell.local_order_id,
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
      sellFills,
    };
  } finally {
    db.close();
  }
}
