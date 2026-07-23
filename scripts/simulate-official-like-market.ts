import fs from "node:fs";
import path from "node:path";
import {
  encodeFunctionData,
  formatUnits,
  maxUint256,
  parseGwei,
  parseUnits,
  zeroHash,
  type Address,
  type Hash,
} from "viem";
import { polygonAmoy } from "viem/chains";
import { readArtifact } from "../src/artifact.js";
import { signerClients } from "../src/chain.js";
import { AMOY_CHAIN_ID } from "../src/constants.js";
import { assertLiveAction, PROJECT_DIR } from "../src/env.js";
import { ORDER_TYPES, signErc7739Order } from "./erc7739.mjs";

type Artifact = ReturnType<typeof readArtifact>;

const GAS_OPTIONS = {
  maxFeePerGas: parseGwei("30"),
  maxPriorityFeePerGas: parseGwei("25"),
} as const;

type PartialDeployment = Partial<{
  version: string;
  chainId: number;
  owner: Address;
  walletCoin: Address;
  outcomeToken: Address;
  marketRegistry: Address;
  walletFactory: Address;
  exchange: Address;
  buyerWallet: Address;
  sellerWallet: Address;
}>;

const deploymentPath = path.resolve(
  PROJECT_DIR,
  "deployments",
  "research-v2-amoy.json",
);

function readDeployment(): PartialDeployment {
  if (!fs.existsSync(deploymentPath)) return {};
  return JSON.parse(fs.readFileSync(deploymentPath, "utf8")) as PartialDeployment;
}

function writeDeployment(deployment: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(deploymentPath), { recursive: true });
  fs.writeFileSync(deploymentPath, `${JSON.stringify(deployment, null, 2)}\n`);
}

async function deploy(
  label: string,
  artifact: Artifact,
  args: readonly unknown[] = [],
): Promise<Address> {
  const { account, publicClient, walletClient } = signerClients();
  const hash = await walletClient.deployContract({
    account,
    chain: polygonAmoy,
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args,
    ...GAS_OPTIONS,
  });
  console.log(`${label} 广播：${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) {
    throw new Error(`${label} 部署失败：${hash}`);
  }
  console.log(`${label} 地址：${receipt.contractAddress}`);
  return receipt.contractAddress;
}

async function wait(hash: Hash, label: string): Promise<Hash> {
  const { publicClient } = signerClients();
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} 失败：${hash}`);
  console.log(`${label} 成功：${hash}`);
  return hash;
}

async function deployOrReuse(
  deployment: PartialDeployment,
  key:
    | "walletCoin"
    | "outcomeToken"
    | "marketRegistry"
    | "walletFactory"
    | "exchange",
  label: string,
  artifact: Artifact,
  args: readonly unknown[] = [],
): Promise<Address> {
  const existing = deployment[key];
  if (existing) {
    const { publicClient } = signerClients();
    const code = await publicClient.getCode({ address: existing });
    if (code && code !== "0x") {
      console.log(`${label} 复用：${existing}`);
      return existing;
    }
  }
  const deployed = await deploy(label, artifact, args);
  deployment[key] = deployed;
  writeDeployment(deployment);
  return deployed;
}

assertLiveAction("SIMULATE_RESEARCH_MARKET");
const { account, publicClient, walletClient } = signerClients();
const chainId = await publicClient.getChainId();
if (chainId !== AMOY_CHAIN_ID) throw new Error(`预期 Amoy 80002，当前 ${chainId}`);

const startingBalance = await publicClient.getBalance({ address: account.address });
console.log(`CTF Exchange V2 风格研究流程账户：${account.address}`);
console.log(`Amoy POL 余额：${formatUnits(startingBalance, 18)}`);
if (startingBalance < parseUnits("0.01", 18)) {
  throw new Error("测试 POL 不足；建议补到至少 0.05 POL 后重新运行。");
}

const walletCoinArtifact = readArtifact("ResearchWalletCoin");
const outcomeArtifact = readArtifact("ResearchOutcomeToken");
const marketArtifact = readArtifact("ResearchMarketRegistry");
const factoryArtifact = readArtifact("ResearchDepositWalletFactory");
const walletArtifact = readArtifact("ResearchDepositWallet");
const exchangeArtifact = readArtifact("ResearchCLOBExchange");

const deployment: PartialDeployment = {
  ...readDeployment(),
  version: "research-ctf-exchange-v2",
  chainId,
  owner: account.address,
};
writeDeployment(deployment);

const walletCoin = await deployOrReuse(
  deployment,
  "walletCoin",
  "ResearchWalletCoin/rWALLET",
  walletCoinArtifact,
);
const outcomeToken = await deployOrReuse(
  deployment,
  "outcomeToken",
  "ResearchOutcomeToken/CTF",
  outcomeArtifact,
  [walletCoin],
);
const marketRegistry = await deployOrReuse(
  deployment,
  "marketRegistry",
  "ResearchMarketRegistry",
  marketArtifact,
  [outcomeToken],
);
const walletFactory = await deployOrReuse(
  deployment,
  "walletFactory",
  "ResearchDepositWalletFactory/Beacon",
  factoryArtifact,
);
const exchange = await deployOrReuse(
  deployment,
  "exchange",
  "ResearchCLOBExchange V2",
  exchangeArtifact,
  [
    walletCoin,
    outcomeToken,
    walletFactory,
    account.address,
    account.address,
    account.address,
  ],
);

