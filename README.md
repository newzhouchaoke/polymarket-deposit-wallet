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

撮合器支持一个 BUY taker 对最多 5 个 SELL maker 的价格优先、时间优先撮合。可通过
`MATCHER_MAX_MAKERS` 调整单笔交易的 maker 上限（1–50）。每次链上
`OrderFilled` 都按 `tx_hash + log_index` 保存到 `order_fills`，同步器再使用
`getOrderStatus(orderHash)` 对账本地的部分成交和完全成交状态：

```bash
npm run test:matcher
npm run db:sync:events
curl http://127.0.0.1:8787/api/order-fills
```

手续费由 Operator 作为 `matchOrders` 参数传入，项目使用与官方 `Fees.sol` 相同的
`cashValue * feeRateBps / 10000` 公式。BUY 的 cash value 是实际支付抵押币，SELL 的
cash value 是实际收到抵押币；启动前还会读取 `getMaxFeeRate()`：

```dotenv
# 50 = 0.5%；默认 0
MATCHER_FEE_RATE_BPS=50
```

配置超过链上上限时 dry-run 和 live matcher 都会拒绝执行。

官方模式的 dry-run 会调用所部署 Exchange 的 `validateOrder`，直接在链上校验订单哈希和
签名。只有钱包已持有对应 pUSD/结果份额并完成授权时，才应启动 live matcher：

```bash
LIVE_ACTION=APPROVE_CURRENT_EXCHANGE \
LIVE_CONFIRMATION=AMOY_TESTNET_ONLY \
npm run exchange:approve
```

授权脚本支持 EOA、官方 Proxy Factory 和研究 ERC-1271 `executeBatch`。官方 Safe 必须通过
Safe 交易或专用 Amoy Relayer 执行，脚本会拒绝把 Safe 当作普通钱包调用。

### 市场关闭、结算与赎回

```bash
# 只读，不广播
npm run official:market:status

# 只关闭本地订单簿，不发链上交易
npm run official:market:close

# 以下命令会在 Amoy 广播不可逆测试交易
npm run official:market:resolve:yes
# 或 npm run official:market:resolve:no

npm run official:market:redeem:buyer
npm run official:market:redeem:seller
```

标准 CTF Exchange 本身不保存“市场开放/关闭”元数据，所以 `close` 是后端订单簿状态。
`resolve` 由配置的 oracle 调用 Conditional Tokens 的 `reportPayouts`；`redeem` 通过
`CtfCollateralAdapter.redeemPositions` 把胜出 ERC-1155 头寸换回 pUSD。交易页面也提供
相同操作，并在结算前显示不可逆确认。

### 官方 V2 订单取消边界

当前固定的官方 V2 没有“用户按订单哈希取消任意签名订单”的入口。项目区分：

- 本地取消：立即从本订单簿移除，但不能让已经泄露到其他撮合器的有效签名失效。
- `preapproveOrder` / `invalidatePreapprovedOrder`：只允许 Exchange operator 调用；
  后者只撤销 operator 预批准，原始用户签名仍可能有效。
- 用户级 `pauseUser` 会影响该 maker 的全部订单，不等于单订单取消。当前官方源码默认在
  100 个区块后链上生效；本地撮合器在提交暂停交易后立即停止使用这些订单。

交易页面的“链上预批准/使预批准失效”按上述边界实现，不把预批准失效错误描述成通用
链上取消。

持续同步：

```bash
npm run chain-sync:once
npm run chain-sync
```

`FULL_SYNC` 默认只写入已有 5 个确认的区块，并为游标保存 block hash：

```dotenv
SYNC_CONFIRMATIONS=5
```

每次继续同步前会检查游标区块是否仍在 canonical chain。发现短重组时，同步器寻找最近
保存的共同区块，删除 orphaned `chain_events`、`order_fills`、成交和操作记录，再从共同
区块之后重放。手动的“已知交易同步”只做幂等补录，不再错误推进 FULL_SYNC 游标。

### API 鉴权、限流、审计和实时推送

默认 `API_HOST=127.0.0.1` 时可继续本机使用。只要监听非本机地址，服务就会强制要求
`API_WRITE_TOKEN`：

