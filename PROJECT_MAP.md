# Project Map — Polymarket Copy-Trader v7.0

A real-time copy-trading bot that detects and mirrors trades from profitable Polymarket whale wallets on the Polygon blockchain.

---

## 1. Full File Tree

```
pl1/
├── src/
│   ├── index.js              ← ENTRY POINT — bootstraps the bot
│   ├── config.js             — Central configuration + .env loader + validation
│   ├── trader.js             — Order execution engine (filters, sizing, FAK/GTC)
│   ├── monitor.js            — On-chain OrderFilled event listener (WSS/HTTP)
│   ├── api.js                — Polymarket API client (rate limiting, cache, helpers)
│   ├── positions.js          — Position book: cost basis, P&L, chain sync
│   ├── exit-manager.js       — Auto-exit: SL/TP/trailing/ratchet/time/EV
│   ├── whale-tracker.js      — Per-whale performance tracking + Kelly sizing
│   ├── stats.js              — Runtime statistics (events, fills, skips, per-target)
│   ├── logger.js             — Structured logging, trade journal, webhook notifications
│   ├── store.js              — Shared debounced JSON file persistence utility
│   ├── errors.js             — Structured error types (HttpError, TransientError)
│   ├── test.js               — Online connectivity + integration tests (npm test)
│   ├── unit-test.js          — Offline unit tests (npm run test:unit)
│   ├── simulate.js           — Offline simulation + validation suite (npm run simulate)
│   ├── audit-test.js         — Audit tests: auth, markets, copy logic, benchmarks
│   ├── show-positions.js     — CLI: display open positions (npm run positions)
│   └── show-portfolio.js     — CLI: display portfolio with live P&L (npm run portfolio)
├── data/                     — Runtime data (git-ignored, auto-created)
│   ├── positions.json        — Persisted open position state
│   ├── stats.json            — Trade statistics across restarts
│   ├── health.json           — Health check output (written every 60s)
│   ├── trades.jsonl          — Append-only trade journal (JSON Lines, rotated at 10 MB)
│   └── whale-tracker.json    — Per-whale performance and win-rate data
├── .env.example              — Template for environment variables (committed)
├── .env                      — Your secrets (git-ignored, create from .env.example)
├── .gitignore                — Ignores node_modules/, data/, .env, *.log, *.pem, *.key
├── .nvmrc                    — Node version hint: 18
├── Dockerfile                — Alpine Node 20 image, runs src/index.js, data/ volume
├── docker-compose.yml        — Single-service Compose: build + .env + data/ volume
├── eslint.config.js          — ESLint 9 flat config (ES2022, module globals)
├── package.json              — Metadata, scripts, dependencies (v7.0.0)
├── package-lock.json         — Locked dependency tree
├── guide.md                  — Complete setup and usage guide
└── PROJECT_MAP.md            — This file
```

---

## 2. File & Folder Descriptions

### Root Files

| File | Role |
|------|------|
| `package.json` | Defines project name (`polymarket-copy-trader`), version (`7.0.0`), type (`module`), 7 npm scripts, 4 runtime dependencies, 1 dev dependency, and engines (`node >= 18`). |
| `package-lock.json` | Locked dependency tree for reproducible `npm install`. |
| `.env.example` | Documents every environment variable with comments. Committed to repo as a template. |
| `.gitignore` | Excludes `node_modules/`, `data/`, `.env`, `.env.*` (except `.env.example`), `*.log`, `*.pem`, `*.key`. |
| `.nvmrc` | Contains `18` — hints `nvm` to use Node.js 18. |
| `Dockerfile` | Multi-stage build: `node:20-alpine` base, production-only `npm install`, copies `src/`, creates `data/` dir, volume mount, runs `node src/index.js`. |
| `docker-compose.yml` | Compose v3.8. Single service `trader`, container name `poly-trader`, `restart: unless-stopped`, loads `.env`, mounts `./data:/app/data`. |
| `eslint.config.js` | ESLint 9+ flat config. Targets `src/**/*.js`, ES2022 + module source type, defines Node.js/browser globals, rules for unused vars, const preference, eqeqeq, no-var. Ignores `node_modules/` and `data/`. |
| `guide.md` | Comprehensive user guide covering overview, tech stack, structure, setup, env vars, scripts, architecture, features, common tasks, and troubleshooting. |
| `PROJECT_MAP.md` | This file — detailed project map with file tree, descriptions, entry points, data flow, dependency map, external services, and config map. |

