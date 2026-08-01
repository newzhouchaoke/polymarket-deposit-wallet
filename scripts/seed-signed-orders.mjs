import { createWalletClient, fallback, http, parseUnits, zeroHash } from "viem";
import { polygonAmoy } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import {
  account,
  dbPath,
  domainFor,
  insertDbOrder,
  loadDeployment,
  openResearchDb,
  privateKey,
} from "./order-utils.mjs";
import { OFFICIAL_MODE } from "./exchange-config.mjs";
import { ORDER_TYPES, signErc7739Order } from "./erc7739.mjs";

function amoyRpcUrls() {
  const configured = process.env.AMOY_RPC_URLS || process.env.AMOY_RPC_URL;
  const preferred = configured
    ? configured.split(",").map((url) => url.trim()).filter(Boolean)
    : [];
  return [
    ...new Set([
      ...preferred,
      "https://polygon-amoy-bor-rpc.publicnode.com",
      "https://rpc-amoy.polygon.technology",
      "https://polygon-amoy.drpc.org",
    ]),
  ];
}

const deployment = loadDeployment({ requireMarket: true });
if (!deployment.buyerWallet || !deployment.sellerWallet) {
  throw new Error(
    `${deployment.mode} 需要配置 buyerWallet/sellerWallet；official-v2 请设置 OFFICIAL_BUYER_WALLET 和 OFFICIAL_SELLER_WALLET`,
  );
}
function roleAccount(role) {
  if (deployment.mode !== OFFICIAL_MODE) return account();
  const configured = process.env[`OFFICIAL_${role}_PRIVATE_KEY`];
  return privateKeyToAccount(configured || privateKey());
}

function roleSignatureType(role) {
  if (deployment.mode !== OFFICIAL_MODE) return 3;
  const value = Number(process.env[`OFFICIAL_${role}_SIGNATURE_TYPE`] ?? "1");
  if (![0, 1, 2, 3].includes(value)) {
    throw new Error(`OFFICIAL_${role}_SIGNATURE_TYPE 必须是 0、1、2 或 3`);
  }
  return value;
}

function signerFor(maker, owner, signatureType, role) {
  if (signatureType === 0 && maker.toLowerCase() !== owner.address.toLowerCase()) {
    throw new Error(
      `${role} 使用 EOA 签名类型 0 时，配置的钱包必须等于该私钥地址 ${owner.address}`,
    );
  }
  return signatureType === 3 ? maker : owner.address;
}

function clientFor(owner) {
  return createWalletClient({
    account: owner,
    chain: polygonAmoy,
    transport: fallback(
      amoyRpcUrls().map((url) => http(url, { retryCount: 1, timeout: 10_000 })),
      { rank: false },
    ),
  });
}

async function signOrder(owner, walletClient, order) {
  if (Number(order.signatureType) === 3) {
    return signErc7739Order({
      walletClient,
      account: owner,
      appDomain: domain,
      order,
    });
  }
  return walletClient.signTypedData({
    account: owner,
    domain,
    types: ORDER_TYPES,
    primaryType: "Order",
    message: order,
  });
}

const buyerOwner = roleAccount("BUYER");
const sellerOwner = roleAccount("SELLER");
const buyerSignatureType = roleSignatureType("BUYER");
const sellerSignatureType = roleSignatureType("SELLER");
const buyerClient = clientFor(buyerOwner);
const sellerClient = clientFor(sellerOwner);
const domain = domainFor(deployment);
const salt = BigInt(Date.now());
const timestamp =
  deployment.mode === OFFICIAL_MODE
    ? BigInt(Date.now())
    : BigInt(Math.floor(Date.now() / 1000));

const buyOrder = {
  salt,
  maker: deployment.buyerWallet,
  signer: signerFor(
    deployment.buyerWallet,
    buyerOwner,
    buyerSignatureType,
    "BUYER",
  ),
  tokenId: BigInt(deployment.market.yesTokenId),
  makerAmount: parseUnits("1.14", 6),
  takerAmount: parseUnits("2", 6),
  side: 0,
  signatureType: buyerSignatureType,
  timestamp,
  metadata: zeroHash,
  builder: zeroHash,
};
const sellOrder = {
  salt: salt + 1n,
  maker: deployment.sellerWallet,
  signer: signerFor(
    deployment.sellerWallet,
    sellerOwner,
    sellerSignatureType,
    "SELLER",
  ),
  tokenId: BigInt(deployment.market.yesTokenId),
  makerAmount: parseUnits("1", 6),
  takerAmount: parseUnits("0.56", 6),
  side: 1,
  signatureType: sellerSignatureType,
  timestamp,
  metadata: zeroHash,
  builder: zeroHash,
};

const [buySignature, sellSignature] = await Promise.all([
  signOrder(buyerOwner, buyerClient, buyOrder),
  signOrder(sellerOwner, sellerClient, sellOrder),
]);

const db = openResearchDb();
const buyId = `signed-buy-${salt}`;
const sellId = `signed-sell-${salt + 1n}`;
insertDbOrder(db, deployment, buyId, buyOrder, buySignature, "OPEN");
insertDbOrder(db, deployment, sellId, sellOrder, sellSignature, "OPEN");
db.close();

console.log("已生成签名 OPEN 订单：");
console.log(
  JSON.stringify(
    {
      mode: deployment.mode,
      buyId,
      sellId,
      buyerSignatureType,
      sellerSignatureType,
      dbPath,
    },
    null,
    2,
  ),
);