```dotenv
API_HOST=127.0.0.1
API_WRITE_TOKEN=
API_READ_RATE_LIMIT_PER_MINUTE=300
API_WRITE_RATE_LIMIT_PER_MINUTE=30
API_REALTIME_POLL_MS=2000
API_REQUIRE_SIGNED_ORDERS=true
API_VALIDATE_SIGNED_ORDERS=true
API_ENFORCE_BALANCE_RESERVATIONS=true
RISK_AUDIT_INTERVAL_MS=30000
MATCHER_ENFORCE_RISK=true
ORDER_EXPIRY_SWEEP_MS=10000
HEALTH_REQUIRE_CHAIN_SYNC=true
SERVICE_STATUS_STALE_MS=180000
```

令牌通过 `Authorization: Bearer ...` 或 `x-api-key` 提交。交易页可以把令牌保存在当前
浏览器的 `localStorage`。所有 POST 成功和失败记录到 `api_audit_log`，但不保存私钥、
令牌或完整请求正文：

```bash
curl http://127.0.0.1:8787/api/audit
npm run test:api
```

实时通道为 `ws://127.0.0.1:8787/ws?marketId=...`，连接后立即推送市场、订单簿、最近
订单和成交快照；API 写入或同步数据库变化时会再次推送。交易页会自动连接和重连。

`POST /api/orders` 会严格验证 EVM 地址、市场 tokenId、uint256/bytes32 字段、签名类型、
价格、过期时间和初始成交量。official-v2 默认要求签名，并在入库前对已部署 Exchange
执行只读 `validateOrder`；校验失败返回 HTTP 422，不会进入订单簿。相同订单重复提交返回
已有记录，不会把已经部分成交或取消的订单重置为 `OPEN`；同一个 `localOrderId` 指向
不同订单时返回 HTTP 409。

official-v2 还会在下单时执行资金预占检查。BUY 使用 Maker 的抵押币余额与 Exchange
allowance 两者中的较小值；SELL 使用对应 ERC-1155 tokenId 的余额，并要求 Exchange
已经获得 operator approval。后端再扣除同一 Maker 其他活动订单已经预占的 makerAmount，
不足时返回 `ORDER_RISK_REJECTED`（HTTP 422），不会写入订单簿。这个过程只执行 `eth_call`，
不发送交易、不消耗 POL。

预占额会随部分成交减少，在完全成交、本地取消、链上取消或过期后释放；`USER_PAUSED`
订单继续保留预占，防止恢复交易前把同一资产重复下单。可查询：

```bash
curl "http://127.0.0.1:8787/api/reservations"
curl "http://127.0.0.1:8787/api/reservations?wallet=0x..."
npm run test:risk
```

API 默认每 30 秒重新读取活动预占对应的 Amoy 余额和授权，将每笔预占标记为：

- `COVERED`：链上容量可以覆盖，允许进入自动撮合。
- `OVERCOMMITTED`：同一资产的累计活动订单超过链上容量，撮合器跳过。
- `CHECK_FAILED`：RPC 检查失败，按安全策略暂不撮合。
- `UNCHECKED`：订单或成交量刚发生变化，等待重新巡检。
- `RELEASED`：订单已经结束，不再占用资金。

同一钱包、同一资产按预占创建时间分配容量，较早订单优先。自动撮合每轮提交前还会强制
执行一次巡检，因此即使用户在下单后转走资产或撤销授权，也不会继续选择已经失去资金
覆盖的订单。手动检查和 API 状态：

```bash
npm run orders:risk:audit
curl http://127.0.0.1:8787/api/risk/status
curl -X POST http://127.0.0.1:8787/api/risk/refresh
```

手动刷新属于受保护的 POST 接口；配置了 `API_WRITE_TOKEN` 时需要携带 Bearer token。

订单保存 `VALID`、`INVALID`、`LOCALLY_SIGNED`、`LEGACY_SIGNED`、`UNSIGNED` 或
`VALIDATION_SKIPPED` 校验状态。现有活动签名订单可以批量重新校验：

```bash
npm run orders:validate
curl http://127.0.0.1:8787/api/orders/stats
```

该命令只读取 Amoy Exchange 并更新本地数据库，不发送交易。API 每 10 秒把到期的
`OPEN/PARTIALLY_FILLED/USER_PAUSED` 订单更新为 `EXPIRED`，释放预占后通过 WebSocket
推送新订单簿。

### MetaMask 浏览器签名

