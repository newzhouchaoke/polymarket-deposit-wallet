# Polymarket-like Deposit Wallet Research System

这个项目是一个运行在 Polygon Amoy 测试网的研究版交易系统，用来学习和模拟 Polymarket 风格的核心流程：

1. 创建研究版 Deposit Wallet。
2. 发布预测市场事件。
3. 发行测试支付币 `rWALLET`。
4. 发行 YES / NO 结果份额。
5. 在后端保存签名订单和订单簿。
6. 通过链上 `ResearchCLOBExchange` 验证订单并完成原子结算。

它不是 Polymarket 官方系统，也不会接入官方 CLOB 或官方 Deposit Wallet 登记流程。所有资产、钱包、市场和交易合约都是本项目在 Amoy 测试网上自建的研究实现。

## 当前核心合约

所有新版研究合约集中在：

```text
contracts/ResearchPolymarketLike.sol
```

包含：

| 合约 | 作用 |
| --- | --- |
| `ResearchWalletCoin` | 6 位小数的测试支付币，符号 `rWALLET` |
| `ResearchOutcomeToken` | ERC-1155 风格 YES / NO 结果份额 |
| `ResearchMarketRegistry` | 市场发布、状态管理、结果结算记录 |
| `ResearchDepositWallet` | 研究版智能合约钱包，支持 `executeBatch` 和 ERC-1271 验签 |
| `ResearchDepositWalletFactory` | 创建 buyer / seller Deposit Wallet |
| `ResearchCLOBExchange` | 验证签名订单、取消订单、部分成交、链上原子结算 |

## 常用命令

```bash
cd /home/enovo/ethereum_conbine/polymarket-deposit-wallet
npm install
npm run build
```

部署 / 模拟：

```bash
LIVE_ACTION=SIMULATE_RESEARCH_MARKET \
LIVE_CONFIRMATION=AMOY_TESTNET_ONLY \
npm run research:simulate
```

数据库：

```bash
npm run db:init
npm run db:import:research
npm run db:sync:events
npm run db:sync:balances
npm run db:summary
```

链上事件持续同步：

```bash
# 执行一轮增量同步
npm run chain-sync:once

# 长期运行；默认每 12 秒同步事件和余额
npm run chain-sync
```

可通过 API 查看同步服务最近状态：

```text
http://127.0.0.1:8787/api/chain-sync/status
```

可选参数：

```bash
CHAIN_SYNC_INTERVAL_MS=8000 SYNC_CHUNK_SIZE=100 SYNC_MAX_BLOCKS_PER_RUN=1000 npm run chain-sync
```

后端和页面：

```bash
npm run api:restart
```

打开：

```text
http://127.0.0.1:8787/dashboard
http://127.0.0.1:8787/trade
```

订单脚本：

```bash
npm run orders:seed:signed
npm run orders:match
npm run orders:cancel:chain
```

自动撮合服务：

```bash
# 只扫描候选订单，不发链上交易
npm run matcher:dry-run

# 执行一轮真实 Amoy 链上撮合
npm run matcher:once

# 长期运行；默认每 15 秒扫描一次，每轮最多撮合 3 笔
npm run matcher
```

可通过 API 查看撮合服务最近状态：

```text
http://127.0.0.1:8787/api/matcher/status
```

可选参数：

```bash
MATCHER_INTERVAL_MS=10000 MATCHER_MAX_PER_TICK=5 npm run matcher
```

## 当前部署记录

主部署记录保存在：

```text
deployments/research-official-like-amoy.json
```

该文件记录当前 Amoy 测试网的：

- `walletCoin`
- `outcomeToken`
- `marketRegistry`
- `walletFactory`
- `exchange`
- buyer / seller Deposit Wallet
- 最新 market、tokenId、交易 tx

## 数据库和后端

SQLite 数据库位于：

```text
data/research-polymarket.sqlite
```

主要表：

| 表 | 作用 |
| --- | --- |
| `contracts` | 已部署合约 |
| `wallets` | 研究版 Deposit Wallet 和外部地址 |
| `markets` | 市场事件 |
| `orders` | 链下签名订单 |
| `trades` | 链上撮合成交 |
| `token_balances` | rWALLET / YES / NO 余额缓存 |
| `chain_events` | 链上事件日志 |
| `chain_actions` | 链上取消、撮合等操作记录 |

## 项目边界

本项目只用于本地研究和 Amoy 测试网验证：

- 不使用 Polygon 主网真实资金。
- 不连接 Polymarket 官方生产 CLOB。
- 不保证与官方 Deposit Wallet 完全一致。
- 不用于商业化生产环境。

核心目标是把 Demo 系统升级为“真实交易研究系统”：链下生成和保存订单，链上验证签名、检查余额授权，并完成 rWALLET 与 YES / NO 的原子交换。