### Source Files (`src/`)

| File | Role |
|------|------|
| `index.js` | **Entry point.** Validates config, prints startup banner with all settings, loads persisted state (positions, stats, whale tracker), initializes the CLOB trader client, syncs positions from chain, wires the on-chain monitor to the trade callback, starts the exit manager, sets up periodic health/watchdog timers, and handles graceful shutdown on SIGINT/SIGTERM. SIGUSR1 toggles dry-run; SIGUSR2 prints stats/positions/portfolio. |
| `config.js` | **Central configuration.** Built-in `.env` file parser (no `dotenv` dependency). Defines all tunable parameters: wallet keys, trading params, smart filters, order execution, signal detection, auto-exit, risk controls, drawdown breaker, sell config, whale tracking, edge scoring, market quality, anti-snipe, position tracking, logging, market filters, whale targets, and API endpoints. Normalizes targets (lowercase addresses, default values). Exports `validate()` which returns an array of human-readable error strings. Exports `getSellMode(target)` and `shouldCopySells(target)` for per-target override resolution. |
| `trader.js` | **Order execution engine.** The largest and most complex module. Implements the full smart filter pipeline (21 checks), position sizing with Kelly criterion and signal boost, FAK and GTC order modes with retry, smart routing (YES↔NO token comparison), anti-front-running delay, in-flight balance tracking, idempotency guards, daily spend/drawdown tracking, and losing-streak cooldown. Exports `initTrader()`, `placeCopyTrade()`, `dryRunCopyTrade()`, `getClient()`, `getWalletAddress()`, `recordExitPnl()`, `_alignToTick()`, `_priceValid()`. |
| `monitor.js` | **On-chain event listener.** `OnChainMonitor` class subscribes to `OrderFilled` events on both Polymarket exchange contracts via WebSocket (or HTTP polling fallback). Dual topic subscriptions catch maker and taker fills. Implements connection-ID guard for reconnect races, 30s keepalive pings, exponential backoff with jitter, partial-fill batching, and deduplication (capped at 10k entries, purged every 10 min). |
| `api.js` | **Polymarket API client.** Rate-limited (8 req/s ring buffer), retrying (exponential backoff, skip 4xx except 429), TTL-cached (5 min, 500 entry cap, 10 min cleanup), deduplicated access to Gamma (market metadata), CLOB (midpoint, order book), and Data API (activity, positions, balance). Also contains pure helper functions: `getSpread`, `getBookDepth`, `getExecutionPriceFromBook`, `isMarketActive`, `getComplementaryToken`, `extractMarketParams`, `getHoursUntilExpiry`, `getMarketQuality`, `calcEdgeScore`, `passesMarketFilter`. |
| `positions.js` | **Position state manager.** `PositionManager` singleton. In-memory `Map<tokenId, position>` with cost-basis accounting, average entry price, realized P&L per partial/full sells, and accumulated closed P&L. Debounced persistence (2 s) via `JsonStore`. On-chain sync with mutex guard and stale-position cleanup (only when chain API returns valid data). Portfolio snapshot with live midpoint prices. Console print methods for positions and portfolio. |
| `exit-manager.js` | **Auto-exit engine.** Interval-based position scanner (default 30 s). Evaluates each position against: EV exit (price > 0.95 or < 0.05), profit ratchet (activate at +15%, floor at +2%), stop-loss (-20%), take-profit (+40%), trailing stop (12% pullback from high, while still > 5% profit), and time exit (72 h stale). Maintains per-position state maps for trailing high watermark, ratchet activation, and last-move timestamp. Places FAK sell orders in live mode; simulates in dry-run. Records P&L for whale tracking. |
| `whale-tracker.js` | **Whale performance tracker.** `WhaleTracker` singleton. Per-whale trade history over rolling 30-day window. Computes: win/loss counts, Bayesian-smoothed win rate (+2 pseudo-observations), profit factor, current streak, half-Kelly fraction (capped at 50%), and dynamic copy multiplier (0.1x–3.0x based on win rate + profit factor + streak, requires 5 min trades). Debounced persistence (5 s) via `JsonStore`. Console print sorted by P&L. |
| `stats.js` | **Runtime statistics.** `Stats` singleton. Tracks: total events, buy/sell event counts, trade outcomes (filled/skipped/rejected/errors), per-target breakdowns with buy/sell sub-stats, and skip reasons. Persisted to `data/stats.json` on shutdown. Periodic console print (default every 5 min). `uptime()` returns formatted string. |
| `logger.js` | **Structured logging.** Four levels (`debug`, `info`, `warn`, `error`) gated by `config.logLevel`. `journal(entry)` buffers JSON Lines for the trade journal. `flushJournal()` writes buffer to disk. 60 s rotation timer renames file when > `logMaxBytes`. `notify(event, data)` queues webhook POSTs (100-item cap, serialized, 5 s timeout, silent drop on failure). `trade(tag, entry)` is a convenience wrapper that logs + journals in one call. All timers use `.unref()`. |
| `store.js` | **JSON file persistence utility.** `JsonStore` class used by `positions.js`, `stats.js`, and `whale-tracker.js`. Provides `load()` (returns parsed JSON or null on ENOENT), `scheduleSave(serializeFn)` (debounced with `.unref()` timer), and `flush()` (immediate write). Creates parent directories automatically. |
| `errors.js` | **Structured error types.** `HttpError` (with `status`, `retryable`, `clientError` getters) and `TransientError`. Used by `api.js` retry logic and `trader.js` order retry to classify errors for retry decisions. |
| `test.js` | **Online test suite.** Run via `npm test`. Tests config validation, Polygon RPC connection (chainId 137), position manager buy/sell/P&L, Data API (activity, positions, balance), Gamma API (market metadata, active check, filter check), and CLOB API (midpoint, order book, BUY/SELL execution estimates with slippage). Skips API tests gracefully when `TEST_ADDRESS` is not set. |
| `unit-test.js` | **Offline unit tests.** Run via `npm run test:unit`. Uses `node:assert/strict`. Tests: config validation (12 cases), position manager (10 cases), stats tracker (7 cases), spread/depth/execution helpers (11 cases), market status/filters (10 cases), complementary token (5 cases), market params extraction (3 cases), market quality scoring (5 cases), edge score calculation (3 cases), expiry helper (4 cases), cache cleanup, and whale tracker (8 cases). |
| `simulate.js` | **Offline simulation suite.** Run via `npm run simulate`. 13 test sections with 100+ assertions: position manager, config validation, API helpers (offline), tick alignment & price bounds, stats tracker, sell mode calculations, simulated trading scenario with smart filters, exit manager thresholds, risk guards, whale performance tracker, market quality scoring, edge score calculation, enhanced exit manager (ratchet, EV, time), and new config parameters. |
| `audit-test.js` | **Audit test suite.** Run via `node src/audit-test.js`. Tests auth & connectivity (config validation, DRY_RUN support, perf timing, watchdog config, trader init + balance fetch), market fetch (activity, metadata, midpoint, order book, execution estimate), copy logic (position tracking, mock whale → dry-run decision, sell modes, risk guards), dry-run order placement, and speed benchmarks (midpoint latency, parallel fetch, offline logic 1000 iterations). |
| `show-positions.js` | **CLI utility.** Loads `data/positions.json` and prints a formatted table of open positions. Exits immediately. |
| `show-portfolio.js` | **CLI utility.** Loads positions and fetches live midpoint prices for each, then prints portfolio summary with unrealized P&L. Exits after printing. |

