export const AMOY_CHAIN_ID = 80002;
export const AMOY_CHAIN_HEX = "0x13882";
export const ZERO_BYTES32 = `0x${"00".repeat(32)}`;

export const ORDER_TYPES = [
  { name: "salt", type: "uint256" },
  { name: "maker", type: "address" },
  { name: "signer", type: "address" },
  { name: "tokenId", type: "uint256" },
  { name: "makerAmount", type: "uint256" },
  { name: "takerAmount", type: "uint256" },
  { name: "side", type: "uint8" },
  { name: "signatureType", type: "uint8" },
  { name: "timestamp", type: "uint256" },
  { name: "metadata", type: "bytes32" },
  { name: "builder", type: "bytes32" },
];

function requireProvider(provider) {
  if (!provider?.request) {
    throw new Error("未检测到 MetaMask/EIP-1193 钱包，请先安装并解锁钱包扩展");
  }
  return provider;
}

export function normalizeChainId(value) {
  try {
    if (typeof value === "number") return Number.isSafeInteger(value) ? value : null;
    const text = String(value ?? "").trim();
    if (!text) return null;
    return Number(BigInt(text));
  } catch {
    return null;
  }
}

export function isAmoyChainId(value) {
  return normalizeChainId(value) === AMOY_CHAIN_ID;
}

async function confirmAmoy(provider) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await provider.request({ method: "eth_chainId" });
    if (isAmoyChainId(current)) return current;
    if (attempt < 4) {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  const actual = await provider.request({ method: "eth_chainId" });
  throw new Error(
    `钱包网络切换未生效：当前 chainId=${actual}，需要 Polygon Amoy chainId=${AMOY_CHAIN_ID}`,
  );
}

export async function ensureAmoy(provider) {
  requireProvider(provider);
  const current = await provider.request({ method: "eth_chainId" });
  if (isAmoyChainId(current)) return current;
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: AMOY_CHAIN_HEX }],
    });
  } catch (error) {
    if (Number(error?.code) !== 4902) throw error;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: AMOY_CHAIN_HEX,
        chainName: "Polygon Amoy",
        nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 },
        rpcUrls: ["https://polygon-amoy-bor-rpc.publicnode.com"],
        blockExplorerUrls: ["https://amoy.polygonscan.com"],
      }],
    });
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: AMOY_CHAIN_HEX }],
    });
  }
  return confirmAmoy(provider);
}

export async function connectWallet(provider) {
  requireProvider(provider);
  const accounts = await provider.request({ method: "eth_requestAccounts" });
  if (!Array.isArray(accounts) || !accounts[0]) {
    throw new Error("钱包没有返回可用账户");
  }
  await ensureAmoy(provider);
  return accounts[0];
}

function integerString(value, name) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) throw new Error(`${name} 必须是非负整数`);
  return text;
}

export function buildOrderForWallet(runtime, formValues, connectedAccount) {
  const signatureType = Number(formValues.signatureType);
  if (![0, 1].includes(signatureType)) {
    throw new Error("浏览器签名当前只支持 EOA(0) 和官方 Proxy(1)");
  }
  const account = String(connectedAccount ?? "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(account)) {
    throw new Error("请先连接有效的 EVM 钱包");
  }
  const maker =
    signatureType === 0 ? account : String(formValues.maker ?? "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(maker)) {
    throw new Error("Proxy maker 地址无效");
  }
  const sideText = String(formValues.side ?? "").toUpperCase();
  if (!["BUY", "SELL"].includes(sideText)) {
    throw new Error("side 必须是 BUY 或 SELL");
  }
  const message = {
    salt: integerString(formValues.salt, "salt"),
    maker,
    signer: account,
    tokenId: integerString(formValues.tokenId, "tokenId"),
    makerAmount: integerString(formValues.makerAmount, "makerAmount"),
    takerAmount: integerString(formValues.takerAmount, "takerAmount"),
    side: sideText === "BUY" ? 0 : 1,
    signatureType,
    timestamp: integerString(formValues.timestamp ?? Date.now(), "timestamp"),
    metadata: formValues.metadata || ZERO_BYTES32,
    builder: formValues.builder || ZERO_BYTES32,
  };
  const typedData = {
    domain: {
      name: "Polymarket CTF Exchange",
      version: "2",
      chainId: Number(runtime.chainId),
      verifyingContract: runtime.exchange,
    },
    primaryType: "Order",
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      Order: ORDER_TYPES,
    },
    message,
  };
  return {
    typedData,
    payload: {
      marketId: String(formValues.marketId),
      maker,
      signer: account,
      side: sideText,
      tokenId: message.tokenId,
      makerAmount: message.makerAmount,
      takerAmount: message.takerAmount,
      expiration: Number(formValues.expiration ?? 0),
      salt: message.salt,
      signatureType,
      timestamp: message.timestamp,
      metadata: message.metadata,
      builder: message.builder,
    },
  };
}

export async function signOrderTypedData(provider, account, typedData) {
  requireProvider(provider);
  await ensureAmoy(provider);
  return provider.request({
    method: "eth_signTypedData_v4",
    params: [account, JSON.stringify(typedData)],
  });
}

function stripHex(value) {
  return String(value).replace(/^0x/i, "");
}

function encodeAddress(value) {
  const raw = stripHex(value);
  if (!/^[0-9a-fA-F]{40}$/.test(raw)) throw new Error(`地址无效：${value}`);
  return raw.toLowerCase().padStart(64, "0");
}

function encodeUint(value) {
  return BigInt(value).toString(16).padStart(64, "0");
}

async function ethCallUint(provider, to, data) {
  const result = await provider.request({
    method: "eth_call",
    params: [{ to, data }, "latest"],
  });
  return BigInt(result || "0x0");
}

export function formatUnits(value, decimals) {
  const amount = BigInt(value);
  const base = 10n ** BigInt(decimals);
  const whole = amount / base;
  const fraction = (amount % base)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export async function readWalletAssets(provider, runtime, maker, account, tokenId) {
  requireProvider(provider);
  await ensureAmoy(provider);
  const balanceOf = `0x70a08231${encodeAddress(maker)}`;
  const allowance =
    `0xdd62ed3e${encodeAddress(maker)}${encodeAddress(runtime.exchange)}`;
  const erc1155Balance =
    `0x00fdd58e${encodeAddress(maker)}${encodeUint(tokenId)}`;
  const approvedForAll =
    `0xe985e9c5${encodeAddress(maker)}${encodeAddress(runtime.exchange)}`;
  const [pol, collateral, collateralAllowance, outcome, approved] =
    await Promise.all([
      provider.request({ method: "eth_getBalance", params: [account, "latest"] }),
      ethCallUint(provider, runtime.collateral, balanceOf),
      ethCallUint(provider, runtime.collateral, allowance),
      ethCallUint(provider, runtime.ctf, erc1155Balance),
      ethCallUint(provider, runtime.ctf, approvedForAll),
    ]);
  const decimals = Number(runtime.collateralDecimals ?? 6);
  return {
    accountPOL: formatUnits(BigInt(pol), 18),
    makerCollateral: formatUnits(collateral, decimals),
    makerCollateralAllowance: formatUnits(collateralAllowance, decimals),
    makerOutcome: formatUnits(outcome, decimals),
    outcomeApprovedForExchange: approved !== 0n,
  };
}
