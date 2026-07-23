import { formatUnits, formatEther, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { relayClient } from "../src/builder.js";
import { publicClient } from "../src/chain.js";
import {
  ADDRESSES,
  ERC1155_ABI,
  ERC20_ABI,
} from "../src/constants.js";
import {
  address,
  chainId,
  hasDedicatedTestnetRelayer,
  privateKey,
  value,
} from "../src/env.js";

const client = publicClient();
const owner = privateKeyToAccount(privateKey()).address;
const relayer = relayClient();
const derivedWallet = getAddress(await relayer.deriveDepositWalletAddress());
const configuredWallet = value("DEPOSIT_WALLET")
  ? address("DEPOSIT_WALLET")
  : undefined;
const wallet = configuredWallet ?? derivedWallet;

const [network, block, ownerBalance, walletCode] = await Promise.all([
  client.getChainId(),
  client.getBlockNumber(),
  client.getBalance({ address: owner }),
  client.getCode({ address: wallet }),
]);
if (network !== chainId()) throw new Error(`RPC chainId 异常：${network}`);

console.log("=== Polygon Amoy / Deposit Wallet 只读检查 ===");
console.log(`区块: ${block}`);
console.log(`Owner: ${owner}`);
console.log(`Owner 测试 POL: ${formatEther(ownerBalance)}`);
console.log(`SDK 推导 Deposit Wallet: ${derivedWallet}`);
console.log(`检查 Wallet: ${wallet}`);
console.log(`Wallet 已上链: ${walletCode && walletCode !== "0x" ? "是" : "否"}`);
if (configuredWallet && configuredWallet !== derivedWallet) {
  console.warn("警告：DEPOSIT_WALLET 与当前私钥推导地址不同");
}

console.log("\n=== 官方 Amoy 合约代码 ===");
for (const [name, contractAddress] of Object.entries(ADDRESSES)) {
  const code = await client.getCode({ address: contractAddress });
  console.log(`${name}: ${code && code !== "0x" ? "已部署" : "无代码"} (${contractAddress})`);
}

const [decimals, collateralBalance, exchangeAllowance, negRiskAllowance] =
  await Promise.all([
    client.readContract({
      address: ADDRESSES.pUsd,
      abi: ERC20_ABI,
      functionName: "decimals",
    }),
    client.readContract({
      address: ADDRESSES.pUsd,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [wallet],
    }),
    client.readContract({
      address: ADDRESSES.pUsd,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [wallet, ADDRESSES.ctfExchange],
    }),
    client.readContract({
      address: ADDRESSES.pUsd,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [wallet, ADDRESSES.negRiskExchange],
    }),
  ]);

console.log("\n=== Wallet 交易准备度 ===");
console.log(`pUSD 余额: ${formatUnits(collateralBalance, decimals)}`);
console.log(`CTF Exchange pUSD allowance: ${formatUnits(exchangeAllowance, decimals)}`);
console.log(`NegRisk Exchange pUSD allowance: ${formatUnits(negRiskAllowance, decimals)}`);

for (const [name, exchange] of [
  ["CTF Exchange", ADDRESSES.ctfExchange],
  ["NegRisk Exchange", ADDRESSES.negRiskExchange],
] as const) {
  const approved = await client.readContract({
    address: ADDRESSES.ctf,
    abi: ERC1155_ABI,
    functionName: "isApprovedForAll",
    args: [wallet, exchange],
  });
  console.log(`${name} CTF approvalForAll: ${approved}`);
}

const tokenId = value("TOKEN_ID");
if (tokenId) {
  const conditionalBalance = await client.readContract({
    address: ADDRESSES.ctf,
    abi: ERC1155_ABI,
    functionName: "balanceOf",
    args: [wallet, BigInt(tokenId)],
  });
  console.log(`TOKEN_ID 余额: ${formatUnits(conditionalBalance, 6)}`);
}

if (hasDedicatedTestnetRelayer()) {
  try {
    console.log(
      `Amoy Relayer 钱包登记: ${await relayer.getDeployed(wallet, "WALLET") ? "是" : "否"}`,
    );
  } catch (error) {
    console.warn(
      `Amoy Relayer 钱包登记查询失败: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
} else {
  console.log("Amoy Relayer 钱包登记: 跳过（未配置专用 RELAYER_TESTNET_URL）");
}