### Runtime Data (`data/`)

| File | Written By | Update Frequency | Description |
|------|-----------|-----------------|-------------|
| `positions.json` | `positions.js` via `store.js` | Debounced 2 s after changes | All open positions with tokenId, shares, costBasis, avgEntry, realizedPnl, market name, copiedFrom label, timestamps. Also stores accumulated `closedPnl`. |
| `stats.json` | `stats.js` via `store.js` | On shutdown | Event counts, trade outcomes, per-target stats, skip reasons. Loaded on startup to preserve stats across restarts. |
| `health.json` | `index.js` | Every 60 s | JSON with `alive`, `uptime`, `events`, `filled`, `positions`, `dryRun`, `ts`. For external health monitoring. |
| `trades.jsonl` | `logger.js` | On every trade event | Append-only JSON Lines file. Each line is a trade event (fill, skip, error, dry-run) with timestamp. Rotated when > 10 MB. |
| `whale-tracker.json` | `whale-tracker.js` via `store.js` | Debounced 5 s after changes | Per-whale records: address, label, trade history (last 200), computed stats (win rate, profit factor, Kelly, multiplier, streak). |

---

## 3. Entry Points

| Entry Point | How to Run | Purpose |
|------------|-----------|---------|
| `src/index.js` | `npm start` or `node src/index.js` | **Main entry.** Starts the bot — validates config, loads state, initializes trader, starts monitor + exit manager, runs until signal. |
| `src/test.js` | `npm test` | Online connectivity tests. |
| `src/unit-test.js` | `npm run test:unit` | Offline unit tests. |
| `src/simulate.js` | `npm run simulate` | Offline simulation suite. |
| `src/audit-test.js` | `node src/audit-test.js` | Audit test suite. |
| `src/show-positions.js` | `npm run positions` | CLI: print positions. |
| `src/show-portfolio.js` | `npm run portfolio` | CLI: print portfolio. |

