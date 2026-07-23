import fs from "node:fs";
import path from "node:path";
import {
  encodeFunctionData,
  formatUnits,
  maxUint256,
  parseGwei,
  parseUnits,
  stringToHex,
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

const GAS_OPTIONS = {
  maxFeePerGas: parseGwei("30"),
  maxPriorityFeePerGas: parseGwei("25"),
} as const;

type PartialDeployment = Partial<{
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

const deploymentPath = path.resolve(
  PROJECT_DIR,
  "deployments",
  "research-official-like-amoy.json",
);
const legacyResearchDeploymentPath = path.resolve(
  PROJECT_DIR,
  "deployments",
  "research-amoy.json",
);

function readDeployment(): PartialDeployment {
  const deployment = fs.existsSync(deploymentPath)
    ? (JSON.parse(fs.readFileSync(deploymentPath, "utf8")) as PartialDeployment)
    : {};
  if (fs.existsSync(legacyResearchDeploymentPath)) {
    const legacy = JSON.parse(
      fs.readFileSync(legacyResearchDeploymentPath, "utf8"),
    ) as Partial<{
      outcomeToken: Address;
      walletFactory: Address;
      buyerWallet: Address;
      sellerWallet: Address;
    }>;
    deployment.outcomeToken ??= legacy.outcomeToken;
    deployment.walletFactory ??= legacy.walletFactory;
    deployment.buyerWallet ??= legacy.buyerWallet;
    deployment.sellerWallet ??= legacy.sellerWallet;
  }
  return deployment;
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

async function ensureWallet(
  walletFactory: Address,
  factoryAbi: Artifact["abi"],
  owner: Address,
  saltText: string,
  label: string,
): Promise<Address> {
  const salt = stringToHex(saltText, { size: 32 });
  const wallet = (await publicClient.readContract({
    address: walletFactory,
    abi: factoryAbi,
    functionName: "getWallet",
    args: [owner, salt],
  })) as Address;
  const code = await publicClient.getCode({ address: wallet });
  if (code && code !== "0x") {
    console.log(`${label} Deposit Wallet 复用：${wallet}`);
    return wallet;
  }

  await wait(
    await walletClient.writeContract({
      account,
      chain: polygonAmoy,
      address: walletFactory,
      abi: factoryAbi,
      functionName: "createWallet",
      args: [owner, salt],
      ...GAS_OPTIONS,
    }),
    `创建 ${label} Deposit Wallet`,
  );
  console.log(`${label} Deposit Wallet 地址：${wallet}`);
  return wallet;
}

assertLiveAction("SIMULATE_RESEARCH_MARKET");
const { account, publicClient, walletClient } = signerClients();
const chainId = await publicClient.getChainId();
if (chainId !== AMOY_CHAIN_ID) throw new Error(`预期 Amoy 80002，当前 ${chainId}`);

const startingBalance = await publicClient.getBalance({ address: account.address });
console.log(`官方风格研究流程账户：${account.address}`);
console.log(`Amoy POL 余额：${formatUnits(startingBalance, 18)}`);
if (startingBalance < parseUnits("0.005", 18)) {
  throw new Error("测试 POL 不足；请补到至少 0.005 POL 后重新运行。");
}

const walletCoinArtifact = readArtifact("ResearchWalletCoin");
const outcomeArtifact = readArtifact("ResearchOutcomeToken");
const marketArtifact = readArtifact("ResearchMarketRegistry");
const factoryArtifact = readArtifact("ResearchDepositWalletFactory");
const walletArtifact = readArtifact("ResearchDepositWallet");
const exchangeArtifact = readArtifact("ResearchCLOBExchange");

const deployment = {
  ...readDeployment(),
  chainId,
  owner: account.address,
} satisfies PartialDeployment;
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
  "ResearchOutcomeToken",
  outcomeArtifact,
);
const marketRegistry = await deployOrReuse(
  deployment,
  "marketRegistry",
  "ResearchMarketRegistry",
  marketArtifact,
  [walletCoin, outcomeToken],
);
const walletFactory = await deployOrReuse(
  deployment,
  "walletFactory",
  "ResearchDepositWalletFactory",
  factoryArtifact,
);
const exchange = await deployOrReuse(
  deployment,
  "exchange",
  "ResearchCLOBExchange",
  exchangeArtifact,
  [walletCoin, outcomeToken, account.address],
);

const buyerWallet = deployment.buyerWallet
  ? deployment.buyerWallet
  : await ensureWallet(
      walletFactory,
      factoryArtifact.abi,
      account.address,
      "official-like-buyer-wallet",
      "buyer",
    );
deployment.buyerWallet = buyerWallet;
writeDeployment(deployment);

const sellerWallet = deployment.sellerWallet
  ? deployment.sellerWallet
  : await ensureWallet(
      walletFactory,
      factoryArtifact.abi,
      account.address,
      "official-like-seller-wallet",
      "seller",
    );
deployment.sellerWallet = sellerWallet;
writeDeployment(deployment);

const question = "Will this research Polymarket-like demo trade settle on Amoy?";
const closeTime = BigInt(Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60);
const [marketId, yesTokenId, noTokenId] = (await publicClient.readContract({
  address: marketRegistry,
  abi: marketArtifact.abi,
  functionName: "nextMarket",
  args: [account.address, question, closeTime],
})) as [Hex, bigint, bigint];

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
  "发布模拟预测事件/市场",
);

const buyerStartingCoin = parseUnits("100", 6);
const sellerStartingYes = parseUnits("10", 6);
const mintBuyerCoinTx = await wait(
  await walletClient.writeContract({
    account,
    chain: polygonAmoy,
    address: walletCoin,
    abi: walletCoinArtifact.abi,
    functionName: "mint",
    args: [buyerWallet, buyerStartingCoin],
    ...GAS_OPTIONS,
  }),
  "给 buyer Deposit Wallet 铸造 rWALLET",
);
const mintSellerYesTx = await wait(
  await walletClient.writeContract({
    account,
    chain: polygonAmoy,
    address: outcomeToken,
    abi: outcomeArtifact.abi,
    functionName: "mint",
    args: [sellerWallet, yesTokenId, sellerStartingYes],
    ...GAS_OPTIONS,
  }),
  "给 seller Deposit Wallet 铸造 YES outcome",
);

const approveWalletCoin = encodeFunctionData({
  abi: walletCoinArtifact.abi,
  functionName: "approve",
  args: [exchange, maxUint256],
});
const approveOutcome = encodeFunctionData({
  abi: outcomeArtifact.abi,
  functionName: "setApprovalForAll",
  args: [exchange, true],
});
const existingBuyerAllowance = (await publicClient.readContract({
  address: walletCoin,
  abi: walletCoinArtifact.abi,
  functionName: "allowance",
  args: [buyerWallet, exchange],
})) as bigint;
const buyerApproveTx =
  existingBuyerAllowance > 0n
    ? "already-approved"
    : await wait(
        await walletClient.writeContract({
          account,
          chain: polygonAmoy,
          address: buyerWallet,
          abi: walletArtifact.abi,
          functionName: "executeBatch",
          args: [[{ target: walletCoin, value: 0n, data: approveWalletCoin }]],
          ...GAS_OPTIONS,
        }),
        "buyer Deposit Wallet 授权 rWALLET 给 Exchange",
      );
if (buyerApproveTx === "already-approved") {
  console.log("buyer Deposit Wallet 已授权 rWALLET，跳过");
}

const existingSellerApproval = (await publicClient.readContract({
  address: outcomeToken,
  abi: outcomeArtifact.abi,
  functionName: "isApprovedForAll",
  args: [sellerWallet, exchange],
})) as boolean;
const sellerApproveTx = existingSellerApproval
  ? "already-approved"
  : await wait(
      await walletClient.writeContract({
        account,
        chain: polygonAmoy,
        address: sellerWallet,
        abi: walletArtifact.abi,
        functionName: "executeBatch",
        args: [[{ target: outcomeToken, value: 0n, data: approveOutcome }]],
        ...GAS_OPTIONS,
      }),
      "seller Deposit Wallet 授权 YES/NO 给 Exchange",
    );
if (sellerApproveTx === "already-approved") {
  console.log("seller Deposit Wallet 已授权 YES/NO，跳过");
}

const salt = BigInt(Date.now());
const buyOrder = {
  maker: buyerWallet,
  signer: buyerWallet,
  tokenId: yesTokenId,
  makerAmount: parseUnits("0.60", 6),
  takerAmount: parseUnits("1", 6),
  side: 0,
  expiration: 0n,
  salt,
};
const sellOrder = {
  maker: sellerWallet,
  signer: sellerWallet,
  tokenId: yesTokenId,
  makerAmount: parseUnits("1", 6),
  takerAmount: parseUnits("0.55", 6),
  side: 1,
  expiration: 0n,
  salt: salt + 1n,
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

const matchTx = await wait(
  await walletClient.writeContract({
    account,
    chain: polygonAmoy,
    address: exchange,
    abi: exchangeArtifact.abi,
    functionName: "matchOrders",
    args: [buyOrder, buySignature as Hex, sellOrder, sellSignature as Hex],
    ...GAS_OPTIONS,
  }),
  "签名订单撮合 YES 买入/卖出订单",
);

const [buyerCoin, sellerCoin, buyerYes, sellerYes] = await Promise.all([
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
    args: [sellerWallet],
  }) as Promise<bigint>,
  publicClient.readContract({
    address: outcomeToken,
    abi: outcomeArtifact.abi,
    functionName: "balanceOf",
    args: [yesTokenId, buyerWallet],
  }) as Promise<bigint>,
  publicClient.readContract({
    address: outcomeToken,
    abi: outcomeArtifact.abi,
    functionName: "balanceOf",
    args: [yesTokenId, sellerWallet],
  }) as Promise<bigint>,
]);

