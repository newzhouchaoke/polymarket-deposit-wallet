import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { dbPath, initSchema, openDatabase, projectDir } from "./db.js";

const outputName = "Polymarket_项目交易流程步骤说明.docx";
const docsDir = path.join(projectDir, "docs");
const outputPath = path.join(docsDir, outputName);
const deploymentPath = path.join(projectDir, "deployments", "research-official-like-amoy.json");
const deployment = fs.existsSync(deploymentPath)
  ? JSON.parse(fs.readFileSync(deploymentPath, "utf8"))
  : {};

const db = openDatabase();
initSchema(db);

function one(sql) {
  return db.prepare(sql).get();
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
  const { bold = false, color, size, font = "Microsoft YaHei" } = options;
  return `<w:r><w:rPr><w:rFonts w:ascii="${escapeXml(font)}" w:hAnsi="${escapeXml(font)}" w:eastAsia="${escapeXml(font)}"/>${bold ? "<w:b/>" : ""}${color ? `<w:color w:val="${color}"/>` : ""}${size ? `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>` : ""}</w:rPr><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
}

function paragraph(text, options = {}) {
  const {
    style = "Normal",
    align,
    before,
    after = 120,
    left,
    hanging,
    bold = false,
    color,
    size,
    font,
  } = options;
  const pPr = [
    style ? `<w:pStyle w:val="${style}"/>` : "",
    align ? `<w:jc w:val="${align}"/>` : "",
    before || after ? `<w:spacing${before ? ` w:before="${before}"` : ""}${after ? ` w:after="${after}"` : ""}/>` : "",
    left || hanging ? `<w:ind${left ? ` w:left="${left}"` : ""}${hanging ? ` w:hanging="${hanging}"` : ""}/>` : "",
  ].join("");
  return `<w:p><w:pPr>${pPr}</w:pPr>${run(text, { bold, color, size, font })}</w:p>`;
}

function heading(text, level = 1) {
  return paragraph(text, { style: `Heading${level}`, after: 160 });
}

function bullet(text) {
  return `<w:p><w:pPr><w:spacing w:after="70"/><w:ind w:left="720" w:hanging="360"/></w:pPr>${run("• ", { bold: true, color: "1565C0" })}${run(text)}</w:p>`;
}

function code(lines) {
  const arr = Array.isArray(lines) ? lines : String(lines).split("\n");
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="D0D7DE"/><w:left w:val="single" w:sz="4" w:color="D0D7DE"/><w:bottom w:val="single" w:sz="4" w:color="D0D7DE"/><w:right w:val="single" w:sz="4" w:color="D0D7DE"/></w:tblBorders><w:tblCellMar><w:top w:w="120" w:type="dxa"/><w:left w:w="160" w:type="dxa"/><w:bottom w:w="120" w:type="dxa"/><w:right w:w="160" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tr><w:tc><w:tcPr><w:shd w:fill="F6F8FA"/></w:tcPr>${arr.map((line) => paragraph(line || " ", { style: "Code", font: "Consolas", size: 18, after: 0 })).join("")}</w:tc></w:tr></w:tbl>${paragraph("", { after: 90 })}`;
}

function cell(text, options = {}) {
  const { bold = false, fill, color, width, font, size = 18 } = options;
  return `<w:tc><w:tcPr>${width ? `<w:tcW w:w="${width}" w:type="dxa"/>` : ""}${fill ? `<w:shd w:fill="${fill}"/>` : ""}<w:vAlign w:val="center"/><w:tcMar><w:top w:w="90" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="90" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tcMar></w:tcPr>${paragraph(text, { bold, color, font, size, after: 0 })}</w:tc>`;
}