---

## 4. Data Flow Map

### Main Trading Loop

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Polygon Blockchain                                                       │
│  OrderFilled events on CTF Exchange (0x4bFb...) & NegRisk (0xC5d5...)   │
└──────────────────────────┬───────────────────────────────────────────────┘
                           │ WebSocket subscription (ethers.js)
                           ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  monitor.js — OnChainMonitor                                             │
│  1. Decode OrderFilled log (maker/taker, tokenId, amounts, side)         │
│  2. Deduplicate (txHash:addr:orderHash)                                  │
│  3. Batch partial fills (txBatchWindowMs = 400ms)                        │
│  4. Fire onTrade(target, activity)                                       │
└──────────────────────────┬───────────────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  index.js — wrappedCallback                                              │
│  1. stats.recordEvent(target, side)                                      │
│  2. Delegate to placeCopyTrade() or dryRunCopyTrade()                    │
│  3. stats.recordTrade(target, result, usdcAmount, side)                  │
└──────────────────────────┬───────────────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  trader.js — _execute() or dryRunCopyTrade()                             │
│  1. Preflight checks (kill switch, dedup, cooldown, max positions, ...)  │
│  2. Parallel fetch: market metadata + midpoint + order book              │
│  3. Smart filter pipeline (21 checks)                                    │
│  4. _calcAmount() — position sizing (Kelly + signal boost + whale mult)  │
│  5. Smart routing: compare direct vs complementary token                 │
│  6. Anti-snipe delay (0–1500ms)                                          │
│  7. Place order via ClobClient (FAK or GTC with fallback)                │
│  8. On fill: positions.recordBuy/Sell, stats, whale-tracker              │
└──────────────────────────────────────────────────────────────────────────┘
```

### Auto-Exit Loop (Parallel)

```
┌──────────────────────────────────────────────────────────────────────────┐
│  exit-manager.js — runs every 30s                                        │
│  For each open position:                                                 │
│    1. Fetch live midpoint price via api.getMidpoint()                     │
│    2. Compute current value and P&L %                                    │
│    3. Check exit rules in priority order:                                │
│       EV → ratchet → stop-loss → take-profit → trailing → time          │
│    4. If triggered: place SELL order (live) or simulate (dry-run)         │
│    5. Record P&L in positions, whale-tracker, and daily drawdown         │
└──────────────────────────────────────────────────────────────────────────┘
```

### Persistence Flow

```
  positions.recordBuy/Sell()  ──► JsonStore.scheduleSave() ──► 2s debounce ──► data/positions.json
  whaleTracker.recordTrade()  ──► JsonStore.scheduleSave() ──► 5s debounce ──► data/whale-tracker.json
  stats.save()                ──► JsonStore.scheduleSave() ──► immediate    ──► data/stats.json
  logger.journal()            ──► _buf buffer ──► _flush() ──► data/trades.jsonl
  writeHealth()               ──► writeFile() ──► every 60s ──► data/health.json
