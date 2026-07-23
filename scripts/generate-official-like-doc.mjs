import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const docsDir = path.join(projectDir, "docs");
const outputPath = path.join(
  docsDir,
  "Polymarket_官方风格模拟项目架构与代码说明.docx",
);
const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), "official-like-docx-"));
const sourcePath = path.join(projectDir, "contracts", "ResearchPolymarketLike.sol");
const scriptPath = path.join(projectDir, "scripts", "simulate-official-like-market.ts");
const v2DeploymentPath = path.join(projectDir, "deployments", "research-v2-amoy.json");
const deploymentPath = fs.existsSync(v2DeploymentPath)
  ? v2DeploymentPath
  : path.join(projectDir, "deployments", "research-official-like-amoy.json");

const source = fs.readFileSync(sourcePath, "utf8");
const script = fs.readFileSync(scriptPath, "utf8");
const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function run(text, options = {}) {
  const {
    bold = false,
    color,
    size,
    font = "Microsoft YaHei",
    italic = false,
  } = options;
  const properties = [
    `<w:rFonts w:ascii="${escapeXml(font)}" w:hAnsi="${escapeXml(font)}" w:eastAsia="${escapeXml(font)}"/>`,
    bold ? "<w:b/>" : "",
    italic ? "<w:i/>" : "",
    color ? `<w:color w:val="${color}"/>` : "",
    size ? `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>` : "",
  ].join("");
  return `<w:r><w:rPr>${properties}</w:rPr><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
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
    italic = false,
    keepNext = false,
  } = options;
  const pPr = [
    `<w:pStyle w:val="${style}"/>`,
    align ? `<w:jc w:val="${align}"/>` : "",
    before || after
      ? `<w:spacing${before ? ` w:before="${before}"` : ""}${after ? ` w:after="${after}"` : ""}/>`
      : "",
    left || hanging
      ? `<w:ind${left ? ` w:left="${left}"` : ""}${hanging ? ` w:hanging="${hanging}"` : ""}/>`
      : "",
    keepNext ? "<w:keepNext/>" : "",
  ].join("");
  return `<w:p><w:pPr>${pPr}</w:pPr>${run(text, {
    bold,
    color,
    size,
    font,
    italic,
  })}</w:p>`;
}

function richParagraph(parts, options = {}) {
  const {
    style = "Normal",
    left,
    hanging,
    after = 100,
    keepNext = false,
  } = options;
  const pPr = [
    `<w:pStyle w:val="${style}"/>`,
    after ? `<w:spacing w:after="${after}"/>` : "",
    left || hanging
      ? `<w:ind${left ? ` w:left="${left}"` : ""}${hanging ? ` w:hanging="${hanging}"` : ""}/>`
      : "",
    keepNext ? "<w:keepNext/>" : "",
  ].join("");
  return `<w:p><w:pPr>${pPr}</w:pPr>${parts.map((part) => run(part.text, part)).join("")}</w:p>`;
}

function heading(text, level = 1) {
  return paragraph(text, {
    style: `Heading${level}`,
    keepNext: true,
    after: level === 1 ? 180 : 120,
  });
}

function bullet(text) {
  return richParagraph(
    [
      { text: "• ", bold: true, color: "1565C0" },
      { text },
    ],
    { left: 720, hanging: 360 },
  );
}

function codeBlock(text) {
  const lines = String(text).split(/\r?\n/);
  return `<w:tbl>
    <w:tblPr>
      <w:tblW w:w="0" w:type="auto"/>
      <w:tblBorders>
        <w:top w:val="single" w:sz="4" w:color="D0D7DE"/>
        <w:left w:val="single" w:sz="4" w:color="D0D7DE"/>
        <w:bottom w:val="single" w:sz="4" w:color="D0D7DE"/>
        <w:right w:val="single" w:sz="4" w:color="D0D7DE"/>
      </w:tblBorders>
      <w:tblCellMar>
        <w:top w:w="100" w:type="dxa"/><w:left w:w="140" w:type="dxa"/>
        <w:bottom w:w="100" w:type="dxa"/><w:right w:w="140" w:type="dxa"/>
      </w:tblCellMar>
    </w:tblPr>
    <w:tr><w:tc><w:tcPr><w:shd w:fill="F6F8FA"/></w:tcPr>${lines
      .map((line) =>
        paragraph(line || " ", {
          style: "Code",
          after: 0,
          font: "Consolas",
          size: 15,
        }),
      )
      .join("")}</w:tc></w:tr>
  </w:tbl>${paragraph("", { after: 80 })}`;
}

function cell(text, options = {}) {
  const {
    bold = false,
    fill,
    color,
    width,
    font = "Microsoft YaHei",
    size = 17,
  } = options;
  return `<w:tc>
    <w:tcPr>
      ${width ? `<w:tcW w:w="${width}" w:type="dxa"/>` : ""}
      ${fill ? `<w:shd w:fill="${fill}"/>` : ""}
      <w:vAlign w:val="center"/>
      <w:tcMar><w:top w:w="80" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tcMar>
    </w:tcPr>
    ${paragraph(text, { bold, color, font, size, after: 0 })}
  </w:tc>`;
}

function table(headers, rows, widths = []) {
  const grid = widths.length
    ? `<w:tblGrid>${widths.map((width) => `<w:gridCol w:w="${width}"/>`).join("")}</w:tblGrid>`
    : "";
  const headerRow = `<w:tr>${headers
    .map((header, index) =>
      cell(header, {
        bold: true,
        fill: "1565C0",
        color: "FFFFFF",
        width: widths[index],
      }),
    )
    .join("")}</w:tr>`;
  const bodyRows = rows
    .map(
      (row, rowIndex) =>
        `<w:tr>${row
          .map((value, index) =>
            cell(value, {
              fill: rowIndex % 2 === 0 ? "F7FAFC" : "FFFFFF",
              width: widths[index],
              font:
                String(value).startsWith("0x") ||
                String(value).includes(".sol") ||
                String(value).includes(".ts") ||
                String(value).includes("npm ")
                  ? "Consolas"
                  : "Microsoft YaHei",
              size: String(value).length > 52 ? 13 : 17,
            }),
          )
          .join("")}</w:tr>`,
    )
    .join("");
  return `<w:tbl>
    <w:tblPr>
      <w:tblW w:w="0" w:type="auto"/>
      <w:tblLayout w:type="fixed"/>
      <w:tblBorders>
        <w:top w:val="single" w:sz="4" w:color="B8C4CE"/>
        <w:left w:val="single" w:sz="4" w:color="B8C4CE"/>
        <w:bottom w:val="single" w:sz="4" w:color="B8C4CE"/>
        <w:right w:val="single" w:sz="4" w:color="B8C4CE"/>
        <w:insideH w:val="single" w:sz="4" w:color="D8E0E7"/>
        <w:insideV w:val="single" w:sz="4" w:color="D8E0E7"/>
      </w:tblBorders>
    </w:tblPr>
    ${grid}${headerRow}${bodyRows}
  </w:tbl>${paragraph("", { after: 80 })}`;
}

function callout(title, text, color = "FFF4CE", border = "D6B656") {
  return `<w:tbl>
    <w:tblPr><w:tblW w:w="0" w:type="auto"/>
      <w:tblBorders>
        <w:left w:val="single" w:sz="18" w:color="${border}"/>
        <w:top w:val="nil"/><w:right w:val="nil"/><w:bottom w:val="nil"/>
      </w:tblBorders>
      <w:tblCellMar><w:top w:w="120" w:type="dxa"/><w:left w:w="160" w:type="dxa"/><w:bottom w:w="120" w:type="dxa"/><w:right w:w="160" w:type="dxa"/></w:tblCellMar>
    </w:tblPr>
    <w:tr><w:tc><w:tcPr><w:shd w:fill="${color}"/></w:tcPr>
      ${paragraph(title, { bold: true, color: "263238", after: 50 })}
      ${paragraph(text, { after: 0 })}
    </w:tc></w:tr>
  </w:tbl>${paragraph("", { after: 80 })}`;
}

function pageBreak() {
  return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
}

function extractBlock(name) {
  const pattern = new RegExp(`(?:interface|contract)\\s+${name}\\b`);
  const match = pattern.exec(source);
  if (!match) return `// 未找到 ${name}`;
  const starts = [];
  const re = /(?:interface|contract)\s+\w+\b/g;
  let item;
  while ((item = re.exec(source))) starts.push(item.index);
  const next = starts.find((index) => index > match.index);
  return source.slice(match.index, next ?? source.length).trim();
}

