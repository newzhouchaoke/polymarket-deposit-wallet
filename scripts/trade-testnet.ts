import {
  Chain,
  ClobClient,
  OrderType,
  Side,
  SignatureTypeV2,
  type ApiKeyCreds,
} from "@polymarket/clob-client-v2";
import { getAddress } from "viem";
import { relayClient } from "../src/builder.js";
import { publicClient, signerClients } from "../src/chain.js";
import {
  assertLiveAction,
  bool,
  required,
  value,
} from "../src/env.js";

const host = required("CLOB_TESTNET_API_URL").replace(/\/$/, "");
if (
  host === "https://clob.polymarket.com" ||
  host === "https://clob-v2.polymarket.com"
) {
  throw new Error("拒绝使用生产/历史生产 CLOB host；本脚本仅允许专用 Amoy 测试端点");
}

const creds: ApiKeyCreds = {
  key: required("CLOB_API_KEY"),
  secret: required("CLOB_SECRET"),
  passphrase: required("CLOB_PASS_PHRASE"),
};
const { walletClient } = signerClients();
const relayer = relayClient();
const depositWallet = getAddress(
  value("DEPOSIT_WALLET") ?? (await relayer.deriveDepositWalletAddress()),
);
const code = await publicClient().getCode({ address: depositWallet });
if (!code || code === "0x") throw new Error("Amoy Deposit Wallet 尚未部署");

const clob = new ClobClient({
  host,
  chain: Chain.AMOY,
  signer: walletClient,
  creds,
  signatureType: SignatureTypeV2.POLY_1271,
  funderAddress: depositWallet,
  throwOnError: true,
});
const tokenID = required("TOKEN_ID");
const side = value("ORDER_SIDE", "BUY") === "SELL" ? Side.SELL : Side.BUY;
const orderType = OrderType.GTC;
const order = {
  tokenID,
  price: Number(value("ORDER_PRICE", "0.01")),
  size: Number(value("ORDER_SIZE", "1")),
  side,
};
const options = {
  tickSize: value("TICK_SIZE", "0.01") as "0.1" | "0.01" | "0.001" | "0.0001",
  negRisk: bool("NEG_RISK"),
};

console.log(`测试 CLOB 版本：${await clob.getVersion()}`);
const signed = await clob.createOrder(order, options);
console.log(`POLY_1271 测试订单已本地签名，maker/signer：${depositWallet}`);
if (value("LIVE_ACTION", "NONE") === "PLACE_TEST_ORDER") {
  assertLiveAction("PLACE_TEST_ORDER");
  const result = await clob.postOrder(signed, orderType);
  console.log("Amoy 测试订单提交结果：", result);
} else {
  console.log("未提交订单；设置 LIVE_ACTION=PLACE_TEST_ORDER 才会发送到测试 CLOB");
}
