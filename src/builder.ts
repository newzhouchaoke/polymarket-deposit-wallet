import {
  RelayClient,
  type DepositWalletCall,
} from "@polymarket/builder-relayer-client";
import {
  BuilderConfig,
  type BuilderApiKeyCreds,
} from "@polymarket/builder-signing-sdk";
import { polygonAmoy } from "viem/chains";
import { signerClients } from "./chain.js";
import { chainId, relayerUrl, value } from "./env.js";

function optionalBuilderConfig(): BuilderConfig | undefined {
  if (value("RELAYER_API_KEY")) return undefined;

  const key = value("BUILDER_API_KEY");
  const secret = value("BUILDER_SECRET");
  const passphrase = value("BUILDER_PASS_PHRASE");
  const configured = [key, secret, passphrase].filter(Boolean).length;
  if (configured === 0) return undefined;
  if (configured !== 3) {
    throw new Error("BUILDER_API_KEY/SECRET/PASS_PHRASE 必须同时配置");
  }

  const creds: BuilderApiKeyCreds = {
    key: key!,
    secret: secret!,
    passphrase: passphrase!,
  };
  return new BuilderConfig({ localBuilderCreds: creds });
}

export function relayClient(): RelayClient {
  const { account, walletClient } = signerClients();
  const client = new RelayClient(
    relayerUrl(),
    chainId(),
    walletClient,
    optionalBuilderConfig(),
    undefined,
    { chain: polygonAmoy },
  );

  const relayerApiKey = value("RELAYER_API_KEY");
  if (relayerApiKey) {
    const keyAddress = value("RELAYER_API_KEY_ADDRESS", account.address)!;
    if (!/^0x[0-9a-fA-F]{40}$/.test(keyAddress)) {
      throw new Error("RELAYER_API_KEY_ADDRESS 不是有效的 EVM 地址");
    }
    client.httpClient.instance.defaults.headers.common.RELAYER_API_KEY =
      relayerApiKey;
    client.httpClient.instance.defaults.headers.common.RELAYER_API_KEY_ADDRESS =
      keyAddress;
  }

  return client;
}

export type { DepositWalletCall };
