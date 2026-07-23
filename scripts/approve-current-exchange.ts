import fs from "node:fs";
import path from "node:path";
import { encodeFunctionData, maxUint256, parseGwei, type Address, type Hash } from "viem";
import { polygonAmoy } from "viem/chains";
import { readArtifact } from "../src/artifact.js";
import { signerClients } from "../src/chain.js";
import { assertLiveAction, PROJECT_DIR } from "../src/env.js";

type Deployment = {
  walletCoin: Address;
  outcomeToken: Address;
  exchange: Address;
  buyerWallet: Address;
  sellerWallet: Address;
  txs?: Record<string, string>;
};

const deploymentPath = path.resolve(
  PROJECT_DIR,
  "deployments",
  "research-official-like-amoy.json",
);

async function wait(hash: Hash, label: string): Promise<Hash> {
  const { publicClient } = signerClients();
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} 失败：${hash}`);
  console.log(`${label} 成功：${hash}`);
  return hash;
}

assertLiveAction("APPROVE_RESEARCH_EXCHANGE");
const { account, publicClient, walletClient } = signerClients();
const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8")) as Deployment;
const walletCoinArtifact = readArtifact("ResearchWalletCoin");
const outcomeArtifact = readArtifact("ResearchOutcomeToken");
const walletArtifact = readArtifact("ResearchDepositWallet");

const approveWalletCoin = encodeFunctionData({
  abi: walletCoinArtifact.abi,
  functionName: "approve",
  args: [deployment.exchange, maxUint256],
});
const approveOutcome = encodeFunctionData({
  abi: outcomeArtifact.abi,
  functionName: "setApprovalForAll",
  args: [deployment.exchange, true],
});

const buyerAllowance = (await publicClient.readContract({
  address: deployment.walletCoin,
  abi: walletCoinArtifact.abi,
  functionName: "allowance",
  args: [deployment.buyerWallet, deployment.exchange],
})) as bigint;

let buyerApproveTx = "already-approved";
if (buyerAllowance === 0n) {
  buyerApproveTx = await wait(
    await walletClient.writeContract({
      account,
      chain: polygonAmoy,
      address: deployment.buyerWallet,
      abi: walletArtifact.abi,
      functionName: "executeBatch",
      args: [[{ target: deployment.walletCoin, value: 0n, data: approveWalletCoin }]],
      maxFeePerGas: parseGwei("30"),
      maxPriorityFeePerGas: parseGwei("25"),
    }),
    "buyer Deposit Wallet 授权 rWALLET 给当前 Exchange",
  );
} else {
  console.log("buyer Deposit Wallet 已授权当前 Exchange，跳过");
}

const sellerApproved = (await publicClient.readContract({
  address: deployment.outcomeToken,
  abi: outcomeArtifact.abi,
  functionName: "isApprovedForAll",
  args: [deployment.sellerWallet, deployment.exchange],
})) as boolean;

let sellerApproveTx = "already-approved";
if (!sellerApproved) {
  sellerApproveTx = await wait(
    await walletClient.writeContract({
      account,
      chain: polygonAmoy,
      address: deployment.sellerWallet,
      abi: walletArtifact.abi,
      functionName: "executeBatch",
      args: [[{ target: deployment.outcomeToken, value: 0n, data: approveOutcome }]],
      maxFeePerGas: parseGwei("30"),
      maxPriorityFeePerGas: parseGwei("25"),
    }),
    "seller Deposit Wallet 授权 YES/NO 给当前 Exchange",
  );
} else {
  console.log("seller Deposit Wallet 已授权当前 Exchange，跳过");
}

deployment.txs = {
  ...(deployment.txs ?? {}),
  currentExchangeBuyerApproveTx: buyerApproveTx,
  currentExchangeSellerApproveTx: sellerApproveTx,
};
fs.writeFileSync(deploymentPath, `${JSON.stringify(deployment, null, 2)}\n`);
console.log(`当前 Exchange 授权完成：${deployment.exchange}`);
