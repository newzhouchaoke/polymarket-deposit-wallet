import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import {
  createPublicClient,
  decodeEventLog,
  fallback,
  http,
  getAddress,
  toHex,
} from "viem";
import { polygonAmoy } from "viem/chains";
import { dbPath, initSchema, openDatabase, projectDir, upsert } from "./db.js";

dotenv.config({ path: path.join(projectDir, "..", ".env"), quiet: true });
dotenv.config({ path: path.join(projectDir, ".env"), override: true, quiet: true });
delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;

const deploymentPath = path.join(
  projectDir,
  "deployments",
  "research-official-like-amoy.json",
);
const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
const chainId = Number(deployment.chainId);

if (chainId !== 80002) {
  throw new Error(`只同步 Polygon Amoy chainId=80002，当前部署记录为 ${chainId}`);
}

function readArtifact(contractName) {
  return JSON.parse(
    fs.readFileSync(path.join(projectDir, "artifacts", `${contractName}.json`), "utf8"),
  );
}

function amoyRpcUrls() {
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

const publicClient = createPublicClient({
  chain: polygonAmoy,
  transport: fallback(
    amoyRpcUrls().map((url) => http(url, { retryCount: 1, timeout: 10_000 })),
    { rank: false },
  ),
});
const logRpcUrls = [
  ...new Set([
    "https://polygon-amoy.drpc.org",
    ...amoyRpcUrls(),
  ]),
];
const logClients = logRpcUrls.map((url) => ({
  url,
  client: createPublicClient({
    chain: polygonAmoy,
    transport: http(url, { retryCount: 1, timeout: 12_000 }),
  }),
}));

const db = openDatabase();
initSchema(db);

const marketAbi = readArtifact("ResearchMarketRegistry").abi;
const walletCoinAbi = readArtifact("ResearchWalletCoin").abi;
const outcomeAbi = readArtifact("ResearchOutcomeToken").abi;
const exchangeAbi = readArtifact("ResearchCLOBExchange").abi;

const addressConfigs = [
  {
    address: getAddress(deployment.marketRegistry),
    contractName: "ResearchMarketRegistry",
    abi: marketAbi,
  },
  {
    address: getAddress(deployment.walletCoin),
    contractName: "ResearchWalletCoin",
    abi: walletCoinAbi,
  },
  {
    address: getAddress(deployment.outcomeToken),
    contractName: "ResearchOutcomeToken",
    abi: outcomeAbi,
  },
  ...(deployment.exchange
    ? [
        {
          address: getAddress(deployment.exchange),
          contractName: "ResearchCLOBExchange",
          abi: exchangeAbi,
        },
      ]
    : []),
];
const configByAddress = new Map(
  addressConfigs.map((config) => [config.address.toLowerCase(), config]),
);

function bigintJson(value) {
  return JSON.stringify(value, (_, item) =>
    typeof item === "bigint" ? item.toString() : item,
  );
}

function getSyncState() {
  return db
    .prepare("SELECT last_block FROM sync_state WHERE chain_id = ? AND name = ?")
    .get(chainId, "official-like-events");
}

function setSyncState(lastBlock) {
  upsert(
    db,
    `INSERT INTO sync_state(chain_id, name, last_block, updated_at)
     VALUES(:chainId, 'official-like-events', :lastBlock, CURRENT_TIMESTAMP)
     ON CONFLICT(chain_id, name) DO UPDATE SET
       last_block=excluded.last_block,
       updated_at=excluded.updated_at`,
    { chainId, lastBlock: Number(lastBlock) },
  );
}

async function initialFromBlock() {
  if (process.env.FROM_BLOCK) return BigInt(process.env.FROM_BLOCK);
  const txHashes = Object.values(deployment.txs ?? {}).filter(
    (hash) => typeof hash === "string" && hash.startsWith("0x"),
  );
  const receipts = await Promise.all(
    txHashes.map((hash) => publicClient.getTransactionReceipt({ hash })),
  );
  const minBlock = receipts.reduce(
    (lowest, receipt) => (receipt.blockNumber < lowest ? receipt.blockNumber : lowest),
    receipts[0]?.blockNumber ?? (await publicClient.getBlockNumber()),
  );
  return minBlock > 100n ? minBlock - 100n : 0n;
}

function upsertMarketFromEvent(event, txHash) {
  const args = event.args;
  upsert(
    db,
    `INSERT INTO markets(
       chain_id, market_id, creator, question, yes_token_id, no_token_id, close_time,
       status, winning_outcome, market_registry, created_tx, updated_at
     )
     VALUES(
       :chainId, :marketId, :creator, :question, :yesTokenId, :noTokenId, :closeTime,
       'OPEN', 0, :marketRegistry, :createdTx, CURRENT_TIMESTAMP
     )
     ON CONFLICT(chain_id, market_id) DO UPDATE SET
       creator=excluded.creator,
       question=excluded.question,
       yes_token_id=excluded.yes_token_id,
       no_token_id=excluded.no_token_id,
       market_registry=excluded.market_registry,
       created_tx=excluded.created_tx,
       updated_at=excluded.updated_at`,
    {
      chainId,
      marketId: args.marketId,
      creator: args.creator,
      question: args.question,
      yesTokenId: args.yesTokenId.toString(),
      noTokenId: args.noTokenId.toString(),
      closeTime: Number(args.closeTime),
      marketRegistry: deployment.marketRegistry,
      createdTx: txHash,
    },
  );
}

function closeMarketFromEvent(event) {
  upsert(
    db,
    `UPDATE markets
     SET status = 'CLOSED', updated_at = CURRENT_TIMESTAMP
     WHERE chain_id = :chainId AND market_id = :marketId`,
    {
      chainId,
      marketId: event.args.marketId,
    },
  );
}

function resolveMarketFromEvent(event) {
  upsert(
    db,
    `UPDATE markets
     SET status = 'RESOLVED', winning_outcome = :winningOutcome, updated_at = CURRENT_TIMESTAMP
     WHERE chain_id = :chainId AND market_id = :marketId`,
    {
      chainId,
      marketId: event.args.marketId,
      winningOutcome: Number(event.args.winningOutcome),
    },
  );
}

function upsertTradeFromEvent(event, txHash) {
  const args = event.args;
  upsert(
    db,
    `INSERT INTO trades(
       chain_id, tx_hash, market_id, buyer, seller, token_id,
       outcome_amount, collateral_amount, raw_json
     )
     VALUES(
       :chainId, :txHash, :marketId, :buyer, :seller, :tokenId,
       :outcomeAmount, :collateralAmount, :rawJson
     )
     ON CONFLICT(chain_id, tx_hash) DO UPDATE SET
       market_id=excluded.market_id,
       buyer=excluded.buyer,
       seller=excluded.seller,
       token_id=excluded.token_id,
       outcome_amount=excluded.outcome_amount,
       collateral_amount=excluded.collateral_amount,
       raw_json=excluded.raw_json`,
    {
      chainId,
      txHash,
      marketId: args.marketId,
      buyer: args.buyer,
      seller: args.seller,
      tokenId: args.tokenId.toString(),
      outcomeAmount: args.outcomeAmount.toString(),
      collateralAmount: args.walletCoinAmount.toString(),
      rawJson: bigintJson(args),
    },
  );
}

function upsertTradeFromOrdersMatched(event, txHash) {
  const args = event.args;
  const existing = db
    .prepare("SELECT buy_order_id, sell_order_id FROM trades WHERE chain_id = ? AND tx_hash = ?")
    .get(chainId, txHash);
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
      chainId,
      txHash,
      marketId: deployment.market.marketId,
      buyer: args.buyer,
      seller: args.seller,
      tokenId: args.tokenId.toString(),
      outcomeAmount: args.outcomeAmount.toString(),
      collateralAmount: args.collateralAmount.toString(),
      buyOrderId: existing?.buy_order_id ?? null,
      sellOrderId: existing?.sell_order_id ?? null,
      rawJson: bigintJson(args),
    },
  );
}

