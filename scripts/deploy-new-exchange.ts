import fs from "node:fs";
import path from "node:path";
import { formatUnits, parseGwei, parseUnits, type Address } from "viem";
import { polygonAmoy } from "viem/chains";
import { readArtifact } from "../src/artifact.js";
import { signerClients } from "../src/chain.js";
import { AMOY_CHAIN_ID } from "../src/constants.js";
import { assertLiveAction, PROJECT_DIR } from "../src/env.js";

const deploymentPath = path.resolve(
  PROJECT_DIR,
  "deployments",
  "research-v2-amoy.json",
);

type Deployment = {
  chainId: number;
  owner: Address;
  walletCoin: Address;
  outcomeToken: Address;
  walletFactory: Address;
  exchange?: Address;
  previousExchanges?: Address[];
  txs?: Record<string, string>;
};

assertLiveAction("DEPLOY_NEW_RESEARCH_EXCHANGE");
const { account, publicClient, walletClient } = signerClients();
const chainId = await publicClient.getChainId();
if (chainId !== AMOY_CHAIN_ID) throw new Error(`预期 Amoy 80002，当前 ${chainId}`);

const balance = await publicClient.getBalance({ address: account.address });
console.log(`部署账户：${account.address}`);
console.log(`Amoy POL 余额：${formatUnits(balance, 18)}`);
if (balance < parseUnits("0.005", 18)) {
  throw new Error("测试 POL 不足；请补到至少 0.005 POL 后重新运行。");
}

if (!fs.existsSync(deploymentPath)) {
  throw new Error(`缺少部署记录：${deploymentPath}`);
}
const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8")) as Deployment;
if (!deployment.walletCoin || !deployment.outcomeToken || !deployment.walletFactory) {
  throw new Error("部署记录缺少 walletCoin/outcomeToken/walletFactory");
}

const artifact = readArtifact("ResearchCLOBExchange");
const hash = await walletClient.deployContract({
  account,
  chain: polygonAmoy,
  abi: artifact.abi,
  bytecode: artifact.bytecode,
  args: [
    deployment.walletCoin,
    deployment.outcomeToken,
    deployment.walletFactory,
    account.address,
    account.address,
    account.address,
  ],
  maxFeePerGas: parseGwei("30"),
  maxPriorityFeePerGas: parseGwei("25"),
});
console.log(`ResearchCLOBExchange 新版广播：${hash}`);
const receipt = await publicClient.waitForTransactionReceipt({ hash });
if (receipt.status !== "success" || !receipt.contractAddress) {
  throw new Error(`新版 Exchange 部署失败：${hash}`);
}

const previous = deployment.exchange;
deployment.previousExchanges = [
  ...new Set([...(deployment.previousExchanges ?? []), ...(previous ? [previous] : [])]),
];
deployment.exchange = receipt.contractAddress;
const outcomeArtifact = readArtifact("ResearchOutcomeToken");
const configureHash = await walletClient.writeContract({
  account,
  chain: polygonAmoy,
  address: deployment.outcomeToken,
  abi: outcomeArtifact.abi,
  functionName: "setExchange",
  args: [receipt.contractAddress],
  maxFeePerGas: parseGwei("30"),
  maxPriorityFeePerGas: parseGwei("25"),
});
const configureReceipt = await publicClient.waitForTransactionReceipt({ hash: configureHash });
if (configureReceipt.status !== "success") {
  throw new Error(`设置 OutcomeToken Exchange 失败：${configureHash}`);
}
deployment.txs = {
  ...(deployment.txs ?? {}),
  deployExchangeTx: hash,
  configureExchangeTx: configureHash,
};
fs.writeFileSync(deploymentPath, `${JSON.stringify(deployment, null, 2)}\n`);

console.log(`ResearchCLOBExchange 新版地址：${receipt.contractAddress}`);
console.log(`部署记录已更新：${deploymentPath}`);