const configuredExchange = (await publicClient.readContract({
  address: outcomeToken,
  abi: outcomeArtifact.abi,
  functionName: "exchange",
})) as Address;
let configureExchangeTx: Hash | "already-configured" = "already-configured";
if (configuredExchange.toLowerCase() !== exchange.toLowerCase()) {
  configureExchangeTx = await wait(
    await walletClient.writeContract({
      account,
      chain: polygonAmoy,
      address: outcomeToken,
      abi: outcomeArtifact.abi,
      functionName: "setExchange",
      args: [exchange],
      ...GAS_OPTIONS,
    }),
    "设置 CTF Exchange",
  );
}

const buyerWallet = (await publicClient.readContract({
  address: walletFactory,
  abi: factoryArtifact.abi,
  functionName: "getWallet",
  args: [account.address],
})) as Address;
let createWalletTx: Hash | "already-deployed" = "already-deployed";
const buyerWalletCode = await publicClient.getCode({ address: buyerWallet });
if (!buyerWalletCode || buyerWalletCode === "0x") {
  createWalletTx = await wait(
    await walletClient.writeContract({
      account,
      chain: polygonAmoy,
      address: walletFactory,
      abi: factoryArtifact.abi,
      functionName: "createWallet",
      args: [account.address],
      ...GAS_OPTIONS,
    }),
    "创建 ERC-1967 Beacon Deposit Wallet",
  );
}
deployment.buyerWallet = buyerWallet;
// One wallet per owner matches the official model. The seller is an EOA in this demo.
deployment.sellerWallet = account.address;
writeDeployment(deployment);

const question = "Will the V2-style research exchange settle this Amoy trade?";
const closeTime = BigInt(Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60);
const preview = (await publicClient.readContract({
  address: marketRegistry,
  abi: marketArtifact.abi,
  functionName: "nextMarket",
  args: [account.address, question, closeTime],
})) as [Hash, Hash, Hash, bigint, bigint];
const [marketId, questionId, conditionId, yesTokenId, noTokenId] = preview;

const publishTx = await wait(
  await walletClient.writeContract({
    account,
    chain: polygonAmoy,
    address: marketRegistry,
    abi: marketArtifact.abi,
    functionName: "publishMarket",
    args: [question, closeTime],
    ...GAS_OPTIONS,
  }),
  "准备 CTF condition 并发布市场",
);

const mintBuyerTx = await wait(
  await walletClient.writeContract({
    account,
    chain: polygonAmoy,
    address: walletCoin,
    abi: walletCoinArtifact.abi,
    functionName: "mint",
    args: [buyerWallet, parseUnits("100", 6)],
    ...GAS_OPTIONS,
  }),
  "给 Deposit Wallet 铸造 rWALLET",
);
const mintSellerCollateralTx = await wait(
  await walletClient.writeContract({
    account,
    chain: polygonAmoy,
    address: walletCoin,
    abi: walletCoinArtifact.abi,
    functionName: "mint",
    args: [account.address, parseUnits("10", 6)],
    ...GAS_OPTIONS,
  }),
  "给 seller EOA 铸造 split 抵押资产",
);

await wait(
  await walletClient.writeContract({
    account,
    chain: polygonAmoy,
    address: walletCoin,
    abi: walletCoinArtifact.abi,
    functionName: "approve",
    args: [outcomeToken, maxUint256],
    ...GAS_OPTIONS,
  }),
  "seller 授权 CTF 锁定抵押资产",
);
const splitTx = await wait(
  await walletClient.writeContract({
    account,
    chain: polygonAmoy,
    address: outcomeToken,
    abi: outcomeArtifact.abi,
    functionName: "splitPosition",
    args: [conditionId, parseUnits("10", 6)],
    ...GAS_OPTIONS,
  }),
  "split 10 个 YES+NO 完整份额",
);

const approveCollateralData = encodeFunctionData({
  abi: walletCoinArtifact.abi,
  functionName: "approve",
  args: [exchange, maxUint256],
});
const buyerApproveTx = await wait(
  await walletClient.writeContract({
    account,
    chain: polygonAmoy,
    address: buyerWallet,
    abi: walletArtifact.abi,
    functionName: "executeBatch",
    args: [[{ target: walletCoin, value: 0n, data: approveCollateralData }]],
    ...GAS_OPTIONS,
  }),
  "Deposit Wallet 批量调用授权 Exchange",
);
const sellerApproveTx = await wait(
  await walletClient.writeContract({
    account,
    chain: polygonAmoy,
    address: outcomeToken,
    abi: outcomeArtifact.abi,
    functionName: "setApprovalForAll",
    args: [exchange, true],
    ...GAS_OPTIONS,
  }),
  "seller 授权 ERC-1155 outcome 给 Exchange",
);

