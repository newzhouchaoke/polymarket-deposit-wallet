import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { dbPath, projectDir } from "./db.js";

const outputName = "Polymarket_研究版合约与官方合约对比说明.docx";
const docsDir = path.join(projectDir, "docs");
const outputPath = path.join(docsDir, outputName);
const desktopDir = "/mnt/c/Users/Lenovo/Desktop";
const desktopPath = path.join(desktopDir, outputName);
const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), "official-contract-comparison-"));

function escapeXml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function run(text, options = {}) {
  const { bold = false, italic = false, color, size, font = "Microsoft YaHei" } = options;
  return `<w:r><w:rPr><w:rFonts w:ascii="${escapeXml(font)}" w:hAnsi="${escapeXml(font)}" w:eastAsia="${escapeXml(font)}"/>${bold ? "<w:b/>" : ""}${italic ? "<w:i/>" : ""}${color ? `<w:color w:val="${color}"/>` : ""}${size ? `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>` : ""}</w:rPr><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
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
  ].join("");
  return `<w:p><w:pPr>${pPr}</w:pPr>${run(text, { bold, italic, color, size, font })}</w:p>`;
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
  const { bold = false, fill, color, width, font, size = 17 } = options;
  const value = String(text ?? "");
  const chosenFont = font ?? (value.startsWith("0x") || value.includes("github.com") || value.includes("docs.polymarket.com") ? "Consolas" : "Microsoft YaHei");
  const chosenSize = value.length > 85 ? 12 : value.length > 55 ? 14 : size;
  return `<w:tc><w:tcPr>${width ? `<w:tcW w:w="${width}" w:type="dxa"/>` : ""}${fill ? `<w:shd w:fill="${fill}"/>` : ""}<w:vAlign w:val="top"/><w:tcMar><w:top w:w="90" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="90" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tcMar></w:tcPr>${paragraph(value, { bold, color, font: chosenFont, size: chosenSize, after: 0 })}</w:tc>`;
}

function table(headers, rows, widths = []) {
  const grid = widths.length ? `<w:tblGrid>${widths.map((width) => `<w:gridCol w:w="${width}"/>`).join("")}</w:tblGrid>` : "";
  const headerRow = `<w:tr>${headers.map((header, i) => cell(header, { bold: true, fill: "1565C0", color: "FFFFFF", width: widths[i], size: 17 })).join("")}</w:tr>`;
  const bodyRows = rows.map((row, rowIndex) => `<w:tr>${row.map((value, i) => cell(value, {
    fill: rowIndex % 2 === 0 ? "F7FAFC" : "FFFFFF",
    width: widths[i],
  })).join("")}</w:tr>`).join("");
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblLayout w:type="fixed"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="B8C4CE"/><w:left w:val="single" w:sz="4" w:color="B8C4CE"/><w:bottom w:val="single" w:sz="4" w:color="B8C4CE"/><w:right w:val="single" w:sz="4" w:color="B8C4CE"/><w:insideH w:val="single" w:sz="4" w:color="D8E0E7"/><w:insideV w:val="single" w:sz="4" w:color="D8E0E7"/></w:tblBorders></w:tblPr>${grid}${headerRow}${bodyRows}</w:tbl>${paragraph("", { after: 90 })}`;
}

