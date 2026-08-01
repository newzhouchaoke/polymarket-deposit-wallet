import fs from "node:fs";
import path from "node:path";
import {
  encodeDeployData,
  formatEther,
  formatGwei,
  getAddress,
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

const OFFICIAL_COMMIT = "ccc0596074f4dfd62c944fbca4de252893b82b4b";
const STANDARD_REFERENCE =
  "0xE111180000d2663C0091e4f400237545B87B996B" as Address;
const NEG_RISK_REFERENCE =
  "0xe2222d279d744050d28e00520010520000310F59" as Address;

const getterAbi = [
  "getCollateral",
  "getCtf",
  "getCtfCollateral",
  "getOutcomeTokenFactory",
  "getProxyFactory",
  "getSafeFactory",
] .map((name) => ({
  type: "function" as const,
  name,
  stateMutability: "view" as const,
  inputs: [],
  outputs: [{ type: "address" as const }],
}));

const roleAbi = [
  {
    type: "function" as const,
    name: "isAdmin",
    stateMutability: "view" as const,
    inputs: [{ type: "address" as const }],
    outputs: [{ type: "bool" as const }],
  },
  {
    type: "function" as const,
    name: "isOperator",
    stateMutability: "view" as const,
    inputs: [{ type: "address" as const }],
    outputs: [{ type: "bool" as const }],
  },
];

type OfficialArtifact = {
  abi: readonly unknown[];
  bytecode: { object: Hex };
  deployedBytecode: { object: Hex };
  metadata?: string;
};

type Dependencies = {
  collateral: Address;
  ctf: Address;
  ctfCollateral: Address;
  outcomeTokenFactory: Address;
  proxyFactory: Address;
  safeFactory: Address;
};

type Candidate = {
  name: "standard" | "negRisk";
  reference: Address;
  dependencies: Dependencies;
  params: Dependencies & {
    admin: Address;
    feeReceiver: Address;
  };
  gas: bigint;
  data: Hex;
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

function readArtifact(): OfficialArtifact {
  const artifactPath = path.resolve(
    PROJECT_DIR,
    "official",
    "ctf-exchange-v2",
    "out",
    "CTFExchange.sol",
    "CTFExchange.json",
  );
  if (!fs.existsSync(artifactPath)) {
    throw new Error(
      "缺少官方 CTFExchange artifact，请先运行 npm run official:build",
    );
  }
  return JSON.parse(fs.readFileSync(artifactPath, "utf8")) as OfficialArtifact;
}

async function readDependencies(reference: Address): Promise<Dependencies> {
  const client = publicClient();
  const names = [
    "getCollateral",
    "getCtf",
    "getCtfCollateral",
    "getOutcomeTokenFactory",
    "getProxyFactory",
    "getSafeFactory",
  ] as const;
  const values = await Promise.all(
    names.map((functionName) =>
      client.readContract({
        address: reference,
        abi: getterAbi,
        functionName,
      }) as Promise<Address>,
    ),
  );
  const dependencies = Object.fromEntries(
    names.map((name, index) => [name.slice(3, 4).toLowerCase() + name.slice(4), getAddress(values[index])]),
  ) as Dependencies;

  for (const [name, address] of Object.entries(dependencies)) {
    const code = await client.getCode({ address });
    if (!code || code === "0x") {
      throw new Error(`官方 Amoy 依赖 ${name} 没有合约代码：${address}`);
    }
  }
  return dependencies;
}

async function estimateCandidate(
  artifact: OfficialArtifact,
  name: Candidate["name"],
  reference: Address,
  admin: Address,
): Promise<Candidate> {
  const dependencies = await readDependencies(reference);
  const params = {
    admin,
    ...dependencies,
    feeReceiver: admin,
  };
  const data = encodeDeployData({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
    args: [params],
  });
  const client = publicClient();
  const gasHex = await client.request({
    method: "eth_estimateGas",
    params: [{ from: admin, data }],
  });
  return {
    name,
    reference,
    dependencies,
    params,
    gas: BigInt(gasHex),
    data,
  };
}

function selectedVariants(): Candidate["name"][] {
  const variant = value("OFFICIAL_V2_VARIANT", "all")?.toLowerCase();
  if (variant === "all") return ["standard", "negRisk"];
  if (variant === "standard") return ["standard"];
  if (variant === "neg-risk" || variant === "negrisk") return ["negRisk"];
  throw new Error(
    "OFFICIAL_V2_VARIANT 必须是 standard、neg-risk 或 all",
  );
}

const deploy = process.argv.includes("--deploy");
const client = publicClient();
const chainId = await client.getChainId();
if (chainId !== AMOY_CHAIN_ID) {
  throw new Error(`只允许 Polygon Amoy ${AMOY_CHAIN_ID}，当前 ${chainId}`);
}

const artifact = readArtifact();
const { account, walletClient } = signerClients();
const variants = selectedVariants();
const references = {
  standard: STANDARD_REFERENCE,
  negRisk: NEG_RISK_REFERENCE,
} as const;
const candidates: Candidate[] = [];
for (const name of variants) {
  candidates.push(
    await estimateCandidate(artifact, name, references[name], account.address),
  );
}

const fees = await client.estimateFeesPerGas();
const rpcMaxFeePerGas = fees.maxFeePerGas ?? fees.gasPrice;
if (!rpcMaxFeePerGas) throw new Error("RPC 没有返回可用 gas fee");
const {
  maxFeePerGas,
  maxPriorityFeePerGas,
  source: gasFeeSource,
} = gasFeeConfig(rpcMaxFeePerGas, fees.maxPriorityFeePerGas);
const balance = await client.getBalance({ address: account.address });
const estimatedMaxCost = candidates.reduce(
  (total, candidate) => total + candidate.gas * maxFeePerGas,
  0n,
);
const requiredBalance = (estimatedMaxCost * 120n) / 100n;

console.log(
  JSON.stringify(
    {
      mode: deploy ? "DEPLOY" : "CHECK_ONLY",
      chainId,
      account: account.address,
      balancePOL: formatEther(balance),
      officialCommit: OFFICIAL_COMMIT,
      compiler: "0.8.34",
      optimizerRuns: 1_000_000,
      gasFeeSource,
      rpcSuggestedMaxFeePerGasGwei: formatGwei(rpcMaxFeePerGas),
      maxFeePerGasGwei: formatGwei(maxFeePerGas),
      maxPriorityFeePerGasGwei:
        maxPriorityFeePerGas === undefined
          ? null
          : formatGwei(maxPriorityFeePerGas),
      candidates: candidates.map((candidate) => ({
        variant: candidate.name,
        reference: candidate.reference,
        estimatedGas: candidate.gas.toString(),
        estimatedMaxCostPOL: formatEther(
          candidate.gas * maxFeePerGas,
        ),
        dependencies: candidate.dependencies,
      })),
      estimatedMaxCostPOL: formatEther(estimatedMaxCost),
      requiredWith20PercentBufferPOL: formatEther(requiredBalance),
      sufficientBalance: balance >= requiredBalance,
    },
    null,
    2,
  ),
);

if (!deploy) process.exit(0);

assertLiveAction("DEPLOY_OFFICIAL_V2");
if (balance < requiredBalance) {
  throw new Error(
    `余额不足，当前 ${formatEther(balance)} POL，安全预算至少需要 ${formatEther(requiredBalance)} POL`,
  );
}

const deploymentPath = path.resolve(
  PROJECT_DIR,
  "deployments",
  "official-v2-amoy.json",
);
const deployment: Record<string, unknown> = {
  version: "official-ctf-exchange-v2",
  nonProductionResearchDeployment: true,
  license: "BUSL-1.1",
  officialCommit: OFFICIAL_COMMIT,
  compiler: "0.8.34",
  optimizerRuns: 1_000_000,
  chainId,
  deployer: account.address,
  deployedAt: new Date().toISOString(),
  contracts: {},
};

for (const candidate of candidates) {
  const hash = await walletClient.deployContract({
    account,
    chain: polygonAmoy,
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
    args: [candidate.params],
    gas: (candidate.gas * 110n) / 100n,
    maxFeePerGas,
    ...(maxPriorityFeePerGas ? { maxPriorityFeePerGas } : {}),
  });
  console.log(`${candidate.name} CTFExchange 已广播：${hash}`);
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) {
    throw new Error(`${candidate.name} CTFExchange 部署失败：${hash}`);
  }
  const address = receipt.contractAddress;
  const [isAdmin, isOperator, code] = await Promise.all([
    client.readContract({
      address,
      abi: roleAbi,
      functionName: "isAdmin",
      args: [account.address],
    }),
    client.readContract({
      address,
      abi: roleAbi,
      functionName: "isOperator",
      args: [account.address],
    }),
    client.getCode({ address }),
  ]);
  if (!isAdmin || !isOperator || !code || code === "0x") {
    throw new Error(`${candidate.name} 部署后的角色或代码验证失败`);
  }
  (deployment.contracts as Record<string, unknown>)[candidate.name] = {
    address,
    txHash: hash,
    blockNumber: receipt.blockNumber.toString(),
    gasUsed: receipt.gasUsed.toString(),
    runtimeCodeBytes: (code.length - 2) / 2,
    dependencies: candidate.dependencies,
  };
  fs.writeFileSync(
    deploymentPath,
    `${JSON.stringify(deployment, null, 2)}\n`,
  );
  console.log(`${candidate.name} CTFExchange：${address}`);
}

console.log(`官方 V2 Amoy 部署记录：${deploymentPath}`);
