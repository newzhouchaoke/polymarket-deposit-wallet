import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  fallback,
  getAddress,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygonAmoy } from "viem/chains";
import {
  OFFICIAL_MODE,
  loadExchangeConfig,
  readExchangeArtifact,
} from "./exchange-config.mjs";
import { openResearchDb, privateKey, upsert } from "./order-utils.mjs";

const proxyFactoryAbi = [
  {
    type: "function",
    name: "proxy",
    stateMutability: "payable",
    inputs: [{
      name: "calls",
      type: "tuple[]",
      components: [
        { name: "typeCode", type: "uint8" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "data", type: "bytes" },
      ],
    }],
    outputs: [{ name: "returnValues", type: "bytes[]" }],
  },
];
const exchangeWalletAbi = [{
  type: "function",
  name: "getProxyWalletAddress",
  stateMutability: "view",
  inputs: [{ name: "owner", type: "address" }],
  outputs: [{ name: "", type: "address" }],
}];

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

const action = String(process.argv[2] ?? "").toLowerCase();
const role = String(process.argv[3] ?? "").toUpperCase();
if (!["pause", "unpause"].includes(action) || !["BUYER", "SELLER"].includes(role)) {
  throw new Error("用法：manage-official-user.mjs pause|unpause BUYER|SELLER");
}
if (
  process.env.LIVE_ACTION !== "MANAGE_OFFICIAL_USER" ||
  process.env.LIVE_CONFIRMATION !== "AMOY_TESTNET_ONLY"
) {
  throw new Error(
    "链上写入已拦截：需要 LIVE_ACTION=MANAGE_OFFICIAL_USER 和 LIVE_CONFIRMATION=AMOY_TESTNET_ONLY",
  );
}

const runtime = loadExchangeConfig({ requireMarket: true });
if (runtime.mode !== OFFICIAL_MODE) throw new Error("此脚本只用于 official-v2");
const wallet = role === "BUYER" ? runtime.buyerWallet : runtime.sellerWallet;
if (!wallet) throw new Error(`缺少 ${role} 钱包配置`);
const key = process.env[`OFFICIAL_${role}_PRIVATE_KEY`] || privateKey();
const owner = privateKeyToAccount(key);
const type = Number(process.env[`OFFICIAL_${role}_SIGNATURE_TYPE`] ?? "1");
const publicClient = createPublicClient({ chain: polygonAmoy, transport: transport() });
const walletClient = createWalletClient({
  account: owner,
  chain: polygonAmoy,
  transport: transport(),
});
if ((await publicClient.getChainId()) !== 80002) throw new Error("只允许 Polygon Amoy");
const artifact = readExchangeArtifact(runtime);
const functionName = action === "pause" ? "pauseUser" : "unpauseUser";
const data = encodeFunctionData({ abi: artifact.abi, functionName });
let hash;

if (type === 0) {
  if (owner.address.toLowerCase() !== wallet.toLowerCase()) {
    throw new Error(`${role} EOA 私钥地址与钱包不一致`);
  }
  hash = await walletClient.sendTransaction({
    account: owner,
    chain: polygonAmoy,
    to: runtime.exchange,
    data,
  });
} else if (type === 1) {
  const derived = await publicClient.readContract({
    address: runtime.exchange,
    abi: exchangeWalletAbi,
    functionName: "getProxyWalletAddress",
    args: [owner.address],
  });
  if (getAddress(derived).toLowerCase() !== wallet.toLowerCase()) {
    throw new Error(`${role} 配置钱包不是 owner 派生的官方 Proxy`);
  }
  hash = await walletClient.writeContract({
    account: owner,
    chain: polygonAmoy,
    address: runtime.officialDependencies.proxyFactory,
    abi: proxyFactoryAbi,
    functionName: "proxy",
    args: [[{ typeCode: 1, to: runtime.exchange, value: 0n, data }]],
  });
} else {
  throw new Error("Safe/ERC-1271 用户暂停需要其专用执行器，本脚本不代签");
}

const receipt = await publicClient.waitForTransactionReceipt({ hash });
if (receipt.status !== "success") throw new Error(`${functionName} 失败：${hash}`);
const paused = await publicClient.readContract({
  address: runtime.exchange,
  abi: artifact.abi,
  functionName: "isUserPaused",
  args: [wallet],
});
const effectivePauseBlock = await publicClient.readContract({
  address: runtime.exchange,
  abi: artifact.abi,
  functionName: "userPausedBlockAt",
  args: [wallet],
});
const requestedPaused = action === "pause";
const db = openResearchDb();
try {
  if (requestedPaused) {
    db.prepare(
      `UPDATE orders
       SET status = 'USER_PAUSED', last_chain_tx = :txHash,
           updated_at = CURRENT_TIMESTAMP
       WHERE chain_id = :chainId AND lower(maker) = lower(:wallet)
         AND status IN ('OPEN', 'PARTIALLY_FILLED')`,
    ).run({ chainId: 80002, wallet, txHash: hash });
  } else {
    db.prepare(
      `UPDATE orders
       SET status = CASE
         WHEN CAST(filled_maker_amount AS INTEGER) > 0
           OR CAST(filled_taker_amount AS INTEGER) > 0
           THEN 'PARTIALLY_FILLED'
         ELSE 'OPEN'
       END,
       last_chain_tx = :txHash,
       updated_at = CURRENT_TIMESTAMP
       WHERE chain_id = :chainId AND lower(maker) = lower(:wallet)
         AND status = 'USER_PAUSED'`,
    ).run({ chainId: 80002, wallet, txHash: hash });
  }
  upsert(
    db,
    `INSERT OR REPLACE INTO chain_actions(
       chain_id, tx_hash, action_type, local_order_id, raw_json
     ) VALUES(80002, :txHash, :actionType, NULL, :rawJson)`,
    {
      txHash: hash,
      actionType: requestedPaused ? "USER_PAUSE" : "USER_UNPAUSE",
      rawJson: JSON.stringify({
        role,
        wallet,
        paused,
        requestedPaused,
        effectivePauseBlock: effectivePauseBlock.toString(),
      }),
    },
  );
} finally {
  db.close();
}

console.log(JSON.stringify({
  action,
  role,
  wallet,
  paused,
  requestedPaused,
  effectivePauseBlock: effectivePauseBlock.toString(),
  txHash: hash,
  blockNumber: receipt.blockNumber.toString(),
  explorer: `https://amoy.polygonscan.com/tx/${hash}`,
  scope:
    requestedPaused
      ? "本地立即停止撮合；链上暂停会在 effectivePauseBlock 后生效，且影响该 maker 的全部订单。"
      : "用户级暂停已撤销；不是单订单取消。",
}, null, 2));