function callout(title, text, fill = "FFF4CE", border = "D6B656") {
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:left w:val="single" w:sz="18" w:color="${border}"/><w:top w:val="nil"/><w:right w:val="nil"/><w:bottom w:val="nil"/></w:tblBorders><w:tblCellMar><w:top w:w="140" w:type="dxa"/><w:left w:w="180" w:type="dxa"/><w:bottom w:w="140" w:type="dxa"/><w:right w:w="180" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tr><w:tc><w:tcPr><w:shd w:fill="${fill}"/></w:tcPr>${paragraph(title, { bold: true, after: 60 })}${paragraph(text, { after: 0 })}</w:tc></w:tr></w:tbl>${paragraph("", { after: 80 })}`;
}

const body = [];
body.push(
  paragraph("Polymarket 研究版合约与官方合约对比说明", { style: "Title", align: "center", before: 1200, after: 240 }),
  paragraph("contracts/research/ResearchPolymarketLike.sol 对照 Polymarket 官方 CLOB V2 / CTF / Deposit Wallet", { style: "Subtitle", align: "center", after: 500 }),
  table(
    ["文档项", "内容"],
    [
      ["项目路径", projectDir],
      ["对比文件", "contracts/research/ResearchPolymarketLike.sol"],
      ["本地数据库", dbPath],
      ["研究网络", "Polygon Amoy 测试网（chainId 80002）"],
      ["官方网络", "Polygon Mainnet（chainId 137）"],
      ["生成时间", new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })],
    ],
    [1900, 6900],
  ),
  callout(
    "核心结论",
    "当前项目是研究版 Polymarket-like 系统：自建 rWALLET、自建 YES/NO、自建 Deposit Wallet、自建 Exchange 和本地订单簿。官方 Polymarket 使用 pUSD、Gnosis Conditional Tokens、官方 Deposit Wallet/Proxy/Safe、官方 CLOB V2、官方 Operator/API/Relayer。二者结构相似，但不是同一套生产系统。",
  ),
);

body.push(
  heading("1. 总体对应关系", 1),
  table(
    ["研究版合约", "官方大致对应", "主要区别", "官方 GitHub / 来源"],
    [
      ["ResearchWalletCoin / ResearchMockUSD", "pUSD / CollateralToken", "rWALLET 是测试币，owner 可 mint；官方 pUSD 是生产抵押资产。", "https://github.com/Polymarket/ctf-exchange-v2"],
      ["ResearchOutcomeToken", "Gnosis ConditionalTokens / CTF", "研究版是简化 ERC1155-like；官方 CTF tokenId 由 conditionId、collectionId、positionId 计算。", "https://github.com/gnosis/conditional-tokens-contracts"],
      ["ResearchMarketRegistry", "Gamma/市场元数据 + UMA Adapter + CTF 准备流程", "研究版直接发布市场并生成 YES/NO；官方市场生命周期跨 API、UMA、CTF、Exchange。", "https://github.com/gnosis/conditional-tokens-contracts"],
      ["ResearchDepositWallet", "Official Deposit Wallet", "研究版是简单 owner 钱包；官方是 ERC-1967 proxy，支持 relayer batch、POLY_1271、ERC-1271。", "https://docs.polymarket.com/trading/deposit-wallets"],
      ["ResearchDepositWalletFactory", "Deposit Wallet Factory", "研究版 CREATE2 自建；官方 factory 与 relayer、beacon、registry 配套。", "https://docs.polymarket.com/resources/contracts"],
      ["ResearchCLOBExchange", "CTF Exchange V2 / Neg Risk CTF Exchange V2", "研究版只实现基础验签、取消、部分成交和转账；官方包含 operator、fees、pausable、签名类型、Safe/Proxy/ERC1271、CTF mint/merge 等。", "https://github.com/Polymarket/ctf-exchange-v2"],
    ],
    [1650, 1850, 3350, 1950],
  ),
);

body.push(
  heading("2. 官方核心合约地址", 1),
  table(
    ["类别", "官方合约", "Polygon 主网地址"],
    [
      ["交易", "CTF Exchange V2", "0xE111180000d2663C0091e4f400237545B87B996B"],
      ["交易", "Neg Risk CTF Exchange V2", "0xe2222d279d744050d28e00520010520000310F59"],
      ["结果代币", "Conditional Tokens / CTF", "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"],
      ["抵押币", "pUSD / CollateralToken proxy", "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB"],
      ["钱包", "Deposit Wallet Factory", "0x00000000000Fb5C9ADea0298D729A0CB3823Cc07"],
      ["钱包", "Deposit Wallet Beacon", "0x7A18EDfe055488A3128f01F563e5B479D92ffc3a"],
      ["Neg Risk", "NegRiskCtfCollateralAdapter", "0xadA2005600Dec949baf300f4C6120000bDB6eAab"],
      ["解析", "UMA Adapter", "0x6A9D222616C90FcA5754cd1333cFD9b7fb6a4F74"],
      ["解析", "UMA Optimistic Oracle", "0xCB1822859cEF82Cd2Eb4E6276C7916e692995130"],
    ],
    [1500, 2750, 4550],
  ),
  paragraph("说明：官方文档明确 Polymarket 合约地址以 Polygon mainnet Contracts 页面为准；本表为 2026-07-23 查询到的对应关系。"),
);

body.push(
  heading("3. ResearchCLOBExchange vs 官方 CTF Exchange V2", 1),
  table(
    ["维度", "研究版 ResearchCLOBExchange", "官方 CTF Exchange V2"],
    [
      ["网络", "Polygon Amoy 测试网", "Polygon Mainnet"],
      ["结算资产", "ResearchMockUSD / ResearchWalletCoin", "pUSD"],
      ["结果 token", "ResearchOutcomeToken", "Gnosis ConditionalTokens ERC1155"],
      ["撮合", "本地 matcher 或脚本调用 matchOrders", "官方 CLOB 后端 operator-driven matching"],
      ["签名", "简化 EIP-712 / ERC-1271 思路", "EOA、Proxy、Safe、EIP-1271、POLY_1271 等签名体系"],
      ["费用", "未实现完整费用模型", "官方有 Fees、Builder attribution、operator-set fee"],
      ["风控", "简化", "Auth、Pausable、UserPausable、operator/admin 权限"],
      ["订单结构", "maker、signer、tokenId、makerAmount、takerAmount、side、expiration、salt", "CLOB V2 订单包含 timestamp、metadata、builder 等新字段，去掉 V1 nonce/feeRateBps/taker"],
      ["资产操作", "直接 transferFrom ERC20-like 和 ERC1155-like", "统一 ERC20/ERC1155 transfer helper、CTF mint/merge、wrapped collateral layer"],
      ["审计", "无生产审计", "官方 CTF Exchange V2 有 Quantstamp、Cantina 审计"],
    ],
    [1700, 3450, 3650],
  ),
  code([
    "官方源码：",
    "https://github.com/Polymarket/ctf-exchange-v2",
    "https://github.com/Polymarket/ctf-exchange-v2/tree/main/src/exchange",
    "https://github.com/Polymarket/ctf-exchange-v2/blob/main/src/exchange/CTFExchange.sol",
    "https://github.com/Polymarket/ctf-exchange-v2/blob/main/src/exchange/libraries/Structs.sol",
  ]),
);

body.push(
  heading("4. rWALLET vs 官方 pUSD", 1),
  table(
    ["维度", "研究版 rWALLET", "官方 pUSD"],
    [
      ["用途", "测试支付币", "Polymarket CLOB V2 生产抵押资产"],
      ["价值", "无真实价值", "生产资产，用于真实交易"],
      ["发行", "owner 可 mint", "官方 CollateralToken / pUSD 体系"],
      ["抵押关系", "未完整锁定 YES/NO 抵押", "YES/NO token 由 pUSD 完全抵押"],
      ["链", "Amoy", "Polygon mainnet"],
    ],
    [1700, 3450, 3650],
  ),
  paragraph("官方 CTF 文档说明：每个二元市场的 YES/NO token 背后由 pUSD 完全抵押；Split、Merge、Redeem 是 CTF 的基础操作。"),
);

body.push(
  heading("5. ResearchOutcomeToken vs 官方 ConditionalTokens", 1),
  table(
    ["维度", "研究版 ResearchOutcomeToken", "官方 ConditionalTokens / CTF"],
    [
      ["标准", "ERC1155-like 简化实现", "Gnosis Conditional Tokens Framework"],
      ["tokenId", "项目内 hash/自定义生成", "conditionId → collectionId → positionId"],
      ["Split/Merge/Redeem", "未完整生产化", "官方核心功能"],
      ["抵押担保", "弱化/模拟", "pUSD 锁定抵押"],
      ["多 outcome", "主要模拟二元 YES/NO", "标准 CTF 支持更通用结构"],
    ],
    [1700, 3450, 3650],
  ),
  code([
    "官方 CTF 源码：",
    "https://github.com/gnosis/conditional-tokens-contracts",
    "https://github.com/gnosis/conditional-tokens-contracts/blob/master/contracts/ConditionalTokens.sol",
  ]),
);

body.push(
  heading("6. ResearchDepositWallet vs 官方 Deposit Wallet", 1),
  table(
    ["维度", "研究版 Deposit Wallet", "官方 Deposit Wallet"],
    [
      ["部署", "ResearchDepositWalletFactory 自建部署", "官方 Relayer WALLET-CREATE"],
      ["结构", "普通合约钱包", "ERC-1967 BeaconProxy / legacy UUPS clone"],
      ["升级", "无官方 beacon 升级体系", "Beacon 可升级，钱包地址保持不变"],
      ["签名", "简化 ERC-1271", "ERC-1271 + ERC-7739-wrapped POLY_1271"],
      ["批量调用", "executeBatch 由 owner 调用", "Relayer WALLET batch，EIP-712 DepositWallet Batch 签名"],
      ["CLOB 认可", "只被自建 Exchange 认可", "官方 CLOB 认可 maker/signer 为 Deposit Wallet"],
      ["资产", "rWALLET / ResearchOutcomeToken", "pUSD / ConditionalTokens"],
    ],
    [1700, 3450, 3650],
  ),
  code([
    "官方 Deposit Wallet 文档：",
    "https://docs.polymarket.com/trading/deposit-wallets",
    "",
    "官方 factory：0x00000000000Fb5C9ADea0298D729A0CB3823Cc07",
    "官方 beacon： 0x7A18EDfe055488A3128f01F563e5B479D92ffc3a",
  ]),
);

body.push(
  heading("7. MarketRegistry 与官方市场体系", 1),
  paragraph("研究版 ResearchMarketRegistry 把市场发布、YES/NO tokenId、状态 OPEN/CLOSED/RESOLVED 放在一个简化合约里。官方 Polymarket 没有一个完全等价的单一 MarketRegistry 合约；官方市场系统由 Gamma/API、UMA Adapter、CTF、CLOB 后端、Exchange 等共同组成。"),
  bullet("研究版：publishMarket 直接发 MarketPublished，并存 yesTokenId/noTokenId。"),
  bullet("官方：市场元数据通常通过 Gamma API，结果解析涉及 UMA，结果份额通过 CTF positionId 表示。"),
  bullet("研究版生命周期是教学式模型；官方还涉及 dispute、resolution、redeem、neg risk 等完整流程。"),
);

body.push(
  heading("8. Neg Risk 差异", 1),
  table(
    ["维度", "研究版项目", "官方 Neg Risk"],
    [
      ["是否实现", "基本未实现", "完整支持"],
      ["对应交易合约", "无独立 Neg Risk Exchange", "Neg Risk CTF Exchange V2"],
      ["NO 转 YES 组合", "未实现", "通过 NegRiskCtfCollateralAdapter / 相关模块处理"],
      ["多互斥市场", "未完整建模", "官方 negRisk 市场体系"],
    ],
    [1700, 3450, 3650],
  ),
  code([
    "官方 Neg Risk 相关：",
    "https://github.com/Polymarket/ctf-exchange-v2",
    "https://github.com/Polymarket/neg-risk-ctf-adapter",
  ]),
);

body.push(
  heading("9. 官方 GitHub 地址汇总", 1),
  table(
    ["用途", "地址"],
    [
      ["CLOB V2 / pUSD / Exchange", "https://github.com/Polymarket/ctf-exchange-v2"],
      ["CTF Exchange V2 源码目录", "https://github.com/Polymarket/ctf-exchange-v2/tree/main/src/exchange"],
      ["主 Exchange 合约", "https://github.com/Polymarket/ctf-exchange-v2/blob/main/src/exchange/CTFExchange.sol"],
      ["订单结构", "https://github.com/Polymarket/ctf-exchange-v2/blob/main/src/exchange/libraries/Structs.sol"],
      ["Gnosis CTF", "https://github.com/gnosis/conditional-tokens-contracts"],
      ["ConditionalTokens.sol", "https://github.com/gnosis/conditional-tokens-contracts/blob/master/contracts/ConditionalTokens.sol"],
      ["Neg Risk Adapter", "https://github.com/Polymarket/neg-risk-ctf-adapter"],
      ["旧版 CTF Exchange V1", "https://github.com/Polymarket/ctf-exchange"],
      ["官方示例", "https://github.com/Polymarket/examples"],
      ["Safe Wallet 集成参考", "https://github.com/Polymarket/safe-wallet-integration"],
      ["安全审计资料", "https://github.com/Polymarket/contract-security"],
    ],
    [2600, 6200],
  ),
);

body.push(
  heading("10. 参考资料", 1),
  bullet("Polymarket Contracts：https://docs.polymarket.com/resources/contracts"),
  bullet("Polymarket CLOB V2 Migration：https://docs.polymarket.com/v2-migration"),
  bullet("Polymarket Deposit Wallets：https://docs.polymarket.com/trading/deposit-wallets"),
  bullet("Polymarket Conditional Token Framework：https://docs.polymarket.com/trading/ctf/overview"),
  bullet("Polymarket CTF Exchange V2 GitHub：https://github.com/Polymarket/ctf-exchange-v2"),
  bullet("Gnosis Conditional Tokens GitHub：https://github.com/gnosis/conditional-tokens-contracts"),
);

const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
 <w:body>
  ${body.join("\n")}
  <w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="900" w:right="720" w:bottom="900" w:left="720" w:header="450" w:footer="450" w:gutter="0"/></w:sectPr>
 </w:body>
</w:document>`;

const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
 <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:rFonts w:ascii="Microsoft YaHei" w:hAnsi="Microsoft YaHei" w:eastAsia="Microsoft YaHei"/><w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr></w:style>
 <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:rPr><w:b/><w:color w:val="0D47A1"/><w:sz w:val="38"/><w:szCs w:val="38"/></w:rPr></w:style>
 <w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:rPr><w:color w:val="455468"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:style>
 <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:rPr><w:b/><w:color w:val="0D47A1"/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>
 <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:rPr><w:b/><w:color w:val="1565C0"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style>
 <w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Microsoft YaHei"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>
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
 <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

const coreXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
 xmlns:dc="http://purl.org/dc/elements/1.1/"
 xmlns:dcterms="http://purl.org/dc/terms/"
 xmlns:dcmitype="http://purl.org/dc/dcmitype/"
 xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
 <dc:title>Polymarket 研究版合约与官方合约对比说明</dc:title>
 <dc:creator>Codex</dc:creator>
 <cp:lastModifiedBy>Codex</cp:lastModifiedBy>
 <dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created>
 <dcterms:modified xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:modified>
</cp:coreProperties>`;

const appXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"
 xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
 <Application>Codex DOCX Generator</Application>
 <Company>OpenAI</Company>
</Properties>`;

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
makeZip(buildDir, outputPath);
fs.mkdirSync(desktopDir, { recursive: true });
fs.copyFileSync(outputPath, desktopPath);

console.log(`合约对比 Word 文档已生成：${outputPath}`);
console.log(`已复制到 Windows 桌面：${desktopPath}`);