function scriptExcerpt(startPattern, endPattern) {
  const start = script.indexOf(startPattern);
  if (start < 0) return "";
  const end = endPattern ? script.indexOf(endPattern, start) : -1;
  return script.slice(start, end > start ? end : undefined).trim();
}

const body = [];

body.push(
  paragraph("Polymarket 官方风格模拟项目", {
    style: "Title",
    align: "center",
    before: 1800,
    after: 180,
  }),
  paragraph("研究版 Deposit Wallet + 自定义市场事件 + 买入/卖出交易", {
    style: "Subtitle",
    align: "center",
    after: 500,
  }),
  paragraph("项目架构、合约代码、部署步骤与链上交易说明", {
    align: "center",
    size: 26,
    color: "455A64",
    after: 900,
  }),
  table(
    ["文档项", "内容"],
    [
      ["项目目录", projectDir],
      ["核心合约文件", "contracts/ResearchPolymarketLike.sol"],
      ["核心脚本文件", "scripts/simulate-official-like-market.ts"],
      ["网络", "Polygon Amoy 测试网（chainId 80002）"],
      ["Owner / 支付 gas 钱包", deployment.owner],
      ["生成日期", "2026-07-10"],
    ],
    [2300, 6500],
  ),
  callout(
    "定位说明",
    "本文档描述的是研究版“官方风格”模拟项目：它模仿官方产品中的 Deposit Wallet、市场发布、YES/NO 份额和买卖交易流程，但不连接 Polymarket 官方 CLOB，也不代表官方 Deposit Wallet 登记。",
    "FDECEC",
    "C62828",
  ),
  pageBreak(),
);

