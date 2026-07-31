import fs from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  fallback,
  getAddress,
  http,
  zeroAddress,
  zeroHash,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygonAmoy } from "viem/chains";
import {
  OFFICIAL_MODE,
  loadExchangeConfig,
  officialMarketPath,
} from "./exchange-config.mjs";
import {
  openResearchDb,
  privateKey,
  upsert,
} from "./order-utils.mjs";

const ctfArtifact = JSON.parse(
  fs.readFileSync(
    new URL("../official/ctf-exchange-v2/artifacts/ConditionalTokens.json", import.meta.url),
    "utf8",
  ),
);
const adapterArtifact = JSON.parse(
  fs.readFileSync(
    new URL(
      "../official/ctf-exchange-v2/out/CtfCollateralAdapter.sol/CtfCollateralAdapter.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const proxyFactoryAbi = [
  {
    type: "function",
    name: "proxy",
    stateMutability: "payable",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "typeCode", type: "uint8" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "data", type: "bytes" },
        ],
      },
    ],
    outputs: [{ name: "returnValues", type: "bytes[]" }],
  },
];
const exchangeWalletAbi = [
  {
    type: "function",
    name: "getProxyWalletAddress",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "address" }],
  },
];

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

function assertLive(action) {
  if (process.env.LIVE_ACTION !== action) {
    throw new Error(`链上写入已拦截：请设置 LIVE_ACTION=${action}`);
  }
  if (process.env.LIVE_CONFIRMATION !== "AMOY_TESTNET_ONLY") {
    throw new Error("测试网写入已拦截：请设置 LIVE_CONFIRMATION=AMOY_TESTNET_ONLY");
  }
}

function saveMarketFile(patch) {
  const filePath = officialMarketPath();
  const current = JSON.parse(fs.readFileSync(filePath, "utf8"));
  fs.writeFileSync(
    filePath,
    `${JSON.stringify(
      { ...current, ...patch, updatedAt: new Date().toISOString() },
      null,
      2,
    )}\n`,
  );
}

function updateMarketDb(db, runtime, patch) {
  const assignments = [];
  const params = {
    chainId: Number(runtime.chainId),
    marketId: runtime.market.marketId,
  };
  for (const [column, value] of Object.entries(patch)) {
    assignments.push(`${column} = :${column}`);
    params[column] = value;
  }
  db.prepare(
    `UPDATE markets
     SET ${assignments.join(", ")}, updated_at = CURRENT_TIMESTAMP
     WHERE chain_id = :chainId AND market_id = :marketId`,
  ).run(params);
}