```

---

## 5. Dependency Map (Key Module Relationships)

### Inbound Dependencies (What Imports This Module)

| Module | Imported By |
|--------|------------|
| `config.js` | Every other module (universal dependency) |
| `logger.js` | `index.js`, `trader.js`, `monitor.js`, `api.js` (indirectly), `positions.js`, `exit-manager.js`, `whale-tracker.js`, `stats.js` |
| `store.js` | `positions.js`, `stats.js`, `whale-tracker.js` |
| `errors.js` | `api.js`, `trader.js` |
| `api.js` | `trader.js`, `exit-manager.js`, `positions.js`, `test.js`, `simulate.js`, `audit-test.js`, `unit-test.js` |
| `positions.js` | `index.js`, `trader.js`, `exit-manager.js`, `simulate.js`, `test.js`, `audit-test.js`, `unit-test.js`, `show-positions.js`, `show-portfolio.js` |
| `trader.js` | `index.js`, `exit-manager.js` (only `recordExitPnl`), `simulate.js` (only `_alignToTick`, `_priceValid`), `audit-test.js` |
| `whale-tracker.js` | `index.js`, `trader.js`, `exit-manager.js`, `simulate.js`, `unit-test.js` |
| `stats.js` | `index.js`, `simulate.js`, `audit-test.js`, `unit-test.js` |
| `monitor.js` | `index.js` |
| `exit-manager.js` | `index.js` |

### Outbound Dependencies (What This Module Imports)

| Module | Imports From |
|--------|-------------|
| `index.js` | `config`, `trader` (5 exports), `monitor` (OnChainMonitor), `exit-manager` (2 exports), `whale-tracker`, `stats`, `positions`, `logger`, `node:fs/promises`, `node:path` |
| `config.js` | `node:fs` (readFileSync), `node:path` (resolve) |
| `trader.js` | `@polymarket/clob-client` (ClobClient, Side, OrderType), `@ethersproject/wallet` (Wallet), `config`, `positions`, `whale-tracker`, `logger`, `errors`, `api` (17 functions) |
| `monitor.js` | `ethers`, `config`, `logger` |
| `api.js` | `config`, `errors` (HttpError) |
| `positions.js` | `config`, `api` (fetchPositions, getMidpoint), `logger`, `store` (JsonStore) |
| `exit-manager.js` | `@polymarket/clob-client` (Side, OrderType), `config`, `positions`, `whale-tracker`, `trader` (recordExitPnl), `logger`, `api` (6 functions) |
| `whale-tracker.js` | `config`, `logger`, `store` (JsonStore) |
| `stats.js` | `config`, `logger`, `store` (JsonStore) |
| `logger.js` | `config`, `node:fs/promises` (appendFile, stat, rename, mkdir), `node:path` |
| `store.js` | `node:fs/promises` (readFile, writeFile, mkdir), `node:path` |
| `errors.js` | _(none — leaf module)_ |

---

## 6. External Services & Integrations

| Service | Protocol | Used By | Purpose |
|---------|----------|---------|---------|
| **Polygon RPC (WSS)** | WebSocket | `monitor.js` | Real-time subscription to `OrderFilled` events on Polymarket exchange contracts. Provider: user-configured (Alchemy, QuickNode, etc.). |
| **Polygon RPC (HTTP)** | HTTPS | `monitor.js` (fallback) | Fallback when WSS is unavailable. 10–15 s delay. Default: `https://polygon-rpc.com`. |
| **Polymarket CLOB API** | HTTPS | `api.js`, `trader.js` | Midpoint prices (`/midpoint`), order books (`/book`), order placement (`createAndPostMarketOrder`, `createAndPostOrder`, `cancelOrder`, `getOrder`), API key derivation (`createOrDeriveApiKey`). |
| **Gamma API** | HTTPS | `api.js` | Market metadata lookup by condition ID or token ID (`/markets`). Returns question, token IDs, tick size, neg risk, volume, liquidity, end date. |
| **Polymarket Data API** | HTTPS | `api.js` | User activity (`/activity`), positions (`/positions`), USDC balance (`/balance`). |
| **Webhook endpoint** | HTTPS POST | `logger.js` | Optional Slack/Discord/custom webhook for trade alerts. Fire-and-forget, 5 s timeout. |

