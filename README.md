# Polymarket CTF Exchange V2 / Deposit Wallet Amoy Research System

这是一个只面向 Polygon Amoy 测试网和本地测试的研究项目。项目分成两层：

- `official/`：固定到明确 commit 的 Polymarket 官方公开源码，不修改源码，保留原许可证、编译器、优化参数和汇编实现。
- `contracts/research/`：便于阅读、修改、数据库和前端演示的研究实现。
- `official/` 与 `contracts/research/` 相互隔离；官方子模块不会被研究编译脚本改写。

交易架构：

1. 用户在链下生成 EIP-712 签名订单。
2. 后端订单簿保存、排序并自动撮合订单。
3. Operator 把一个 taker 订单和多个 maker 订单提交到链上。
4. Exchange 在链上验证签名、余额、授权、价格、费用和剩余数量。
5. 合约以原子交易完成抵押币和 ERC-1155 结果份额结算。
6. 链上事件持续同步回 SQLite，供 API、订单簿和页面查询。

项目不连接 Polymarket 生产 CLOB，不使用官方主网资产。所有写链脚本都校验
`chainId=80002` 并要求 `LIVE_CONFIRMATION=AMOY_TESTNET_ONLY`。

## 官方源码对齐层

| 组件 | 本项目路径 | 固定版本 | 对齐程度 |
| --- | --- | --- | --- |
| CTF Exchange V2 | `official/ctf-exchange-v2` | `ccc0596074f4dfd62c944fbca4de252893b82b4b` | 官方源码、Solidity 0.8.34、1,000,000 optimizer runs、官方汇编 |
| Neg Risk | `official/neg-risk-ctf-adapter` | `f78b35b0863b4308a431ca307d06f49b2ea65e78` | 官方源码与测试 |
| UMA CTF Adapter | `official/uma-ctf-adapter` | `8b76cc9e0d46c6f7450a0adb0ddc0f5b0568c9cc` | 官方源码、Solidity 0.8.15 |
| Proxy / Safe factories | `official/proxy-factories` | `7137c021e6954d671095f77c94afc3d083d10a84` | 官方地址派生与 factory 源码 |
| 新 Deposit Wallet | 研究实现 + Solady ERC-7739 | — | 官方文档/ABI 行为对齐；官方新 Beacon Wallet 完整源码未公开，不能声称字节码相同 |

CTF Exchange V2 使用 BUSL-1.1；本项目保留官方许可证。非生产研究部署不等于
Polymarket 官方部署或审计结论。

## 当前合约架构

所有自定义研究合约位于
`contracts/research/ResearchPolymarketLike.sol`，与 `official/` 下固定版本的官方源码分开。

| 合约 | 作用 |
| --- | --- |
| `ResearchWalletCoin` | 6 位小数测试抵押币 `rWALLET` |
| `ResearchOutcomeToken` | ERC-1155 二元条件代币；支持 prepare、split、merge、resolve、redeem |
| `ResearchMarketRegistry` | 市场元数据和研究版 oracle adapter |
| `ResearchDepositWallet` | EIP-712 Batch、nonce、deadline、session signer、ERC-1271、ERC-7739 |
| `ResearchUpgradeableBeacon` | Deposit Wallet 共享实现地址 |
| `ResearchBeaconProxy` | ERC-1967 BeaconProxy 研究实现 |
| `ResearchDepositWalletFactory` | CREATE2 确定性部署；每个 owner 一个钱包 |
| `ResearchCLOBExchange` | V2 风格订单、operator 一对多撮合、费用、暂停和链上结算 |

### 已实现的三种结算

- `COMPLEMENTARY`：BUY 与 SELL 交易同一个 YES 或 NO token，直接交换抵押币和结果份额。
- `MINT`：YES BUY 与 NO BUY 互补，抵押币锁入 CTF 后铸造一套 YES+NO。
- `MERGE`：YES SELL 与 NO SELL 互补，销毁完整份额并释放抵押币。

### V2 风格订单

链上 `Order` 使用以下字段顺序：

```text
salt
maker
signer
tokenId
makerAmount
takerAmount
side
signatureType
timestamp
metadata
builder
signature
```

EIP-712 域：

```text
name: Polymarket CTF Exchange
version: 2
chainId: 当前链 ID
verifyingContract: ResearchCLOBExchange 地址
```

Exchange 支持 `EOA`、研究版确定性 proxy 和 `POLY_1271`。官方 Proxy/Safe
CREATE2 地址派生直接由 `official/ctf-exchange-v2` 中的官方合约计算，不在研究合约里重复仿写。

