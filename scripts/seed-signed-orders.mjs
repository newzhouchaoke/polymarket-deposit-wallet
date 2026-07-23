import { createWalletClient, fallback, http, parseUnits, zeroHash } from "viem";
import { polygonAmoy } from "viem/chains";
import {
  account,
  dbPath,
  domainFor,
  insertDbOrder,
  loadDeployment,
  openResearchDb,
} from "./order-utils.mjs";
import { signErc7739Order } from "./erc7739.mjs";

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

const deployment = loadDeployment();
const signer = account();
const walletClient = createWalletClient({
  account: signer,
  chain: polygonAmoy,
  transport: fallback(
    amoyRpcUrls().map((url) => http(url, { retryCount: 1, timeout: 10_000 })),
    { rank: false },
  ),
});
const domain = domainFor(deployment);
const salt = BigInt(Date.now());
const timestamp = BigInt(Math.floor(Date.now() / 1000));

const buyOrder = {
  salt,
  maker: deployment.buyerWallet,
  signer: deployment.buyerWallet,
  tokenId: BigInt(deployment.market.yesTokenId),
  makerAmount: parseUnits("1.14", 6),
  takerAmount: parseUnits("2", 6),
  side: 0,
  signatureType: 3,
  timestamp,
  metadata: zeroHash,
  builder: zeroHash,
};
const sellOrder = {
  salt: salt + 1n,
  maker: deployment.sellerWallet,
  signer: deployment.sellerWallet,
  tokenId: BigInt(deployment.market.yesTokenId),
  makerAmount: parseUnits("1", 6),
  takerAmount: parseUnits("0.56", 6),
  side: 1,
  signatureType: 3,
  timestamp,
  metadata: zeroHash,
  builder: zeroHash,
};

const [buySignature, sellSignature] = await Promise.all([
  signErc7739Order({
    walletClient,
    account: signer,
    appDomain: domain,
    order: buyOrder,
  }),
  signErc7739Order({
    walletClient,
    account: signer,
    appDomain: domain,
    order: sellOrder,
  }),
]);

const db = openResearchDb();
const buyId = `signed-buy-${salt}`;
const sellId = `signed-sell-${salt + 1n}`;
insertDbOrder(db, deployment, buyId, buyOrder, buySignature, "OPEN");
insertDbOrder(db, deployment, sellId, sellOrder, sellSignature, "OPEN");
db.close();

console.log("已生成签名 OPEN 订单：");
console.log(JSON.stringify({ buyId, sellId, dbPath }, null, 2));