body.push(
  heading("1. 项目目标与核心结论", 1),
  paragraph(
    "该项目用于本地研究和 Amoy 测试网验证：自己发行一个钱包币 rWALLET，发布一个模拟预测市场事件，给 buyer/seller 两个智能钱包分别发放支付币和 YES 结果份额，然后通过 Market Hub 合约模拟买入/卖出交易。",
  ),
  bullet("rWALLET 是自定义 ERC-20 风格钱包币，用于支付交易价格。"),
  bullet("ResearchOutcomeToken 是 ERC-1155-like 结果份额合约，本次 YES tokenId 来自市场事件。"),
  bullet("ResearchDepositWallet 是 owner 控制的智能合约钱包，可通过 executeBatch 代表钱包授权或调用合约。"),
  bullet("ResearchMarketRegistry 同时负责发布模拟市场事件，并通过 simulateTrade 执行研究版买卖结算。"),
  bullet("所有交易均在 Polygon Amoy 测试网执行，只消耗测试 POL。"),
  callout(
    "核心区别",
    "官方 Polymarket Deposit Wallet 需要由官方系统/Relayer/Builder API 创建与登记；本项目钱包只是功能上类似，不能被官方 CLOB 当作生产 Deposit Wallet 使用。",
    "FFF4CE",
    "D6B656",
  ),
);