function table(headers, rows, widths = []) {
  const grid = widths.length ? `<w:tblGrid>${widths.map((width) => `<w:gridCol w:w="${width}"/>`).join("")}</w:tblGrid>` : "";
  const headerRow = `<w:tr>${headers.map((header, i) => cell(header, { bold: true, fill: "1565C0", color: "FFFFFF", width: widths[i] })).join("")}</w:tr>`;
  const bodyRows = rows.map((row, rowIndex) => `<w:tr>${row.map((value, i) => cell(value, {
    fill: rowIndex % 2 === 0 ? "F7FAFC" : "FFFFFF",
    width: widths[i],
    font: String(value).startsWith("0x") || String(value).includes("/") ? "Consolas" : "Microsoft YaHei",
    size: String(value).length > 50 ? 14 : 18,
  })).join("")}</w:tr>`).join("");
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblLayout w:type="fixed"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="B8C4CE"/><w:left w:val="single" w:sz="4" w:color="B8C4CE"/><w:bottom w:val="single" w:sz="4" w:color="B8C4CE"/><w:right w:val="single" w:sz="4" w:color="B8C4CE"/><w:insideH w:val="single" w:sz="4" w:color="D8E0E7"/><w:insideV w:val="single" w:sz="4" w:color="D8E0E7"/></w:tblBorders></w:tblPr>${grid}${headerRow}${bodyRows}</w:tbl>${paragraph("", { after: 90 })}`;
}

function callout(title, text) {
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:left w:val="single" w:sz="18" w:color="D6B656"/><w:top w:val="nil"/><w:right w:val="nil"/><w:bottom w:val="nil"/></w:tblBorders><w:tblCellMar><w:top w:w="140" w:type="dxa"/><w:left w:w="180" w:type="dxa"/><w:bottom w:w="140" w:type="dxa"/><w:right w:w="180" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tr><w:tc><w:tcPr><w:shd w:fill="FFF4CE"/></w:tcPr>${paragraph(title, { bold: true, after: 60 })}${paragraph(text, { after: 0 })}</w:tc></w:tr></w:tbl>${paragraph("", { after: 80 })}`;
}

const body = [];
body.push(
  paragraph("Polymarket-like 项目交易流程步骤说明", { style: "Title", align: "center", before: 1600, after: 240 }),
  paragraph("从签名订单到链上撮合、部分成交、取消与同步", { style: "Subtitle", align: "center", after: 600 }),
  table(
    ["文档项", "内容"],
    [
      ["项目路径", projectDir],
      ["目标网络", "Polygon Amoy 测试网（chainId 80002）"],
      ["当前 Exchange", deployment.exchange ?? ""],
      ["Buyer Wallet", deployment.buyerWallet ?? ""],
      ["Seller Wallet", deployment.sellerWallet ?? ""],
      ["数据库", dbPath],
      ["生成时间", new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })],
    ],
    [2100, 6700],
  ),
  callout("一句话总结", "链下生成签名订单 → 数据库存订单簿 → matcher 找到可成交订单 → 链上 Exchange 验签和结算 → 同步事件和余额回数据库/页面。"),
);

body.push(
  heading("1. 部署研究合约", 1),
  paragraph("项目首先在 Polygon Amoy 测试网上部署研究版合约。它们共同组成一个独立的 Polymarket-like 交易研究环境。"),
  table(
    ["合约", "作用"],
    [
      ["ResearchWalletCoin", "模拟抵押币 rWALLET"],
      ["ResearchOutcomeToken", "模拟 YES/NO 结果代币"],
      ["ResearchDepositWallet", "模拟 Deposit Wallet，持有资产并验证签名"],
      ["ResearchDepositWalletFactory", "通过 CREATE2 创建确定性钱包"],
      ["ResearchMarketRegistry", "保存市场信息与生命周期状态"],
      ["ResearchCLOBExchange", "验证签名订单并执行链上撮合/结算/取消"],
    ],
    [3000, 5800],
  ),
  bullet("当前真正负责交易结算的是 ResearchCLOBExchange。"),
  bullet("MarketRegistry 主要负责市场信息，早期 simulateTrade 已不是当前主交易路径。"),
);

body.push(
  heading("2. 创建 Deposit Wallet", 1),
  paragraph("项目通过 ResearchDepositWalletFactory 创建两个研究版 Deposit Wallet：buyerWallet 和 sellerWallet。它们都是智能合约钱包，不是普通 EOA。"),
  table(
    ["钱包", "职责"],
    [
      ["buyerWallet", "持有 rWALLET，用于买入 YES"],
      ["sellerWallet", "持有 YES 结果代币，用于卖出 YES"],
    ],
    [2600, 6200],
  ),
  bullet("钱包由 owner 控制。"),
  bullet("钱包实现 ERC-1271，允许 Exchange 验证 owner 对订单的签名。"),
  bullet("钱包可以通过 executeBatch 执行授权、转账等合约调用。"),
);

