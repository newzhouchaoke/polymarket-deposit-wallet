import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  createWalletClient,
  custom,
  encodeFunctionData,
  maxUint256,
  parseUnits,
  zeroHash,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  CANCEL_TYPES,
  ORDER_TYPES,
  signErc7739Order,
  signErc7739TypedData,
} from "./erc7739.mjs";

const projectDir = path.resolve(new URL("..", import.meta.url).pathname);
const originalConsole = {
  log: console.log,
  warn: console.warn,
  error: console.error,
};
// Node 24 has no Ganache native µWS binary, so Ganache safely uses its JS path.
// Silence only that import-time compatibility notice.
console.log = () => {};
console.warn = () => {};
console.error = () => {};
const { default: ganache } = await import("ganache");
Object.assign(console, originalConsole);
const provider = ganache.provider({
  chain: { chainId: 1337, hardfork: "shanghai" },
  logging: { quiet: true },
  wallet: { totalAccounts: 3, defaultBalance: 1_000 },
});
const initialAccounts = provider.getInitialAccounts();
const secrets = Object.values(initialAccounts).map((item) => item.secretKey);
const owner = privateKeyToAccount(secrets[0]);
const second = privateKeyToAccount(secrets[1]);
const transport = custom(provider);
const publicClient = createPublicClient({ transport });
const ownerClient = createWalletClient({ account: owner, transport });
const secondClient = createWalletClient({ account: second, transport });
const chainId = await publicClient.getChainId();

function artifact(name) {
  return JSON.parse(
    fs.readFileSync(path.join(projectDir, "artifacts", `${name}.json`), "utf8"),
  );
}

