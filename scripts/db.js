import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

export const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const dbDir = path.join(projectDir, "data");
export const dbPath = path.join(dbDir, "research-polymarket.sqlite");

export function openDatabase() {
  fs.mkdirSync(dbDir, { recursive: true });
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

    CREATE TABLE IF NOT EXISTS sync_state (
      chain_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      last_block INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (chain_id, name)
    );

    CREATE INDEX IF NOT EXISTS idx_orders_market_status
      ON orders(chain_id, market_id, status);
    CREATE INDEX IF NOT EXISTS idx_trades_market
      ON trades(chain_id, market_id);
    CREATE INDEX IF NOT EXISTS idx_chain_events_name
      ON chain_events(chain_id, event_name);
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

  const marketColumns = db.prepare("PRAGMA table_info(markets)").all();
  if (!marketColumns.some((column) => column.name === "creator")) {
    db.exec("ALTER TABLE markets ADD COLUMN creator TEXT NOT NULL DEFAULT '';");
  }
  if (!marketColumns.some((column) => column.name === "winning_outcome")) {
    db.exec("ALTER TABLE markets ADD COLUMN winning_outcome INTEGER NOT NULL DEFAULT 0;");
  }

  const orderColumns = db.prepare("PRAGMA table_info(orders)").all();
  if (!orderColumns.some((column) => column.name === "filled_maker_amount")) {
    db.exec("ALTER TABLE orders ADD COLUMN filled_maker_amount TEXT NOT NULL DEFAULT '0';");
  }
  if (!orderColumns.some((column) => column.name === "filled_taker_amount")) {
    db.exec("ALTER TABLE orders ADD COLUMN filled_taker_amount TEXT NOT NULL DEFAULT '0';");
  }
}

export function upsert(db, sql, params) {
  db.prepare(sql).run(params);
}
