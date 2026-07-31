import { createPublicClient, createWalletClient, fallback, http } from "viem";
import { polygonAmoy } from "viem/chains";
import {
  CANCEL_TYPES,
  account,
  assertCancelLiveAction,
  domainFor,
  loadDeployment,
  openResearchDb,
  readArtifact,
  toContractOrder,
} from "./order-utils.mjs";
import { signErc7739TypedData } from "./erc7739.mjs";
import { OFFICIAL_MODE } from "./exchange-config.mjs";

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

function amoyTransport() {
  return fallback(
    amoyRpcUrls().map((url) => http(url, { retryCount: 1, timeout: 10_000 })),
    { rank: false },
  );
}

function selectOrder(db, localOrderId) {
  if (localOrderId) {
    return db
      .prepare("SELECT * FROM orders WHERE local_order_id = ?")
      .get(localOrderId);
  }
  return db.prepare(
    `SELECT *
     FROM orders
     WHERE status IN ('OPEN', 'PARTIALLY_FILLED')
       AND signature IS NOT NULL
     ORDER BY updated_at DESC
     LIMIT 1`,
  ).get();
}

const requestedId = process.argv[2] || process.env.ORDER_ID;
const deployment = loadDeployment();
if (deployment.mode === OFFICIAL_MODE) {
  throw new Error(
    "官方 CTF Exchange V2 没有研究版 cancelOrder(order,signature) 接口。请通过 POST /api/orders/:id/cancel 做链下取消；只有 preapproved 订单才能由 operator 调用 invalidatePreapprovedOrder。",
  );
}
const db = openResearchDb();
const row = selectOrder(db, requestedId);
if (!row) {
  console.log(JSON.stringify({
    reason: requestedId
      ? `未找到订单：${requestedId}`
      : "没有可取消的已签名 OPEN/PARTIALLY_FILLED 订单",
  }, null, 2));
  db.close();
  process.exit(0);
}
if (!["OPEN", "PARTIALLY_FILLED"].includes(row.status)) {
  throw new Error(`订单状态不可取消：${row.local_order_id} status=${row.status}`);
}
if (!row.signature) {
  throw new Error(`订单缺少签名，不能链上取消：${row.local_order_id}`);
}

console.log(`准备链上取消订单：${row.local_order_id}`);
assertCancelLiveAction();

const signer = account();
const publicClient = createPublicClient({
  chain: polygonAmoy,
  transport: amoyTransport(),
});
const walletClient = createWalletClient({
  account: signer,
  chain: polygonAmoy,
  transport: amoyTransport(),
});
const exchangeArtifact = readArtifact("ResearchCLOBExchange");
const order = toContractOrder(row);
const orderHash = await publicClient.readContract({
  address: deployment.exchange,
  abi: exchangeArtifact.abi,
  functionName: "hashOrder",
  args: [order],
});
const cancelSignature = Number(order.signatureType) === 3
  ? await signErc7739TypedData({
      walletClient,
      account: signer,
      appDomain: domainFor(deployment),
      contentsTypes: CANCEL_TYPES,
      primaryType: "Cancel",
      contents: { orderHash },
      depositWallet: order.maker,
    })
  : await walletClient.signTypedData({
  account: signer,
  domain: domainFor(deployment),
  types: CANCEL_TYPES,
  primaryType: "Cancel",
  message: { orderHash },
  });

const txHash = await walletClient.writeContract({
  account: signer,
  chain: polygonAmoy,
  address: deployment.exchange,
  abi: exchangeArtifact.abi,
  functionName: "cancelOrder",
  args: [order, cancelSignature],
});
console.log(`取消交易已广播：${txHash}`);
const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
if (receipt.status !== "success") throw new Error(`取消交易失败：${txHash}`);

const raw = typeof row.raw_json === "string" ? JSON.parse(row.raw_json) : row.raw_json;
db.prepare(
  `UPDATE orders
   SET status = 'CANCELLED',
       raw_json = :rawJson,
       updated_at = CURRENT_TIMESTAMP
   WHERE chain_id = :chainId AND local_order_id = :localOrderId`,
).run({
  chainId: row.chain_id,
  localOrderId: row.local_order_id,
  rawJson: JSON.stringify({
    ...raw,
    orderHash,
    cancelSignature,
    cancelTx: txHash,
  }),
});
db.prepare(
  `INSERT INTO chain_actions(chain_id, tx_hash, action_type, local_order_id, raw_json)
   VALUES(:chainId, :txHash, 'ORDER_CANCEL', :localOrderId, :rawJson)
   ON CONFLICT(chain_id, tx_hash) DO UPDATE SET
     action_type=excluded.action_type,
     local_order_id=excluded.local_order_id,
     raw_json=excluded.raw_json`,
).run({
  chainId: row.chain_id,
  txHash,
  localOrderId: row.local_order_id,
  rawJson: JSON.stringify({
    orderHash,
    cancelSignature,
    cancelTx: txHash,
  }),
});
db.close();

console.log(`链上取消成功：https://amoy.polygonscan.com/tx/${txHash}`);