## 能否做到“和官方完全一样”

公开合约可以做到“相同官方源码 + 相同编译设置”，本项目已经采用这种方式。以下内容不能
在 Amoy 自建环境里伪装成官方生产系统：

- 官方新 Beacon Deposit Wallet 的完整实现源码和生产部署权限并未公开；研究钱包实现
  ERC-7739 嵌套签名，但不会冒充官方字节码。
- 官方生产 operator、fee receiver、relayer 白名单、风控和 CLOB 服务属于链下基础设施。
- UMA 在 Amoy 可做接口/请求流程验证，但测试网预言机经济安全与 Polygon 主网生产 UMA
  不等价。
- 官方主网资产、流动性和订单簿不会复制到 Amoy。
- 研究合约保留签名取消等便于学习的扩展；需要官方 ABI/字节码时应部署 `official/` artifact，
  而不是部署研究合约。

官方参考：

- [Polymarket CTF Exchange V2](https://github.com/Polymarket/ctf-exchange-v2)
- [Polymarket Deposit Wallet 文档](https://docs.polymarket.com/trading/deposit-wallets)
- [Gnosis Conditional Tokens](https://github.com/gnosis/conditional-tokens-contracts)

## 安装、编译和本地测试

```bash
git clone --recurse-submodules \
  https://github.com/newzhouchaoke/polymarket-deposit-wallet.git
cd polymarket-deposit-wallet
git submodule update --init --recursive
npm install
npm run build
npm test
```

`npm test` 使用内存 Ganache，不连接 Amoy、不消耗 POL。测试实际覆盖：

- ERC-1967 Beacon Deposit Wallet 创建；
- condition prepare 和完整份额 split；
- BUY/SELL complementary 结算；
- 部分成交与签名取消；
- Deposit Wallet nonce/deadline 签名 Batch；
- BUY+BUY MINT；
- SELL+SELL MERGE。

验证所有固定版本官方源码：

```bash
npm run official:verify
```

当前验证基线：

- CTF Exchange V2：265 项通过；
- UMA CTF Adapter：72 项通过；
- Neg Risk：113 项通过。

## 官方 V2 / UMA 的 Amoy 部署

先执行只读检查。它会读取官方 Amoy 参考合约的 CTF、抵押品 adapter、Proxy/Safe
factory 等依赖，检查代码、估算 gas 和余额，但不会广播：

```bash
npm run official:check:amoy
npm run official:uma:check:amoy
npm run official:wallets:derive
```

`official:wallets:derive` 返回官方 V2 对 owner 的 Proxy 和 Safe 确定性地址，并明确显示
该地址是否已经有合约代码。地址可计算不代表钱包已经被 factory 部署。

余额满足安全预算后，才可显式广播：

```bash
LIVE_ACTION=DEPLOY_OFFICIAL_V2 \
LIVE_CONFIRMATION=AMOY_TESTNET_ONLY \
OFFICIAL_V2_VARIANT=standard \
npm run official:deploy:amoy

LIVE_ACTION=DEPLOY_UMA_CTF_ADAPTER \
LIVE_CONFIRMATION=AMOY_TESTNET_ONLY \
npm run official:uma:deploy:amoy
```

`OFFICIAL_V2_VARIANT` 支持 `standard`、`neg-risk` 或 `all`。部署脚本在 RPC 不是
Amoy、依赖没有合约代码或余额小于“估算上限 + 20% 缓冲”时直接终止。

当不同 RPC 返回明显偏高的 EIP-1559 建议费用时，可以先用只读模式测试一个明确的
Amoy fee cap：

```bash
AMOY_MAX_FEE_GWEI=30.5 \
AMOY_PRIORITY_FEE_GWEI=30 \
OFFICIAL_V2_VARIANT=all \
npm run official:check:amoy
```

只有当输出中的 `sufficientBalance` 为 `true`，并且当前网络建议费没有超过 cap 时才应
广播。cap 太低不会节省已成交交易的 gas 数量，只会限制每单位 gas 的最高价格，并可能
让交易长时间 pending。

## Amoy 部署和模拟

在项目 `.env` 或上级 `.env` 配置测试私钥和 RPC。然后运行：

```bash
LIVE_ACTION=SIMULATE_RESEARCH_MARKET \
LIVE_CONFIRMATION=AMOY_TESTNET_ONLY \
npm run research:simulate
```

该命令会部署全新 V2 研究合约、创建 Deposit Wallet、发布市场、split YES/NO、签署订单并执行一笔 Amoy 撮合交易。新版部署记录写入：

```text
deployments/research-v2-amoy.json
```

旧的 `deployments/research-official-like-amoy.json` 只代表旧合约地址，不能与新版 ABI 混用。

## 数据库、API 和后台服务

后端支持两套运行模式：

- `EXCHANGE_MODE=research`：读取研究版合约、ABI 和
  `data/research-polymarket.sqlite`。
- `EXCHANGE_MODE=official-v2`：读取
  `deployments/official-v2-amoy.json`、官方 Forge artifact 和
  `data/official-v2-polymarket.sqlite`。

两套模式的数据库、撮合状态和链上同步状态相互隔离，不会把研究版订单或事件混入官方
V2 页面。当前 Amoy 标准官方 V2 部署记录为：

```text
Exchange: 0xf5d3fb02D8D529190d117aA8BD85A930f8CaB5BB
Deploy tx: 0x77429ed98250e5d914417fcd562476b8d2de9abf0b433cbd7d42780c1adb9dda
```

官方模式先配置 `.env`：

```dotenv
EXCHANGE_MODE=official-v2
OFFICIAL_V2_RUNTIME_VARIANT=standard
OFFICIAL_BUYER_WALLET=0x...
OFFICIAL_SELLER_WALLET=0x...
# 0=EOA, 1=官方 Proxy, 2=官方 Safe, 3=ERC-1271
OFFICIAL_BUYER_SIGNATURE_TYPE=1
OFFICIAL_SELLER_SIGNATURE_TYPE=0
```

准备标准二元 CTF 市场：

```bash
npm run official:market:check

LIVE_ACTION=PREPARE_OFFICIAL_MARKET \
LIVE_CONFIRMATION=AMOY_TESTNET_ONLY \
npm run official:market:prepare
```

`official:market:prepare` 把市场参数写入
`deployments/official-market-amoy.json`。账户持有测试抵押币后，可使用
`official:market:split` 经官方 OutcomeTokenFactory 拆分 YES/NO 份额。
Neg Risk 不使用此标准市场脚本。

官方 Amoy 的测试 USDC.e 支持测试铸造。下面的命令只在 chainId 80002 执行，通过官方
CollateralOnramp 为买方/卖方包装 pUSD：

```bash
LIVE_ACTION=FUND_OFFICIAL_V2 \
LIVE_CONFIRMATION=AMOY_TESTNET_ONLY \
npm run official:fund:amoy

LIVE_ACTION=PREPARE_OFFICIAL_MARKET \
LIVE_CONFIRMATION=AMOY_TESTNET_ONLY \
npm run official:market:split
```

不要把该测试铸造流程用于 Polygon 主网；脚本会拒绝非 Amoy 网络。

然后初始化当前模式的数据库：

```bash
npm run db:init
npm run db:import
npm run db:sync:events
npm run db:sync:balances
npm run api:restart
```

页面：

```text
http://127.0.0.1:8787/dashboard
http://127.0.0.1:8787/trade
```

自动撮合：

```bash
npm run orders:seed:signed
npm run matcher:dry-run
npm run matcher:once
npm run matcher
```

官方模式的 dry-run 会调用所部署 Exchange 的 `validateOrder`，直接在链上校验订单哈希和
签名。只有钱包已持有对应 pUSD/结果份额并完成授权时，才应启动 live matcher：

```bash
LIVE_ACTION=APPROVE_CURRENT_EXCHANGE \
LIVE_CONFIRMATION=AMOY_TESTNET_ONLY \
npm run exchange:approve
```

授权脚本支持 EOA、官方 Proxy Factory 和研究 ERC-1271 `executeBatch`。官方 Safe 必须通过
Safe 交易或专用 Amoy Relayer 执行，脚本会拒绝把 Safe 当作普通钱包调用。

持续同步：

```bash
npm run chain-sync:once
npm run chain-sync
```

SQLite 文件按运行模式分别位于 `data/research-polymarket.sqlite` 与
`data/official-v2-polymarket.sqlite`，保存合约、钱包、市场、链下订单、链上成交、余额和事件。

## 安全边界

- 只允许 Polygon Amoy `chainId=80002` 的写入脚本。
- 写链命令要求 `LIVE_CONFIRMATION=AMOY_TESTNET_ONLY`。
- `.env`、私钥、SQLite 和运行日志不会提交到 Git。
- 合约尚未经过独立安全审计，不应部署到主网或承载真实资金。
