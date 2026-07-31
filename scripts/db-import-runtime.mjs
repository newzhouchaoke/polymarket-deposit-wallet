import {
  OFFICIAL_MODE,
  loadExchangeConfig,
  runtimeSummary,
} from "./exchange-config.mjs";
import { dbPath, initSchema, openDatabase, upsert } from "./db.js";

const runtime = loadExchangeConfig();
if (runtime.mode !== OFFICIAL_MODE) {
  await import("./db-import-research.mjs");
  process.exit(0);
}

const db = openDatabase();
initSchema(db);
const chainId = Number(runtime.chainId);
const now = new Date().toISOString();

function insertContract(name, address, role, createdTx, notes) {
  if (!address) return;
  upsert(
    db,
    `INSERT INTO contracts(chain_id, name, address, role, created_tx, notes, updated_at)
     VALUES(:chainId, :name, :address, :role, :createdTx, :notes, :updatedAt)
     ON CONFLICT(chain_id, name) DO UPDATE SET
       address=excluded.address,
       role=excluded.role,
       created_tx=excluded.created_tx,
       notes=excluded.notes,
       updated_at=excluded.updated_at`,
    { chainId, name, address, role, createdTx, notes, updatedAt: now },
  );
}

insertContract(
  `OfficialCTFExchangeV2-${runtime.variant}`,
  runtime.exchange,
  "exchange",
  runtime.txs?.exchangeDeployTx ?? null,
  "Exact pinned Polymarket CTF Exchange V2 artifact; Amoy research deployment",
);
insertContract(
  "OfficialCollateral",
  runtime.collateral,
  "collateral",
  null,
  runtime.collateralSymbol,
);
insertContract("OfficialConditionalTokens", runtime.ctf, "ctf", null, "ERC-1155 CTF");
for (const [name, address] of Object.entries(runtime.officialDependencies ?? {})) {
  insertContract(`OfficialDependency-${name}`, address, "dependency", null, runtime.variant);
}

for (const [walletAddress, role] of [
  [runtime.buyerWallet, "buyer"],
  [runtime.sellerWallet, "seller"],
]) {
  if (!walletAddress) continue;
  upsert(
    db,
    `INSERT INTO wallets(
       chain_id, wallet_address, owner_address, wallet_role, wallet_type, created_tx, updated_at
     )
     VALUES(:chainId, :walletAddress, :ownerAddress, :walletRole, 'OFFICIAL_V2_CONFIGURED', NULL, :updatedAt)
     ON CONFLICT(chain_id, wallet_address) DO UPDATE SET
       owner_address=excluded.owner_address,
       wallet_role=excluded.wallet_role,
       wallet_type=excluded.wallet_type,
       updated_at=excluded.updated_at`,
    {
      chainId,
      walletAddress,
      ownerAddress: walletAddress,
      walletRole: role,
      updatedAt: now,
    },
  );
}

if (runtime.market) {
  upsert(
    db,
    `INSERT INTO markets(
       chain_id, market_id, creator, question, yes_token_id, no_token_id,
       close_time, status, winning_outcome, market_registry, created_tx, updated_at
     )
     VALUES(
       :chainId, :marketId, '', :question, :yesTokenId, :noTokenId,
       :closeTime, :status, :winningOutcome, :marketRegistry, NULL, :updatedAt
     )
     ON CONFLICT(chain_id, market_id) DO UPDATE SET
       question=excluded.question,
       yes_token_id=excluded.yes_token_id,
       no_token_id=excluded.no_token_id,
       close_time=excluded.close_time,
       status=excluded.status,
       winning_outcome=excluded.winning_outcome,
       market_registry=excluded.market_registry,
       updated_at=excluded.updated_at`,
    {
      chainId,
      marketId: runtime.market.marketId,
      question: runtime.market.question,
      yesTokenId: runtime.market.yesTokenId,
      noTokenId: runtime.market.noTokenId,
      closeTime: runtime.market.closeTime,
      status: runtime.market.status,
      winningOutcome: runtime.market.winningOutcome,
      marketRegistry: runtime.officialDependencies?.outcomeTokenFactory ?? runtime.ctf,
      updatedAt: now,
    },
  );
}

db.close();
console.log(
  JSON.stringify(
    {
      imported: runtimeSummary(runtime),
      marketImported: Boolean(runtime.market),
      dbPath,
    },
    null,
    2,
  ),
);
