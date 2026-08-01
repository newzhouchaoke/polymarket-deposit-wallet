import { initSchema, openDatabase } from "./db.js";
import { loadExchangeConfig } from "./exchange-config.mjs";
import { auditActiveReservations } from "./order-risk.mjs";

const db = openDatabase();
try {
  initSchema(db);
  const runtime = loadExchangeConfig({ requireMarket: true });
  const result = await auditActiveReservations(db, runtime);
  console.log(JSON.stringify(result, null, 2));
  if (result.overcommitted > 0 || result.checkFailed > 0) {
    process.exitCode = 2;
  }
} finally {
  db.close();
}
