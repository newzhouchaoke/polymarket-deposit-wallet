import fs from "node:fs";
import path from "node:path";
import {
  formatEther,
  formatGwei,
  getAddress,
  isAddress,
  parseGwei,
  type Address,
  type Hex,
} from "viem";
import { polygonAmoy } from "viem/chains";
import { publicClient, signerClients } from "../src/chain.js";
import { AMOY_CHAIN_ID } from "../src/constants.js";
import {
  assertLiveAction,
  PROJECT_DIR,
  value,
} from "../src/env.js";

const UMA_COMMIT = "8b76cc9e0d46c6f7450a0adb0ddc0f5b0568c9cc";
const DEFAULT_CTF =
  "0x69308FB512518e39F9b16112fA8d994F4e2Bf8bB" as Address;
const UMA_FINDER =
  "0x28077B47Cd03326De7838926A63699849DD4fa87" as Address;
const UMA_OPTIMISTIC_ORACLE_V2 =
  "0x38fAc33bD20D4c4Cce085C0f347153C06CbA2968" as Address;

type UmaArtifact = {
  abi: readonly unknown[];
  bytecode: { object: Hex };
};

function gasFeeConfig(
  rpcMaxFeePerGas: bigint,
  rpcMaxPriorityFeePerGas?: bigint,
): {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas?: bigint;
  source: "rpc" | "configured-cap";
} {
  const configuredMax = value("AMOY_MAX_FEE_GWEI");
  const configuredPriority = value("AMOY_PRIORITY_FEE_GWEI");
  const maxFeePerGas = configuredMax
    ? parseGwei(configuredMax)
    : rpcMaxFeePerGas;
  const maxPriorityFeePerGas = configuredPriority
    ? parseGwei(configuredPriority)
    : rpcMaxPriorityFeePerGas && rpcMaxPriorityFeePerGas <= maxFeePerGas
      ? rpcMaxPriorityFeePerGas
      : configuredMax
        ? maxFeePerGas
        : rpcMaxPriorityFeePerGas;

  if (maxFeePerGas <= 0n) {
    throw new Error("AMOY_MAX_FEE_GWEI 必须大于 0");
  }
  if (
    maxPriorityFeePerGas !== undefined &&
    (maxPriorityFeePerGas < 0n || maxPriorityFeePerGas > maxFeePerGas)
  ) {
    throw new Error(
      "AMOY_PRIORITY_FEE_GWEI 必须大于等于 0，并且不能超过 AMOY_MAX_FEE_GWEI",
    );
  }
  return {
    maxFeePerGas,
    ...(maxPriorityFeePerGas !== undefined
      ? { maxPriorityFeePerGas }
      : {}),
    source:
      configuredMax || configuredPriority ? "configured-cap" : "rpc",
  };
}

function configuredCtf(): Address {
  const raw = value("UMA_CTF_TARGET", DEFAULT_CTF)!;
  if (!isAddress(raw)) throw new Error(`UMA_CTF_TARGET 地址无效：${raw}`);
  return getAddress(raw);
}

function readArtifact(): UmaArtifact {
  const artifactPath = path.resolve(
    PROJECT_DIR,
    "official",
    "uma-ctf-adapter",
    "out",
    "UmaCtfAdapter.sol",
    "UmaCtfAdapter.json",
  );
  if (!fs.existsSync(artifactPath)) {
    throw new Error(
      "缺少 UmaCtfAdapter artifact，请先运行 npm run official:uma:build",
    );
  }
  return JSON.parse(fs.readFileSync(artifactPath, "utf8")) as UmaArtifact;
}

const deploy = process.argv.includes("--deploy");
const client = publicClient();
const chainId = await client.getChainId();
if (chainId !== AMOY_CHAIN_ID) {
  throw new Error(`只允许 Polygon Amoy ${AMOY_CHAIN_ID}，当前 ${chainId}`);
}

const { account, walletClient } = signerClients();
const artifact = readArtifact();
const ctf = configuredCtf();
for (const [name, address] of Object.entries({
  ctf,
  finder: UMA_FINDER,
  optimisticOracleV2: UMA_OPTIMISTIC_ORACLE_V2,
})) {
  const code = await client.getCode({ address });
  if (!code || code === "0x") {
    throw new Error(`UMA Amoy 依赖 ${name} 没有合约代码：${address}`);
  }
}