async function deploy(name, args = []) {
  const compiled = artifact(name);
  const hash = await ownerClient.deployContract({
    account: owner,
    abi: compiled.abi,
    bytecode: compiled.bytecode,
    args,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success", `${name} deployment failed`);
  assert.ok(receipt.contractAddress);
  return { address: receipt.contractAddress, abi: compiled.abi };
}

async function write(client, account, contract, functionName, args = []) {
  const hash = await client.writeContract({
    account,
    address: contract.address,
    abi: contract.abi,
    functionName,
    args,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success", `${functionName} failed`);
  return hash;
}

async function read(contract, functionName, args = []) {
  return publicClient.readContract({
    address: contract.address,
    abi: contract.abi,
    functionName,
    args,
  });
}

const BATCH_TYPES = {
  Call: [
    { name: "target", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
  ],
  Batch: [
    { name: "wallet", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "calls", type: "Call[]" },
  ],
};

const collateral = await deploy("ResearchWalletCoin");
const outcome = await deploy("ResearchOutcomeToken", [collateral.address]);
const registry = await deploy("ResearchMarketRegistry", [outcome.address]);
const factory = await deploy("ResearchDepositWalletFactory");
const exchange = await deploy("ResearchCLOBExchange", [
  collateral.address,
  outcome.address,
  factory.address,
  owner.address,
  owner.address,
  owner.address,
]);
const walletAbi = artifact("ResearchDepositWallet").abi;
const buyerWallet = await read(factory, "getWallet", [owner.address]);
await write(ownerClient, owner, factory, "createWallet", [owner.address]);
await write(ownerClient, owner, outcome, "setExchange", [exchange.address]);

const question = "Local V2 integration test";
const closeTime = BigInt(Math.floor(Date.now() / 1000) + 86_400);
const preview = await read(registry, "nextMarket", [
  owner.address,
  question,
  closeTime,
]);
const [marketId, questionId, conditionId, yesTokenId, noTokenId] = preview;
assert.equal(marketId, conditionId);
assert.notEqual(questionId, zeroHash);
await write(ownerClient, owner, registry, "publishMarket", [question, closeTime]);

// Create a fully collateralized YES/NO set for the seller.
await write(ownerClient, owner, collateral, "mint", [
  buyerWallet,
  parseUnits("100", 6),
]);
await write(ownerClient, owner, collateral, "mint", [
  owner.address,
  parseUnits("10", 6),
]);
await write(ownerClient, owner, collateral, "approve", [
  outcome.address,
  maxUint256,
]);
await write(ownerClient, owner, outcome, "splitPosition", [
  conditionId,
  parseUnits("10", 6),
]);
assert.equal(
  await read(outcome, "balanceOf", [owner.address, yesTokenId]),
  parseUnits("10", 6),
);
assert.equal(
  await read(outcome, "balanceOf", [owner.address, noTokenId]),
  parseUnits("10", 6),
);

const approveCollateral = encodeFunctionData({
  abi: collateral.abi,
  functionName: "approve",
  args: [exchange.address, maxUint256],
});
await write(
  ownerClient,
  owner,
  { address: buyerWallet, abi: walletAbi },
  "executeBatch",
  [[{ target: collateral.address, value: 0n, data: approveCollateral }]],
);
await write(ownerClient, owner, outcome, "setApprovalForAll", [
  exchange.address,
  true,
]);

const exchangeDomain = {
  name: "Polymarket CTF Exchange",
  version: "2",
  chainId,
  verifyingContract: exchange.address,
};
let salt = 1n;
const timestamp = BigInt(Math.floor(Date.now() / 1000));

async function signedOrder(client, account, values) {
  const unsigned = {
    salt: salt++,
    timestamp,
    metadata: zeroHash,
    builder: zeroHash,
    ...values,
  };
  const signature = Number(unsigned.signatureType) === 3
    ? await signErc7739Order({
        walletClient: client,
        account,
        appDomain: exchangeDomain,
        order: unsigned,
      })
    : await client.signTypedData({
        account,
        domain: exchangeDomain,
        types: ORDER_TYPES,
        primaryType: "Order",
        message: unsigned,
      });
  return { ...unsigned, signature };
}

const buyOrder = await signedOrder(ownerClient, owner, {
  maker: buyerWallet,
  signer: buyerWallet,
  tokenId: yesTokenId,
  makerAmount: parseUnits("0.60", 6),
  takerAmount: parseUnits("1", 6),
  side: 0,
  signatureType: 3,
});
const sellOrder = await signedOrder(ownerClient, owner, {
  maker: owner.address,
  signer: owner.address,
  tokenId: yesTokenId,
  makerAmount: parseUnits("1", 6),
  takerAmount: parseUnits("0.55", 6),
  side: 1,
  signatureType: 0,
});
await write(ownerClient, owner, exchange, "matchOrders", [
  conditionId,
  buyOrder,
  [sellOrder],
  parseUnits("0.55", 6),
  [parseUnits("1", 6)],
  0n,
  [0n],
]);
assert.equal(
  await read(outcome, "balanceOf", [buyerWallet, yesTokenId]),
  parseUnits("1", 6),
);
assert.equal(
  await read(collateral, "balanceOf", [buyerWallet]),
  parseUnits("99.45", 6),
);
assert.equal(
  await read(collateral, "balanceOf", [owner.address]),
  parseUnits("0.55", 6),
);
const buyHash = await read(exchange, "hashOrder", [buyOrder]);
const buyStatus = await read(exchange, "getOrderStatus", [buyHash]);
assert.equal(buyStatus.filled, false);
assert.equal(buyStatus.remaining, parseUnits("0.05", 6));

// Cancel the partially filled POLY_1271 order with an owner-signed Cancel.
const cancelSignature = await signErc7739TypedData({
  walletClient: ownerClient,
  account: owner,
  appDomain: exchangeDomain,
  contentsTypes: CANCEL_TYPES,
  primaryType: "Cancel",
  contents: { orderHash: buyHash },
  depositWallet: buyerWallet,
});
await write(ownerClient, owner, exchange, "cancelOrder", [
  buyOrder,
  cancelSignature,
]);
assert.equal(
  (await read(exchange, "getOrderStatus", [buyHash])).filled,
  true,
);

// Execute a relayer-style Deposit Wallet Batch with nonce and deadline.
const transferBack = encodeFunctionData({
  abi: collateral.abi,
  functionName: "transfer",
  args: [owner.address, parseUnits("1", 6)],
});
const calls = [{ target: collateral.address, value: 0n, data: transferBack }];
const walletNonce = await publicClient.readContract({
  address: buyerWallet,
  abi: walletAbi,
  functionName: "nonce",
});
const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
const walletSignature = await ownerClient.signTypedData({
  account: owner,
  domain: {
    name: "DepositWallet",
    version: "1",
    chainId,
    verifyingContract: buyerWallet,
  },
  types: BATCH_TYPES,
  primaryType: "Batch",
  message: {
    wallet: buyerWallet,
    nonce: walletNonce,
    deadline,
    calls,
  },
});
await write(
  secondClient,
  second,
  { address: buyerWallet, abi: walletAbi },
  "executeBatch",
  [calls, walletNonce, deadline, walletSignature],
);

// BUY+BUY MINT: 0.60 YES bid + 0.40 NO bid creates one complete set.
await write(ownerClient, owner, collateral, "mint", [
  owner.address,
  parseUnits("1", 6),
]);
await write(ownerClient, owner, collateral, "mint", [
  second.address,
  parseUnits("1", 6),
]);
await write(ownerClient, owner, collateral, "approve", [
  exchange.address,
  maxUint256,
]);
await write(secondClient, second, collateral, "approve", [
  exchange.address,
  maxUint256,
]);
const yesBuy = await signedOrder(ownerClient, owner, {
  maker: owner.address,
  signer: owner.address,
  tokenId: yesTokenId,
  makerAmount: parseUnits("0.60", 6),
  takerAmount: parseUnits("1", 6),
  side: 0,
  signatureType: 0,
});
const noBuy = await signedOrder(secondClient, second, {
  maker: second.address,
  signer: second.address,
  tokenId: noTokenId,
  makerAmount: parseUnits("0.40", 6),
  takerAmount: parseUnits("1", 6),
  side: 0,
  signatureType: 0,
});
await write(ownerClient, owner, exchange, "matchOrders", [
  conditionId,
  yesBuy,
  [noBuy],
  parseUnits("0.60", 6),
  [parseUnits("0.40", 6)],
  0n,
  [0n],
]);

// SELL+SELL MERGE: complementary shares merge back into one collateral unit.
await write(secondClient, second, outcome, "setApprovalForAll", [
  exchange.address,
  true,
]);
const yesSell = await signedOrder(ownerClient, owner, {
  maker: owner.address,
  signer: owner.address,
  tokenId: yesTokenId,
  makerAmount: parseUnits("1", 6),
  takerAmount: parseUnits("0.60", 6),
  side: 1,
  signatureType: 0,
});
const noSell = await signedOrder(secondClient, second, {
  maker: second.address,
  signer: second.address,
  tokenId: noTokenId,
  makerAmount: parseUnits("1", 6),
  takerAmount: parseUnits("0.40", 6),
  side: 1,
  signatureType: 0,
});
await write(ownerClient, owner, exchange, "matchOrders", [
  conditionId,
  yesSell,
  [noSell],
  parseUnits("1", 6),
  [parseUnits("1", 6)],
  0n,
  [0n],
]);

assert.equal(
  (await read(exchange, "getOrderStatus", [await read(exchange, "hashOrder", [yesBuy])]))
    .filled,
  true,
);
assert.equal(
  (await read(exchange, "getOrderStatus", [await read(exchange, "hashOrder", [yesSell])]))
    .filled,
  true,
);

await provider.disconnect();
console.log(
  JSON.stringify(
    {
      ok: true,
      tested: [
        "ERC-1967 Beacon Deposit Wallet",
        "ERC-7739 wrapped POLY_1271",
        "CTF prepare/split",
        "COMPLEMENTARY BUY/SELL",
        "partial fill + signed cancel",
        "signed relayer Batch",
        "BUY+BUY MINT",
        "SELL+SELL MERGE",
      ],
    },
    null,
    2,
  ),
);
