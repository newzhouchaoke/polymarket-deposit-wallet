import assert from "node:assert/strict";
import {
  AMOY_CHAIN_HEX,
  buildOrderForWallet,
  connectWallet,
  readWalletAssets,
  signOrderTypedData,
} from "../public/trade-wallet.js";

const account = "0x0000000000000000000000000000000000000002";
const proxy = "0x0000000000000000000000000000000000000003";
const exchange = "0x0000000000000000000000000000000000000004";
const collateral = "0x0000000000000000000000000000000000000005";
const ctf = "0x0000000000000000000000000000000000000006";
const calls = [];
let chainId = "0x1";
const provider = {
  async request(request) {
    calls.push(request);
    if (request.method === "eth_chainId") return chainId;
    if (request.method === "wallet_switchEthereumChain") {
      chainId = request.params[0].chainId;
      return null;
    }
    if (request.method === "eth_requestAccounts") return [account];
    if (request.method === "eth_signTypedData_v4") return `0x${"11".repeat(65)}`;
    if (request.method === "eth_getBalance") return "0xde0b6b3a7640000";
    if (request.method === "eth_call") {
      const data = request.params[0].data;
      if (data.startsWith("0x70a08231")) return "0x1e8480";
      if (data.startsWith("0xdd62ed3e")) return "0x2dc6c0";
      if (data.startsWith("0x00fdd58e")) return "0x3d0900";
      if (data.startsWith("0xe985e9c5")) return "0x1";
    }
    throw new Error(`unexpected method ${request.method}`);
  },
};

assert.equal(await connectWallet(provider), account);
assert.ok(
  calls.some(
    (call) =>
      call.method === "wallet_switchEthereumChain" &&
      call.params[0].chainId === AMOY_CHAIN_HEX,
  ),
);

const runtime = {
  chainId: 80002,
  exchange,
  collateral,
  ctf,
};
const form = {
  marketId: "market",
  maker: proxy,
  side: "BUY",
  tokenId: "7",
  makerAmount: "500000",
  takerAmount: "1000000",
  expiration: "0",
  salt: "123",
  signatureType: "1",
  timestamp: "456",
};
const built = buildOrderForWallet(runtime, form, account);
assert.equal(built.payload.maker, proxy);
assert.equal(built.payload.signer, account);
assert.equal(built.typedData.message.side, 0);
assert.equal(built.typedData.domain.verifyingContract, exchange);

const signature = await signOrderTypedData(provider, account, built.typedData);
assert.equal(signature.length, 132);

const assets = await readWalletAssets(provider, runtime, proxy, account, "7");
assert.deepEqual(assets, {
  accountPOL: "1",
  makerCollateral: "2",
  makerCollateralAllowance: "3",
  makerOutcome: "4",
  outcomeApprovedForExchange: true,
});

assert.throws(
  () =>
    buildOrderForWallet(runtime, { ...form, signatureType: "3" }, account),
  /只支持 EOA\(0\) 和官方 Proxy\(1\)/,
);

console.log("MetaMask Amoy connection, EIP-712 order, and asset read tests passed");