body.push(
  heading("3. 给钱包准备资产", 1),
  paragraph("交易前需要让双方钱包拥有可交易资产。测试环境中由脚本直接 mint 测试代币。"),
  code([
    "buyerWallet  获得 rWALLET",
    "sellerWallet 获得 YES outcome token",
  ]),
  paragraph("可以理解为：买方有钱，卖方有 YES 份额。"),
);

body.push(
  heading("4. 钱包授权 Exchange", 1),
  paragraph("Exchange 需要从钱包转移资产，因此两个钱包必须先授权当前 Exchange。"),
  code([
    "buyerWallet  -> approve(exchange, maxUint256)         // 授权 rWALLET",
    "sellerWallet -> setApprovalForAll(exchange, true)     // 授权 YES/NO",
  ]),
  bullet("授权动作由 owner 调用 Deposit Wallet 的 executeBatch 完成。"),
  bullet("如果部署了新版 Exchange，需要重新授权，因为授权是针对具体合约地址的。"),
);

body.push(
  heading("5. 链下生成订单", 1),
  paragraph("订单不是一开始就上链，而是先在链下生成并保存到 SQLite orders 表。"),
  table(
    ["订单类型", "示例含义"],
    [
      ["BUY", "buyer 愿意用 1.14 rWALLET 买 2 YES"],
      ["SELL", "seller 愿意卖 1 YES，收 0.56 rWALLET"],
    ],
    [2200, 6600],
  ),
  code([
    "Order {",
    "  maker,        // 持有资产的钱包地址",
    "  signer,       // 验签主体；本项目中等于 Deposit Wallet",
    "  tokenId,      // YES/NO tokenId",
    "  makerAmount,",
    "  takerAmount,",
    "  side,         // 0=BUY, 1=SELL",
    "  expiration,",
    "  salt",
    "}",
  ]),
);

body.push(
  heading("6. 对订单签名", 1),
  paragraph("订单采用 EIP-712 签名。这里最关键的是：订单 signer 是 Deposit Wallet 地址，但实际签名由 owner 私钥完成。"),
  code([
    "订单 signer = Deposit Wallet 地址",
    "实际签名者 = owner 私钥",
    "",
    "Exchange -> DepositWallet.isValidSignature(orderDigest, signature)",
    "DepositWallet -> ecrecover(signature) == owner ? 0x1626ba7e : 0xffffffff",
  ]),
  callout("为什么这样设计", "这模拟了智能合约钱包作为交易主体的场景。资产在 Deposit Wallet 中，订单也以 Deposit Wallet 为 signer；但签名授权来自钱包 owner。"),
);

body.push(
  heading("7. 订单进入订单簿", 1),
  paragraph("签名订单写入 SQLite 后，API 会按价格聚合成订单簿。"),
  table(
    ["字段", "说明"],
    [
      ["local_order_id", "本地订单 ID"],
      ["side", "BUY 或 SELL"],
      ["price_micros", "价格，1 USDC = 1,000,000 micros"],
      ["status", "OPEN / PARTIALLY_FILLED / FILLED / CANCELLED"],
      ["filled_maker_amount", "maker 侧已成交数量"],
      ["filled_taker_amount", "taker 侧已成交数量"],
      ["signature", "EIP-712 签名"],
    ],
    [2600, 6200],
  ),
  code([
    "GET /api/markets/:marketId/orderbook",
    "GET /api/orders",
    "GET /trade",
  ]),
);

body.push(
  heading("8. 自动撮合订单", 1),
  paragraph("matcher 会从数据库中寻找可撮合订单。满足条件后，调用链上 ResearchCLOBExchange。"),
  bullet("BUY 和 SELL 必须属于同一个 market。"),
  bullet("BUY 和 SELL 必须交易同一个 tokenId。"),
  bullet("订单必须有签名。"),
  bullet("订单状态必须是 OPEN 或 PARTIALLY_FILLED。"),
  bullet("买价必须大于或等于卖价。"),
  bullet("订单不能已被链上取消。"),
  code([
    "LIVE_ACTION=MATCH_RESEARCH_ORDERS LIVE_CONFIRMATION=AMOY_TESTNET_ONLY npm run orders:match",
  ]),
);

