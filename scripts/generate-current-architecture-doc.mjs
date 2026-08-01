import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { dbPath, initSchema, openDatabase, projectDir } from "./db.js";

const docsDir = path.join(projectDir, "docs");
const outputName = "Polymarket_真实交易研究系统_当前完整架构说明.docx";
const outputPath = path.join(docsDir, outputName);
const v2DeploymentPath = path.join(projectDir, "deployments", "research-v2-amoy.json");
const deploymentPath = fs.existsSync(v2DeploymentPath)
  ? v2DeploymentPath
  : path.join(projectDir, "deployments", "research-official-like-amoy.json");
const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), "current-architecture-docx-"));

const deployment = fs.existsSync(deploymentPath)
  ? JSON.parse(fs.readFileSync(deploymentPath, "utf8"))
  : {};

const db = openDatabase();
initSchema(db);

function all(sql, params = {}) {
  return db.prepare(sql).all(params);
}

function one(sql, params = {}) {
  return db.prepare(sql).get(params);
}

function count(table) {
  return one(`SELECT COUNT(*) AS count FROM ${table}`).count;
}

function escapeXml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function run(text, options = {}) {
  const {
    bold = false,
    italic = false,
    color,
    size,
    font = "Microsoft YaHei",
    breakAfter = false,
  } = options;
  const props = [
    `<w:rFonts w:ascii="${escapeXml(font)}" w:hAnsi="${escapeXml(font)}" w:eastAsia="${escapeXml(font)}"/>`,
    bold ? "<w:b/>" : "",
    italic ? "<w:i/>" : "",
    color ? `<w:color w:val="${color}"/>` : "",
    size ? `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>` : "",
  ].join("");
  return `<w:r><w:rPr>${props}</w:rPr><w:t xml:space="preserve">${escapeXml(text)}</w:t>${breakAfter ? "<w:br/>" : ""}</w:r>`;
}

function paragraph(text, options = {}) {
  const {
    style = "Normal",
    align,
    before,
    after = 120,
    left,
    hanging,
    keepNext = false,
    pageBreakBefore = false,
    bold = false,
    italic = false,
    color,
    size,
    font,
  } = options;
  const pPr = [
    style ? `<w:pStyle w:val="${style}"/>` : "",
    align ? `<w:jc w:val="${align}"/>` : "",
    before || after ? `<w:spacing${before ? ` w:before="${before}"` : ""}${after ? ` w:after="${after}"` : ""}/>` : "",
    left || hanging ? `<w:ind${left ? ` w:left="${left}"` : ""}${hanging ? ` w:hanging="${hanging}"` : ""}/>` : "",
    keepNext ? "<w:keepNext/>" : "",
    pageBreakBefore ? "<w:pageBreakBefore/>" : "",
  ].join("");
  return `<w:p><w:pPr>${pPr}</w:pPr>${run(text, { bold, italic, color, size, font })}</w:p>`;
}

function heading(text, level = 1) {
  return paragraph(text, { style: `Heading${level}`, keepNext: true, after: 160 });
}

function bullet(text, level = 0) {
  return `<w:p><w:pPr><w:spacing w:after="70"/><w:ind w:left="${720 + level * 360}" w:hanging="360"/></w:pPr>${run("• ", { bold: true, color: "1565C0" })}${run(text)}</w:p>`;
}