### Polymarket Exchange Contracts (Polygon Mainnet)

| Contract | Address | Description |
|----------|---------|-------------|
| CTF Exchange | `0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E` | Standard exchange for binary outcome tokens |
| NegRisk CTF Exchange | `0xC5d563A36AE78145C45a50134d48A1215220f80a` | Exchange for neg-risk markets |

### On-Chain Event Monitored

`OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint256 makerAssetId, uint256 takerAssetId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee)` — both tokens use 6 decimal places.

---

## 7. Config & Env Map

### Which Config File Controls What

| File | Controls |
|------|----------|
| `src/config.js` | All runtime behavior: whale targets, risk limits, smart filters, auto-exit thresholds, order execution params, whale tracking settings, signal detection, logging, API endpoints. This is the single source of truth for all tunable parameters. |
| `.env` / `.env.example` | Secrets and overrides: `PRIVATE_KEY`, `WSS_URL`, `RPC_URL`, risk control overrides (`MAX_DAILY_USDC`, etc.), `LOG_LEVEL`, `WEBHOOK_URL`, `KILL_SWITCH`, `TEST_ADDRESS`, `FUNDER_ADDRESS`, `SIGNATURE_TYPE`. Values from `.env` are loaded by `config.js`'s built-in parser. Real env vars take precedence. |
| `eslint.config.js` | ESLint linting rules and globals. No runtime effect. |
| `.nvmrc` | Node.js version hint for `nvm`. Contains `18`. |
| `Dockerfile` | Build steps: base image (`node:20-alpine`), production install, file copy, volume, CMD. |
| `docker-compose.yml` | Service definition: build context, container name, restart policy, env file, volume mount. |
| `package.json` | npm scripts, dependency versions, engine constraint (`node >= 18`). |
| `.gitignore` | Files excluded from version control. |

### Environment Variable → Config Property Mapping