body.push(
  heading("2. 当前链上部署结果", 1),
  table(
    ["对象", "地址/值"],
    [
      ["Owner", deployment.owner],
      ["rWALLET / ResearchWalletCoin", deployment.walletCoin],
      ["OutcomeToken", deployment.outcomeToken],
      ["MarketRegistry / Market Hub", deployment.marketRegistry],
      ["DepositWalletFactory", deployment.walletFactory],
      ["buyer Deposit Wallet", deployment.buyerWallet],
      ["seller Deposit Wallet", deployment.sellerWallet],
      ["Market ID", deployment.market.marketId],
      ["YES tokenId", deployment.market.yesTokenId],
      ["NO tokenId", deployment.market.noTokenId],
    ],
    [2600, 6200],
  ),
  heading("2.1 交易哈希", 2),
  table(
    ["步骤", "交易哈希"],
    [
      ["发布模拟预测事件/市场", deployment.txs.publishTx],
      ["给 buyer 铸造 rWALLET", deployment.txs.mintBuyerCoinTx],
      ["给 seller 铸造 YES", deployment.txs.mintSellerYesTx],
      ["buyer 授权 rWALLET", deployment.txs.buyerApproveTx],
      ["seller 授权 YES/NO", deployment.txs.sellerApproveTx],
      ["模拟撮合买入/卖出", deployment.txs.matchTx],
    ],
    [2600, 6200],
  ),
  paragraph(`撮合交易浏览器链接：https://amoy.polygonscan.com/tx/${deployment.txs.matchTx}`, {
    font: "Consolas",
    size: 16,
  }),
  heading("2.2 最终余额", 2),
  table(
    ["钱包", "rWALLET", "YES"],
    [
      ["buyer", deployment.finalBalances.buyerRWALLET, deployment.finalBalances.buyerYES],
      ["seller", deployment.finalBalances.sellerRWALLET, deployment.finalBalances.sellerYES],
    ],
    [2500, 3150, 3150],
  ),
);

body.push(
  heading("3. 项目框架", 1),
  table(
    ["层", "文件/合约", "作用"],
    [
      ["配置层", "src/env.ts", "加载 .env，限制 Amoy chainId，保护写操作，删除不安全 TLS 环境变量"],
      ["链客户端层", "src/chain.ts", "创建 viem publicClient/walletClient，多 RPC fallback"],
      ["资产层", "ResearchWalletCoin / ResearchOutcomeToken", "rWALLET 支付币和 YES/NO 结果份额"],
      ["钱包层", "ResearchDepositWallet / Factory", "创建和控制 buyer/seller 智能钱包"],
      ["市场层", "ResearchMarketRegistry", "发布市场事件、生成 YES/NO tokenId、模拟交易结算"],
      ["脚本层", "simulate-official-like-market.ts", "一键部署/复用、发币、发布事件、授权、执行交易、记录结果"],
    ],
    [1500, 3300, 4000],
  ),
  heading("3.1 执行流程", 2),
  bullet("读取 .env 中的私钥和 RPC 配置，确认当前网络是 Amoy。"),
  bullet("复用或部署 rWALLET、OutcomeToken、MarketRegistry、DepositWalletFactory。"),
  bullet("通过 Factory 复用或创建 buyer/seller Deposit Wallet。"),
  bullet("发布模拟预测事件，得到 marketId、YES tokenId、NO tokenId。"),
  bullet("向 buyer 钱包 mint 100 rWALLET，向 seller 钱包 mint 10 YES。"),
  bullet("buyer 授权 Market Hub 使用 rWALLET，seller 授权 Market Hub 使用 OutcomeToken。"),
  bullet("调用 simulateTrade：buyer 支付 0.55 rWALLET，seller 转出 1 YES。"),
  bullet("读取链上余额并写入 deployments/research-official-like-amoy.json。"),
  codeBlock(`cd ${projectDir}
npm run build
LIVE_ACTION=SIMULATE_RESEARCH_MARKET LIVE_CONFIRMATION=AMOY_TESTNET_ONLY npm run research:simulate`),
);

