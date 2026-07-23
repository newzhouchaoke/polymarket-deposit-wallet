import {
  createPublicClient,
  createWalletClient,
  fallback,
  http,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygonAmoy } from "viem/chains";
import { amoyRpcUrls, privateKey } from "./env.js";

function amoyTransport() {
  return fallback(
    amoyRpcUrls().map((url) =>
      http(url, {
        retryCount: 1,
        timeout: 10_000,
      }),
    ),
    { rank: false },
  );
}

export function publicClient(): PublicClient {
  return createPublicClient({
    chain: polygonAmoy,
    transport: amoyTransport(),
  });
}

export function signerClients(): {
  account: ReturnType<typeof privateKeyToAccount>;
  publicClient: PublicClient;
  walletClient: WalletClient;
} {
  const account = privateKeyToAccount(privateKey());
  return {
    account,
    publicClient: publicClient(),
    walletClient: createWalletClient({
      account,
      chain: polygonAmoy,
      transport: amoyTransport(),
    }),
  };
}