| Env Variable | Config Property | Default | Type |
|-------------|----------------|---------|------|
| `PRIVATE_KEY` | `config.privateKey` | `''` | string |
| `WSS_URL` | `config.wssUrl` | `''` | string |
| `RPC_URL` | `config.rpcUrl` | `'https://polygon-rpc.com'` | string |
| `LIVE_MODE` | (affects `config.dryRun`) | _(unset)_ | `'1'` to go live |
| `DRY_RUN` | `config.dryRun` | `true` (when LIVE_MODE unset) | boolean |
| `KILL_SWITCH` | `config.killSwitch` | `false` | boolean |
| `FUNDER_ADDRESS` | `config.funderAddress` | `''` | string |
| `SIGNATURE_TYPE` | `config.signatureType` | `0` | integer (0/1/2) |
| `MAX_DAILY_USDC` | `config.maxDailyUsdc` | `100` | integer |
| `MAX_POSITION_USDC` | `config.maxPositionUsdc` | `50` | integer |
| `MAX_TRADE_USDC` | `config.maxTradeUsdc` | `25` | integer |
| `MIN_BALANCE_USDC` | `config.minBalanceUsdc` | `20` | integer |
| `MAX_DAILY_DRAWDOWN_USDC` | `config.maxDailyDrawdownUsdc` | `30` | integer |
| `LOG_LEVEL` | `config.logLevel` | `'info'` | string |
| `WEBHOOK_URL` | `config.webhookUrl` | `''` | string |
| `TEST_ADDRESS` | `config.testAddress` | `''` | string |

### Config Properties NOT Settable via Env

These are only configurable by editing `src/config.js`:

`slippage`, `maxPriceDrift`, `cooldownMs`, `minOrderUsdc`, `txBatchWindowMs`, `enablePerfTiming`, `maxBuyPrice`, `minSellPrice`, `maxSpreadPct`, `minBookDepthUsdc`, `orderMode`, `gtcOffsetPct`, `gtcTimeoutMs`, `useSmartRouting`, `signalWindowMs`, `signalBoostRatio`, `signalMaxBoost`, `enableAutoExit`, `stopLossPct`, `takeProfitPct`, `enableTrailingStop`, `trailingStopPct`, `enableProfitRatchet`, `ratchetThreshold`, `ratchetFloor`, `enableTimeExit`, `timeExitHours`, `timeExitMinMovePct`, `enableEvExit`, `evExitMaxPrice`, `evExitMinPrice`, `exitCheckIntervalMs`, `maxOpenPositions`, `maxPortfolioExposurePct`, `enableDrawdownBreaker`, `minExpiryHours`, `enableStreakCooldown`, `maxLosingStreak`, `streakCooldownMs`, `copySells`, `sellMode`, `sellOnlyIfHeld`, `enableWhaleTracking`, `whaleTrackFile`, `whaleTrackWindowMs`, `whaleMinTrades`, `whaleMinMultiplier`, `whaleMaxMultiplier`, `enableKellySizing`, `enableEdgeFilter`, `minEdgeScore`, `enableMarketQuality`, `minMarketVolume`, `enableAntiSnipe`, `antiSnipeMaxMs`, `syncPositionsOnStart`, `positionFile`, `statsFile`, `healthFile`, `logFile`, `logMaxBytes`, `marketBlocklist`, `marketAllowlist`, `targets`, `watchdogIntervalMs`, `watchdogMaxSilenceMs`.

---

## Unverifiable Items

The following items are referenced in the codebase or docs but cannot be fully verified from the source code alone:

1. **Polymarket wallet approval process** — the guide mentions connecting the wallet to polymarket.com and completing approval prompts. The exact steps depend on Polymarket's current UI.
2. **Alchemy free tier limits** — the guide states "300M compute units/month." This may have changed.
3. **Exact number of offline tests** — the guide and existing docs reference "149 tests" in `simulate.js`, but the actual count depends on assertions executed at runtime (some are conditional). The codebase contains approximately 100+ `assert()` calls.
4. **Git repository URL** — referenced as `<repo-url>` in the guide. The actual URL depends on where the repo is hosted.
5. **Polymarket API stability** — the bot assumes specific response shapes from Gamma, CLOB, and Data APIs. If Polymarket changes their API contracts, the bot may break without code changes.