function updateOrderFromCancelled(event, txHash) {
  const args = event.args;
  const action = db
    .prepare("SELECT local_order_id FROM chain_actions WHERE chain_id = ? AND tx_hash = ?")
    .get(chainId, txHash);
  if (action?.local_order_id) {
    upsert(
      db,
      `UPDATE orders
       SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP
       WHERE chain_id = :chainId AND local_order_id = :localOrderId`,
      {
        chainId,
        localOrderId: action.local_order_id,
      },
    );
    return;
  }

  // Best-effort fallback for orders whose raw_json already contains the order hash.
  const candidates = db
    .prepare("SELECT chain_id, local_order_id, raw_json FROM orders WHERE chain_id = ?")
    .all(chainId);
  for (const candidate of candidates) {
    try {
      const raw = JSON.parse(candidate.raw_json);
      if (String(raw.orderHash).toLowerCase() === String(args.orderHash).toLowerCase()) {
        upsert(
          db,
          `UPDATE orders
           SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP
           WHERE chain_id = :chainId AND local_order_id = :localOrderId`,
          {
            chainId,
            localOrderId: candidate.local_order_id,
          },
        );
      }
    } catch {
      // Ignore non-JSON rows.
    }
  }
}

function saveEvent(log, decoded, config) {
  upsert(
    db,
    `INSERT INTO chain_events(
       chain_id, tx_hash, block_number, log_index, event_name, contract_address, args_json
     )
     VALUES(
       :chainId, :txHash, :blockNumber, :logIndex, :eventName, :contractAddress, :argsJson
     )
     ON CONFLICT(chain_id, tx_hash, log_index) DO UPDATE SET
       block_number=excluded.block_number,
       event_name=excluded.event_name,
       contract_address=excluded.contract_address,
       args_json=excluded.args_json`,
    {
      chainId,
      txHash: log.transactionHash,
      blockNumber: Number(log.blockNumber),
      logIndex: Number(log.logIndex),
      eventName: decoded.eventName,
      contractAddress: config.address,
      argsJson: bigintJson(decoded.args),
    },
  );

  if (decoded.eventName === "MarketPublished") {
    upsertMarketFromEvent(decoded, log.transactionHash);
  } else if (decoded.eventName === "MarketClosed") {
    closeMarketFromEvent(decoded);
  } else if (decoded.eventName === "MarketResolved") {
    resolveMarketFromEvent(decoded);
  } else if (decoded.eventName === "TradeExecuted") {
    upsertTradeFromEvent(decoded, log.transactionHash);
  } else if (decoded.eventName === "OrdersMatched") {
    upsertTradeFromOrdersMatched(decoded, log.transactionHash);
  } else if (decoded.eventName === "OrderCancelled") {
    updateOrderFromCancelled(decoded, log.transactionHash);
  }
}

