import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { initSchema } from "./db.js";
import {
  auditActiveReservations,
  assertReservationCapacity,
  readChainCapacity,
  reservationSpec,
  reservationSummary,
  syncOrderReservation,
} from "./order-risk.mjs";

const maker = "0x0000000000000000000000000000000000000001";
const exchange = "0x0000000000000000000000000000000000000002";
const collateral = "0x0000000000000000000000000000000000000003";
const ctf = "0x0000000000000000000000000000000000000004";
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
     maker_amount, taker_amount, filled_maker_amount, filled_taker_amount,
     price_micros, status, expiration, salt, validation_status, raw_json
   )
   VALUES(
     80002, :id, 'market', :maker, :maker, :side, :tokenId,
     :makerAmount, :takerAmount, '0', '0', 500000, 'OPEN', 0, :id,
     'VALID', '{}'
   )`,
);
insert.run({
  id: "buy-1",
  maker,
  side: "BUY",
  tokenId: "1",
  makerAmount: "600",
  takerAmount: "1000",
});
const first = syncOrderReservation(db, "buy-1", 80002);
assert.equal(first.assetType, "COLLATERAL");
assert.equal(first.reservedAmount, 600n);

const candidate = reservationSpec({
  chain_id: 80002,
  local_order_id: "buy-2",
  maker,
  side: "BUY",
  token_id: "1",
  maker_amount: "500",
  filled_maker_amount: "0",
  status: "OPEN",
});
assert.throws(
  () => assertReservationCapacity(db, candidate, 1000n),
  (error) =>
    error.statusCode === 422 &&
    error.code === "ORDER_RISK_REJECTED" &&
    error.details.available === "400",
);
const allowed = assertReservationCapacity(
  db,
  { ...candidate, reservedAmount: 400n },
  1000n,
);
assert.equal(allowed.availableAfterOrder, "0");

db.prepare(
  `UPDATE orders
   SET filled_maker_amount = '250', status = 'PARTIALLY_FILLED'
   WHERE local_order_id = 'buy-1'`,
).run();
syncOrderReservation(db, "buy-1", 80002);
assert.equal(
  reservationSummary(db, maker).totals[0].reservedAmount,
  "350",
);
db.prepare(
  "UPDATE orders SET status = 'CANCELLED' WHERE local_order_id = 'buy-1'",
).run();
syncOrderReservation(db, "buy-1", 80002);
assert.equal(reservationSummary(db, maker).totals.length, 0);

const runtime = { exchange, collateral, ctf };
const buyCapacity = await readChainCapacity(
  runtime,
  { ...candidate, walletAddress: maker, assetType: "COLLATERAL" },
  {
    readContract: async ({ functionName }) =>
      functionName === "balanceOf" ? 1000n : 800n,
  },
);
assert.equal(buyCapacity.capacity, 800n);
assert.equal(buyCapacity.allowance, 800n);

const sellCapacity = await readChainCapacity(
  runtime,
  {
    ...candidate,
    walletAddress: maker,
    assetType: "OUTCOME",
    tokenId: "1",
  },
  {
    readContract: async ({ functionName }) =>
      functionName === "balanceOf" ? 20n : false,
  },
);
assert.equal(sellCapacity.capacity, 0n);
assert.equal(sellCapacity.approvedForAll, false);

insert.run({
  id: "buy-2",
  maker,
  side: "BUY",
  tokenId: "1",
  makerAmount: "600",
  takerAmount: "1000",
});
insert.run({
  id: "buy-3",
  maker,
  side: "BUY",
  tokenId: "1",
  makerAmount: "500",
  takerAmount: "1000",
});
const audit = await auditActiveReservations(db, runtime, {
  readContract: async ({ functionName }) =>
    functionName === "balanceOf" ? 1000n : 1000n,
});
assert.equal(audit.groups, 1);
assert.equal(audit.covered, 1);
assert.equal(audit.overcommitted, 1);
assert.equal(
  db.prepare(
    `SELECT risk_status FROM order_reservations
     WHERE local_order_id = 'buy-2'`,
  ).get().risk_status,
  "COVERED",
);
assert.equal(
  db.prepare(
    `SELECT risk_status FROM order_reservations
     WHERE local_order_id = 'buy-3'`,
  ).get().risk_status,
  "OVERCOMMITTED",
);
const failedAudit = await auditActiveReservations(db, runtime, {
  readContract: async () => {
    throw new Error("rpc unavailable");
  },
});
assert.equal(failedAudit.checkFailed, 2);
assert.equal(
  db.prepare(
    `SELECT COUNT(*) AS count FROM order_reservations
     WHERE risk_status = 'CHECK_FAILED'`,
  ).get().count,
  2,
);

db.close();
console.log("order reservation, live audit, and chain capacity tests passed");
