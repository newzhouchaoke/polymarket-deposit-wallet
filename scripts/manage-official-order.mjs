import {
  createPublicClient,
  createWalletClient,
  fallback,
  http,
} from "viem";
import { polygonAmoy } from "viem/chains";
import {
  OFFICIAL_MODE,
  loadExchangeConfig,
  readExchangeArtifact,
} from "./exchange-config.mjs";
import {
  account,
  openResearchDb,
  orderHashFor,
  toContractOrder,
  upsert,
} from "./order-utils.mjs";

function transport() {
  const configured = process.env.AMOY_RPC_URLS || process.env.AMOY_RPC_URL;
  const urls = [
    ...new Set([
      ...(configured
        ? configured.split(",").map((url) => url.trim()).filter(Boolean)
        : []),
      "https://polygon-amoy-bor-rpc.publicnode.com",
      "https://rpc-amoy.polygon.technology",
      "https://polygon-amoy.drpc.org",
    ]),
  ];
  return fallback(
    urls.map((url) => http(url, { retryCount: 1, timeout: 10_000 })),
    { rank: false },
  );
}

function assertLive() {
  if (process.env.LIVE_ACTION !== "MANAGE_OFFICIAL_ORDER") {
    throw new Error("链上写入已拦截：请设置 LIVE_ACTION=MANAGE_OFFICIAL_ORDER");
  }
  if (process.env.LIVE_CONFIRMATION !== "AMOY_TESTNET_ONLY") {
    throw new Error("测试网写入已拦截：请设置 LIVE_CONFIRMATION=AMOY_TESTNET_ONLY");
  }
}

const action = String(process.argv[2] ?? "").toLowerCase();
const localOrderId = process.argv[3];
if (!["preapprove", "invalidate"].includes(action) || !localOrderId) {
  throw new Error(
    "用法：manage-official-order.mjs preapprove|invalidate <local_order_id>",
  );
}
assertLive();

const runtime = loadExchangeConfig({ requireMarket: true });
if (runtime.mode !== OFFICIAL_MODE) {
  throw new Error("此脚本只用于 official-v2");
}
const operator = account();
const publicClient = createPublicClient({
  chain: polygonAmoy,
  transport: transport(),
});
if ((await publicClient.getChainId()) !== 80002) {
  throw new Error("只允许 Polygon Amoy chainId=80002");
}
const artifact = readExchangeArtifact(runtime);
const isOperator = await publicClient.readContract({
  address: runtime.exchange,
  abi: artifact.abi,
  functionName: "isOperator",
  args: [operator.address],
});
if (!isOperator) {
  throw new Error(`${operator.address} 不是当前 Exchange 的 operator`);
}

const db = openResearchDb();
try {
  const row = db
    .prepare(
      "SELECT * FROM orders WHERE chain_id = ? AND local_order_id = ?",
    )
    .get(Number(runtime.chainId), localOrderId);
  if (!row) throw new Error(`找不到订单：${localOrderId}`);
  const order = toContractOrder(row);
  const orderHash = row.order_hash ?? orderHashFor(runtime, order);
  if (action === "preapprove" && (!row.signature || row.signature === "0x")) {
    throw new Error("预批准前仍需一份有效签名供 operator 验证");
  }

  const walletClient = createWalletClient({
    account: operator,
    chain: polygonAmoy,
    transport: transport(),
  });
  const functionName =
    action === "preapprove" ? "preapproveOrder" : "invalidatePreapprovedOrder";
  const args = action === "preapprove" ? [order] : [orderHash];
  const { request } = await publicClient.simulateContract({
    account: operator,
    address: runtime.exchange,
    abi: artifact.abi,
    functionName,
    args,
  });
  const hash = await walletClient.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} 失败：${hash}`);

  db.prepare(
    `UPDATE orders
     SET order_hash = :orderHash,
         preapproved = :preapproved,
         invalidated = :invalidated,
         status = CASE
           WHEN :invalidated = 1 AND status IN ('OPEN', 'PARTIALLY_FILLED')
             THEN 'CANCELLED'
           ELSE status
         END,
         last_chain_tx = :txHash,
         updated_at = CURRENT_TIMESTAMP
     WHERE chain_id = :chainId AND local_order_id = :localOrderId`,
  ).run({
    chainId: Number(runtime.chainId),
    localOrderId,
    orderHash,
    preapproved: action === "preapprove" ? 1 : 0,
    invalidated: action === "invalidate" ? 1 : 0,
    txHash: hash,
  });
  upsert(
    db,
    `INSERT OR REPLACE INTO chain_actions(
       chain_id, tx_hash, action_type, local_order_id, raw_json
     ) VALUES(:chainId, :txHash, :actionType, :localOrderId, :rawJson)`,
    {
      chainId: Number(runtime.chainId),
      txHash: hash,
      actionType:
        action === "preapprove"
          ? "ORDER_PREAPPROVE"
          : "ORDER_PREAPPROVAL_INVALIDATE",
      localOrderId,
      rawJson: JSON.stringify({ localOrderId, orderHash }),
    },
  );
  console.log(JSON.stringify({
    action,
    localOrderId,
    orderHash,
    txHash: hash,
    blockNumber: receipt.blockNumber.toString(),
    explorer: `https://amoy.polygonscan.com/tx/${hash}`,
    boundary:
      action === "invalidate"
        ? "这只会使 operator 预批准失效；普通签名本身仍可能有效。本地状态已同时取消，防止本撮合器继续使用。"
        : "operator 已验证签名并登记预批准；后续可省略签名 calldata。",
  }, null, 2));
} finally {
  db.close();
}
