import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { getAddress, isAddress } from "viem";
import { projectDir } from "./db.js";

dotenv.config({ path: path.join(projectDir, "..", ".env"), quiet: true });
dotenv.config({
  path: path.join(projectDir, ".env"),
  override: true,
  quiet: true,
});
delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;

export const RESEARCH_MODE = "research";
export const OFFICIAL_MODE = "official-v2";

export const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
];

export const erc1155Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "id", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "isApprovedForAll",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "operator", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "setApprovalForAll",
    stateMutability: "nonpayable",
    inputs: [
      { name: "operator", type: "address" },
      { name: "approved", type: "bool" },
    ],
    outputs: [],
  },
];

function envValue(name) {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function requiredAddress(value, name) {
  if (!value || !isAddress(value)) {
    throw new Error(`${name} 不是有效地址或尚未配置`);
  }
  return getAddress(value);
}

function optionalAddress(value, name) {
  if (!value) return undefined;
  return requiredAddress(value, name);
}

function readJson(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`缺少${label}：${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function exchangeMode() {
  const mode = (envValue("EXCHANGE_MODE") ?? RESEARCH_MODE).toLowerCase();
  if (mode !== RESEARCH_MODE && mode !== OFFICIAL_MODE) {
    throw new Error("EXCHANGE_MODE 必须是 research 或 official-v2");
  }
  return mode;
}

export function researchDeploymentPath() {
  return path.join(projectDir, "deployments", "research-v2-amoy.json");
}

export function officialDeploymentPath() {
  const configured = envValue("OFFICIAL_V2_DEPLOYMENT_PATH");
  return configured
    ? path.resolve(projectDir, configured)
    : path.join(projectDir, "deployments", "official-v2-amoy.json");
}

export function officialMarketPath() {
  const configured = envValue("OFFICIAL_MARKET_CONFIG_PATH");
  return configured
    ? path.resolve(projectDir, configured)
    : path.join(projectDir, "deployments", "official-market-amoy.json");
}

function officialMarket() {
  let fileMarket = {};
  const filePath = officialMarketPath();
  if (fs.existsSync(filePath)) {
    fileMarket = JSON.parse(fs.readFileSync(filePath, "utf8"));
  }
  const marketId = envValue("OFFICIAL_MARKET_ID") ?? fileMarket.marketId;
  const conditionId =
    envValue("OFFICIAL_CONDITION_ID") ?? fileMarket.conditionId ?? marketId;
  const yesTokenId =
    envValue("OFFICIAL_YES_TOKEN_ID") ?? fileMarket.yesTokenId;
  const noTokenId =
    envValue("OFFICIAL_NO_TOKEN_ID") ?? fileMarket.noTokenId;
  if (!marketId || !conditionId || !yesTokenId || !noTokenId) return null;
  return {
    marketId,
    conditionId,
    yesTokenId: String(yesTokenId),
    noTokenId: String(noTokenId),
    question:
      envValue("OFFICIAL_MARKET_QUESTION") ??
      fileMarket.question ??
      "Configured official V2 Amoy market",
    closeTime: Number(fileMarket.closeTime ?? 0),
    status: String(fileMarket.status ?? "OPEN").toUpperCase(),
    winningOutcome: Number(fileMarket.winningOutcome ?? 0),
  };
}

function normalizeResearch() {
  const filePath = researchDeploymentPath();
  const deployment = readJson(filePath, "研究版部署记录");
  if (Number(deployment.chainId) !== 80002 || !deployment.exchange) {
    throw new Error("研究部署记录不是有效的 Polygon Amoy V2 部署");
  }
  return {
    ...deployment,
    mode: RESEARCH_MODE,
    variant: "research",
    deploymentPath: filePath,
    exchange: getAddress(deployment.exchange),
    collateral: getAddress(deployment.walletCoin),
    ctf: getAddress(deployment.outcomeToken),
    collateralSymbol: "rWALLET",
    collateralDecimals: 6,
    exchangeArtifactPath: path.join(
      projectDir,
      "artifacts",
      "ResearchCLOBExchange.json",
    ),
    syncStateName: "research-v2-events",
    writable: true,
  };
}

function normalizeOfficial() {
  const filePath = officialDeploymentPath();
  const deployment = readJson(filePath, "官方 V2 部署记录");
  if (Number(deployment.chainId) !== 80002) {
    throw new Error("官方 V2 部署记录不是 Polygon Amoy chainId=80002");
  }
  const variant = (
    envValue("OFFICIAL_V2_RUNTIME_VARIANT") ?? "standard"
  ).toLowerCase();
  if (variant !== "standard" && variant !== "negrisk" && variant !== "neg-risk") {
    throw new Error(
      "OFFICIAL_V2_RUNTIME_VARIANT 必须是 standard 或 neg-risk",
    );
  }
  const key = variant === "standard" ? "standard" : "negRisk";
  const contract = deployment.contracts?.[key];
  const overrideAddress = envValue("OFFICIAL_V2_EXCHANGE_ADDRESS");
  const exchange = requiredAddress(
    overrideAddress ?? contract?.address,
    "官方 V2 Exchange",
  );
  const dependencies = contract?.dependencies ?? {};
  const collateral = requiredAddress(
    envValue("OFFICIAL_COLLATERAL_ADDRESS") ?? dependencies.collateral,
    "官方 collateral",
  );
  const ctf = requiredAddress(
    envValue("OFFICIAL_CTF_ADDRESS") ?? dependencies.ctf,
    "官方 CTF",
  );
  const market = officialMarket();
  return {
    ...deployment,
    mode: OFFICIAL_MODE,
    variant: key,
    deploymentPath: filePath,
    exchange,
    collateral,
    ctf,
    walletCoin: collateral,
    outcomeToken: ctf,
    market,
    buyerWallet: optionalAddress(
      envValue("OFFICIAL_BUYER_WALLET"),
      "OFFICIAL_BUYER_WALLET",
    ),
    sellerWallet: optionalAddress(
      envValue("OFFICIAL_SELLER_WALLET"),
      "OFFICIAL_SELLER_WALLET",
    ),
    collateralSymbol: envValue("OFFICIAL_COLLATERAL_SYMBOL") ?? "pUSD",
    collateralDecimals: Number(
      envValue("OFFICIAL_COLLATERAL_DECIMALS") ?? "6",
    ),
    officialDependencies: dependencies,
    txs: {
      exchangeDeployTx: contract?.txHash,
    },
    exchangeArtifactPath: path.join(
      projectDir,
      "official",
      "ctf-exchange-v2",
      "out",
      "CTFExchange.sol",
      "CTFExchange.json",
    ),
    syncStateName: `official-v2-${key}-events`,
    writable: !overrideAddress || Boolean(contract?.address),
  };
}

export function loadExchangeConfig(options = {}) {
  const config =
    exchangeMode() === OFFICIAL_MODE
      ? normalizeOfficial()
      : normalizeResearch();
  if (options.requireMarket && !config.market) {
    throw new Error(
      `${config.mode} 尚未配置市场。official-v2 需要 OFFICIAL_MARKET_ID、OFFICIAL_CONDITION_ID、OFFICIAL_YES_TOKEN_ID、OFFICIAL_NO_TOKEN_ID，或 deployments/official-market-amoy.json`,
    );
  }
  return config;
}

export function readExchangeArtifact(config = loadExchangeConfig()) {
  return readJson(config.exchangeArtifactPath, "Exchange artifact");
}

export function runtimeSummary(config = loadExchangeConfig()) {
  return {
    mode: config.mode,
    variant: config.variant,
    chainId: Number(config.chainId),
    exchange: config.exchange,
    collateral: config.collateral,
    ctf: config.ctf,
    collateralSymbol: config.collateralSymbol,
    marketConfigured: Boolean(config.market),
    marketId: config.market?.marketId ?? null,
    deploymentPath: config.deploymentPath,
  };
}