const salt = BigInt(Date.now());
const timestamp = BigInt(Math.floor(Date.now() / 1000));
const unsignedBuyOrder = {
  salt,
  maker: buyerWallet,
  signer: buyerWallet,
  tokenId: yesTokenId,
  makerAmount: parseUnits("0.60", 6),
  takerAmount: parseUnits("1", 6),
  side: 0,
  signatureType: 3,
  timestamp,
  metadata: zeroHash,
  builder: zeroHash,
};
const unsignedSellOrder = {
  salt: salt + 1n,
  maker: account.address,
  signer: account.address,
  tokenId: yesTokenId,
  makerAmount: parseUnits("1", 6),
  takerAmount: parseUnits("0.55", 6),
  side: 1,
  signatureType: 0,
  timestamp,
  metadata: zeroHash,
  builder: zeroHash,
};
const domain = {
  name: "Polymarket CTF Exchange",
  version: "2",
  chainId,
  verifyingContract: exchange,
} as const;
const buySignature = await signErc7739Order({
  walletClient,
  account,
  appDomain: domain,
  order: unsignedBuyOrder,
});
const sellSignature = await walletClient.signTypedData({
  account,
  domain,
  types: ORDER_TYPES,
  primaryType: "Order",
  message: unsignedSellOrder,
});
const buyOrder = { ...unsignedBuyOrder, signature: buySignature };
const sellOrder = { ...unsignedSellOrder, signature: sellSignature };

const collateralFill = parseUnits("0.55", 6);
const outcomeFill = parseUnits("1", 6);
const matchTx = await wait(
  await walletClient.writeContract({
    account,
    chain: polygonAmoy,
    address: exchange,
    abi: exchangeArtifact.abi,
    functionName: "matchOrders",
    args: [
      conditionId,
      buyOrder,
      [sellOrder],
      collateralFill,
      [outcomeFill],
      0n,
      [0n],
    ],
    ...GAS_OPTIONS,
  }),
  "V2 一对多入口撮合 BUY/SELL",
);

const [buyerCoin, sellerCoin, buyerYes, sellerYes, sellerNo] =
  await Promise.all([
    publicClient.readContract({
      address: walletCoin,
      abi: walletCoinArtifact.abi,
      functionName: "balanceOf",
      args: [buyerWallet],
    }) as Promise<bigint>,
    publicClient.readContract({
      address: walletCoin,
      abi: walletCoinArtifact.abi,
      functionName: "balanceOf",
      args: [account.address],
    }) as Promise<bigint>,
    publicClient.readContract({
      address: outcomeToken,
      abi: outcomeArtifact.abi,
      functionName: "balanceOf",
      args: [buyerWallet, yesTokenId],
    }) as Promise<bigint>,
    publicClient.readContract({
      address: outcomeToken,
      abi: outcomeArtifact.abi,
      functionName: "balanceOf",
      args: [account.address, yesTokenId],
    }) as Promise<bigint>,
    publicClient.readContract({
      address: outcomeToken,
      abi: outcomeArtifact.abi,
      functionName: "balanceOf",
      args: [account.address, noTokenId],
    }) as Promise<bigint>,
  ]);

function serializeOrder(order: typeof buyOrder | typeof sellOrder) {
  return Object.fromEntries(
    Object.entries(order).map(([key, value]) => [
      key,
      typeof value === "bigint" ? value.toString() : value,
    ]),
  );
}

const result = {
  ...deployment,
  version: "research-ctf-exchange-v2",
  chainId,
  owner: account.address,
  walletCoin,
  outcomeToken,
  marketRegistry,
  walletFactory,
  exchange,
  buyerWallet,
  sellerWallet: account.address,
  market: {
    marketId,
    questionId,
    conditionId,
    question,
    closeTime: closeTime.toString(),
    yesTokenId: yesTokenId.toString(),
    noTokenId: noTokenId.toString(),
  },
  orders: {
    buyOrder: serializeOrder(buyOrder),
    sellOrder: serializeOrder(sellOrder),
  },
  txs: {
    configureExchangeTx,
    createWalletTx,
    publishTx,
    mintBuyerTx,
    mintSellerCollateralTx,
    splitTx,
    buyerApproveTx,
    sellerApproveTx,
    matchTx,
  },
  finalBalances: {
    buyerRWALLET: formatUnits(buyerCoin, 6),
    sellerRWALLET: formatUnits(sellerCoin, 6),
    buyerYES: formatUnits(buyerYes, 6),
    sellerYES: formatUnits(sellerYes, 6),
    sellerNO: formatUnits(sellerNo, 6),
  },
};
writeDeployment(result);

console.log("CTF Exchange V2 风格研究流程完成：");
console.log(JSON.stringify(result.finalBalances, null, 2));
console.log(`Deposit Wallet：${buyerWallet}`);
console.log(`Condition ID：${conditionId}`);
console.log(`撮合交易：https://amoy.polygonscan.com/tx/${matchTx}`);
console.log(`部署记录：${deploymentPath}`);
