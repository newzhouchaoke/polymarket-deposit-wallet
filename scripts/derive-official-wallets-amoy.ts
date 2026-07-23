import fs from "node:fs";
import path from "node:path";
import { getAddress, isAddress, type Address } from "viem";
import { publicClient, signerClients } from "../src/chain.js";
import { AMOY_CHAIN_ID } from "../src/constants.js";
import { PROJECT_DIR, value } from "../src/env.js";

const STANDARD_REFERENCE =
  "0xE111180000d2663C0091e4f400237545B87B996B" as Address;
const NEG_RISK_REFERENCE =
  "0xe2222d279d744050d28e00520010520000310F59" as Address;

const walletDerivationAbi = [
  {
    type: "function",
    name: "getProxyWalletAddress",
    stateMutability: "view",
    inputs: [{ name: "_addr", type: "address" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "getSafeWalletAddress",
    stateMutability: "view",
    inputs: [{ name: "_addr", type: "address" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "getProxyFactory",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "getSafeFactory",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

type DeploymentFile = {
  contracts?: Record<string, { address?: string }>;
};

function ownerAddress(): Address {
  const configured = value("OFFICIAL_WALLET_OWNER");
  if (configured) {
    if (!isAddress(configured)) {
      throw new Error(`OFFICIAL_WALLET_OWNER 地址无效：${configured}`);
    }
    return getAddress(configured);
  }
  return signerClients().account.address;
}

function selectedExchanges(): Array<{ name: string; address: Address }> {
  const selected: Array<{ name: string; address: Address }> = [
    { name: "officialAmoyStandardReference", address: STANDARD_REFERENCE },
    { name: "officialAmoyNegRiskReference", address: NEG_RISK_REFERENCE },
  ];
  const deploymentPath = path.resolve(
    PROJECT_DIR,
    "deployments",
    "official-v2-amoy.json",
  );
  if (!fs.existsSync(deploymentPath)) return selected;

  const deployment = JSON.parse(
    fs.readFileSync(deploymentPath, "utf8"),
  ) as DeploymentFile;
  for (const [variant, contract] of Object.entries(
    deployment.contracts ?? {},
  )) {
    if (contract.address && isAddress(contract.address)) {
      selected.push({
        name: `localAmoy${variant}`,
        address: getAddress(contract.address),
      });
    }
  }
  return selected;
}

const client = publicClient();
const chainId = await client.getChainId();
if (chainId !== AMOY_CHAIN_ID) {
  throw new Error(`只允许 Polygon Amoy ${AMOY_CHAIN_ID}，当前 ${chainId}`);
}

const owner = ownerAddress();
const results = [];
for (const exchange of selectedExchanges()) {
  const code = await client.getCode({ address: exchange.address });
  if (!code || code === "0x") {
    throw new Error(`${exchange.name} 没有合约代码：${exchange.address}`);
  }
  const [proxyWallet, safeWallet, proxyFactory, safeFactory] =
    await Promise.all([
      client.readContract({
        address: exchange.address,
        abi: walletDerivationAbi,
        functionName: "getProxyWalletAddress",
        args: [owner],
      }),
      client.readContract({
        address: exchange.address,
        abi: walletDerivationAbi,
        functionName: "getSafeWalletAddress",
        args: [owner],
      }),
      client.readContract({
        address: exchange.address,
        abi: walletDerivationAbi,
        functionName: "getProxyFactory",
      }),
      client.readContract({
        address: exchange.address,
        abi: walletDerivationAbi,
        functionName: "getSafeFactory",
      }),
    ]);
  const [proxyCode, safeCode] = await Promise.all([
    client.getCode({ address: proxyWallet }),
    client.getCode({ address: safeWallet }),
  ]);
  results.push({
    exchange: exchange.name,
    exchangeAddress: exchange.address,
    proxyFactory,
    safeFactory,
    proxyWallet,
    proxyWalletDeployed: Boolean(proxyCode && proxyCode !== "0x"),
    safeWallet,
    safeWalletDeployed: Boolean(safeCode && safeCode !== "0x"),
  });
}

console.log(
  JSON.stringify(
    {
      mode: "READ_ONLY",
      chainId,
      owner,
      note:
        "地址由官方 CTF Exchange V2 的 getProxyWalletAddress/getSafeWalletAddress 计算；计算地址不等于钱包已经部署。",
      results,
    },
    null,
    2,
  ),
);