function code(lines) {
  const body = Array.isArray(lines) ? lines : String(lines).split("\n");
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="D0D7DE"/><w:left w:val="single" w:sz="4" w:color="D0D7DE"/><w:bottom w:val="single" w:sz="4" w:color="D0D7DE"/><w:right w:val="single" w:sz="4" w:color="D0D7DE"/></w:tblBorders><w:tblCellMar><w:top w:w="120" w:type="dxa"/><w:left w:w="160" w:type="dxa"/><w:bottom w:w="120" w:type="dxa"/><w:right w:w="160" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tr><w:tc><w:tcPr><w:shd w:fill="F6F8FA"/></w:tcPr>${body.map((line) => paragraph(line || " ", { style: "Code", font: "Consolas", size: 18, after: 0 })).join("")}</w:tc></w:tr></w:tbl>${paragraph("", { after: 90 })}`;
}

function cell(text, options = {}) {
  const { bold = false, fill, color, width, font, size = 18 } = options;
  return `<w:tc><w:tcPr>${width ? `<w:tcW w:w="${width}" w:type="dxa"/>` : ""}${fill ? `<w:shd w:fill="${fill}"/>` : ""}<w:vAlign w:val="center"/><w:tcMar><w:top w:w="90" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="90" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tcMar></w:tcPr>${paragraph(text, { bold, color, font, size, after: 0 })}</w:tc>`;
}

function table(headers, rows, widths = []) {
  const grid = widths.length ? `<w:tblGrid>${widths.map((width) => `<w:gridCol w:w="${width}"/>`).join("")}</w:tblGrid>` : "";
  const headerRow = `<w:tr>${headers.map((header, index) => cell(header, { bold: true, fill: "1565C0", color: "FFFFFF", width: widths[index] })).join("")}</w:tr>`;
  const bodyRows = rows.map((row, rowIndex) => `<w:tr>${row.map((value, index) => cell(value, {
    fill: rowIndex % 2 === 0 ? "F7FAFC" : "FFFFFF",
    width: widths[index],
    font: String(value).startsWith("0x") || String(value).includes("/") || String(value).includes(".") ? "Consolas" : "Microsoft YaHei",
    size: String(value).length > 55 ? 14 : 18,
  })).join("")}</w:tr>`).join("");
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblLayout w:type="fixed"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="B8C4CE"/><w:left w:val="single" w:sz="4" w:color="B8C4CE"/><w:bottom w:val="single" w:sz="4" w:color="B8C4CE"/><w:right w:val="single" w:sz="4" w:color="B8C4CE"/><w:insideH w:val="single" w:sz="4" w:color="D8E0E7"/><w:insideV w:val="single" w:sz="4" w:color="D8E0E7"/></w:tblBorders></w:tblPr>${grid}${headerRow}${bodyRows}</w:tbl>${paragraph("", { after: 90 })}`;
}

