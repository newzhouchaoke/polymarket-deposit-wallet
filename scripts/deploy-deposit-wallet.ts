import { getAddress } from "viem";
import { relayClient } from "../src/builder.js";
import { publicClient } from "../src/chain.js";
import {
  assertDedicatedAmoyRelayer,
  assertLiveAction,
} from "../src/env.js";

async function main(): Promise<void> {
  assertLiveAction("DEPLOY_DEPOSIT_WALLET");
  assertDedicatedAmoyRelayer();

  const relayer = relayClient();
  const wallet = getAddress(await relayer.deriveDepositWalletAddress());
  const client = publicClient();
  const existingCode = await client.getCode({ address: wallet });
  if (existingCode && existingCode !== "0x") {
    console.log(`Deposit Wallet 已部署，无需重复操作：${wallet}`);
    return;
  }

  console.log(`提交 Amoy Deposit Wallet 部署：${wallet}`);
  const response = await relayer.deployDepositWallet();
  const confirmed = await response.wait();
  if (!confirmed) throw new Error("Relayer 未返回确认结果");
  const code = await client.getCode({ address: wallet });
  if (!code || code === "0x") {
    throw new Error("Relayer 已返回，但链上仍未发现钱包代码");
  }
  console.log(`Deposit Wallet 部署成功：${wallet}`);
  console.log(`交易哈希：${confirmed.transactionHash}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('"status":401')) {
    console.error(
      "部署未提交：官方 relayer 返回 401。请配置有效的 RELAYER_API_KEY（推荐），或旧版 BUILDER_API_KEY/SECRET/PASS_PHRASE。",
    );
  } else {
    console.error(message);
  }
  process.exitCode = 1;
});