async function getLogsReliable(params) {
  const attempts = Number(process.env.SYNC_RPC_ATTEMPTS ?? "3");
  let lastError;
  const addresses = Array.isArray(params.address) ? params.address : [params.address];
  const allLogs = [];
  for (const address of addresses) {
    const logs = await getLogsForAddressReliable({
      address,
      fromBlock: params.fromBlock,
      toBlock: params.toBlock,
    });
    allLogs.push(...logs);
  }
  return allLogs.sort((a, b) => {
    const blockDiff = Number(BigInt(a.blockNumber) - BigInt(b.blockNumber));
    if (blockDiff !== 0) return blockDiff;
    return Number(BigInt(a.logIndex) - BigInt(b.logIndex));
  });
}

async function getLogsForAddressReliable(params) {
  const attempts = Number(process.env.SYNC_RPC_ATTEMPTS ?? "3");
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const messages = [];
    for (const { url, client } of logClients) {
      try {
        return await client.request({
          method: "eth_getLogs",
          params: [
            {
              address: params.address,
              fromBlock: toHex(params.fromBlock),
              toBlock: toHex(params.toBlock),
            },
          ],
        });
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        messages.push(`rpc=${url} ${message.split("\n")[0]}`);
      }
    }
    console.warn(`getLogs 本轮 RPC 均失败 attempt=${attempt}/${attempts}：${messages.join(" | ")}`);
    await new Promise((resolve) => setTimeout(resolve, 750 * attempt));
  }
  throw lastError;
}

