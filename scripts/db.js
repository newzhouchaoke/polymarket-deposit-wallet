import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import dotenv from "dotenv";

export const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const dbDir = path.join(projectDir, "data");
dotenv.config({ path: path.join(projectDir, "..", ".env"), quiet: true });
dotenv.config({ path: path.join(projectDir, ".env"), override: true, quiet: true });

export const dbMode =
  String(process.env.EXCHANGE_MODE ?? "research").trim().toLowerCase() === "official-v2"
    ? "official-v2"
    : "research";
export const dbPath = process.env.POLYMARKET_DB_PATH
  ? path.resolve(process.env.POLYMARKET_DB_PATH)
  : path.join(
      dbDir,
      dbMode === "official-v2"
        ? "official-v2-polymarket.sqlite"
        : "research-polymarket.sqlite",
    );

export function openDatabase() {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA journal_mode = WAL;");
  return db;
}

export function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS contracts (
      chain_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      address TEXT NOT NULL,
      role TEXT NOT NULL,
      created_tx TEXT,
      notes TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (chain_id, name)
    );

    CREATE TABLE IF NOT EXISTS wallets (
      chain_id INTEGER NOT NULL,
      wallet_address TEXT NOT NULL,
      owner_address TEXT NOT NULL,
      wallet_role TEXT NOT NULL,
      wallet_type TEXT NOT NULL,
      created_tx TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (chain_id, wallet_address)
    );

    CREATE TABLE IF NOT EXISTS markets (
      chain_id INTEGER NOT NULL,
      market_id TEXT NOT NULL,
      creator TEXT NOT NULL DEFAULT '',
      question TEXT NOT NULL,
      yes_token_id TEXT NOT NULL,
      no_token_id TEXT NOT NULL,
      close_time INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'OPEN',
      winning_outcome INTEGER NOT NULL DEFAULT 0,
      question_id TEXT,
      condition_id TEXT,
      oracle TEXT,
      close_tx TEXT,
      resolve_tx TEXT,
      payout_denominator TEXT NOT NULL DEFAULT '0',
      market_registry TEXT NOT NULL,
      created_tx TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (chain_id, market_id)
    );

    CREATE TABLE IF NOT EXISTS orders (
      chain_id INTEGER NOT NULL,
      local_order_id TEXT NOT NULL,
      market_id TEXT NOT NULL,
      maker TEXT NOT NULL,
      signer TEXT NOT NULL,
      side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
      token_id TEXT NOT NULL,
      maker_amount TEXT NOT NULL,
      taker_amount TEXT NOT NULL,
      filled_maker_amount TEXT NOT NULL DEFAULT '0',
      filled_taker_amount TEXT NOT NULL DEFAULT '0',
      price_micros INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'OPEN',
      expiration INTEGER NOT NULL DEFAULT 0,
      salt TEXT NOT NULL,
      signature TEXT,
      order_hash TEXT,
      preapproved INTEGER NOT NULL DEFAULT 0,
      invalidated INTEGER NOT NULL DEFAULT 0,
      last_chain_tx TEXT,
      validation_status TEXT NOT NULL DEFAULT 'UNVERIFIED',
      validation_error TEXT,
      validated_at TEXT,
      raw_json TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (chain_id, local_order_id),
      FOREIGN KEY (chain_id, market_id) REFERENCES markets(chain_id, market_id)
    );

    CREATE TABLE IF NOT EXISTS trades (
      chain_id INTEGER NOT NULL,
      tx_hash TEXT NOT NULL,
      market_id TEXT NOT NULL,
      buyer TEXT NOT NULL,
      seller TEXT NOT NULL,
      token_id TEXT NOT NULL,
      outcome_amount TEXT NOT NULL,
      collateral_amount TEXT NOT NULL,
      buy_order_id TEXT,
      sell_order_id TEXT,
      raw_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (chain_id, tx_hash),
      FOREIGN KEY (chain_id, market_id) REFERENCES markets(chain_id, market_id)
    );

    CREATE TABLE IF NOT EXISTS token_balances (
      chain_id INTEGER NOT NULL,
      wallet_address TEXT NOT NULL,
      token_symbol TEXT NOT NULL,
      token_id TEXT NOT NULL DEFAULT '',
      balance_decimal TEXT NOT NULL,
      source_tx TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (chain_id, wallet_address, token_symbol, token_id)
    );

    CREATE TABLE IF NOT EXISTS chain_events (
      chain_id INTEGER NOT NULL,
      tx_hash TEXT NOT NULL,
      block_number INTEGER NOT NULL DEFAULT 0,
      block_hash TEXT,
      log_index INTEGER NOT NULL DEFAULT 0,
      event_name TEXT NOT NULL,
      contract_address TEXT NOT NULL,
      args_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (chain_id, tx_hash, log_index)
    );

    CREATE TABLE IF NOT EXISTS chain_actions (
      chain_id INTEGER NOT NULL,
      tx_hash TEXT NOT NULL,
      action_type TEXT NOT NULL,
      local_order_id TEXT,
      raw_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (chain_id, tx_hash)
    );

    CREATE TABLE IF NOT EXISTS order_fills (
      chain_id INTEGER NOT NULL,
      tx_hash TEXT NOT NULL,
      log_index INTEGER NOT NULL,
      order_hash TEXT NOT NULL,
      local_order_id TEXT,
      maker TEXT NOT NULL,
      taker TEXT NOT NULL,
      side TEXT NOT NULL,
      token_id TEXT NOT NULL,
      maker_amount_filled TEXT NOT NULL,
      taker_amount_filled TEXT NOT NULL,
      fee TEXT NOT NULL DEFAULT '0',
      block_number INTEGER NOT NULL DEFAULT 0,
      block_hash TEXT,
      raw_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (chain_id, tx_hash, log_index)
    );

    CREATE TABLE IF NOT EXISTS order_reservations (
      chain_id INTEGER NOT NULL,
      local_order_id TEXT NOT NULL,
      wallet_address TEXT NOT NULL,
      asset_type TEXT NOT NULL CHECK (asset_type IN ('COLLATERAL', 'OUTCOME')),
      token_id TEXT NOT NULL DEFAULT '',
      original_amount TEXT NOT NULL,
      reserved_amount TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'RELEASED')),
      release_reason TEXT,
      risk_status TEXT NOT NULL DEFAULT 'UNCHECKED',
      chain_capacity TEXT,
      chain_balance TEXT,
      chain_allowance TEXT,
      approved_for_all INTEGER,
      risk_error TEXT,
      last_checked_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (chain_id, local_order_id),
      FOREIGN KEY (chain_id, local_order_id)
        REFERENCES orders(chain_id, local_order_id)
        ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sync_state (
      chain_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      last_block INTEGER NOT NULL,
      last_block_hash TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (chain_id, name)
    );

    CREATE TABLE IF NOT EXISTS chain_blocks (
      chain_id INTEGER NOT NULL,
      block_number INTEGER NOT NULL,
      block_hash TEXT NOT NULL,
      parent_hash TEXT NOT NULL,
      processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (chain_id, block_number)
    );

    CREATE TABLE IF NOT EXISTS api_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      remote_address TEXT NOT NULL,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      action TEXT NOT NULL,
      actor TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      request_hash TEXT,
      details_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_orders_market_status
      ON orders(chain_id, market_id, status);
    CREATE INDEX IF NOT EXISTS idx_trades_market
      ON trades(chain_id, market_id);
    CREATE INDEX IF NOT EXISTS idx_chain_events_name
      ON chain_events(chain_id, event_name);
    CREATE INDEX IF NOT EXISTS idx_order_fills_order_hash
      ON order_fills(chain_id, order_hash);
    CREATE INDEX IF NOT EXISTS idx_order_reservations_capacity
      ON order_reservations(
        chain_id, wallet_address, asset_type, token_id, status
      );
    CREATE INDEX IF NOT EXISTS idx_api_audit_time
      ON api_audit_log(occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chain_blocks_hash
      ON chain_blocks(chain_id, block_hash);
  `);

  const columns = db.prepare("PRAGMA table_info(chain_events)").all();
  const hasLogIndex = columns.some((column) => column.name === "log_index");
  if (!hasLogIndex) {
    db.exec(`
      ALTER TABLE chain_events RENAME TO chain_events_legacy;
      CREATE TABLE chain_events (
        chain_id INTEGER NOT NULL,
        tx_hash TEXT NOT NULL,
        block_number INTEGER NOT NULL DEFAULT 0,
        log_index INTEGER NOT NULL DEFAULT 0,
        event_name TEXT NOT NULL,
        contract_address TEXT NOT NULL,
        args_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (chain_id, tx_hash, log_index)
      );
      INSERT OR IGNORE INTO chain_events(
        chain_id, tx_hash, block_number, log_index, event_name, contract_address, args_json, created_at
      )
      SELECT
        chain_id, tx_hash, 0, rowid, event_name, contract_address, args_json, created_at
      FROM chain_events_legacy;
      DROP TABLE chain_events_legacy;
      CREATE INDEX IF NOT EXISTS idx_chain_events_name
        ON chain_events(chain_id, event_name);
    `);
  }
  const currentEventColumns = db.prepare("PRAGMA table_info(chain_events)").all();
  if (!currentEventColumns.some((column) => column.name === "block_hash")) {
    db.exec("ALTER TABLE chain_events ADD COLUMN block_hash TEXT;");
  }

  const marketColumns = db.prepare("PRAGMA table_info(markets)").all();
  if (!marketColumns.some((column) => column.name === "creator")) {
    db.exec("ALTER TABLE markets ADD COLUMN creator TEXT NOT NULL DEFAULT '';");
  }
  if (!marketColumns.some((column) => column.name === "winning_outcome")) {
    db.exec("ALTER TABLE markets ADD COLUMN winning_outcome INTEGER NOT NULL DEFAULT 0;");
  }
  for (const [name, definition] of [
    ["question_id", "TEXT"],
    ["condition_id", "TEXT"],
    ["oracle", "TEXT"],
    ["close_tx", "TEXT"],
    ["resolve_tx", "TEXT"],
    ["payout_denominator", "TEXT NOT NULL DEFAULT '0'"],
  ]) {
    if (!marketColumns.some((column) => column.name === name)) {
      db.exec(`ALTER TABLE markets ADD COLUMN ${name} ${definition};`);
    }
  }

  const orderColumns = db.prepare("PRAGMA table_info(orders)").all();
  if (!orderColumns.some((column) => column.name === "filled_maker_amount")) {
    db.exec("ALTER TABLE orders ADD COLUMN filled_maker_amount TEXT NOT NULL DEFAULT '0';");
  }
  const fillColumns = db.prepare("PRAGMA table_info(order_fills)").all();
  if (!fillColumns.some((column) => column.name === "block_hash")) {
    db.exec("ALTER TABLE order_fills ADD COLUMN block_hash TEXT;");
  }
  const syncColumns = db.prepare("PRAGMA table_info(sync_state)").all();
  if (!syncColumns.some((column) => column.name === "last_block_hash")) {
    db.exec("ALTER TABLE sync_state ADD COLUMN last_block_hash TEXT;");
  }
  if (!orderColumns.some((column) => column.name === "filled_taker_amount")) {
    db.exec("ALTER TABLE orders ADD COLUMN filled_taker_amount TEXT NOT NULL DEFAULT '0';");
  }
  for (const [name, definition] of [
    ["order_hash", "TEXT"],
    ["preapproved", "INTEGER NOT NULL DEFAULT 0"],
    ["invalidated", "INTEGER NOT NULL DEFAULT 0"],
    ["last_chain_tx", "TEXT"],
  ]) {
    if (!orderColumns.some((column) => column.name === name)) {
      db.exec(`ALTER TABLE orders ADD COLUMN ${name} ${definition};`);
    }
  }
  for (const [name, definition] of [
    ["validation_status", "TEXT NOT NULL DEFAULT 'UNVERIFIED'"],
    ["validation_error", "TEXT"],
    ["validated_at", "TEXT"],
  ]) {
    if (!orderColumns.some((column) => column.name === name)) {
      db.exec(`ALTER TABLE orders ADD COLUMN ${name} ${definition};`);
    }
  }
  db.exec(`
    UPDATE orders
    SET validation_status = CASE
      WHEN signature IS NULL OR signature = '' THEN 'UNSIGNED'
      ELSE 'LEGACY_SIGNED'
    END
    WHERE validation_status = 'UNVERIFIED'
      AND validated_at IS NULL;
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_orders_order_hash
      ON orders(chain_id, order_hash);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_order_hash_unique
      ON orders(chain_id, order_hash)
      WHERE order_hash IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_order_fills_order_hash
      ON order_fills(chain_id, order_hash);
  `);

  const reservationColumns = db.prepare(
    "PRAGMA table_info(order_reservations)",
  ).all();
  for (const [name, definition] of [
    ["risk_status", "TEXT NOT NULL DEFAULT 'UNCHECKED'"],
    ["chain_capacity", "TEXT"],
    ["chain_balance", "TEXT"],
    ["chain_allowance", "TEXT"],
    ["approved_for_all", "INTEGER"],
    ["risk_error", "TEXT"],
    ["last_checked_at", "TEXT"],
    ["created_at", "TEXT"],
  ]) {
    if (!reservationColumns.some((column) => column.name === name)) {
      db.exec(`ALTER TABLE order_reservations ADD COLUMN ${name} ${definition};`);
    }
  }
  db.exec(`
    UPDATE order_reservations
    SET created_at = COALESCE(created_at, updated_at, CURRENT_TIMESTAMP);
    UPDATE order_reservations
    SET risk_status = CASE
      WHEN status = 'RELEASED' THEN 'RELEASED'
      ELSE COALESCE(NULLIF(risk_status, ''), 'UNCHECKED')
    END;
    CREATE INDEX IF NOT EXISTS idx_order_reservations_risk
      ON order_reservations(chain_id, status, risk_status);
  `);
}

export function upsert(db, sql, params) {
  db.prepare(sql).run(params);
}
