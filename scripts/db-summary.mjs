import { dbPath, initSchema, openDatabase } from "./db.js";

const db = openDatabase();
initSchema(db);

function all(sql, params = {}) {
  return db.prepare(sql).all(params);
}

function count(table) {
  return db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
}

console.log(`数据库：${dbPath}`);
console.log(
  JSON.stringify(
    {
      contracts: count("contracts"),
      wallets: count("wallets"),
      markets: count("markets"),
      orders: count("orders"),
      orderReservations: count("order_reservations"),
      trades: count("trades"),
      tokenBalances: count("token_balances"),
      chainEvents: count("chain_events"),
    },
    null,
    2,
  ),
);

console.log("\nMarkets");
console.table(
  all(`SELECT chain_id, market_id, creator, question, status, winning_outcome, yes_token_id, no_token_id FROM markets`),
);

console.log("\nOrders");
console.table(
  all(`SELECT local_order_id, side, maker, token_id, maker_amount, taker_amount, price_micros, status FROM orders`),
);

console.log("\nReservations");
console.table(
  all(
    `SELECT local_order_id, wallet_address, asset_type, token_id,
            reserved_amount, status, release_reason
     FROM order_reservations
     ORDER BY updated_at DESC`,
  ),
);

console.log("\nTrades");
console.table(
  all(`SELECT tx_hash, buyer, seller, token_id, outcome_amount, collateral_amount FROM trades`),
);

console.log("\nBalances");
console.table(
  all(`SELECT wallet_address, token_symbol, token_id, balance_decimal FROM token_balances ORDER BY wallet_address, token_symbol`),
);

db.close();
