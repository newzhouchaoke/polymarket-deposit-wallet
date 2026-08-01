import { syncAllReservations } from "./order-risk.mjs";

export function expireOrders(db, nowSeconds = Math.floor(Date.now() / 1000)) {
  const result = db.prepare(
    `UPDATE orders
     SET status = 'EXPIRED', updated_at = CURRENT_TIMESTAMP
     WHERE status IN ('OPEN', 'PARTIALLY_FILLED', 'USER_PAUSED')
       AND expiration > 0
       AND expiration <= :nowSeconds`,
  ).run({ nowSeconds });
  if (Number(result.changes ?? 0) > 0) syncAllReservations(db);
  return Number(result.changes ?? 0);
}

export function orderStats(db) {
  const byStatus = db.prepare(
    `SELECT status, COUNT(*) AS count
     FROM orders
     GROUP BY status
     ORDER BY status`,
  ).all();
  const bySide = db.prepare(
    `SELECT side, COUNT(*) AS count
     FROM orders
     GROUP BY side
     ORDER BY side`,
  ).all();
  const byValidation = db.prepare(
    `SELECT validation_status AS validationStatus, COUNT(*) AS count
     FROM orders
     GROUP BY validation_status
     ORDER BY validation_status`,
  ).all();
  return { byStatus, bySide, byValidation };
}
