import fs from "node:fs";
import path from "node:path";
import {
  encodeFunctionData,
  formatUnits,
  maxUint256,
  parseUnits,
  stringToHex,
  type Abi,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import { polygonAmoy } from "viem/chains";
import { readArtifact } from "../src/artifact.js";
import { signerClients } from "../src/chain.js";
import { AMOY_CHAIN_ID } from "../src/constants.js";
import { assertLiveAction, PROJECT_DIR } from "../src/env.js";

type Artifact = ReturnType<typeof readArtifact>;

const ORDER_TYPES = {
  Order: [
    { name: "maker", type: "address" },
    { name: "signer", type: "address" },
    { name: "tokenId", type: "uint256" },
    { name: "makerAmount", type: "uint256" },
    { name: "takerAmount", type: "uint256" },
    { name: "side", type: "uint8" },
    { name: "expiration", type: "uint256" },
    { name: "salt", type: "uint256" },
  ],
} as const;

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
  });
  console.log(`${label} 广播：${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) {
    throw new Error(`${label} 部署失败：${hash}`);
  }
  console.log(`${label} 地址：${receipt.contractAddress}`);
  return receipt.contractAddress;
}

async function wait(hash: Hash, label: string): Promise<void> {
  const { publicClient } = signerClients();
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} 失败：${hash}`);
  console.log(`${label} 成功：${hash}`);
}

type PartialDeployment = Partial<{
  chainId: number;
  owner: Address;
  collateral: Address;
  outcomeToken: Address;
  walletFactory: Address;
  exchange: Address;
  buyerWallet: Address;
  sellerWallet: Address;
}>;

const deploymentPath = path.resolve(PROJECT_DIR, "deployments", "research-amoy.json");

function readDeployment(): PartialDeployment {
  if (!fs.existsSync(deploymentPath)) return {};
  return JSON.parse(fs.readFileSync(deploymentPath, "utf8")) as PartialDeployment;
}

function writeDeployment(deployment: PartialDeployment): void {
  fs.mkdirSync(path.dirname(deploymentPath), { recursive: true });
  fs.writeFileSync(deploymentPath, `${JSON.stringify(deployment, null, 2)}\n`);
}

