import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { initSchema } from "./db.js";
import {
  bestMatch,
  bestPair,
  collateralForOutcome,
  feeForCashValue,
} from "./matcher-core.mjs";

const db = new DatabaseSync(":memory:");
initSchema(db);
db.prepare(
  `INSERT INTO markets(
     chain_id, market_id, question, yes_token_id, no_token_id,
     close_time, market_registry
   ) VALUES(80002, 'market-1', 'multi maker test', '1', '2', 0, 'exchange')`,
).run();

function insertOrder(id, side, makerAmount, takerAmount, priceMicros, age) {
  db.prepare(
    `INSERT INTO orders(
       chain_id, local_order_id, market_id, maker, signer, side, token_id,
       maker_amount, taker_amount, price_micros, status, salt, signature,
       raw_json, updated_at
     ) VALUES(
       80002, :id, 'market-1', :maker, :maker, :side, '1',
       :makerAmount, :takerAmount, :priceMicros, 'OPEN', :salt, '0x01',
       '{}', :updatedAt
     )`,
  ).run({
    id,
    maker: `0x${age.toString(16).padStart(40, "0")}`,
    side,
    makerAmount: String(makerAmount),
    takerAmount: String(takerAmount),
    priceMicros,
    salt: String(age),
    updatedAt: `2026-01-01T00:00:0${age}.000Z`,
  });
}

insertOrder("buy", "BUY", 1_200_000, 2_000_000, 600_000, 1);
insertOrder("sell-a", "SELL", 500_000, 250_000, 500_000, 2);
insertOrder("sell-b", "SELL", 800_000, 440_000, 550_000, 3);
insertOrder("sell-c", "SELL", 1_000_000, 580_000, 580_000, 4);
insertOrder("sell-too-expensive", "SELL", 1_000_000, 700_000, 700_000, 5);

const match = bestMatch(db, 5);
assert.equal(match.buy.local_order_id, "buy");
assert.deepEqual(
  match.makers.map(({ sell }) => sell.local_order_id),
  ["sell-a", "sell-b", "sell-c"],
);
assert.equal(
  match.makers.reduce((sum, item) => sum + item.outcomeAmount, 0n),
  2_000_000n,
);
assert.equal(
  match.makers.reduce((sum, item) => sum + item.collateralAmount, 0n),
  1_096_000n,
);
assert.equal(collateralForOutcome(match.makers[2].sell, 700_000n), 406_000n);
assert.equal(feeForCashValue(1_096_000n, 50), 5_480n);
assert.equal(feeForCashValue(250_000n, 0), 0n);
assert.throws(() => feeForCashValue(1_000n, 10_000), /0-9999/);

const pair = bestPair(db);
assert.equal(pair.buy.local_order_id, "buy");
assert.equal(pair.sell.local_order_id, "sell-a");

db.close();
console.log("matcher-core multi-maker tests passed");