function callout(title, text, fill = "FFF4CE", border = "D6B656") {
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:left w:val="single" w:sz="18" w:color="${border}"/><w:top w:val="nil"/><w:right w:val="nil"/><w:bottom w:val="nil"/></w:tblBorders><w:tblCellMar><w:top w:w="140" w:type="dxa"/><w:left w:w="180" w:type="dxa"/><w:bottom w:w="140" w:type="dxa"/><w:right w:w="180" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tr><w:tc><w:tcPr><w:shd w:fill="${fill}"/></w:tcPr>${paragraph(title, { bold: true, after: 60 })}${paragraph(text, { after: 0 })}</w:tc></w:tr></w:tbl>${paragraph("", { after: 80 })}`;
}

function pageBreak() {
  return `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`;
}

function safeRows(sql, mapper, limit = 20) {
  try {
    return all(sql).slice(0, limit).map(mapper);
  } catch {
    return [];
  }
}

const counts = {
  contracts: count("contracts"),
  wallets: count("wallets"),
  markets: count("markets"),
  orders: count("orders"),
  trades: count("trades"),
  balances: count("token_balances"),
  events: count("chain_events"),
  actions: count("chain_actions"),
};

const contracts = safeRows(
  "SELECT name, role, address, notes FROM contracts ORDER BY name",
  (row) => [row.name, row.role, row.address, row.notes ?? ""],
  20,
);
const markets = safeRows(
  "SELECT market_id, status, question, yes_token_id, no_token_id FROM markets ORDER BY updated_at DESC",
  (row) => [row.market_id, row.status, row.question, row.yes_token_id, row.no_token_id],
  6,
);
const recentOrders = safeRows(
  "SELECT local_order_id, side, price_micros, status, filled_maker_amount, maker_amount, filled_taker_amount, taker_amount FROM orders ORDER BY updated_at DESC LIMIT 12",
  (row) => [
    row.local_order_id,
    row.side,
    String(row.price_micros),
    row.status,
    `${row.filled_maker_amount}/${row.maker_amount}`,
    `${row.filled_taker_amount}/${row.taker_amount}`,
  ],
  12,
);
const recentTrades = safeRows(
  "SELECT tx_hash, buyer, seller, outcome_amount, collateral_amount FROM trades ORDER BY created_at DESC LIMIT 8",
  (row) => [row.tx_hash, row.buyer, row.seller, row.outcome_amount, row.collateral_amount],
  8,
);
const recentEvents = safeRows(
  "SELECT event_name, tx_hash, block_number, contract_address FROM chain_events ORDER BY block_number DESC, log_index DESC LIMIT 12",
  (row) => [row.event_name, row.tx_hash, String(row.block_number), row.contract_address],
  12,
);

const body = [];

body.push(
  paragraph("Polymarket-like 真实交易研究系统", { style: "Title", align: "center", before: 1600, after: 220 }),
  paragraph("当前完整架构、合约、数据库、API 与操作说明", { style: "Subtitle", align: "center", after: 650 }),
  table(
    ["文档项", "内容"],
    [
      ["项目路径", projectDir],
      ["目标网络", "Polygon Amoy 测试网（chainId 80002）"],
      ["生成时间", new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })],
      ["数据库", dbPath],
      ["部署记录", deploymentPath],
      ["当前 Exchange", deployment.exchange ?? ""],
      ["当前 Market", deployment.market?.marketId ?? ""],
    ],
    [2100, 6700],
  ),
  callout(
    "重要说明",
    "本文档记录的是独立研究系统，不是 Polymarket 官方系统。项目中的 Deposit Wallet、rWALLET、YES/NO、Exchange、订单簿和撮合器均为 Amoy 测试网研究实现，不能用于真实资金或生产交易。",
    "FDECEC",
    "C62828",
  ),
  pageBreak(),
);

body.push(
  heading("1. 当前项目能力总览", 1),
  paragraph("项目已经从最初的 Demo 系统升级为可运行的真实交易研究系统雏形：支持链下签名订单、SQLite 订单簿、链上验签、链上撮合、链上部分成交、链上取消、事件同步、余额同步与浏览器交易控制台。"),
  table(
    ["模块", "当前状态", "说明"],
    [
      ["智能钱包", "已完成", "CREATE2 + ERC-1967 BeaconProxy；EIP-712 Batch、nonce/deadline、ERC-1271"],
      ["资产", "已完成", "rWALLET 抵押币；标准 ERC-1155 调用方式；CTF split/merge/redeem"],
      ["市场生命周期", "已完成基础版", "Market 存储与 OPEN/CLOSED/RESOLVED 状态；前端控制还可继续增强"],
      ["订单簿", "已完成", "SQLite 保存订单、状态、签名、成交数量；API 可查询 orderbook"],
      ["签名订单", "已完成", "EIP-712 Order，signer 为 Deposit Wallet，owner 签名，链上 ERC-1271 验证"],
      ["链上撮合", "已完成", "V2 风格一对多 matchOrders；COMPLEMENTARY、MINT、MERGE"],
      ["链上取消", "研究扩展", "EIP-712 Cancel(orderHash)，OrderStatus 标记 filled"],
      ["前端控制台", "已完成基础版", "/trade 支持生成签名订单、链上撮合、链上取消、同步、订单簿查看"],
      ["事件与余额同步", "已完成", "OrdersMatched、OrderCancelled、Transfer、Approval 等事件入库；余额链上读取"],
    ],
    [1900, 1800, 5100],
  ),
  table(
    ["数据项", "数量"],
    Object.entries(counts).map(([key, value]) => [key, String(value)]),
    [2500, 1600],
  ),
);

body.push(
  heading("2. 系统总体架构", 1),
  table(
    ["层级", "组件", "职责"],
    [
      ["前端/控制台", "/trade、/dashboard", "浏览订单簿、生成签名订单、触发链上撮合/取消、查看事件和余额"],
      ["API 服务", "scripts/api-server.mjs", "提供 /api/orders、/api/orderbook、/api/events、/api/sync 等接口"],
      ["数据库", "SQLite research-polymarket.sqlite", "保存 markets、orders、trades、balances、chain_events、chain_actions"],
      ["脚本层", "seed/match/cancel/sync/deploy 脚本", "生成签名、部署合约、撮合、取消、同步事件和余额"],
      ["钱包层", "DepositWallet + Beacon + Proxy + Factory", "确定性钱包、签名 Batch、session signer、ERC-1271"],
      ["交易层", "ResearchCLOBExchange", "V2 订单、operator 一对多撮合、费用、暂停、三种结算"],
      ["资产层", "ResearchWalletCoin / ResearchOutcomeToken", "抵押币与可 split/merge/redeem 的 ERC-1155 条件份额"],
      ["链层", "Polygon Amoy", "保存合约状态和交易日志，使用测试 POL 支付 gas"],
    ],
    [1600, 2800, 4400],
  ),
  heading("2.1 核心流程图", 2),
  code([
    "用户/脚本生成订单",
    "  -> EIP-712 签名，signer = Deposit Wallet",
    "  -> POST /api/orders 或 orders:seed:signed 写入 SQLite",
    "  -> 订单簿按 price_micros 聚合 BUY/SELL",
    "  -> matcher 发现 buy.price >= sell.price",
    "  -> 调用 matchOrders(conditionId, taker, makers[], fillAmounts[], fees[])",
    "  -> Exchange 调用 DepositWallet.isValidSignature 验证签名",
    "  -> transferFrom 交换 rWALLET 与 YES",
    "  -> OrdersMatched 事件上链",
    "  -> db-sync-events/db-sync-balances 回写数据库和 Dashboard",
  ]),
);

body.push(
  heading("3. 当前合约地址", 1),
  table(["名称", "角色", "地址", "备注"], contracts, [2100, 1600, 3200, 1900]),
  heading("3.1 关键部署记录", 2),
  table(
    ["字段", "值"],
    [
      ["owner", deployment.owner ?? ""],
      ["walletCoin", deployment.walletCoin ?? ""],
      ["outcomeToken", deployment.outcomeToken ?? ""],
      ["marketRegistry", deployment.marketRegistry ?? ""],
      ["walletFactory", deployment.walletFactory ?? ""],
      ["exchange", deployment.exchange ?? ""],
      ["buyerWallet", deployment.buyerWallet ?? ""],
      ["sellerWallet", deployment.sellerWallet ?? ""],
      ["previousExchanges", (deployment.previousExchanges ?? []).join(", ")],
    ],
    [2300, 6500],
  ),
);

body.push(
  heading("4. 智能合约说明", 1),
  heading("4.1 ResearchDepositWallet", 2),
  bullet("由 Factory 通过 CREATE2 部署 ERC-1967 BeaconProxy，每个 owner 一个确定性地址。"),
  bullet("支持官方公开 Batch 结构：wallet、nonce、deadline、calls，并支持 session signer。"),
  bullet("实现 ERC-1271，并实现 ERC-1155 receiver 以持有 YES/NO。"),
  bullet("本项目的 Deposit Wallet 是研究版自建钱包，不是官方 Polymarket Deposit Wallet。"),
  heading("4.2 ResearchCLOBExchange", 2),
  bullet("订单字段和 EIP-712 域对齐 CTF Exchange V2 公开结构。"),
  bullet("支持一个 taker 对多个 maker 的 matchOrders 入口。"),
  bullet("支持 BUY/SELL 直接交换、BUY+BUY MINT、SELL+SELL MERGE。"),
  bullet("使用 OrderStatus(filled, remaining) 记录剩余 maker amount。"),
  bullet("cancelOrder 是本研究项目保留的扩展，并非官方 V2 同名生产接口。"),
  bullet("发出 OrdersMatched 和 OrderCancelled 事件，供同步器写入数据库。"),
  heading("4.3 ResearchWalletCoin 与 ResearchOutcomeToken", 2),
  bullet("ResearchWalletCoin/rWALLET 是 6 位小数测试抵押币。"),
  bullet("ResearchOutcomeToken 使用 ERC-1155 标准方法并实现 prepare/split/merge/resolve/redeem。"),
  bullet("结果份额完全抵押，collateralizedSupply 用于检查抵押支持。"),
  heading("4.4 ResearchMarketRegistry", 2),
  bullet("保存 Market 数据：marketId、creator、question、yesTokenId、noTokenId、closeTime、status、winningOutcome。"),
  bullet("支持市场 OPEN/CLOSED/RESOLVED 生命周期事件。"),
  bullet("MarketRegistry 同时作为研究版 oracle adapter，resolve 后向 CTF 报告 payout。"),
);

body.push(
  heading("5. 数据库架构", 1),
  table(
    ["表名", "用途", "关键字段"],
    [
      ["contracts", "保存合约地址", "chain_id, name, address, role, notes"],
      ["wallets", "保存 Deposit Wallet", "wallet_address, owner_address, wallet_role"],
      ["markets", "市场生命周期", "market_id, status, yes_token_id, no_token_id, winning_outcome"],
      ["orders", "订单簿", "local_order_id, side, price_micros, status, signature, filled_*"],
      ["trades", "成交记录", "tx_hash, buyer, seller, outcome_amount, collateral_amount"],
      ["token_balances", "链上余额快照", "wallet_address, token_symbol, token_id, balance_decimal"],
      ["chain_events", "链上事件", "tx_hash, block_number, log_index, event_name, args_json"],
      ["chain_actions", "非成交链上动作", "ORDER_CANCEL 等动作与 tx_hash/local_order_id"],
      ["sync_state", "同步状态", "last_block"],
    ],
    [1700, 2600, 4500],
  ),
  heading("5.1 最近订单", 2),
  table(["订单ID", "方向", "价格", "状态", "maker成交/总量", "taker成交/总量"], recentOrders, [2400, 800, 1000, 1500, 1500, 1500]),
  heading("5.2 最近成交", 2),
  table(["交易哈希", "Buyer", "Seller", "Outcome", "Collateral"], recentTrades, [2700, 2300, 2300, 900, 1000]),
  heading("5.3 最近链上事件", 2),
  table(["事件", "交易哈希", "区块", "合约"], recentEvents, [1500, 3100, 900, 3100]),
);

body.push(
  heading("6. API 与前端控制台", 1),
  paragraph("API 服务由 scripts/api-server.mjs 提供，默认监听 http://127.0.0.1:8787。端口被占用时可执行 npm run api:restart 自动关闭旧进程并启动。"),
  table(
    ["入口", "方法", "作用"],
    [
      ["/dashboard", "GET", "可视化查看合约、钱包、市场、订单、订单簿、成交、余额、事件"],
      ["/trade", "GET", "交易控制台：生成签名订单、链上撮合、链上取消、同步"],
      ["/api/orders", "GET/POST", "查询订单/写入数据库订单"],
      ["/api/orders/seed-signed", "POST", "生成一组 EIP-712 签名订单，只写 SQLite"],
      ["/api/orders/match-chain", "POST", "链上自动撮合，需要 confirmation=AMOY_TESTNET_ONLY"],
      ["/api/orders/:id/cancel-chain", "POST", "链上取消订单，需要 confirmation=AMOY_TESTNET_ONLY"],
      ["/api/markets/:id/orderbook", "GET", "查询指定市场订单簿"],
      ["/api/events", "GET", "按 eventName/txHash/contract 查询链上事件"],
      ["/api/sync", "POST", "同步链上事件与余额"],
    ],
    [3100, 1100, 4600],
  ),
  heading("6.1 常用命令", 2),
  code([
    "cd /home/enovo/ethereum_conbine/polymarket-deposit-wallet",
    "npm run build",
    "npm run api:restart",
    "npm run orders:seed:signed",
    "LIVE_ACTION=MATCH_RESEARCH_ORDERS LIVE_CONFIRMATION=AMOY_TESTNET_ONLY npm run orders:match",
    "LIVE_ACTION=CANCEL_RESEARCH_ORDER LIVE_CONFIRMATION=AMOY_TESTNET_ONLY npm run orders:cancel:chain -- <local_order_id>",
    "npm run db:sync:events && npm run db:sync:balances && npm run db:summary",
  ]),
);

body.push(
  heading("7. 签名订单、撮合与取消", 1),
  heading("7.1 Order 结构", 2),
  code([
    "Order {",
    "  salt: uint256,",
    "  maker: address,",
    "  signer: address,",
    "  tokenId: uint256,      // YES/NO tokenId",
    "  makerAmount: uint256,  // BUY: 支付 rWALLET；SELL: 卖出 YES",
    "  takerAmount: uint256,  // BUY: 想买 YES；SELL: 想收 rWALLET",
    "  side: uint8,           // 0=BUY, 1=SELL",
    "  signatureType: uint8,",
    "  timestamp: uint256,",
    "  metadata: bytes32,",
    "  builder: bytes32,",
    "  signature: bytes",
    "}",
  ]),
  heading("7.2 部分成交规则", 2),
  bullet("matcher 计算 BUY 和 SELL 的剩余 outcome 数量，取较小值作为 outcomeAmount。"),
  bullet("collateralAmount = outcomeAmount * sell.takerAmount / sell.makerAmount。"),
  bullet("链上要求 buy price >= sell price，否则 PriceDoesNotCross。"),
  bullet("成交后 BUY 的 filled_maker_amount 增加 collateralAmount，filled_taker_amount 增加 outcomeAmount。"),
  bullet("成交后 SELL 的 filled_maker_amount 增加 outcomeAmount，filled_taker_amount 增加 collateralAmount。"),
  heading("7.3 链上取消规则", 2),
  bullet("取消签名使用 EIP-712 Cancel(orderHash)。"),
  bullet("Exchange 验证 signer 对 Cancel 的签名后把 OrderStatus 标记为 filled。"),
  bullet("同步器读取 OrderCancelled 事件后，把数据库订单状态更新为 CANCELLED。"),
);

body.push(
  heading("8. 当前市场、订单与余额状态", 1),
  table(["Market ID", "状态", "问题", "YES tokenId", "NO tokenId"], markets, [2500, 900, 2600, 1600, 1600]),
  heading("8.1 当前余额", 2),
  table(
    ["钱包", "资产", "Token ID", "余额"],
    safeRows(
      "SELECT wallet_address, token_symbol, token_id, balance_decimal FROM token_balances ORDER BY wallet_address, token_symbol, token_id",
      (row) => [row.wallet_address, row.token_symbol, row.token_id, row.balance_decimal],
      20,
    ),
    [2700, 900, 2600, 1200],
  ),
);

body.push(
  heading("9. 安全边界与限制", 1),
  bullet("本项目只面向 Polygon Amoy；src/env.ts 会限制 chainId=80002。"),
  bullet("链上写入动作必须设置 LIVE_ACTION 和 LIVE_CONFIRMATION=AMOY_TESTNET_ONLY。"),
  bullet("API 默认绑定 127.0.0.1，不应开放公网访问。"),
  bullet("当前后端会用本地私钥生成研究订单签名；真实系统应改为浏览器钱包签名，后端只接收 signed order。"),
  bullet("研究 CTF 没有复制 Gnosis collectionId 椭圆曲线算法，positionId 是可读版确定性计算。"),
  bullet("尚未实现官方 ERC-7739 包装、Safe 派生、Neg Risk、生产预言机和生产风控。"),
  bullet("所有合约未审计，不可用于主网资金。"),
  heading("9.1 与官方 Polymarket 的差异", 2),
  table(
    ["项目", "本研究系统", "官方 Polymarket"],
    [
      ["Deposit Wallet", "自建 ResearchDepositWallet", "官方创建/登记/支持的钱包"],
      ["CLOB", "本地 SQLite + 自建 matcher", "官方订单簿与 operator/relayer 体系"],
      ["Exchange", "ResearchCLOBExchange", "官方生产合约与结算体系"],
      ["资产", "rWALLET/测试 YES", "Polygon 主网 USDC/条件代币等"],
      ["用途", "学习、研究、Amoy 测试", "真实市场交易"],
    ],
    [1800, 3500, 3500],
  ),
);

body.push(
  heading("10. 后续完善路线", 1),
  bullet("把 /trade 的订单表每行加“链上取消”按钮和“点击价格填单”。"),
  bullet("将 matcher 做成常驻 daemon，周期性扫描订单簿并自动撮合。"),
  bullet("实现前端钱包连接和浏览器 EIP-712 签名，后端不再持有用户私钥。"),
  bullet("增加 order_fills 表，记录每一次部分成交明细。"),
  bullet("增加自动化测试：签名验证、价格交叉、部分成交、取消后不可成交。"),
  bullet("完善 Market CLOSED/RESOLVED 的前端按钮与 API，并在撮合前强制检查市场状态。"),
  bullet("增加费用模型、批量撮合、nonce 批量失效、风控和更多链上只读查询函数。"),
);

body.push(
  heading("附录 A：重要交易哈希", 1),
  table(
    ["名称", "交易哈希"],
    Object.entries(deployment.txs ?? {}).map(([key, value]) => [key, String(value)]),
    [2600, 6200],
  ),
  heading("附录 B：生成与导出", 1),
  paragraph(`本文档由 scripts/generate-current-architecture-doc.mjs 生成。输出路径：${outputPath}`),
  paragraph("文档不会读取或写入任何私钥、API Secret 或 Passphrase。共享文档前仍应确认其中只包含公开地址、测试交易哈希和架构说明。"),
);

const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas"
 xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
 xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"
 xmlns:v="urn:schemas-microsoft-com:vml"
 xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing"
 xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
 xmlns:w10="urn:schemas-microsoft-com:office:word"
 xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
 xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"
 xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup"
 xmlns:wpi="http://schemas.microsoft.com/office/word/2010/wordprocessingInk"
 xmlns:wne="http://schemas.microsoft.com/office/word/2006/wordml"
 xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"
 mc:Ignorable="w14 wp14">
 <w:body>
  ${body.join("\n")}
  <w:sectPr>
   <w:pgSz w:w="11906" w:h="16838"/>
   <w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/>
   <w:cols w:space="708"/>
   <w:docGrid w:linePitch="312"/>
  </w:sectPr>
 </w:body>
</w:document>`;

const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
 <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
  <w:name w:val="Normal"/><w:qFormat/>
  <w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr>
  <w:rPr><w:rFonts w:ascii="Microsoft YaHei" w:hAnsi="Microsoft YaHei" w:eastAsia="Microsoft YaHei"/><w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr>
 </w:style>
 <w:style w:type="paragraph" w:styleId="Title">
  <w:name w:val="Title"/><w:qFormat/>
  <w:pPr><w:jc w:val="center"/><w:spacing w:after="240"/></w:pPr>
  <w:rPr><w:rFonts w:ascii="Microsoft YaHei" w:hAnsi="Microsoft YaHei" w:eastAsia="Microsoft YaHei"/><w:b/><w:color w:val="0D47A1"/><w:sz w:val="44"/><w:szCs w:val="44"/></w:rPr>
 </w:style>
 <w:style w:type="paragraph" w:styleId="Subtitle">
  <w:name w:val="Subtitle"/><w:qFormat/>
  <w:pPr><w:jc w:val="center"/><w:spacing w:after="240"/></w:pPr>
  <w:rPr><w:rFonts w:ascii="Microsoft YaHei" w:hAnsi="Microsoft YaHei" w:eastAsia="Microsoft YaHei"/><w:color w:val="455A64"/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr>
 </w:style>
 <w:style w:type="paragraph" w:styleId="Heading1">
  <w:name w:val="heading 1"/><w:qFormat/>
  <w:pPr><w:keepNext/><w:spacing w:before="360" w:after="160"/></w:pPr>
  <w:rPr><w:rFonts w:ascii="Microsoft YaHei" w:hAnsi="Microsoft YaHei" w:eastAsia="Microsoft YaHei"/><w:b/><w:color w:val="0D47A1"/><w:sz w:val="30"/><w:szCs w:val="30"/></w:rPr>
 </w:style>
 <w:style w:type="paragraph" w:styleId="Heading2">
  <w:name w:val="heading 2"/><w:qFormat/>
  <w:pPr><w:keepNext/><w:spacing w:before="220" w:after="120"/></w:pPr>
  <w:rPr><w:rFonts w:ascii="Microsoft YaHei" w:hAnsi="Microsoft YaHei" w:eastAsia="Microsoft YaHei"/><w:b/><w:color w:val="1565C0"/><w:sz w:val="25"/><w:szCs w:val="25"/></w:rPr>
 </w:style>
 <w:style w:type="paragraph" w:styleId="Code">
  <w:name w:val="Code"/><w:qFormat/>
  <w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Consolas"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr>
 </w:style>
</w:styles>`;

const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="xml" ContentType="application/xml"/>
 <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
 <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
 <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
 <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;

const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
 <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
 <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;

const documentRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

const coreXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
 xmlns:dc="http://purl.org/dc/elements/1.1/"
 xmlns:dcterms="http://purl.org/dc/terms/"
 xmlns:dcmitype="http://purl.org/dc/dcmitype/"
 xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
 <dc:title>Polymarket-like 真实交易研究系统当前完整架构说明</dc:title>
 <dc:creator>Codex</dc:creator>
 <cp:lastModifiedBy>Codex</cp:lastModifiedBy>
 <dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created>
 <dcterms:modified xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:modified>
</cp:coreProperties>`;

const appXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"
 xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
 <Application>Codex DOCX Generator</Application>
 <DocSecurity>0</DocSecurity>
 <ScaleCrop>false</ScaleCrop>
 <Company>OpenAI</Company>
</Properties>`;

function writeFile(relativePath, content) {
  const file = path.join(buildDir, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

writeFile("[Content_Types].xml", contentTypesXml);
writeFile("_rels/.rels", relsXml);
writeFile("word/document.xml", documentXml);
writeFile("word/styles.xml", stylesXml);
writeFile("word/_rels/document.xml.rels", documentRelsXml);
writeFile("docProps/core.xml", coreXml);
writeFile("docProps/app.xml", appXml);

fs.mkdirSync(docsDir, { recursive: true });
fs.rmSync(outputPath, { force: true });

function listFiles(dir, prefix = "") {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(absolute, relative) : [relative];
  });
}

const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i += 1) {
  let c = i;
  for (let j = 0; j < 8; j += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  crcTable[i] = c >>> 0;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const time =
    (date.getHours() << 11) |
    (date.getMinutes() << 5) |
    Math.floor(date.getSeconds() / 2);
  const dosDate =
    ((date.getFullYear() - 1980) << 9) |
    ((date.getMonth() + 1) << 5) |
    date.getDate();
  return { time, date: dosDate };
}

function makeZip(sourceDir, targetFile) {
  const files = listFiles(sourceDir).sort();
  const chunks = [];
  const central = [];
  let offset = 0;
  const { time, date } = dosDateTime();

  for (const fileName of files) {
    const data = fs.readFileSync(path.join(sourceDir, fileName));
    const compressed = zlib.deflateRawSync(data, { level: 9 });
    const nameBuffer = Buffer.from(fileName, "utf8");
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuffer, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(date, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, nameBuffer);

    offset += local.length + nameBuffer.length + compressed.length;
  }

  const centralOffset = offset;
  const centralSize = central.reduce((sum, item) => sum + item.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);

  fs.writeFileSync(targetFile, Buffer.concat([...chunks, ...central, end]));
}

makeZip(buildDir, outputPath);
db.close();
console.log(`新版 Word 文档已生成：${outputPath}`);