body.push(
  heading("4. 每个合约说明与代码", 1),
  heading("4.1 IERC1271Like", 2),
  paragraph("ERC-1271 接口，用于让撮合合约或其他外部合约询问智能钱包：某个 hash 和签名是否有效。官方 Deposit Wallet 场景也依赖类似的合约签名验证能力。"),
  codeBlock(extractBlock("IERC1271Like")),
  heading("4.2 ResearchMockUSD", 2),
  paragraph("早期研究版抵押币，符号 rUSD。当前官方风格模拟流程主要使用 ResearchWalletCoin，但该合约仍保留，用于完整 CLOB 研究脚本。"),
  codeBlock(extractBlock("ResearchMockUSD")),
  heading("4.3 ResearchWalletCoin", 2),
  paragraph("自定义钱包币，符号 rWALLET，6 位小数。它在官方风格模拟流程中充当买方支付资产。"),
  bullet("mint：测试铸币。"),
  bullet("approve：钱包通过 executeBatch 授权 Market Hub 使用。"),
  bullet("transferFrom：simulateTrade 中从 buyer 转给 seller。"),
  codeBlock(extractBlock("ResearchWalletCoin")),
  heading("4.4 ResearchOutcomeToken", 2),
  paragraph("ERC-1155-like 结果份额合约，保存 tokenId -> address -> balance。MarketRegistry 发布事件时生成 YES/NO tokenId，脚本向 seller 铸造 YES。"),
  codeBlock(extractBlock("ResearchOutcomeToken")),
  heading("4.5 ResearchMarketRegistry", 2),
  paragraph("本次官方风格模拟的 Market Hub。它负责发布事件、生成 YES/NO tokenId，并执行 simulateTrade。simulateTrade 不是官方 CLOB 撮合，只是研究版结算入口。"),
  bullet("nextMarket：根据 chainId、合约地址、creator、marketCount、question、closeTime 预测 marketId 和 YES/NO tokenId。"),
  bullet("publishMarket：增加 marketCount 并发出 MarketPublished 事件。"),
  bullet("simulateTrade：operator 调用，完成 rWALLET 与 outcome token 的原子转移，并发出 TradeExecuted。"),
  codeBlock(extractBlock("ResearchMarketRegistry")),
  heading("4.6 ResearchDepositWallet", 2),
  paragraph("研究版 Deposit Wallet。它由 owner 控制，能够持有资产并通过 executeBatch 代表钱包调用其他合约。isValidSignature 支持 ERC-1271 风格验签。"),
  codeBlock(extractBlock("ResearchDepositWallet")),
  heading("4.7 ResearchDepositWalletFactory", 2),
  paragraph("使用 CREATE2 创建确定性智能钱包。相同 owner 与 salt 会得到同一个钱包地址，便于提前预测 buyer/seller 钱包地址。"),
  codeBlock(extractBlock("ResearchDepositWalletFactory")),
  heading("4.8 ResearchCLOBExchange", 2),
  paragraph("完整 CLOB 研究合约，保留在源码中。它支持 EIP-712 订单、ERC-1271 验签、价格交叉检查和一次性填充。当前官方风格轻量脚本没有使用它，而是使用 MarketRegistry.simulateTrade。"),
  codeBlock(extractBlock("ResearchCLOBExchange")),
);

body.push(
  heading("5. simulate-official-like-market.ts 脚本说明", 1),
  paragraph("该脚本是官方风格模拟流程的一键入口。它可以断点续跑：部署记录中已有地址时会复用，buyer 已授权时会跳过。"),
  heading("5.1 读取部署记录与旧部署复用", 2),
  codeBlock(scriptExcerpt("function readDeployment()", "function writeDeployment")),
  heading("5.2 部署/复用合约", 2),
  codeBlock(scriptExcerpt("const walletCoin = await deployOrReuse", "const buyerWallet =")),
  heading("5.3 发布市场与铸币", 2),
  codeBlock(scriptExcerpt("const question =", "const approveWalletCoin")),
  heading("5.4 授权与模拟撮合", 2),
  codeBlock(scriptExcerpt("const approveWalletCoin", "const [buyerCoin")),
  heading("5.5 写入最终结果", 2),
  codeBlock(scriptExcerpt("const result =", "console.log(\"官方风格研究流程完成：\"")),
);