async function syncKnownTransactions() {
  const deploymentTxHashes = Object.values(deployment.txs ?? {}).filter(
    (hash) => typeof hash === "string" && hash.startsWith("0x"),
  );
  const tradeTxHashes = db
    .prepare("SELECT tx_hash FROM trades WHERE chain_id = ? AND tx_hash LIKE '0x%'")
    .all(chainId)
    .map((row) => row.tx_hash);
  const actionTxHashes = db
    .prepare("SELECT tx_hash FROM chain_actions WHERE chain_id = ? AND tx_hash LIKE '0x%'")
    .all(chainId)
    .map((row) => row.tx_hash);
  const txHashes = [...new Set([...deploymentTxHashes, ...tradeTxHashes, ...actionTxHashes])];
  let decodedCount = 0;

  const selectedAddresses = addressConfigs.map((config) => config.address.toLowerCase());
  const placeholders = selectedAddresses.map(() => "?").join(", ");
  db.prepare(
    `DELETE FROM chain_events
     WHERE chain_id = ?
       AND lower(contract_address) IN (${placeholders})`,
  ).run(chainId, ...selectedAddresses);

  for (const txHash of txHashes) {
    const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
    for (const log of receipt.logs) {
      const config = configByAddress.get(log.address.toLowerCase());
      if (!config) continue;
      try {
        const decoded = decodeEventLog({
          abi: config.abi,
          data: log.data,
          topics: log.topics,
          strict: false,
        });
        saveEvent(log, decoded, config);
        decodedCount += 1;
      } catch {
        // Ignore logs that do not belong to the ABI we selected.
      }
    }
  }

  const latestBlock = await publicClient.getBlockNumber();
  setSyncState(latestBlock);
  console.log(`已同步已知交易 ${txHashes.length} 笔，解析事件 ${decodedCount} 条`);
  console.log(`sync_state 已更新到 latestBlock=${latestBlock}`);
  console.log(`数据库：${dbPath}`);
}

if (process.env.FULL_SYNC !== "true") {
  await syncKnownTransactions();
  db.close();
  process.exit(0);
}

const state = getSyncState();
const chainLatestBlock = await publicClient.getBlockNumber();
let fromBlock = state ? BigInt(state.last_block) + 1n : await initialFromBlock();
let synced = 0;
let decodedCount = 0;
const chunkSize = BigInt(process.env.SYNC_CHUNK_SIZE ?? "2000");
const maxBlocksPerRun = BigInt(process.env.SYNC_MAX_BLOCKS_PER_RUN ?? "0");
const latestBlock =
  maxBlocksPerRun > 0n && fromBlock + maxBlocksPerRun - 1n < chainLatestBlock
    ? fromBlock + maxBlocksPerRun - 1n
    : chainLatestBlock;

if (fromBlock > chainLatestBlock) {
  console.log(`已是最新：last_block=${state.last_block}, latest=${chainLatestBlock}`);
  db.close();
  process.exit(0);
}

console.log(`同步 Amoy 事件：fromBlock=${fromBlock} toBlock=${latestBlock} chainLatest=${chainLatestBlock}`);

while (fromBlock <= latestBlock) {
  const toBlock = fromBlock + chunkSize - 1n > latestBlock
    ? latestBlock
    : fromBlock + chunkSize - 1n;
  const logs = await getLogsReliable({
    address: addressConfigs.map((config) => config.address),
    fromBlock,
    toBlock,
  });

  for (const log of logs) {
    const config = configByAddress.get(log.address.toLowerCase());
    if (!config) continue;
    try {
      const decoded = decodeEventLog({
        abi: config.abi,
        data: log.data,
        topics: log.topics,
        strict: false,
      });
      saveEvent(log, decoded, config);
      decodedCount += 1;
    } catch {
      // Ignore logs that do not belong to the ABI we selected.
    }
  }

  setSyncState(toBlock);
  synced += logs.length;
  console.log(`区块 ${fromBlock}-${toBlock}：读取 ${logs.length} 条 logs，已解析 ${decodedCount} 条`);
  fromBlock = toBlock + 1n;
}

db.close();
console.log(`同步完成：读取 logs=${synced}，解析事件=${decodedCount}`);
console.log(`数据库：${dbPath}`);
