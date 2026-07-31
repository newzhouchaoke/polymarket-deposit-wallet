import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  fallback,
  getAddress,
  http,
  maxUint256,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygonAmoy } from "viem/chains";
import {
  OFFICIAL_MODE,
  erc20Abi,
  erc1155Abi,
} from "./exchange-config.mjs";
import {
  loadDeployment,
  privateKey,
  readArtifact,
} from "./order-utils.mjs";

const executeBatchAbi = [
  {
    type: "function",
    name: "executeBatch",
    stateMutability: "payable",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "value", type: "uint256" },
          { name: "data", type: "bytes" },
        ],
      },
    ],
    outputs: [{ name: "results", type: "bytes[]" }],
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

function rpcUrls() {
  const configured = process.env.AMOY_RPC_URLS || process.env.AMOY_RPC_URL;
  const preferred = configured
    ? configured.split(",").map((url) => url.trim()).filter(Boolean)
    : [];
  return [
    ...new Set([
      ...preferred,
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

function roleAccount(role, runtime) {
  const configured =
    runtime.mode === OFFICIAL_MODE
      ? process.env[`OFFICIAL_${role}_PRIVATE_KEY`]
      : undefined;
  const key = configured || privateKey();
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(`${role} 私钥格式无效`);
  }
  return privateKeyToAccount(key);
}

function roleSignatureType(role, runtime) {
  if (runtime.mode !== OFFICIAL_MODE) return 3;
  const result = Number(process.env[`OFFICIAL_${role}_SIGNATURE_TYPE`] ?? "1");
  if (![0, 1, 2, 3].includes(result)) {
    throw new Error(`OFFICIAL_${role}_SIGNATURE_TYPE 必须是 0、1、2 或 3`);
  }
  return result;
}

function assertLiveAction() {
  if (process.env.LIVE_ACTION !== "APPROVE_CURRENT_EXCHANGE") {
    throw new Error(
      "授权写入已拦截：请设置 LIVE_ACTION=APPROVE_CURRENT_EXCHANGE",
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

async function executeFromWallet({
  runtime,
  role,
  wallet,
  target,
  data,
  label,
  publicClient,
}) {
  const owner = roleAccount(role, runtime);
  const signatureType = roleSignatureType(role, runtime);
  const walletClient = createWalletClient({
    account: owner,
    chain: polygonAmoy,
    transport: transport(),
  });

  if (signatureType === 0) {
    if (owner.address.toLowerCase() !== wallet.toLowerCase()) {
      throw new Error(
        `${role} 使用 EOA 类型 0，但钱包 ${wallet} 不等于私钥地址 ${owner.address}`,
      );
    }
    return wait(
      publicClient,
      await walletClient.sendTransaction({
        account: owner,
        chain: polygonAmoy,
        to: target,
        data,
      }),
      label,
    );
  }

  if (signatureType === 1) {
    if (runtime.mode !== OFFICIAL_MODE) {
      throw new Error("官方 Proxy 签名类型只适用于 official-v2");
    }
    const proxyFactory = runtime.officialDependencies?.proxyFactory;
    if (!proxyFactory) throw new Error("官方部署记录缺少 proxyFactory");
    const derived = await publicClient.readContract({
      address: runtime.exchange,
      abi: exchangeWalletAbi,
      functionName: "getProxyWalletAddress",
      args: [owner.address],
    });
    if (getAddress(derived).toLowerCase() !== wallet.toLowerCase()) {
      throw new Error(
        `${role} 配置钱包 ${wallet} 不是 owner ${owner.address} 对应的官方 Proxy 地址 ${derived}`,
      );
    }
    return wait(
      publicClient,
      await walletClient.writeContract({
        account: owner,
        chain: polygonAmoy,
        address: proxyFactory,
        abi: proxyFactoryAbi,
        functionName: "proxy",
        args: [[{ typeCode: 1, to: target, value: 0n, data }]],
      }),
      `${label}（官方 Proxy）`,
    );
  }

  if (signatureType === 2) {
    throw new Error(
      `${role} 是官方 Safe 类型。请通过 Safe 交易或专用 Amoy Relayer 执行授权；本脚本不会伪造 Safe 多签执行。`,
    );
  }

  return wait(
    publicClient,
    await walletClient.writeContract({
      account: owner,
      chain: polygonAmoy,
      address: wallet,
      abi: executeBatchAbi,
      functionName: "executeBatch",
      args: [[{ target, value: 0n, data }]],
    }),
    `${label}（ERC-1271/executeBatch）`,
  );
}

assertLiveAction();
const runtime = loadDeployment();
if (!runtime.buyerWallet || !runtime.sellerWallet) {
  throw new Error(
    `${runtime.mode} 尚未配置 buyerWallet/sellerWallet，无法执行授权`,
  );
}

const publicClient = createPublicClient({
  chain: polygonAmoy,
  transport: transport(),
});
const chainId = await publicClient.getChainId();
if (chainId !== 80002) {
  throw new Error(`只允许 Polygon Amoy chainId=80002，当前 ${chainId}`);
}

const collateralAbi =
  runtime.mode === OFFICIAL_MODE
    ? erc20Abi
    : readArtifact("ResearchWalletCoin").abi;
const outcomeAbi =
  runtime.mode === OFFICIAL_MODE
    ? erc1155Abi
    : readArtifact("ResearchOutcomeToken").abi;

const buyerAllowance = await publicClient.readContract({
  address: runtime.collateral,
  abi: collateralAbi,
  functionName: "allowance",
  args: [runtime.buyerWallet, runtime.exchange],
});
let buyerApproveTx = "already-approved";
if (buyerAllowance === 0n) {
  buyerApproveTx = await executeFromWallet({
    runtime,
    role: "BUYER",
    wallet: runtime.buyerWallet,
    target: runtime.collateral,
    data: encodeFunctionData({
      abi: collateralAbi,
      functionName: "approve",
      args: [runtime.exchange, maxUint256],
    }),
    label: `BUYER 授权 ${runtime.collateralSymbol}`,
    publicClient,
  });
}

const sellerApproved = await publicClient.readContract({
  address: runtime.ctf,
  abi: outcomeAbi,
  functionName: "isApprovedForAll",
  args: [runtime.sellerWallet, runtime.exchange],
});
let sellerApproveTx = "already-approved";
if (!sellerApproved) {
  sellerApproveTx = await executeFromWallet({
    runtime,
    role: "SELLER",
    wallet: runtime.sellerWallet,
    target: runtime.ctf,
    data: encodeFunctionData({
      abi: outcomeAbi,
      functionName: "setApprovalForAll",
      args: [runtime.exchange, true],
    }),
    label: "SELLER 授权 CTF ERC-1155",
    publicClient,
  });
}

console.log(
  JSON.stringify(
    {
      mode: runtime.mode,
      variant: runtime.variant,
      exchange: runtime.exchange,
      buyerWallet: runtime.buyerWallet,
      sellerWallet: runtime.sellerWallet,
      buyerApproveTx,
      sellerApproveTx,
    },
    null,
    2,
  ),
);