body.push(
  heading("6. 和官方 Polymarket 的关系", 1),
  table(
    ["项目", "研究版官方风格模拟", "Polymarket 官方生产体系"],
    [
      ["钱包创建", "ResearchDepositWalletFactory 自建 CREATE2 钱包", "官方 SDK/Relayer/Factory 创建并登记"],
      ["支付资产", "自定义 rWALLET 测试币", "官方支持的生产资产，如 pUSD 等"],
      ["市场发布", "ResearchMarketRegistry 发 MarketPublished 事件", "官方市场、条件、订单簿和后端服务"],
      ["交易撮合", "simulateTrade 由 operator 直接结算", "官方 CLOB 订单簿、撮合与链上 Exchange"],
      ["签名模型", "轻量流程不验签；完整 CLOB 合约支持 ERC-1271/EIP-712", "官方订单签名、POLY_1271/ERC-7739 等体系"],
      ["网络", "Amoy 测试网", "Polygon 主网"],
      ["用途", "学习、研究、测试", "真实交易环境"],
    ],
    [1900, 3500, 3400],
  ),
  callout(
    "不要混用概念",
    "本项目可以帮助理解官方产品背后的技术形态，但不能把自建钱包或自建 Market Hub 直接接入官方 CLOB。官方是否愿意赞助任意自定义合约调用，也取决于官方 Relayer 服务策略，不能由本地合约单方面决定。",
    "FFF4CE",
    "D6B656",
  ),
);

body.push(
  heading("7. 运行与排障", 1),
  heading("7.1 必需环境变量", 2),
  bullet("POLYMARKET_PRIVATE_KEY、ETH_PRIVATE_KEY 或 PRIVATE_KEY：三者至少一个有效。"),
  bullet("AMOY_RPC_URLS 或 AMOY_RPC_URL：可选，不配置时使用内置 Amoy RPC fallback。"),
  bullet("LIVE_ACTION=SIMULATE_RESEARCH_MARKET：允许该模拟流程写链。"),
  bullet("LIVE_CONFIRMATION=AMOY_TESTNET_ONLY：确认只在 Amoy 测试网写入。"),
  heading("7.2 常见问题", 2),
  table(
    ["现象", "原因", "处理"],
    [
      ["测试 POL 不足", "部署/交易需要 Amoy gas", "给 owner 地址补充 Amoy POL"],
      ["gas tip cap below minimum", "Amoy 节点当前要求较高 priority fee", "脚本中 GAS_OPTIONS 已设置 25 gwei tip"],
      ["NODE_TLS_REJECT_UNAUTHORIZED 警告", "外部环境关闭了 HTTPS 证书校验", "src/env.ts 已在项目启动时删除该变量"],
      ["YES 不显示名称", "OutcomeToken 没有完整 ERC-1155 元数据", "需要实现 URI/metadata 或前端自行映射 tokenId"],
      ["重复运行余额变大", "脚本每次会重新 mint 测试币和测试 YES", "这是研究脚本行为，生产系统应限制 mint 权限"],
    ],
    [2100, 3300, 3400],
  ),
);

body.push(
  heading("8. 安全与生产化限制", 1),
  bullet("mint 函数没有权限控制，任何人都能铸币，只适合测试网。"),
  bullet("MarketRegistry.simulateTrade 只允许 operator 调用，但没有订单签名、nonce、取消、过期、部分成交等完整订单保护。"),
  bullet("ResearchOutcomeToken 不是完整 ERC-1155，浏览器和钱包展示能力有限。"),
  bullet("ResearchDepositWallet 的 executeBatch 只支持 owner 直接发交易，不是官方 gasless relayer 模型。"),
  bullet("若要向生产级 CLOB 靠近，应使用完整 ResearchCLOBExchange 路线，并增加订单簿、数据库、风控、审计、元数据和预言机/结算模块。"),
  heading("8.1 建议后续扩展", 2),
  bullet("把 simulateTrade 替换为 EIP-712 签名订单撮合，使用 ResearchCLOBExchange 或升级版 Exchange。"),
  bullet("为 rWALLET 和 OutcomeToken 增加权限控制、角色管理和事件索引。"),
  bullet("实现完整 ERC-1155 元数据 URI，让 YES/NO 在区块浏览器里显示更友好。"),
  bullet("增加订单数据库，用于保存完整订单、撮合状态和前端查询。"),
  bullet("增加 market resolve/redeem 流程，模拟预测市场到期结算。"),
);