交易页 `http://127.0.0.1:8787/trade` 可以直接连接 EIP-1193 钱包：

1. 点击“连接 MetaMask”，页面检查并切换到 Polygon Amoy（chainId `80002`）。
2. 选择 EOA(0) 或官方 Proxy(1) 签名类型。
3. EOA 模式自动把 maker/signer 设置为当前账户；Proxy 模式保留 Deposit Wallet maker，
   signer 使用当前账户。
4. 点击“MetaMask 签名并提交”，钱包执行 `eth_signTypedData_v4`。
5. 后端使用官方 V2 Exchange 的只读 `validateOrder` 验签，通过后才写入订单簿。

浏览器不会读取或上传私钥。余额面板使用 `eth_call` 显示账户 POL、Maker 的抵押币、
结果代币、ERC-20 allowance、ERC-1155 operator approval、活动订单预占和扣除预占后的
可用额度；当前仅检查授权，不会自动发授权交易。Safe(2) 和 ERC-1271(3) 需要各自的
包装/多签流程，页面保留手动签名方式，
不会把普通 MetaMask 签名错误标记成这两种类型。

如果 Chrome 同时安装 Phantom 和 MetaMask，页面通过 EIP-6963 与
`window.ethereum.providers` 查找 `io.metamask`，明确绑定 MetaMask，不直接使用可能被
Phantom 占用的 `window.ethereum`。首次添加 Amoy 后会再次执行切换，并以数值方式确认
chainId 确实为 `80002`。

```bash
npm run test:frontend
```

### 健康检查、指标和故障退避

```bash
curl http://127.0.0.1:8787/api/health/live
curl http://127.0.0.1:8787/api/health/ready
curl http://127.0.0.1:8787/api/metrics
npm run test:backend
```

- `live` 表示 API 进程可以响应。
- `ready` 检查 SQLite、Amoy official-v2 运行时、市场配置、持续同步服务和资金巡检；
  存在活动预占但 RPC 巡检全部失败时会返回未就绪，防止上游继续发送可撮合流量。可通过
  `HEALTH_REQUIRE_CHAIN_SYNC=false` 在不启动同步器的独立开发环境关闭链同步检查。
- `metrics` 返回 API 内存/运行时长、WebSocket 连接数、订单/成交/事件计数，以及撮合器和
  同步器状态。
- 状态文件使用临时文件加原子重命名，避免读取半截 JSON；API 还会核对 PID 和状态更新时间，
  不再把已经退出或卡住的后台进程显示为“运行中”。
- 链同步和自动撮合连续失败时采用指数退避，成功后恢复正常间隔：

```dotenv
CHAIN_SYNC_INTERVAL_MS=12000
CHAIN_SYNC_MAX_BACKOFF_MS=120000
MATCHER_INTERVAL_MS=15000
MATCHER_MAX_BACKOFF_MS=120000
```

测试或运维需要隔离数据库时可设置绝对路径 `POLYMARKET_DB_PATH`，避免污染当前运行库。
数据库可执行完整性/外键检查，也可以生成包含当前 WAL 状态的一致性备份：

```bash
npm run db:check
npm run db:backup
```

备份保存在 `data/backups/`，属于本地运行数据，不会提交到 Git。

### Standard / Neg Risk / UMA 模块状态

```bash
npm run official:modules:status
curl http://127.0.0.1:8787/api/modules
```

该检查只读取源码 artifact、部署记录和 Amoy 合约代码，不广播交易。当前 Standard
Exchange 已就绪；Neg Risk 和 UMA 源码/依赖已就绪，但在本项目中尚未部署，因此状态会
明确返回 `runtimeReady=false`，不会把官方参考地址伪装成本项目部署。账户余额不足时继续
使用只读检查，不应为追求“完整”强行消耗真实 POL。

SQLite 文件按运行模式分别位于 `data/research-polymarket.sqlite` 与
`data/official-v2-polymarket.sqlite`，保存合约、钱包、市场、链下订单、订单资金预占、
链上成交、余额和事件。

## 安全边界

- 只允许 Polygon Amoy `chainId=80002` 的写入脚本。
- 写链命令要求 `LIVE_CONFIRMATION=AMOY_TESTNET_ONLY`。
- `.env`、私钥、SQLite 和运行日志不会提交到 Git。
- 合约尚未经过独立安全审计，不应部署到主网或承载真实资金。
