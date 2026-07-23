import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import { AMOY_CHAIN_ID } from "./constants.js";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.resolve(projectDir, "..", ".env"), quiet: true });
dotenv.config({ path: path.resolve(projectDir, ".env"), override: true, quiet: true });
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
}

export const PROJECT_DIR = projectDir;

export function value(name: string, fallback?: string): string | undefined {
  const raw = process.env[name]?.trim();
  return raw || fallback;
}

export function required(name: string): string {
  const result = value(name);
  if (!result) throw new Error(`缺少环境变量 ${name}`);
  return result;
}

export function address(name: string): Address {
  const result = required(name);
  if (!isAddress(result)) throw new Error(`${name} 不是有效的 EVM 地址`);
  return getAddress(result);
}

export function privateKey(): Hex {
  const key =
    value("POLYMARKET_PRIVATE_KEY") ??
    value("ETH_PRIVATE_KEY") ??
    value("PRIVATE_KEY");
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(
      "缺少有效的 POLYMARKET_PRIVATE_KEY（也可回退到根目录 ETH_PRIVATE_KEY）",
    );
  }
  return key as Hex;
}

export function chainId(): number {
  const id = Number(value("CHAIN_ID", String(AMOY_CHAIN_ID)));
  if (id !== AMOY_CHAIN_ID) {
    throw new Error(`仅支持 Polygon Amoy 测试网 chainId=80002，当前为 ${id}`);
  }
  return id;
}

export function amoyRpcUrls(): string[] {
  const configured = value("AMOY_RPC_URLS") ?? value("AMOY_RPC_URL");
  const preferred = configured
    ? configured
        .split(",")
        .map((url) => url.trim())
        .filter(Boolean)
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

export function relayerUrl(): string {
  return (
    value("RELAYER_TESTNET_URL") ??
    value("RELAYER_URL") ??
    "https://relayer-v2.polymarket.com/"
  );
}

export function hasDedicatedTestnetRelayer(): boolean {
  return Boolean(value("RELAYER_TESTNET_URL"));
}

export function assertDedicatedAmoyRelayer(): void {
  const url = value("RELAYER_TESTNET_URL");
  if (!url) {
    throw new Error(
      "未配置 RELAYER_TESTNET_URL。生产 relayer 不接受 chainId 参数，会把 WALLET 请求发送到 Polygon 主网；Amoy 写入已拦截。",
    );
  }
  const hostname = new URL(url).hostname.toLowerCase();
  if (
    hostname === "relayer-v2.polymarket.com" ||
    hostname === "relayer.polymarket.com"
  ) {
    throw new Error("RELAYER_TESTNET_URL 指向生产 relayer，Amoy 写入已拦截");
  }
}

export function bool(name: string, fallback = false): boolean {
  const raw = value(name);
  if (!raw) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} 必须是 true 或 false`);
}

export function assertLiveAction(action: string): void {
  if (value("LIVE_ACTION", "NONE") !== action) {
    throw new Error(`写入已拦截：请设置 LIVE_ACTION=${action}`);
  }
  if (value("LIVE_CONFIRMATION") !== "AMOY_TESTNET_ONLY") {
    throw new Error(
      "测试网写入已拦截：请设置 LIVE_CONFIRMATION=AMOY_TESTNET_ONLY",
    );
  }
}
