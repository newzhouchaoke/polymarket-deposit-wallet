import { createPublicClient, fallback, getAddress, http } from "viem";
import { polygonAmoy } from "viem/chains";
import { erc1155Abi, erc20Abi } from "./exchange-config.mjs";

const ACTIVE_ORDER_STATUSES = new Set([
  "OPEN",
  "PARTIALLY_FILLED",
  "USER_PAUSED",
]);

function amount(value, name) {
  const text = String(value ?? "");
  if (!/^\d+$/.test(text)) throw new Error(`${name} 必须是 uint256 字符串`);
  return BigInt(text);
}

function rpcUrls() {
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

export function reservationSpec(order) {
  const original = amount(order.maker_amount, "maker_amount");
  const filled = amount(order.filled_maker_amount ?? "0", "filled_maker_amount");
  if (filled > original) {
    throw new Error(`订单 ${order.local_order_id} 的 filled_maker_amount 超过 maker_amount`);
  }
  const active = ACTIVE_ORDER_STATUSES.has(String(order.status).toUpperCase());
  const remaining = active ? original - filled : 0n;
  return {
    chainId: Number(order.chain_id),
    localOrderId: String(order.local_order_id),
    walletAddress: getAddress(order.maker),
    assetType: String(order.side).toUpperCase() === "BUY"
      ? "COLLATERAL"
      : "OUTCOME",
    tokenId: String(order.side).toUpperCase() === "BUY"
      ? ""
      : String(order.token_id),
    originalAmount: original,
    reservedAmount: remaining,
    status: remaining > 0n ? "ACTIVE" : "RELEASED",
    releaseReason: remaining > 0n ? null : String(order.status).toUpperCase(),
  };
}

export function syncOrderReservation(db, localOrderId, chainId) {
  const params = chainId === undefined
    ? { localOrderId }
    : { localOrderId, chainId: Number(chainId) };
  const order = db.prepare(
    `SELECT *
     FROM orders
     WHERE local_order_id = :localOrderId
       ${chainId === undefined ? "" : "AND chain_id = :chainId"}
     ORDER BY chain_id
     LIMIT 1`,
  ).get(params);
  if (!order) return null;
  const spec = reservationSpec(order);
  db.prepare(
    `INSERT INTO order_reservations(
       chain_id, local_order_id, wallet_address, asset_type, token_id,
       original_amount, reserved_amount, status, release_reason, updated_at
     )
     VALUES(
       :chainId, :localOrderId, :walletAddress, :assetType, :tokenId,
       :originalAmount, :reservedAmount, :status, :releaseReason,
       CURRENT_TIMESTAMP
     )
     ON CONFLICT(chain_id, local_order_id) DO UPDATE SET
       wallet_address = excluded.wallet_address,
       asset_type = excluded.asset_type,
       token_id = excluded.token_id,
       original_amount = excluded.original_amount,
       reserved_amount = excluded.reserved_amount,
       status = excluded.status,
       release_reason = excluded.release_reason,
       updated_at = CURRENT_TIMESTAMP`,
  ).run({
    chainId: spec.chainId,
    localOrderId: spec.localOrderId,
    walletAddress: spec.walletAddress,
    assetType: spec.assetType,
    tokenId: spec.tokenId,
    originalAmount: spec.originalAmount.toString(),
    reservedAmount: spec.reservedAmount.toString(),
    status: spec.status,
    releaseReason: spec.releaseReason,
  });
  return spec;
}

export function syncAllReservations(db) {
  const orders = db.prepare(
    "SELECT chain_id, local_order_id FROM orders ORDER BY chain_id, local_order_id",
  ).all();
  for (const order of orders) {
    syncOrderReservation(db, order.local_order_id, order.chain_id);
  }
  const released = db.prepare(
    `UPDATE order_reservations
     SET status = 'RELEASED',
         reserved_amount = '0',
         release_reason = 'ORDER_REMOVED',
         updated_at = CURRENT_TIMESTAMP
     WHERE NOT EXISTS (
       SELECT 1 FROM orders
       WHERE orders.chain_id = order_reservations.chain_id
         AND orders.local_order_id = order_reservations.local_order_id
     )`,
  ).run();
  return {
    orders: orders.length,
    orphanReservationsReleased: Number(released.changes ?? 0),
  };
}

export function reservedForAsset(db, {
  chainId,
  walletAddress,
  assetType,
  tokenId = "",
  excludeLocalOrderId,
}) {
  const rows = db.prepare(
    `SELECT local_order_id, reserved_amount
     FROM order_reservations
     WHERE chain_id = :chainId
       AND lower(wallet_address) = lower(:walletAddress)
       AND asset_type = :assetType
       AND token_id = :tokenId
       AND status = 'ACTIVE'
       AND (:excludeLocalOrderId IS NULL OR local_order_id <> :excludeLocalOrderId)`,
  ).all({
    chainId: Number(chainId),
    walletAddress,
    assetType,
    tokenId,
    excludeLocalOrderId: excludeLocalOrderId ?? null,
  });
  return rows.reduce(
    (total, row) => total + amount(row.reserved_amount, "reserved_amount"),
    0n,
  );
}

export function assertReservationCapacity(db, spec, capacity) {
  const alreadyReserved = reservedForAsset(db, {
    chainId: spec.chainId,
    walletAddress: spec.walletAddress,
    assetType: spec.assetType,
    tokenId: spec.tokenId,
    excludeLocalOrderId: spec.localOrderId,
  });
  const available = capacity > alreadyReserved ? capacity - alreadyReserved : 0n;
  if (spec.reservedAmount > available) {
    const error = new Error(
      `可用额度不足：订单需要 ${spec.reservedAmount}，链上可用上限 ${capacity}，` +
      `其他活动订单已预占 ${alreadyReserved}，剩余 ${available}`,
    );
    error.statusCode = 422;
    error.code = "ORDER_RISK_REJECTED";
    error.details = {
      assetType: spec.assetType,
      tokenId: spec.tokenId,
      required: spec.reservedAmount.toString(),
      chainCapacity: capacity.toString(),
      alreadyReserved: alreadyReserved.toString(),
      available: available.toString(),
    };
    throw error;
  }
  return {
    assetType: spec.assetType,
    tokenId: spec.tokenId,
    required: spec.reservedAmount.toString(),
    chainCapacity: capacity.toString(),
    alreadyReserved: alreadyReserved.toString(),
    availableBeforeOrder: available.toString(),
    availableAfterOrder: (available - spec.reservedAmount).toString(),
  };
}

export function reservationSummary(db, walletAddress) {
  const clauses = ["status = 'ACTIVE'"];
  const params = {};
  if (walletAddress) {
    clauses.push("lower(wallet_address) = lower(:walletAddress)");
    params.walletAddress = getAddress(walletAddress);
  }
  const reservations = db.prepare(
    `SELECT *
     FROM order_reservations
     WHERE ${clauses.join(" AND ")}
     ORDER BY wallet_address, asset_type, token_id, updated_at`,
  ).all(params);
  const grouped = new Map();
  for (const row of reservations) {
    const key = [
      row.chain_id,
      row.wallet_address.toLowerCase(),
      row.asset_type,
      row.token_id,
    ].join(":");
    const current = grouped.get(key) ?? {
      chainId: row.chain_id,
      walletAddress: row.wallet_address,
      assetType: row.asset_type,
      tokenId: row.token_id,
      reservedAmount: 0n,
      orderCount: 0,
    };
    current.reservedAmount += amount(row.reserved_amount, "reserved_amount");
    current.orderCount += 1;
    grouped.set(key, current);
  }
  return {
    walletAddress: walletAddress ? getAddress(walletAddress) : null,
    totals: [...grouped.values()].map((item) => ({
      ...item,
      reservedAmount: item.reservedAmount.toString(),
    })),
    reservations,
  };
}

export function createRiskPublicClient() {
  return createPublicClient({
    chain: polygonAmoy,
    transport: fallback(
      rpcUrls().map((url) => http(url, { retryCount: 1, timeout: 10_000 })),
      { rank: false },
    ),
  });
}

export async function readChainCapacity(runtime, spec, client = createRiskPublicClient()) {
  if (spec.assetType === "COLLATERAL") {
    const [balance, allowance] = await Promise.all([
      client.readContract({
        address: runtime.collateral,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [spec.walletAddress],
      }),
      client.readContract({
        address: runtime.collateral,
        abi: erc20Abi,
        functionName: "allowance",
        args: [spec.walletAddress, runtime.exchange],
      }),
    ]);
    const normalizedBalance = BigInt(balance);
    const normalizedAllowance = BigInt(allowance);
    return {
      capacity: normalizedBalance < normalizedAllowance
        ? normalizedBalance
        : normalizedAllowance,
      balance: normalizedBalance,
      allowance: normalizedAllowance,
      approvedForAll: null,
    };
  }
  const [balance, approvedForAll] = await Promise.all([
    client.readContract({
      address: runtime.ctf,
      abi: erc1155Abi,
      functionName: "balanceOf",
      args: [spec.walletAddress, BigInt(spec.tokenId)],
    }),
    client.readContract({
      address: runtime.ctf,
      abi: erc1155Abi,
      functionName: "isApprovedForAll",
      args: [spec.walletAddress, runtime.exchange],
    }),
  ]);
  const normalizedBalance = BigInt(balance);
  return {
    capacity: approvedForAll ? normalizedBalance : 0n,
    balance: normalizedBalance,
    allowance: null,
    approvedForAll: Boolean(approvedForAll),
  };
}