body.push(
  pageBreak(),
  heading("附录 A：完整源码位置", 1),
  table(
    ["文件", "用途"],
    [
      [sourcePath, "所有研究版合约源码"],
      [scriptPath, "官方风格模拟流程脚本"],
      [deploymentPath, "最新部署地址、交易哈希和最终余额"],
    ],
    [4200, 4600],
  ),
  heading("附录 B：源码总览", 1),
  codeBlock(source),
);

const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    ${body.join("")}
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1080" w:right="900" w:bottom="900" w:left="900" w:header="720" w:footer="720" w:gutter="0"/>
      <w:cols w:space="720"/>
      <w:docGrid w:linePitch="360"/>
    </w:sectPr>
  </w:body>
</w:document>`;

const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
    <w:rPr><w:rFonts w:ascii="Microsoft YaHei" w:hAnsi="Microsoft YaHei" w:eastAsia="Microsoft YaHei"/><w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr>
    <w:pPr><w:spacing w:line="330" w:lineRule="auto" w:after="120"/></w:pPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Title">
    <w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>
    <w:pPr><w:jc w:val="center"/></w:pPr>
    <w:rPr><w:b/><w:color w:val="0D47A1"/><w:sz w:val="44"/><w:szCs w:val="44"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Subtitle">
    <w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>
    <w:pPr><w:jc w:val="center"/></w:pPr>
    <w:rPr><w:color w:val="1565C0"/><w:sz w:val="31"/><w:szCs w:val="31"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>
    <w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="340" w:after="160"/><w:outlineLvl w:val="0"/></w:pPr>
    <w:rPr><w:b/><w:color w:val="0D47A1"/><w:sz w:val="30"/><w:szCs w:val="30"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>
    <w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="220" w:after="100"/><w:outlineLvl w:val="1"/></w:pPr>
    <w:rPr><w:b/><w:color w:val="1565C0"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Code">
    <w:name w:val="Code"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:spacing w:after="0" w:line="230" w:lineRule="auto"/></w:pPr>
    <w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Microsoft YaHei"/><w:sz w:val="15"/><w:szCs w:val="15"/></w:rPr>
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

const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
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
  <dc:title>Polymarket 官方风格模拟项目架构与代码说明</dc:title>
  <dc:subject>研究版 Deposit Wallet、市场事件和交易模拟</dc:subject>
  <dc:creator>Codex</dc:creator>
  <cp:lastModifiedBy>Codex</cp:lastModifiedBy>
  <dc:description>依据当前项目源码和 Polygon Amoy 实际部署结果生成。</dc:description>
  <dcterms:created xsi:type="dcterms:W3CDTF">2026-07-10T00:00:00Z</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">2026-07-10T00:00:00Z</dcterms:modified>
</cp:coreProperties>`;

const appXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"
 xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>Codex OOXML Generator</Application>
  <AppVersion>1.0</AppVersion>
  <DocSecurity>0</DocSecurity>
  <ScaleCrop>false</ScaleCrop>
</Properties>`;

function write(relativePath, content) {
  const target = path.join(buildDir, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

write("[Content_Types].xml", contentTypesXml);
write("_rels/.rels", rootRelsXml);
write("docProps/core.xml", coreXml);
write("docProps/app.xml", appXml);
write("word/document.xml", documentXml);
write("word/styles.xml", stylesXml);
write("word/_rels/document.xml.rels", documentRelsXml);

fs.mkdirSync(docsDir, { recursive: true });
fs.rmSync(outputPath, { force: true });
const jar = spawnSync(
  "/usr/lib/jvm/java-17-openjdk-amd64/bin/jar",
  ["--create", "--file", outputPath, "--no-manifest", "-C", buildDir, "."],
  { encoding: "utf8" },
);
fs.rmSync(buildDir, { recursive: true, force: true });
if (jar.status !== 0) {
  throw new Error(`DOCX 打包失败：${jar.stderr || jar.stdout}`);
}

console.log(outputPath);
