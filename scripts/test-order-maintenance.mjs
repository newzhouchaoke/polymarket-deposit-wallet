import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { initSchema } from "./db.js";
import { expireOrders, orderStats } from "./order-maintenance.mjs";

const db = new DatabaseSync(":memory:");
db.exec("PRAGMA foreign_keys = ON");
initSchema(db);
db.prepare(
  `INSERT INTO markets(
     chain_id, market_id, creator, question, yes_token_id, no_token_id,
     close_time, status, market_registry
   )
   VALUES(80002, 'market', '', 'test', '1', '2', 0, 'OPEN', '')`,
).run();
const insert = db.prepare(
  `INSERT INTO orders(
     chain_id, local_order_id, market_id, maker, signer, side, token_id,
     maker_amount, taker_amount, price_micros, status, expiration, salt,
     validation_status, raw_json
   )
   VALUES(
     80002, :id, 'market',
     '0x0000000000000000000000000000000000000001',
     '0x0000000000000000000000000000000000000001',
     :side, :tokenId, '1000', '1000', 500000, :status, :expiration, :id,
     :validationStatus, '{}'
   )`,
);
insert.run({
  id: "one",
  status: "OPEN",
  side: "BUY",
  tokenId: "1",
  expiration: 100,
  validationStatus: "VALID",
});
insert.run({
  id: "two",
  status: "PARTIALLY_FILLED",
  side: "SELL",
  tokenId: "1",
  expiration: 200,
  validationStatus: "LOCALLY_SIGNED",
});
insert.run({
  id: "three",
  status: "OPEN",
  side: "BUY",
  tokenId: "1",
  expiration: 0,
  validationStatus: "UNSIGNED",
});
insert.run({
  id: "four",
  status: "CANCELLED",
  side: "SELL",
  tokenId: "1",
  expiration: 50,
  validationStatus: "VALID",
});

assert.equal(expireOrders(db, 150), 1);
assert.equal(expireOrders(db, 250), 1);
assert.equal(expireOrders(db, 250), 0);

const stats = orderStats(db);
assert.deepEqual(
  Object.fromEntries(stats.byStatus.map((row) => [row.status, row.count])),
  { CANCELLED: 1, EXPIRED: 2, OPEN: 1 },
);
assert.deepEqual(
  Object.fromEntries(stats.byValidation.map((row) => [row.validationStatus, row.count])),
  { LOCALLY_SIGNED: 1, UNSIGNED: 1, VALID: 2 },
);
assert.equal(
  db.prepare(
    "SELECT COUNT(*) AS count FROM order_reservations WHERE status = 'ACTIVE'",
  ).get().count,
  1,
);

db.close();
console.log("order expiry, reservation release, and statistics tests passed");