body.push(
  heading("9. 链上验证和结算", 1),
  paragraph("ResearchCLOBExchange 在链上执行严格检查，通过后完成原子交换。"),
  bullet("检查 buy.side == BUY，sell.side == SELL。"),
  bullet("检查 buy.tokenId == sell.tokenId。"),
  bullet("检查订单未过期。"),
  bullet("检查价格交叉。"),
  bullet("调用 ERC-1271 验证智能钱包签名。"),
  bullet("检查 filledMakerAmount 不会超额。"),
  bullet("检查 orderHash 没有被 cancelled。"),
  code([
    "buyerWallet  -> sellerWallet  转 rWALLET",
    "sellerWallet -> buyerWallet   转 YES",
    "",
    "emit OrdersMatched(...)",
  ]),
  callout("原子性", "rWALLET 和 YES 的转移发生在同一笔交易中；任意一步失败，整笔交易回滚。不会出现只付款未收币或只交币未收款。"),
);

body.push(
  heading("10. 部分成交", 1),
  paragraph("新版 Exchange 支持部分成交。matcher 会计算双方剩余可成交的 YES 数量，并把较小值作为 outcomeAmount。"),
  code([
    "outcomeAmount = min(buy 剩余想买 YES, sell 剩余可卖 YES)",
    "collateralAmount = outcomeAmount * sell.takerAmount / sell.makerAmount",
  ]),
  bullet("买单成交后：filled_maker_amount 增加支付的 rWALLET，filled_taker_amount 增加买到的 YES。"),
  bullet("卖单成交后：filled_maker_amount 增加卖出的 YES，filled_taker_amount 增加收到的 rWALLET。"),
  bullet("如果订单只成交一部分，状态变为 PARTIALLY_FILLED。"),
);

body.push(
  heading("11. 链上取消订单", 1),
  paragraph("订单未完全成交时，可以通过链上取消使其永久不可再成交。"),
  code([
    "Cancel { orderHash }",
    "",
    "Exchange.cancelOrder(order, cancelSignature)",
    "  -> 验证 signer 对 Cancel(orderHash) 的 EIP-712 签名",
    "  -> cancelled[orderHash] = true",
    "  -> emit OrderCancelled(orderHash, maker, signer)",
  ]),
  bullet("取消交易会写入 chain_actions 表。"),
  bullet("同步器读取 OrderCancelled 事件后，将 orders.status 更新为 CANCELLED。"),
  code([
    "LIVE_ACTION=CANCEL_RESEARCH_ORDER LIVE_CONFIRMATION=AMOY_TESTNET_ONLY npm run orders:cancel:chain -- <local_order_id>",
    "POST /api/orders/:id/cancel-chain",
  ]),
);

body.push(
  heading("12. 事件和余额同步", 1),
  paragraph("撮合或取消完成后，项目会同步链上事件和余额到 SQLite，Dashboard 和 /trade 页面再读取数据库展示最新状态。"),
  table(
    ["同步对象", "写入表"],
    [
      ["OrdersMatched", "chain_events + trades"],
      ["OrderCancelled", "chain_events + orders.status"],
      ["Transfer / TransferSingle / Approval", "chain_events"],
      ["钱包余额", "token_balances"],
    ],
    [2600, 6200],
  ),
  code([
    "npm run db:sync:events",
    "npm run db:sync:balances",
    "npm run db:summary",
  ]),
);

body.push(
  heading("13. 浏览器交易控制台", 1),
  paragraph("当前浏览器入口是 /trade。它用于本地研究和手动测试整个交易流程。"),
  table(
    ["按钮/区域", "作用"],
    [
      ["生成签名订单", "创建一组 BUY/SELL 签名订单，只写数据库"],
      ["链上自动撮合", "发 Amoy 链上交易，调用 matchOrders"],
      ["链上取消", "输入 local_order_id，调用 cancelOrder"],
      ["同步事件/余额", "同步链上事件和钱包余额"],
      ["当前订单簿", "展示 BUY/SELL 聚合深度"],
      ["最近订单", "展示订单状态、价格、已成交数量和签名状态"],
    ],
    [2600, 6200],
  ),
  code([
    "http://127.0.0.1:8787/trade",
    "http://127.0.0.1:8787/dashboard",
  ]),
);

