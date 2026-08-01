import fs from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  fallback,
  formatUnits,
  http,
  maxUint256,
  parseUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygonAmoy } from "viem/chains";
import {
  OFFICIAL_MODE,
  erc20Abi,
  loadExchangeConfig,
  officialMarketPath,
} from "./exchange-config.mjs";
import { privateKey } from "./order-utils.mjs";

const collateralTokenAbi = [
  {
    type: "function",
    name: "USDCE",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
];
const testTokenAbi = [
  ...erc20Abi,
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
];
const onrampAbi = [
  {
    type: "function",
    name: "wrap",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
];

const ONRAMP = "0x93070a847efEf7F70739046A929D47a521F5B8ee";

function rpcUrls() {
  const configured = process.env.AMOY_RPC_URLS || process.env.AMOY_RPC_URL;
  return [
    ...new Set([
      ...(configured
        ? configured.split(",").map((url) => url.trim()).filter(Boolean)
        : []),
      "https://polygon-amoy-bor-rpc.publicnode.com",
      "https://rpc-amoy.polygon.technology",
      "https://polygon-amoy.drpc.org",
    ]),
  ];
}

function transport() {
  return fallback(
    rpcUrls().map((url) => http(url, { retryCount: 1, timeout: 10_000 })),
    { rank: false },
  );
}

function assertWriteAllowed() {
  if (process.env.LIVE_ACTION !== "FUND_OFFICIAL_V2") {
    throw new Error(
      "测试资产写入已拦截：请设置 LIVE_ACTION=FUND_OFFICIAL_V2",
    );
  }
  if (process.env.LIVE_CONFIRMATION !== "AMOY_TESTNET_ONLY") {
    throw new Error(
      "测试网写入已拦截：请设置 LIVE_CONFIRMATION=AMOY_TESTNET_ONLY",
    );
  }
}

async function wait(publicClient, hash, label) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label}失败：${hash}`);
  console.log(`${label}成功：${hash}`);
  return hash;
}

assertWriteAllowed();
const runtime = loadExchangeConfig({ requireMarket: true });
if (runtime.mode !== OFFICIAL_MODE || runtime.variant !== "standard") {
  throw new Error("此脚本只支持 official-v2 standard 模式");
}
if (!runtime.buyerWallet || !runtime.sellerWallet) {
  throw new Error("缺少 OFFICIAL_BUYER_WALLET/OFFICIAL_SELLER_WALLET");
}

const owner = privateKeyToAccount(
  process.env.OFFICIAL_MARKET_ORACLE_PRIVATE_KEY || privateKey(),
);
if (owner.address.toLowerCase() !== runtime.sellerWallet.toLowerCase()) {
  throw new Error(
    `当前测试资金脚本要求 sellerWallet 等于资金 EOA ${owner.address}`,
  );
}
const publicClient = createPublicClient({
  chain: polygonAmoy,
  transport: transport(),
});
const walletClient = createWalletClient({
  account: owner,
  chain: polygonAmoy,
  transport: transport(),
});
if ((await publicClient.getChainId()) !== 80002) {
  throw new Error("只允许 Polygon Amoy chainId=80002");
}

const buyerAmount = parseUnits(
  process.env.OFFICIAL_BUYER_PUSD_AMOUNT ?? "10",
  runtime.collateralDecimals,
);
const sellerAmount = parseUnits(
  process.env.OFFICIAL_SELLER_PUSD_AMOUNT ?? "10",
  runtime.collateralDecimals,
);
const totalAmount = buyerAmount + sellerAmount;
const usdce = await publicClient.readContract({
  address: runtime.collateral,
  abi: collateralTokenAbi,
  functionName: "USDCE",
});

const mintTx = await wait(
  publicClient,
  await walletClient.writeContract({
    account: owner,
    chain: polygonAmoy,
    address: usdce,
    abi: testTokenAbi,
    functionName: "mint",
    args: [owner.address, totalAmount],
  }),
  "铸造 Amoy 测试 USDC.e",
);

const allowance = await publicClient.readContract({
  address: usdce,
  abi: testTokenAbi,
  functionName: "allowance",
  args: [owner.address, ONRAMP],
});
let approveTx = null;
if (allowance < totalAmount) {
  approveTx = await wait(
    publicClient,
    await walletClient.writeContract({
      account: owner,
      chain: polygonAmoy,
      address: usdce,
      abi: testTokenAbi,
      functionName: "approve",
      args: [ONRAMP, maxUint256],
    }),
    "授权测试 USDC.e 给 CollateralOnramp",
  );
}

const buyerWrapTx = await wait(
  publicClient,
  await walletClient.writeContract({
    account: owner,
    chain: polygonAmoy,
    address: ONRAMP,
    abi: onrampAbi,
    functionName: "wrap",
    args: [usdce, runtime.buyerWallet, buyerAmount],
  }),
  "为 BUYER Proxy 包装 pUSD",
);
const sellerWrapTx = await wait(
  publicClient,
  await walletClient.writeContract({
    account: owner,
    chain: polygonAmoy,
    address: ONRAMP,
    abi: onrampAbi,
    functionName: "wrap",
    args: [usdce, runtime.sellerWallet, sellerAmount],
  }),
  "为 SELLER 包装 pUSD",
);

const [buyerBalance, sellerBalance] = await Promise.all([
  publicClient.readContract({
    address: runtime.collateral,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [runtime.buyerWallet],
  }),
  publicClient.readContract({
    address: runtime.collateral,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [runtime.sellerWallet],
  }),
]);

const marketPath = officialMarketPath();
if (fs.existsSync(marketPath)) {
  const market = JSON.parse(fs.readFileSync(marketPath, "utf8"));
  market.funding = {
    testOnly: true,
    usdce,
    pUSD: runtime.collateral,
    onramp: ONRAMP,
    mintTx,
    approveTx,
    buyerWrapTx,
    sellerWrapTx,
    buyerAmount: formatUnits(buyerAmount, runtime.collateralDecimals),
    sellerAmount: formatUnits(sellerAmount, runtime.collateralDecimals),
  };
  market.updatedAt = new Date().toISOString();
  fs.writeFileSync(marketPath, `${JSON.stringify(market, null, 2)}\n`);
}

console.log(
  JSON.stringify(
    {
      chainId: 80002,
      testOnly: true,
      usdce,
      pUSD: runtime.collateral,
      onramp: ONRAMP,
      mintTx,
      approveTx,
      buyerWrapTx,
      sellerWrapTx,
      buyerWallet: runtime.buyerWallet,
      buyerPUSD: formatUnits(buyerBalance, runtime.collateralDecimals),
      sellerWallet: runtime.sellerWallet,
      sellerPUSD: formatUnits(sellerBalance, runtime.collateralDecimals),
    },
    null,
    2,
  ),
);