async function deployOrReuse(
  deployment: PartialDeployment,
  key: "collateral" | "outcomeToken" | "walletFactory" | "exchange",
  label: string,
  artifact: Artifact,
  args: readonly unknown[] = [],
): Promise<Address> {
  const existing = deployment[key] as Address | undefined;
  if (existing) {
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

assertLiveAction("DEPLOY_RESEARCH_POLYMARKET");
const { account, publicClient, walletClient } = signerClients();
const chainId = await publicClient.getChainId();
if (chainId !== AMOY_CHAIN_ID) throw new Error(`预期 Amoy 80002，当前 ${chainId}`);

const startingBalance = await publicClient.getBalance({ address: account.address });
console.log(`Research Polymarket-like 部署账户：${account.address}`);
console.log(`Amoy POL 余额：${formatUnits(startingBalance, 18)}`);
if (startingBalance < parseUnits("0.05", 18)) {
  throw new Error("剩余测试 POL 不足；已做断点续跑，请补到至少 0.1 POL 后重新运行。");
}

const usd = readArtifact("ResearchMockUSD");
const outcome = readArtifact("ResearchOutcomeToken");
const factory = readArtifact("ResearchDepositWalletFactory");
const walletArtifact = readArtifact("ResearchDepositWallet");
const exchangeArtifact = readArtifact("ResearchCLOBExchange");

const deployment = {
  ...readDeployment(),
  chainId,
  owner: account.address,
} satisfies PartialDeployment;
writeDeployment(deployment);

const collateral = await deployOrReuse(deployment, "collateral", "ResearchMockUSD", usd);
const outcomeToken = await deployOrReuse(
  deployment,
  "outcomeToken",
  "ResearchOutcomeToken",
  outcome,
);
const walletFactory = await deployOrReuse(
  deployment,
  "walletFactory",
  "ResearchDepositWalletFactory",
  factory,
);
const exchange = await deployOrReuse(deployment, "exchange", "ResearchCLOBExchange", exchangeArtifact, [
  collateral,
  outcomeToken,
  account.address,
]);

const buyerSalt = stringToHex("buyer-wallet", { size: 32 });
const sellerSalt = stringToHex("seller-wallet", { size: 32 });
const [buyerWallet, sellerWallet] = await Promise.all([
  publicClient.readContract({
    address: walletFactory,
    abi: factory.abi,
    functionName: "getWallet",
    args: [account.address, buyerSalt],
  }) as Promise<Address>,
  publicClient.readContract({
    address: walletFactory,
    abi: factory.abi,
    functionName: "getWallet",
    args: [account.address, sellerSalt],
  }) as Promise<Address>,
]);
await wait(
  await walletClient.writeContract({
    account,
    chain: polygonAmoy,
    address: walletFactory,
    abi: factory.abi,
    functionName: "createWallet",
    args: [account.address, buyerSalt],
  }),
  "创建 buyer Deposit Wallet",
);
deployment.buyerWallet = buyerWallet;
writeDeployment(deployment);
await wait(
  await walletClient.writeContract({
    account,
    chain: polygonAmoy,
    address: walletFactory,
    abi: factory.abi,
    functionName: "createWallet",
    args: [account.address, sellerSalt],
  }),
  "创建 seller Deposit Wallet",
);
deployment.sellerWallet = sellerWallet;
writeDeployment(deployment);

const tokenId = 1n;
const buyerStartingUsd = parseUnits("100", 6);
const sellerStartingOutcome = parseUnits("10", 6);
await wait(
  await walletClient.writeContract({
    account,
    chain: polygonAmoy,
    address: collateral,
    abi: usd.abi,
    functionName: "mint",
    args: [buyerWallet, buyerStartingUsd],
  }),
  "给 buyer 钱包铸造 rUSD",
);
await wait(
  await walletClient.writeContract({
    account,
    chain: polygonAmoy,
    address: outcomeToken,
    abi: outcome.abi,
    functionName: "mint",
    args: [sellerWallet, tokenId, sellerStartingOutcome],
  }),
  "给 seller 钱包铸造 YES outcome",
);

const approveCollateral = encodeFunctionData({
  abi: usd.abi,
  functionName: "approve",
  args: [exchange, maxUint256],
});
const approveOutcome = encodeFunctionData({
  abi: outcome.abi,
  functionName: "setApprovalForAll",
  args: [exchange, true],
});
await wait(
  await walletClient.writeContract({
    account,
    chain: polygonAmoy,
    address: buyerWallet,
    abi: walletArtifact.abi,
    functionName: "executeBatch",
    args: [[{ target: collateral, value: 0n, data: approveCollateral }]],
  }),
  "buyer Deposit Wallet 授权 rUSD",
);
await wait(
  await walletClient.writeContract({
    account,
    chain: polygonAmoy,
    address: sellerWallet,
    abi: walletArtifact.abi,
    functionName: "executeBatch",
    args: [[{ target: outcomeToken, value: 0n, data: approveOutcome }]],
  }),
  "seller Deposit Wallet 授权 outcome",
);

const nowSalt = BigInt(Date.now());
const buyOrder = {
  maker: buyerWallet,
  signer: buyerWallet,
  tokenId,
  makerAmount: parseUnits("0.60", 6), // buyer pays up to 0.60 rUSD
  takerAmount: parseUnits("1", 6), // buyer wants 1 YES
  side: 0,
  expiration: 0n,
  salt: nowSalt,
};
const sellOrder = {
  maker: sellerWallet,
  signer: sellerWallet,
  tokenId,
  makerAmount: parseUnits("1", 6), // seller sells 1 YES
  takerAmount: parseUnits("0.55", 6), // seller asks 0.55 rUSD
  side: 1,
  expiration: 0n,
  salt: nowSalt + 1n,
};
const domain = {
  name: "ResearchCLOBExchange",
  version: "1",
  chainId,
  verifyingContract: exchange,
} as const;
const buySignature = await walletClient.signTypedData({
  account,
  domain,
  types: ORDER_TYPES,
  primaryType: "Order",
  message: buyOrder,
});
const sellSignature = await walletClient.signTypedData({
  account,
  domain,
  types: ORDER_TYPES,
  primaryType: "Order",
  message: sellOrder,
});

await wait(
  await walletClient.writeContract({
    account,
    chain: polygonAmoy,
    address: exchange,
    abi: exchangeArtifact.abi,
    functionName: "matchOrders",
    args: [buyOrder, buySignature as Hex, sellOrder, sellSignature as Hex],
  }),
  "撮合 BUY/SELL 订单",
);

const [buyerUsd, sellerUsd, buyerYes, sellerYes] = await Promise.all([
  publicClient.readContract({
    address: collateral,
    abi: usd.abi,
    functionName: "balanceOf",
    args: [buyerWallet],
  }) as Promise<bigint>,
  publicClient.readContract({
    address: collateral,
    abi: usd.abi,
    functionName: "balanceOf",
    args: [sellerWallet],
  }) as Promise<bigint>,
  publicClient.readContract({
    address: outcomeToken,
    abi: outcome.abi,
    functionName: "balanceOf",
    args: [tokenId, buyerWallet],
  }) as Promise<bigint>,
  publicClient.readContract({
    address: outcomeToken,
    abi: outcome.abi,
    functionName: "balanceOf",
    args: [tokenId, sellerWallet],
  }) as Promise<bigint>,
]);
const result = {
  ...deployment,
  chainId,
  owner: account.address,
  collateral,
  outcomeToken,
  walletFactory,
  exchange,
  buyerWallet,
  sellerWallet,
  tokenId: tokenId.toString(),
  finalBalances: {
    buyerRUSD: formatUnits(buyerUsd, 6),
    sellerRUSD: formatUnits(sellerUsd, 6),
    buyerYES: formatUnits(buyerYes, 6),
    sellerYES: formatUnits(sellerYes, 6),
  },
};
fs.writeFileSync(deploymentPath, `${JSON.stringify(result, null, 2)}\n`);

console.log("研究版撮合验收通过：");
console.log(JSON.stringify(result.finalBalances, null, 2));
console.log(`部署记录：${deploymentPath}`);
