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

function compactError(error) {
  return (
    error && typeof error === "object" && typeof error.shortMessage === "string"
      ? error.shortMessage
      : error instanceof Error
        ? error.message
        : String(error)
  ).replace(/\s+/g, " ").trim();
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
       original_amount, reserved_amount, status, release_reason, risk_status,
       created_at, updated_at
     )
     VALUES(
       :chainId, :localOrderId, :walletAddress, :assetType, :tokenId,
       :originalAmount, :reservedAmount, :status, :releaseReason, :riskStatus,
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
     )
     ON CONFLICT(chain_id, local_order_id) DO UPDATE SET
       wallet_address = excluded.wallet_address,
       asset_type = excluded.asset_type,
       token_id = excluded.token_id,
       original_amount = excluded.original_amount,
       reserved_amount = excluded.reserved_amount,
       status = excluded.status,
       release_reason = excluded.release_reason,
       risk_status = CASE
         WHEN excluded.status = 'RELEASED' THEN 'RELEASED'
         WHEN order_reservations.status <> excluded.status
           OR order_reservations.wallet_address <> excluded.wallet_address
           OR order_reservations.asset_type <> excluded.asset_type
           OR order_reservations.token_id <> excluded.token_id
           OR order_reservations.reserved_amount <> excluded.reserved_amount
           THEN 'UNCHECKED'
         ELSE order_reservations.risk_status
       END,
       risk_error = CASE
         WHEN excluded.status = 'RELEASED'
           OR order_reservations.reserved_amount <> excluded.reserved_amount
           THEN NULL
         ELSE order_reservations.risk_error
       END,
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
    riskStatus: spec.status === "ACTIVE" ? "UNCHECKED" : "RELEASED",
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
         risk_status = 'RELEASED',
         risk_error = NULL,
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
      riskStatuses: {},
      chainCapacity: row.chain_capacity,
      chainBalance: row.chain_balance,
      chainAllowance: row.chain_allowance,
      approvedForAll:
        row.approved_for_all === null ? null : Boolean(row.approved_for_all),
      lastCheckedAt: row.last_checked_at,
    };
    current.reservedAmount += amount(row.reserved_amount, "reserved_amount");
    current.orderCount += 1;
    current.riskStatuses[row.risk_status] =
      (current.riskStatuses[row.risk_status] ?? 0) + 1;
    if (
      row.last_checked_at &&
      (!current.lastCheckedAt || row.last_checked_at > current.lastCheckedAt)
    ) {
      current.chainCapacity = row.chain_capacity;
      current.chainBalance = row.chain_balance;
      current.chainAllowance = row.chain_allowance;
      current.approvedForAll =
        row.approved_for_all === null ? null : Boolean(row.approved_for_all);
      current.lastCheckedAt = row.last_checked_at;
    }
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

export function recordReservationRisk(db, localOrderId, chainId, snapshot, riskStatus) {
  const status = String(riskStatus).toUpperCase();
  if (!["COVERED", "OVERCOMMITTED", "CHECK_FAILED"].includes(status)) {
    throw new Error(`未知 riskStatus：${riskStatus}`);
  }
  const result = db.prepare(
    `UPDATE order_reservations
     SET risk_status = :riskStatus,
         chain_capacity = :chainCapacity,
         chain_balance = :chainBalance,
         chain_allowance = :chainAllowance,
         approved_for_all = :approvedForAll,
         risk_error = :riskError,
         last_checked_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
     WHERE chain_id = :chainId
       AND local_order_id = :localOrderId
       AND status = 'ACTIVE'`,
  ).run({
    chainId: Number(chainId),
    localOrderId,
    riskStatus: status,
    chainCapacity: snapshot?.capacity?.toString() ?? null,
    chainBalance: snapshot?.balance?.toString() ?? null,
    chainAllowance: snapshot?.allowance?.toString() ?? null,
    approvedForAll:
      snapshot?.approvedForAll === null || snapshot?.approvedForAll === undefined
        ? null
        : snapshot.approvedForAll
          ? 1
          : 0,
    riskError: snapshot?.error ?? null,
  });
  return Number(result.changes ?? 0);
}

export async function auditActiveReservations(
  db,
  runtime,
  client = createRiskPublicClient(),
) {
  syncAllReservations(db);
  const reservations = db.prepare(
    `SELECT *
     FROM order_reservations
     WHERE status = 'ACTIVE'
     ORDER BY chain_id, lower(wallet_address), asset_type, token_id,
              created_at, local_order_id`,
  ).all();
  const groups = new Map();
  for (const row of reservations) {
    const key = [
      row.chain_id,
      row.wallet_address.toLowerCase(),
      row.asset_type,
      row.token_id,
    ].join(":");
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  const result = {
    checkedAt: new Date().toISOString(),
    groups: groups.size,
    reservations: reservations.length,
    covered: 0,
    overcommitted: 0,
    checkFailed: 0,
    details: [],
  };
  for (const [key, group] of groups) {
    const first = group[0];
    const spec = {
      chainId: Number(first.chain_id),
      walletAddress: getAddress(first.wallet_address),
      assetType: first.asset_type,
      tokenId: first.token_id,
    };
    try {
      const snapshot = await readChainCapacity(runtime, spec, client);
      let cumulative = 0n;
      const orders = [];
      for (const row of group) {
        cumulative += amount(row.reserved_amount, "reserved_amount");
        const covered = cumulative <= snapshot.capacity;
        recordReservationRisk(
          db,
          row.local_order_id,
          row.chain_id,
          snapshot,
          covered ? "COVERED" : "OVERCOMMITTED",
        );
        if (covered) result.covered += 1;
        else result.overcommitted += 1;
        orders.push({
          localOrderId: row.local_order_id,
          reservedAmount: row.reserved_amount,
          cumulativeReserved: cumulative.toString(),
          riskStatus: covered ? "COVERED" : "OVERCOMMITTED",
        });
      }
      result.details.push({
        key,
        walletAddress: spec.walletAddress,
        assetType: spec.assetType,
        tokenId: spec.tokenId,
        capacity: snapshot.capacity.toString(),
        balance: snapshot.balance.toString(),
        allowance: snapshot.allowance?.toString() ?? null,
        approvedForAll: snapshot.approvedForAll,
        orders,
      });
    } catch (error) {
      const message = compactError(error);
      for (const row of group) {
        recordReservationRisk(
          db,
          row.local_order_id,
          row.chain_id,
          { error: message },
          "CHECK_FAILED",
        );
        result.checkFailed += 1;
      }
      result.details.push({
        key,
        walletAddress: spec.walletAddress,
        assetType: spec.assetType,
        tokenId: spec.tokenId,
        error: message,
      });
    }
  }
  return result;
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
