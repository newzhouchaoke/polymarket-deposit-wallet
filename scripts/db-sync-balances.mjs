import { createPublicClient, fallback, formatUnits, http } from "viem";
import { polygonAmoy } from "viem/chains";
import {
  loadDeployment,
  openResearchDb,
  readArtifact,
  upsert,
} from "./order-utils.mjs";
import {
  OFFICIAL_MODE,
  erc20Abi,
  erc1155Abi,
} from "./exchange-config.mjs";

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

const deployment = loadDeployment({ requireMarket: true });
const db = openResearchDb();
const publicClient = createPublicClient({
  chain: polygonAmoy,
  transport: fallback(
    amoyRpcUrls().map((url) => http(url, { retryCount: 1, timeout: 10_000 })),
    { rank: false },
  ),
});
const collateralAbi =
  deployment.mode === OFFICIAL_MODE
    ? erc20Abi
    : readArtifact("ResearchWalletCoin").abi;
const outcomeAbi =
  deployment.mode === OFFICIAL_MODE
    ? erc1155Abi
    : readArtifact("ResearchOutcomeToken").abi;
const wallets = [
  ...new Set(
    db.prepare("SELECT wallet_address FROM wallets WHERE chain_id = ? ORDER BY wallet_role, wallet_address")
      .all(Number(deployment.chainId))
      .map((row) => row.wallet_address)
      .filter(Boolean),
  ),
];
for (const wallet of [deployment.buyerWallet, deployment.sellerWallet]) {
  if (wallet && !wallets.includes(wallet)) wallets.push(wallet);
}
if (wallets.length === 0) {
  throw new Error(
    `${deployment.mode} 尚未配置可同步的钱包。请先运行 npm run db:import，或配置官方买卖钱包地址`,
  );
}

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

db.prepare(
  `DELETE FROM token_balances
   WHERE chain_id = ? AND token_id = '' AND token_symbol <> ?`,
).run(Number(deployment.chainId), deployment.collateralSymbol);

for (const wallet of wallets) {
  const walletCoinBalance = await publicClient.readContract({
    address: deployment.collateral,
    abi: collateralAbi,
    functionName: "balanceOf",
    args: [wallet],
  });
  upsert(
    db,
    `INSERT INTO token_balances(
       chain_id, wallet_address, token_symbol, token_id, balance_decimal, source_tx, updated_at
     )
       VALUES(:chainId, :walletAddress, :tokenSymbol, '', :balanceDecimal, :sourceTx, CURRENT_TIMESTAMP)
     ON CONFLICT(chain_id, wallet_address, token_symbol, token_id) DO UPDATE SET
       balance_decimal=excluded.balance_decimal,
       source_tx=excluded.source_tx,
       updated_at=excluded.updated_at`,
    {
      chainId: Number(deployment.chainId),
      walletAddress: wallet,
      tokenSymbol: deployment.collateralSymbol,
      balanceDecimal: formatUnits(walletCoinBalance, deployment.collateralDecimals),
      sourceTx: deployment.txs?.matchTx ?? null,
    },
  );

  for (const tokenId of tokenIds) {
    const balance = await publicClient.readContract({
      address: deployment.ctf,
      abi: outcomeAbi,
      functionName: "balanceOf",
      args: [wallet, BigInt(tokenId)],
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
        balanceDecimal: formatUnits(balance, deployment.collateralDecimals),
        sourceTx: deployment.txs?.matchTx ?? null,
      },
    );
  }
}

db.close();
console.log("链上余额已同步到 SQLite");
