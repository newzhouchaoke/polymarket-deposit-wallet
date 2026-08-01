import fs from "node:fs";
import path from "node:path";
import { dbPath, initSchema, openDatabase, projectDir, upsert } from "./db.js";

const deploymentPath = path.join(
  projectDir,
  "deployments",
  "research-v2-amoy.json",
);

if (!fs.existsSync(deploymentPath)) {
  throw new Error(`缺少部署记录：${deploymentPath}`);
}

const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
const db = openDatabase();
initSchema(db);

const chainId = Number(deployment.chainId);
const now = new Date().toISOString();

function insertContract(name, address, role, createdTx = null, notes = "") {
  upsert(
    db,
    `INSERT INTO contracts(chain_id, name, address, role, created_tx, notes, updated_at)
     VALUES(:chainId, :name, :address, :role, :createdTx, :notes, :updatedAt)
     ON CONFLICT(chain_id, name) DO UPDATE SET
       address=excluded.address,
       role=excluded.role,
       created_tx=excluded.created_tx,
       notes=excluded.notes,
       updated_at=excluded.updated_at`,
    { chainId, name, address, role, createdTx, notes, updatedAt: now },
  );
}

function insertWallet(walletRole, walletAddress, walletType, createdTx = null) {
  upsert(
    db,
    `INSERT INTO wallets(chain_id, wallet_address, owner_address, wallet_role, wallet_type, created_tx, updated_at)
     VALUES(:chainId, :walletAddress, :ownerAddress, :walletRole, :walletType, :createdTx, :updatedAt)
     ON CONFLICT(chain_id, wallet_address) DO UPDATE SET
       owner_address=excluded.owner_address,
       wallet_role=excluded.wallet_role,
       wallet_type=excluded.wallet_type,
       created_tx=excluded.created_tx,
       updated_at=excluded.updated_at`,
    {
      chainId,
      walletAddress,
      ownerAddress: deployment.owner,
      walletRole,
      walletType,
      createdTx,
      updatedAt: now,
    },
  );
}

function sideName(side) {
  return Number(side) === 0 ? "BUY" : "SELL";
}

function priceMicros(order) {
  const maker = BigInt(order.makerAmount);
  const taker = BigInt(order.takerAmount);
  if (Number(order.side) === 0) {
    return Number((maker * 1_000_000n) / taker);
  }
  return Number((taker * 1_000_000n) / maker);
}

function insertOrder(localOrderId, order, status) {
  const filledMakerAmount = status === "FILLED" ? order.makerAmount : "0";
  const filledTakerAmount = status === "FILLED" ? order.takerAmount : "0";
  upsert(
    db,
    `INSERT INTO orders(
       chain_id, local_order_id, market_id, maker, signer, side, token_id,
       maker_amount, taker_amount, filled_maker_amount, filled_taker_amount,
       price_micros, status, expiration, salt, signature, raw_json, updated_at
     )
     VALUES(
       :chainId, :localOrderId, :marketId, :maker, :signer, :side, :tokenId,
       :makerAmount, :takerAmount, :filledMakerAmount, :filledTakerAmount,
       :priceMicros, :status, :expiration, :salt, :signature, :rawJson, :updatedAt
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
       raw_json=excluded.raw_json,
       updated_at=excluded.updated_at`,
    {
      chainId,
      localOrderId,
      marketId: deployment.market.marketId,
      maker: order.maker,
      signer: order.signer,
      side: sideName(order.side),
      tokenId: order.tokenId,
      makerAmount: order.makerAmount,
      takerAmount: order.takerAmount,
      filledMakerAmount,
      filledTakerAmount,
      priceMicros: priceMicros(order),
      status,
      expiration: Number(order.expiration ?? 0),
      salt: order.salt,
      signature: order.signature ?? null,
      rawJson: JSON.stringify(order),
      updatedAt: now,
    },
  );
}

insertContract("ResearchWalletCoin", deployment.walletCoin, "collateral token", null, "rWALLET");
insertContract("ResearchOutcomeToken", deployment.outcomeToken, "conditional tokens", null, "ERC-1155 YES/NO with split, merge and redeem");
insertContract("ResearchMarketRegistry", deployment.marketRegistry, "market hub", deployment.txs.publishTx, "Publishes markets and lifecycle events");
insertContract("ResearchDepositWalletFactory", deployment.walletFactory, "wallet factory", deployment.txs.createWalletTx, "CREATE2 ERC-1967 BeaconProxy wallet factory");
if (deployment.exchange) {
  insertContract(
    "ResearchCLOBExchange",
    deployment.exchange,
    "exchange",
    deployment.txs.deployExchangeTx ?? deployment.txs.matchTx,
    "V2-style EIP-712 orders, one-to-many matching, complementary/mint/merge settlement",
  );
}

insertWallet("buyer", deployment.buyerWallet, "ResearchDepositWallet", deployment.txs.createWalletTx);
insertWallet("seller", deployment.sellerWallet, "EOA");

