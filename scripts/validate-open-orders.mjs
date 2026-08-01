import { loadExchangeConfig } from "./exchange-config.mjs";
import { openResearchDb } from "./order-utils.mjs";
import { validateSignedOrder } from "./order-validation.mjs";

const deployment = loadExchangeConfig({ requireMarket: true });
const db = openResearchDb();
const orders = db.prepare(
  `SELECT *
   FROM orders
   WHERE signature IS NOT NULL
     AND status IN ('OPEN', 'PARTIALLY_FILLED')
   ORDER BY updated_at ASC`,
).all();
const results = [];

try {
  for (const order of orders) {
    try {
      const validation = await validateSignedOrder(deployment, order);
      db.prepare(
        `UPDATE orders
         SET validation_status = :status,
             validation_error = NULL,
             validated_at = :validatedAt
         WHERE chain_id = :chainId AND local_order_id = :localOrderId`,
      ).run({
        status: validation.status,
        validatedAt: validation.validatedAt,
        chainId: order.chain_id,
        localOrderId: order.local_order_id,
      });
      results.push({
        localOrderId: order.local_order_id,
        status: validation.status,
      });
    } catch (error) {
      const message =
        error?.validationError ??
        (error instanceof Error ? error.message : String(error));
      db.prepare(
        `UPDATE orders
         SET validation_status = 'INVALID',
             validation_error = :error,
             validated_at = :validatedAt
         WHERE chain_id = :chainId AND local_order_id = :localOrderId`,
      ).run({
        error: message,
        validatedAt: new Date().toISOString(),
        chainId: order.chain_id,
        localOrderId: order.local_order_id,
      });
      results.push({
        localOrderId: order.local_order_id,
        status: "INVALID",
        error: message,
      });
    }
  }
} finally {
  db.close();
}

console.log(
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      exchange: deployment.exchange,
      checked: results.length,
      valid: results.filter((result) => result.status === "VALID").length,
      invalid: results.filter((result) => result.status === "INVALID").length,
      results,
      writesPerformed: "local-database-only",
    },
    null,
    2,
  ),
);