const gasHex = await client.request({
  method: "eth_estimateGas",
  params: [
    {
      from: account.address,
      data: await (async () => {
        const { encodeDeployData } = await import("viem");
        return encodeDeployData({
          abi: artifact.abi,
          bytecode: artifact.bytecode.object,
          args: [ctf, UMA_FINDER, UMA_OPTIMISTIC_ORACLE_V2],
        });
      })(),
    },
  ],
});
const gas = BigInt(gasHex);
const fees = await client.estimateFeesPerGas();
const rpcMaxFeePerGas = fees.maxFeePerGas ?? fees.gasPrice;
if (!rpcMaxFeePerGas) throw new Error("RPC 没有返回可用 gas fee");
const {
  maxFeePerGas,
  maxPriorityFeePerGas,
  source: gasFeeSource,
} = gasFeeConfig(rpcMaxFeePerGas, fees.maxPriorityFeePerGas);
const balance = await client.getBalance({ address: account.address });
const estimatedMaxCost = gas * maxFeePerGas;
const requiredBalance = (estimatedMaxCost * 120n) / 100n;

console.log(
  JSON.stringify(
    {
      mode: deploy ? "DEPLOY" : "CHECK_ONLY",
      chainId,
      account: account.address,
      balancePOL: formatEther(balance),
      officialCommit: UMA_COMMIT,
      compiler: "0.8.15",
      optimizerRuns: 1_000_000,
      gasFeeSource,
      rpcSuggestedMaxFeePerGasGwei: formatGwei(rpcMaxFeePerGas),
      ctf,
      finder: UMA_FINDER,
      optimisticOracleV2: UMA_OPTIMISTIC_ORACLE_V2,
      estimatedGas: gas.toString(),
      maxFeePerGasGwei: formatGwei(maxFeePerGas),
      maxPriorityFeePerGasGwei:
        maxPriorityFeePerGas === undefined
          ? null
          : formatGwei(maxPriorityFeePerGas),
      estimatedMaxCostPOL: formatEther(estimatedMaxCost),
      requiredWith20PercentBufferPOL: formatEther(requiredBalance),
      sufficientBalance: balance >= requiredBalance,
    },
    null,
    2,
  ),
);

if (!deploy) process.exit(0);

assertLiveAction("DEPLOY_UMA_CTF_ADAPTER");
if (balance < requiredBalance) {
  throw new Error(
    `余额不足，当前 ${formatEther(balance)} POL，安全预算至少需要 ${formatEther(requiredBalance)} POL`,
  );
}

const hash = await walletClient.deployContract({
  account,
  chain: polygonAmoy,
  abi: artifact.abi,
  bytecode: artifact.bytecode.object,
  args: [ctf, UMA_FINDER, UMA_OPTIMISTIC_ORACLE_V2],
  gas: (gas * 110n) / 100n,
  maxFeePerGas,
  ...(maxPriorityFeePerGas ? { maxPriorityFeePerGas } : {}),
});
console.log(`UmaCtfAdapter 已广播：${hash}`);
const receipt = await client.waitForTransactionReceipt({ hash });
if (receipt.status !== "success" || !receipt.contractAddress) {
  throw new Error(`UmaCtfAdapter 部署失败：${hash}`);
}
const [isAdmin, configuredCtfAddress, code] = await Promise.all([
  client.readContract({
    address: receipt.contractAddress,
    abi: artifact.abi,
    functionName: "isAdmin",
    args: [account.address],
  }) as Promise<boolean>,
  client.readContract({
    address: receipt.contractAddress,
    abi: artifact.abi,
    functionName: "ctf",
  }) as Promise<Address>,
  client.getCode({ address: receipt.contractAddress }),
]);
if (
  !isAdmin ||
  getAddress(configuredCtfAddress) !== ctf ||
  !code ||
  code === "0x"
) {
  throw new Error("UmaCtfAdapter 部署后状态验证失败");
}

const deploymentPath = path.resolve(
  PROJECT_DIR,
  "deployments",
  "official-uma-amoy.json",
);
fs.writeFileSync(
  deploymentPath,
  `${JSON.stringify(
    {
      version: "official-uma-ctf-adapter",
      nonProductionResearchDeployment: true,
      license: "MIT",
      officialCommit: UMA_COMMIT,
      compiler: "0.8.15",
      optimizerRuns: 1_000_000,
      chainId,
      deployer: account.address,
      address: receipt.contractAddress,
      txHash: hash,
      blockNumber: receipt.blockNumber.toString(),
      gasUsed: receipt.gasUsed.toString(),
      runtimeCodeBytes: (code.length - 2) / 2,
      dependencies: {
        ctf,
        finder: UMA_FINDER,
        optimisticOracleV2: UMA_OPTIMISTIC_ORACLE_V2,
      },
      deployedAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`,
);
console.log(`UmaCtfAdapter：${receipt.contractAddress}`);
console.log(`部署记录：${deploymentPath}`);