upsert(
  db,
  `INSERT INTO markets(
     chain_id, market_id, creator, question, yes_token_id, no_token_id, close_time,
     status, winning_outcome, market_registry, created_tx, updated_at
   )
   VALUES(
     :chainId, :marketId, :creator, :question, :yesTokenId, :noTokenId, :closeTime,
     'OPEN', 0, :marketRegistry, :createdTx, :updatedAt
   )
   ON CONFLICT(chain_id, market_id) DO UPDATE SET
     creator=excluded.creator,
     question=excluded.question,
     yes_token_id=excluded.yes_token_id,
     no_token_id=excluded.no_token_id,
     close_time=excluded.close_time,
     status=excluded.status,
     winning_outcome=excluded.winning_outcome,
     market_registry=excluded.market_registry,
     created_tx=excluded.created_tx,
     updated_at=excluded.updated_at`,
  {
    chainId,
    marketId: deployment.market.marketId,
    creator: deployment.owner,
    question: deployment.market.question,
    yesTokenId: deployment.market.yesTokenId,
    noTokenId: deployment.market.noTokenId,
    closeTime: Number(deployment.market.closeTime),
    marketRegistry: deployment.marketRegistry,
    createdTx: deployment.txs.publishTx,
    updatedAt: now,
  },
);

insertOrder("research-buy-order", deployment.orders.buyOrder, "PARTIALLY_FILLED");
insertOrder("research-sell-order", deployment.orders.sellOrder, "FILLED");

upsert(
  db,
  `INSERT INTO trades(
     chain_id, tx_hash, market_id, buyer, seller, token_id,
     outcome_amount, collateral_amount, buy_order_id, sell_order_id, raw_json
   )
   VALUES(
     :chainId, :txHash, :marketId, :buyer, :seller, :tokenId,
     :outcomeAmount, :collateralAmount, 'research-buy-order', 'research-sell-order', :rawJson
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
    txHash: deployment.txs.matchTx,
    marketId: deployment.market.marketId,
    buyer: deployment.buyerWallet,
    seller: deployment.sellerWallet,
    tokenId: deployment.market.yesTokenId,
    outcomeAmount: deployment.orders.sellOrder.makerAmount,
    collateralAmount: deployment.orders.sellOrder.takerAmount,
    rawJson: JSON.stringify({
      txs: deployment.txs,
      finalBalances: deployment.finalBalances,
    }),
  },
);

const balances = [
  [deployment.buyerWallet, "rWALLET", "", deployment.finalBalances.buyerRWALLET],
  [deployment.sellerWallet, "rWALLET", "", deployment.finalBalances.sellerRWALLET],
  [deployment.buyerWallet, "YES", deployment.market.yesTokenId, deployment.finalBalances.buyerYES],
  [deployment.sellerWallet, "YES", deployment.market.yesTokenId, deployment.finalBalances.sellerYES],
  [deployment.sellerWallet, "NO", deployment.market.noTokenId, deployment.finalBalances.sellerNO],
];

for (const [walletAddress, tokenSymbol, tokenId, balanceDecimal] of balances) {
  upsert(
    db,
    `INSERT INTO token_balances(
       chain_id, wallet_address, token_symbol, token_id, balance_decimal, source_tx, updated_at
     )
     VALUES(:chainId, :walletAddress, :tokenSymbol, :tokenId, :balanceDecimal, :sourceTx, :updatedAt)
     ON CONFLICT(chain_id, wallet_address, token_symbol, token_id) DO UPDATE SET
       balance_decimal=excluded.balance_decimal,
       source_tx=excluded.source_tx,
       updated_at=excluded.updated_at`,
    {
      chainId,
      walletAddress,
      tokenSymbol,
      tokenId,
      balanceDecimal,
      sourceTx: deployment.txs.matchTx,
      updatedAt: now,
    },
  );
}

const events = [
  ["MarketPublished", deployment.marketRegistry, deployment.txs.publishTx, deployment.market],
  ["PositionSplit", deployment.outcomeToken, deployment.txs.splitTx, {
    stakeholder: deployment.sellerWallet,
    conditionId: deployment.market.conditionId,
    amount: "10000000",
  }],
  ["OrdersMatched", deployment.exchange, deployment.txs.matchTx, {
    marketId: deployment.market.marketId,
    buyer: deployment.buyerWallet,
    seller: deployment.sellerWallet,
    tokenId: deployment.market.yesTokenId,
    outcomeAmount: deployment.orders.sellOrder.makerAmount,
    collateralAmount: deployment.orders.sellOrder.takerAmount,
  }],
];

for (const [eventName, contractAddress, txHash, args] of events) {
  if (!txHash || txHash === "already-approved") continue;
  const logIndex = events.findIndex(
    ([name, address, hash]) => name === eventName && address === contractAddress && hash === txHash,
  );
  upsert(
    db,
    `INSERT INTO chain_events(chain_id, tx_hash, block_number, log_index, event_name, contract_address, args_json)
     VALUES(:chainId, :txHash, 0, :logIndex, :eventName, :contractAddress, :argsJson)
     ON CONFLICT(chain_id, tx_hash, log_index) DO UPDATE SET
       event_name=excluded.event_name,
       contract_address=excluded.contract_address,
       args_json=excluded.args_json`,
    {
      chainId,
      txHash,
      logIndex,
      eventName,
      contractAddress,
      argsJson: JSON.stringify(args),
    },
  );
}

db.close();

console.log(`已导入研究部署记录：${deploymentPath}`);
console.log(`数据库：${dbPath}`);