const result = {
  ...deployment,
  chainId,
  owner: account.address,
  walletCoin,
  outcomeToken,
  marketRegistry,
  walletFactory,
  exchange,
  buyerWallet,
  sellerWallet,
  market: {
    marketId,
    question,
    closeTime: closeTime.toString(),
    yesTokenId: yesTokenId.toString(),
    noTokenId: noTokenId.toString(),
  },
  orders: {
    buyOrder: {
      ...buyOrder,
      tokenId: buyOrder.tokenId.toString(),
      makerAmount: buyOrder.makerAmount.toString(),
      takerAmount: buyOrder.takerAmount.toString(),
      expiration: buyOrder.expiration.toString(),
      salt: buyOrder.salt.toString(),
      signature: buySignature,
    },
    sellOrder: {
      ...sellOrder,
      tokenId: sellOrder.tokenId.toString(),
      makerAmount: sellOrder.makerAmount.toString(),
      takerAmount: sellOrder.takerAmount.toString(),
      expiration: sellOrder.expiration.toString(),
      salt: sellOrder.salt.toString(),
      signature: sellSignature,
    },
  },
  txs: {
    publishTx,
    mintBuyerCoinTx,
    mintSellerYesTx,
    buyerApproveTx,
    sellerApproveTx,
    matchTx,
  },
  finalBalances: {
    buyerRWALLET: formatUnits(buyerCoin, 6),
    sellerRWALLET: formatUnits(sellerCoin, 6),
    buyerYES: formatUnits(buyerYes, 6),
    sellerYES: formatUnits(sellerYes, 6),
  },
};
writeDeployment(result);

console.log("官方风格研究流程完成：");
console.log(JSON.stringify(result.finalBalances, null, 2));
console.log(`YES tokenId：${yesTokenId}`);
console.log(`NO tokenId：${noTokenId}`);
console.log(`撮合交易：https://amoy.polygonscan.com/tx/${matchTx}`);
console.log(`部署/模拟记录：${deploymentPath}`);