async function wait(publicClient, hash, label) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label}失败：${hash}`);
  return receipt;
}

function roleAccount(role) {
  const key = process.env[`OFFICIAL_${role}_PRIVATE_KEY`] || privateKey();
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(`OFFICIAL_${role}_PRIVATE_KEY 格式无效`);
  }
  return privateKeyToAccount(key);
}

function signatureType(role) {
  return Number(process.env[`OFFICIAL_${role}_SIGNATURE_TYPE`] ?? "1");
}

async function redeemForRole(runtime, publicClient, role) {
  const roleName = role.toUpperCase();
  const wallet = roleName === "BUYER" ? runtime.buyerWallet : runtime.sellerWallet;
  if (!wallet) throw new Error(`缺少 ${roleName} 钱包配置`);
  const owner = roleAccount(roleName);
  const walletClient = createWalletClient({
    account: owner,
    chain: polygonAmoy,
    transport: transport(),
  });
  const data = encodeFunctionData({
    abi: adapterArtifact.abi,
    functionName: "redeemPositions",
    args: [zeroAddress, zeroHash, runtime.market.conditionId, [1n, 2n]],
  });
  const type = signatureType(roleName);
  if (type === 0) {
    if (owner.address.toLowerCase() !== wallet.toLowerCase()) {
      throw new Error(`${roleName} EOA 私钥地址与配置钱包不一致`);
    }
    return walletClient.sendTransaction({
      account: owner,
      chain: polygonAmoy,
      to: runtime.officialDependencies.outcomeTokenFactory,
      data,
    });
  }
  if (type === 1) {
    const derived = await publicClient.readContract({
      address: runtime.exchange,
      abi: exchangeWalletAbi,
      functionName: "getProxyWalletAddress",
      args: [owner.address],
    });
    if (getAddress(derived).toLowerCase() !== wallet.toLowerCase()) {
      throw new Error(`${roleName} 配置钱包不是该 owner 派生的官方 Proxy`);
    }
    return walletClient.writeContract({
      account: owner,
      chain: polygonAmoy,
      address: runtime.officialDependencies.proxyFactory,
      abi: proxyFactoryAbi,
      functionName: "proxy",
      args: [[{
        typeCode: 1,
        to: runtime.officialDependencies.outcomeTokenFactory,
        value: 0n,
        data,
      }]],
    });
  }
  throw new Error(
    `${roleName} signatureType=${type} 暂不自动执行赎回；Safe/自定义 ERC-1271 需要各自执行器`,
  );
}

const action = String(process.argv[2] ?? "status").toLowerCase();
const argument = String(process.argv[3] ?? "").toUpperCase();
const runtime = loadExchangeConfig({ requireMarket: true });
if (runtime.mode !== OFFICIAL_MODE || runtime.variant !== "standard") {
  throw new Error("市场生命周期脚本目前只支持 official-v2 standard / Polygon Amoy");
}
if (!runtime.market.questionId || !runtime.market.oracle) {
  throw new Error("市场配置缺少 questionId 或 oracle");
}
const publicClient = createPublicClient({
  chain: polygonAmoy,
  transport: transport(),
});
if ((await publicClient.getChainId()) !== 80002) {
  throw new Error("只允许 Polygon Amoy chainId=80002");
}
const db = openResearchDb();

try {
  const payoutDenominator = await publicClient.readContract({
    address: runtime.ctf,
    abi: ctfArtifact.abi,
    functionName: "payoutDenominator",
    args: [runtime.market.conditionId],
  });

  if (action === "status") {
    console.log(JSON.stringify({
      chainId: 80002,
      market: runtime.market,
      ctf: runtime.ctf,
      outcomeTokenFactory: runtime.officialDependencies.outcomeTokenFactory,
      payoutDenominator: payoutDenominator.toString(),
      resolved: payoutDenominator > 0n,
    }, null, 2));
    process.exitCode = 0;
  } else if (action === "close") {
    if (payoutDenominator > 0n) throw new Error("市场已经链上结算，不能再关闭");
    const closedAt = Math.floor(Date.now() / 1000);
    saveMarketFile({ status: "CLOSED", closeTime: closedAt });
    updateMarketDb(db, runtime, { status: "CLOSED", close_time: closedAt });
    console.log(JSON.stringify({
      action: "close",
      onchainTransaction: false,
      marketId: runtime.market.marketId,
      status: "CLOSED",
      closeTime: closedAt,
      note: "官方 CTF Exchange 没有 Market close 方法；关闭由本地订单簿执行。",
    }, null, 2));
  } else if (action === "resolve") {
    assertLive("RESOLVE_OFFICIAL_MARKET");
    if (!["YES", "NO"].includes(argument)) {
      throw new Error("用法：official-market-lifecycle.mjs resolve YES|NO");
    }
    if (runtime.market.status !== "CLOSED") {
      throw new Error(`结算前必须先关闭市场，当前状态：${runtime.market.status}`);
    }
    if (payoutDenominator > 0n) throw new Error("该 condition 已经结算");
    const oracle = roleAccount("MARKET_ORACLE");
    if (oracle.address.toLowerCase() !== runtime.market.oracle.toLowerCase()) {
      throw new Error(`Oracle 私钥地址 ${oracle.address} 与市场 oracle 不一致`);
    }
    const walletClient = createWalletClient({
      account: oracle,
      chain: polygonAmoy,
      transport: transport(),
    });
    const payouts = argument === "YES" ? [1n, 0n] : [0n, 1n];
    const hash = await walletClient.writeContract({
      account: oracle,
      chain: polygonAmoy,
      address: runtime.ctf,
      abi: ctfArtifact.abi,
      functionName: "reportPayouts",
      args: [runtime.market.questionId, payouts],
    });
    const receipt = await wait(publicClient, hash, "CTF reportPayouts");
    const winningOutcome = argument === "YES" ? 1 : 2;
    saveMarketFile({
      status: "RESOLVED",
      winningOutcome,
      resolveTx: hash,
      payoutDenominator: "1",
    });
    updateMarketDb(db, runtime, {
      status: "RESOLVED",
      winning_outcome: winningOutcome,
      resolve_tx: hash,
      payout_denominator: "1",
    });
    upsert(db, `INSERT OR REPLACE INTO chain_actions(
      chain_id, tx_hash, action_type, local_order_id, raw_json
    ) VALUES(:chainId, :txHash, 'MARKET_RESOLVE', NULL, :rawJson)`, {
      chainId: 80002,
      txHash: hash,
      rawJson: JSON.stringify({
        marketId: runtime.market.marketId,
        outcome: argument,
        blockNumber: receipt.blockNumber.toString(),
      }),
    });
    console.log(JSON.stringify({
      action: "resolve",
      outcome: argument,
      txHash: hash,
      explorer: `https://amoy.polygonscan.com/tx/${hash}`,
    }, null, 2));
  } else if (action === "redeem") {
    assertLive("REDEEM_OFFICIAL_MARKET");
    if (!["BUYER", "SELLER"].includes(argument)) {
      throw new Error("用法：official-market-lifecycle.mjs redeem BUYER|SELLER");
    }
    if (payoutDenominator === 0n) throw new Error("市场尚未链上结算，不能赎回");
    const hash = await redeemForRole(runtime, publicClient, argument);
    const receipt = await wait(publicClient, hash, `${argument} redeemPositions`);
    upsert(db, `INSERT OR REPLACE INTO chain_actions(
      chain_id, tx_hash, action_type, local_order_id, raw_json
    ) VALUES(:chainId, :txHash, :actionType, NULL, :rawJson)`, {
      chainId: 80002,
      txHash: hash,
      actionType: `MARKET_REDEEM_${argument}`,
      rawJson: JSON.stringify({
        marketId: runtime.market.marketId,
        wallet: argument === "BUYER" ? runtime.buyerWallet : runtime.sellerWallet,
        blockNumber: receipt.blockNumber.toString(),
      }),
    });
    console.log(JSON.stringify({
      action: "redeem",
      role: argument,
      txHash: hash,
      explorer: `https://amoy.polygonscan.com/tx/${hash}`,
    }, null, 2));
  } else {
    throw new Error("支持的操作：status | close | resolve YES|NO | redeem BUYER|SELLER");
  }
} finally {
  db.close();
}
