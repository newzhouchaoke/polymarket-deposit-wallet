import { createPublicClient, fallback, formatUnits, http } from "viem";
import { polygonAmoy } from "viem/chains";
import { loadDeployment, openResearchDb, readArtifact, upsert } from "./order-utils.mjs";

function amoyRpcUrls() {
  const configured = process.env.AMOY_RPC_URLS || process.env.AMOY_RPC_URL;
  const preferred = configured
    ? configured.split(",").map((url) => url.trim()).filter(Boolean)
    : [];
  return [
    ...new Set([
      ...preferred,
      "https://polygon-amoy-bor-rpc.publicnode.com",
      "https://rpc-amoy.polygon.technology",
      "https://polygon-amoy.drpc.org",
    ]),
  ];
}

const deployment = loadDeployment();
const db = openResearchDb();
const publicClient = createPublicClient({
  chain: polygonAmoy,
  transport: fallback(
    amoyRpcUrls().map((url) => http(url, { retryCount: 1, timeout: 10_000 })),
    { rank: false },
  ),
});
const walletCoinArtifact = readArtifact("ResearchWalletCoin");
const outcomeArtifact = readArtifact("ResearchOutcomeToken");
const wallets = [
  ...new Set(
    db.prepare("SELECT wallet_address FROM wallets WHERE chain_id = ? ORDER BY wallet_role, wallet_address")
      .all(Number(deployment.chainId))
      .map((row) => row.wallet_address)
      .filter(Boolean),
  ),
];
if (!wallets.includes(deployment.buyerWallet)) wallets.push(deployment.buyerWallet);
if (!wallets.includes(deployment.sellerWallet)) wallets.push(deployment.sellerWallet);

const tokenRows = db.prepare(
  `SELECT yes_token_id, no_token_id
   FROM markets
   WHERE chain_id = ?
   ORDER BY updated_at DESC`,
).all(Number(deployment.chainId));
const tokenIds = [
  ...new Set(
    tokenRows
      .flatMap((row) => [row.yes_token_id, row.no_token_id])
      .concat([deployment.market?.yesTokenId, deployment.market?.noTokenId])
      .filter(Boolean),
  ),
];

for (const wallet of wallets) {
  const walletCoinBalance = await publicClient.readContract({
    address: deployment.walletCoin,
    abi: walletCoinArtifact.abi,
    functionName: "balanceOf",
    args: [wallet],
  });
  upsert(
    db,
    `INSERT INTO token_balances(
       chain_id, wallet_address, token_symbol, token_id, balance_decimal, source_tx, updated_at
     )
     VALUES(:chainId, :walletAddress, 'rWALLET', '', :balanceDecimal, :sourceTx, CURRENT_TIMESTAMP)
     ON CONFLICT(chain_id, wallet_address, token_symbol, token_id) DO UPDATE SET
       balance_decimal=excluded.balance_decimal,
       source_tx=excluded.source_tx,
       updated_at=excluded.updated_at`,
    {
      chainId: Number(deployment.chainId),
      walletAddress: wallet,
      balanceDecimal: formatUnits(walletCoinBalance, 6),
      sourceTx: deployment.txs?.matchTx ?? null,
    },
  );

  for (const tokenId of tokenIds) {
    const balance = await publicClient.readContract({
      address: deployment.outcomeToken,
      abi: outcomeArtifact.abi,
      functionName: "balanceOf",
      args: [BigInt(tokenId), wallet],
    });
    upsert(
      db,
      `INSERT INTO token_balances(
         chain_id, wallet_address, token_symbol, token_id, balance_decimal, source_tx, updated_at
       )
       VALUES(:chainId, :walletAddress, :tokenSymbol, :tokenId, :balanceDecimal, :sourceTx, CURRENT_TIMESTAMP)
       ON CONFLICT(chain_id, wallet_address, token_symbol, token_id) DO UPDATE SET
         balance_decimal=excluded.balance_decimal,
         source_tx=excluded.source_tx,
         updated_at=excluded.updated_at`,
      {
        chainId: Number(deployment.chainId),
        walletAddress: wallet,
        tokenSymbol: tokenRows.some((row) => row.yes_token_id === tokenId) ? "YES" : "NO",
        tokenId,
        balanceDecimal: formatUnits(balance, 6),
        sourceTx: deployment.txs?.matchTx ?? null,
      },
    );
  }
}

db.close();
console.log("链上余额已同步到 SQLite");