body.push(
  heading("14. 简化流程总览", 1),
  code([
    "1. 部署合约：rWALLET、OutcomeToken、WalletFactory、MarketRegistry、Exchange",
    "2. 创建 buyer/seller Deposit Wallet",
    "3. 给 buyer 铸造 rWALLET，给 seller 铸造 YES",
    "4. 两个钱包授权 Exchange",
    "5. 链下生成 BUY/SELL 订单",
    "6. owner 对订单做 EIP-712 签名",
    "7. 订单写入 SQLite 订单簿",
    "8. matcher 找到价格交叉订单",
    "9. 链上 Exchange 验证签名、状态、价格和剩余量",
    "10. 链上原子转移 rWALLET 与 YES",
    "11. 发出 OrdersMatched 事件",
    "12. 同步事件、成交和余额到数据库与页面",
  ]),
);

body.push(
  heading("附录：当前数据库概况", 1),
  table(
    ["项目", "数量"],
    [
      ["contracts", String(one("SELECT COUNT(*) count FROM contracts").count)],
      ["markets", String(one("SELECT COUNT(*) count FROM markets").count)],
      ["orders", String(one("SELECT COUNT(*) count FROM orders").count)],
      ["trades", String(one("SELECT COUNT(*) count FROM trades").count)],
      ["chain_events", String(one("SELECT COUNT(*) count FROM chain_events").count)],
    ],
    [3000, 1600],
  ),
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
  <w:rPr><w:rFonts w:ascii="Microsoft YaHei" w:hAnsi="Microsoft YaHei" w:eastAsia="Microsoft YaHei"/><w:b/><w:color w:val="0D47A1"/><w:sz w:val="40"/><w:szCs w:val="40"/></w:rPr>
 </w:style>
 <w:style w:type="paragraph" w:styleId="Subtitle">
  <w:name w:val="Subtitle"/><w:qFormat/>
  <w:pPr><w:jc w:val="center"/><w:spacing w:after="240"/></w:pPr>
  <w:rPr><w:rFonts w:ascii="Microsoft YaHei" w:hAnsi="Microsoft YaHei" w:eastAsia="Microsoft YaHei"/><w:color w:val="455A64"/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr>
 </w:style>
 <w:style w:type="paragraph" w:styleId="Heading1">
  <w:name w:val="heading 1"/><w:qFormat/>
  <w:pPr><w:keepNext/><w:spacing w:before="340" w:after="160"/></w:pPr>
  <w:rPr><w:rFonts w:ascii="Microsoft YaHei" w:hAnsi="Microsoft YaHei" w:eastAsia="Microsoft YaHei"/><w:b/><w:color w:val="0D47A1"/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr>
 </w:style>
 <w:style w:type="paragraph" w:styleId="Heading2">
  <w:name w:val="heading 2"/><w:qFormat/>
  <w:pPr><w:keepNext/><w:spacing w:before="220" w:after="120"/></w:pPr>
  <w:rPr><w:rFonts w:ascii="Microsoft YaHei" w:hAnsi="Microsoft YaHei" w:eastAsia="Microsoft YaHei"/><w:b/><w:color w:val="1565C0"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr>
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
 <dc:title>Polymarket-like 项目交易流程步骤说明</dc:title>
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

const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), "trade-flow-docx-"));
function writeFile(relative, content) {
  const file = path.join(buildDir, relative);
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

function listFiles(dir, prefix = "") {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(absolute, relative) : [relative];
  });
}

const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i += 1) {
  let c = i;
  for (let j = 0; j < 8; j += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[i] = c >>> 0;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
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
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, nameBuffer);
    offset += local.length + nameBuffer.length + compressed.length;
  }
  const centralOffset = offset;
  const centralSize = central.reduce((sum, item) => sum + item.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  fs.writeFileSync(targetFile, Buffer.concat([...chunks, ...central, end]));
}

fs.mkdirSync(docsDir, { recursive: true });
fs.rmSync(outputPath, { force: true });
makeZip(buildDir, outputPath);
db.close();
console.log(`交易流程 Word 文档已生成：${outputPath}`);
