import fs from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  fallback,
  http,
  keccak256,
  maxUint256,
  parseUnits,
  stringToHex,
  zeroHash,
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

const ctfArtifact = JSON.parse(
  fs.readFileSync(
    new URL(
      "../official/ctf-exchange-v2/artifacts/ConditionalTokens.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const adapterAbi = [
  {
    type: "function",
    name: "splitPosition",
    stateMutability: "nonpayable",
    inputs: [
      { name: "collateralToken", type: "address" },
      { name: "parentCollectionId", type: "bytes32" },
      { name: "conditionId", type: "bytes32" },
      { name: "partition", type: "uint256[]" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
];

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
  if (process.env.LIVE_ACTION !== "PREPARE_OFFICIAL_MARKET") {
    throw new Error(
      "市场写入已拦截：请设置 LIVE_ACTION=PREPARE_OFFICIAL_MARKET",
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

const runtime = loadExchangeConfig();
if (runtime.mode !== OFFICIAL_MODE) {
  throw new Error("请先设置 EXCHANGE_MODE=official-v2");
}
if (runtime.variant !== "standard") {
  throw new Error(
    "本脚本只准备标准二元 CTF 市场；Neg Risk 需要通过 NegRiskAdapter 的市场/问题流程",
  );
}

const account = privateKeyToAccount(
  process.env.OFFICIAL_MARKET_ORACLE_PRIVATE_KEY || privateKey(),
);
const publicClient = createPublicClient({
  chain: polygonAmoy,
  transport: transport(),
});
const walletClient = createWalletClient({
  account,
  chain: polygonAmoy,
  transport: transport(),
});
const chainId = await publicClient.getChainId();
if (chainId !== 80002) {
  throw new Error(`只允许 Polygon Amoy chainId=80002，当前 ${chainId}`);
}

const question =
  process.env.OFFICIAL_MARKET_QUESTION ||
  `Amoy official V2 research market ${new Date().toISOString().slice(0, 10)}`;
const questionId =
  process.env.OFFICIAL_QUESTION_ID || keccak256(stringToHex(question));
const conditionId = await publicClient.readContract({
  address: runtime.ctf,
  abi: ctfArtifact.abi,
  functionName: "getConditionId",
  args: [account.address, questionId, 2n],
});
const marketConfigPath = officialMarketPath();
const previousRecord = fs.existsSync(marketConfigPath)
  ? JSON.parse(fs.readFileSync(marketConfigPath, "utf8"))
  : {};
let outcomeSlotCount = await publicClient.readContract({
  address: runtime.ctf,
  abi: ctfArtifact.abi,
  functionName: "getOutcomeSlotCount",
  args: [conditionId],
});

let prepareTx = previousRecord.prepareTx ?? null;
if (process.argv.includes("--prepare") && outcomeSlotCount === 0n) {
  assertWriteAllowed();
  prepareTx = await wait(
    publicClient,
    await walletClient.writeContract({
      account,
      chain: polygonAmoy,
      address: runtime.ctf,
      abi: ctfArtifact.abi,
      functionName: "prepareCondition",
      args: [account.address, questionId, 2n],
    }),
    "CTF prepareCondition",
  );
  outcomeSlotCount = await publicClient.readContract({
    address: runtime.ctf,
    abi: ctfArtifact.abi,
    functionName: "getOutcomeSlotCount",
    args: [conditionId],
  });
}

const yesCollectionId = await publicClient.readContract({
  address: runtime.ctf,
  abi: ctfArtifact.abi,
  functionName: "getCollectionId",
  args: [zeroHash, conditionId, 1n],
});
const noCollectionId = await publicClient.readContract({
  address: runtime.ctf,
  abi: ctfArtifact.abi,
  functionName: "getCollectionId",
  args: [zeroHash, conditionId, 2n],
});
const [yesTokenId, noTokenId] = await Promise.all([
  publicClient.readContract({
    address: runtime.ctf,
    abi: ctfArtifact.abi,
    functionName: "getPositionId",
    args: [runtime.officialDependencies.ctfCollateral, yesCollectionId],
  }),
  publicClient.readContract({
    address: runtime.ctf,
    abi: ctfArtifact.abi,
    functionName: "getPositionId",
    args: [runtime.officialDependencies.ctfCollateral, noCollectionId],
  }),
]);

let approveTx = previousRecord.approveTx ?? null;
let splitTx = previousRecord.splitTx ?? null;
if (process.argv.includes("--split")) {
  assertWriteAllowed();
  if (outcomeSlotCount !== 2n) {
    throw new Error("条件尚未 prepare；请同时使用 --prepare，或先准备市场");
  }
  const amount = parseUnits(
    process.env.OFFICIAL_MARKET_SPLIT_AMOUNT ?? "10",
    runtime.collateralDecimals,
  );
  const outcomeTokenFactory = runtime.officialDependencies.outcomeTokenFactory;
  const allowance = await publicClient.readContract({
    address: runtime.collateral,
    abi: erc20Abi,
    functionName: "allowance",
    args: [account.address, outcomeTokenFactory],
  });
  if (allowance < amount) {
    approveTx = await wait(
      publicClient,
      await walletClient.writeContract({
        account,
        chain: polygonAmoy,
        address: runtime.collateral,
        abi: erc20Abi,
        functionName: "approve",
        args: [outcomeTokenFactory, maxUint256],
      }),
      `授权 ${runtime.collateralSymbol} 给 OutcomeTokenFactory`,
    );
  }
  splitTx = await wait(
    publicClient,
    await walletClient.writeContract({
      account,
      chain: polygonAmoy,
      address: outcomeTokenFactory,
      abi: adapterAbi,
      functionName: "splitPosition",
      args: [runtime.collateral, zeroHash, conditionId, [1n, 2n], amount],
    }),
    "拆分 YES/NO 结果份额",
  );
}

const record = {
  marketId: conditionId,
  conditionId,
  questionId,
  oracle: account.address,
  question,
  yesTokenId: yesTokenId.toString(),
  noTokenId: noTokenId.toString(),
  closeTime: 0,
  status: "OPEN",
  winningOutcome: 0,
  prepared: outcomeSlotCount === 2n,
  prepareTx,
  approveTx,
  splitTx,
  updatedAt: new Date().toISOString(),
};
if (record.prepared) {
  fs.writeFileSync(marketConfigPath, `${JSON.stringify(record, null, 2)}\n`);
}

console.log(
  JSON.stringify(
    {
      mode: process.argv.includes("--prepare") ? "WRITE_OR_REUSE" : "CHECK_ONLY",
      chainId,
      exchange: runtime.exchange,
      ctf: runtime.ctf,
      collateral: runtime.collateral,
      outcomeTokenFactory: runtime.officialDependencies.outcomeTokenFactory,
      configPath: marketConfigPath,
      configSaved: record.prepared,
      ...record,
    },
    null,
    2,
  ),
);
