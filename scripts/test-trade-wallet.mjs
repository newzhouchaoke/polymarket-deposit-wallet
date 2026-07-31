import assert from "node:assert/strict";
import {
  AMOY_CHAIN_HEX,
  buildOrderForWallet,
  connectWallet,
  discoverInjectedProviders,
  ensureAmoy,
  findMetaMaskProvider,
  isAmoyChainId,
  normalizeChainId,
  readWalletAssets,
  signOrderTypedData,
} from "../public/trade-wallet.js";

assert.equal(normalizeChainId("0x13882"), 80002);
assert.equal(normalizeChainId("0x013882"), 80002);
assert.equal(normalizeChainId("80002"), 80002);
assert.equal(normalizeChainId(80002), 80002);
assert.equal(normalizeChainId("not-a-chain"), null);
assert.equal(isAmoyChainId("0X13882"), true);

const phantomProvider = {
  isPhantom: true,
  isMetaMask: true,
  async request() {},
};
const metaMaskProvider = {
  isMetaMask: true,
  async request() {},
};
const multiWallet = {
  ethereum: {
    isPhantom: true,
    providers: [phantomProvider, metaMaskProvider],
  },
};
const discoveredLegacy = await discoverInjectedProviders(multiWallet, 0);
assert.equal(discoveredLegacy.length, 2);
assert.equal((await findMetaMaskProvider(multiWallet)).provider, metaMaskProvider);

const eip6963Window = new EventTarget();
eip6963Window.Event = Event;
eip6963Window.ethereum = phantomProvider;
eip6963Window.addEventListener("eip6963:requestProvider", () => {
  const announcement = new Event("eip6963:announceProvider");
  Object.defineProperty(announcement, "detail", {
    value: {
      info: {
        uuid: "metamask-test",
        name: "MetaMask",
        rdns: "io.metamask",
        icon: "",
      },
      provider: metaMaskProvider,
    },
  });
  eip6963Window.dispatchEvent(announcement);
});
assert.equal(
  (await findMetaMaskProvider(eip6963Window)).provider,
  metaMaskProvider,
);
await assert.rejects(
  findMetaMaskProvider({ ethereum: phantomProvider }),
  /未发现 MetaMask Provider/,
);

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

let addFlowChain = "0x1";
let firstSwitch = true;
const addFlowCalls = [];
const addFlowProvider = {
  async request(request) {
    addFlowCalls.push(request.method);
    if (request.method === "eth_chainId") return addFlowChain;
    if (request.method === "wallet_switchEthereumChain") {
      if (firstSwitch) {
        firstSwitch = false;
        throw Object.assign(new Error("unknown chain"), { code: 4902 });
      }
      addFlowChain = request.params[0].chainId;
      return null;
    }
    if (request.method === "wallet_addEthereumChain") return null;
    throw new Error(`unexpected method ${request.method}`);
  },
};
await ensureAmoy(addFlowProvider);
assert.equal(addFlowChain, AMOY_CHAIN_HEX);
assert.deepEqual(
  addFlowCalls.filter((method) => method.startsWith("wallet_")),
  [
    "wallet_switchEthereumChain",
    "wallet_addEthereumChain",
    "wallet_switchEthereumChain",
  ],
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
