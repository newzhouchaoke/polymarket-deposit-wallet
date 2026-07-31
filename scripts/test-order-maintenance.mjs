import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { expireOrders, orderStats } from "./order-maintenance.mjs";

const db = new DatabaseSync(":memory:");
db.exec(`
  CREATE TABLE orders (
    status TEXT NOT NULL,
    side TEXT NOT NULL,
    expiration INTEGER NOT NULL,
    validation_status TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);
const insert = db.prepare(
  `INSERT INTO orders(status, side, expiration, validation_status)
   VALUES(:status, :side, :expiration, :validationStatus)`,
);
insert.run({
  status: "OPEN",
  side: "BUY",
  expiration: 100,
  validationStatus: "VALID",
});
insert.run({
  status: "PARTIALLY_FILLED",
  side: "SELL",
  expiration: 200,
  validationStatus: "LOCALLY_SIGNED",
});
insert.run({
  status: "OPEN",
  side: "BUY",
  expiration: 0,
  validationStatus: "UNSIGNED",
});
insert.run({
  status: "CANCELLED",
  side: "SELL",
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

db.close();
console.log("order expiry and statistics tests passed");
