# Project Map — Polymarket Copy-Trader v7.0

A real-time copy-trading bot that detects and mirrors trades from profitable Polymarket whale wallets on the Polygon blockchain.

## File Listing

| File | Description |
|------|-------------|
| `package.json` | Project metadata, npm scripts (`start`, `test`, `simulate`, `positions`, `portfolio`), and dependencies |
| `package-lock.json` | Locked dependency tree for reproducible installs |
| `.env.example` | Template for required/optional environment variables (private key, WSS URL, etc.) |
| `.gitignore` | Ignores `node_modules/`, `data/`, `.env`, and `*.log` from version control |
| `Dockerfile` | Alpine Node 20 container image that runs `src/index.js` with a persistent `data/` volume |
| `docker-compose.yml` | Single-service Compose file to build and run the bot with `.env` and `data/` volume |
| `guide.md` | Comprehensive setup guide covering installation, configuration, deployment, and troubleshooting |
| `guide.md.bak` | Backup copy of the setup guide |
| **`src/index.js`** | Entry point — bootstraps the bot, wires modules together, handles process signals |
| **`src/config.js`** | All configuration: whale targets, risk controls, smart filters, auto-exit params, API endpoints |
| **`src/trader.js`** | Order execution engine with smart filters, Kelly sizing, slippage control, and retry logic |
| **`src/monitor.js`** | On-chain event listener — connects via WebSocket to detect whale trades in real time |
| **`src/api.js`** | Polymarket REST/WebSocket API client with rate limiting, TTL cache, and request deduplication |
| **`src/positions.js`** | Position state management, P&L tracking, and on-chain sync |
| **`src/exit-manager.js`** | Auto-exit engine: stop-loss, take-profit, trailing stop, profit ratchet, time/EV exits |
| **`src/stats.js`** | Runtime statistics collector (trades, fills, skips, daily spend) |
| **`src/logger.js`** | Structured logging with log levels, file rotation, and Slack/Discord webhook alerts |
| **`src/whale-tracker.js`** | Tracks per-whale win rate and performance; adjusts copy ratios over time |
| **`src/test.js`** | Connectivity tests — verifies RPC, Polymarket API access, and order book analysis |
| **`src/simulate.js`** | Offline logic test suite (149 tests) covering filters, exits, position math, and whale tracking |
| **`src/audit-test.js`** | Audit test suite — tests auth, market fetch, copy logic, dry-run orders, and benchmarks |
| **`src/show-positions.js`** | CLI utility to display current open positions |
| **`src/show-portfolio.js`** | CLI utility to display portfolio summary and P&L |

## Runtime Data (`data/` — git-ignored, auto-created)

| File | Description |
|------|-------------|
| `data/positions.json` | Persisted open position state |
| `data/stats.json` | Trade statistics |
| `data/health.json` | Health check output (updated every 60s) |
| `data/trades.jsonl` | Append-only trade journal (JSON Lines) |
| `data/whale-tracker.json` | Per-whale performance and win-rate data |

## Code Walkthrough

### `src/config.js`

**Purpose:** Central configuration module. Loads `.env` files, defines every tunable parameter, normalizes whale targets, and validates the full config before the bot starts.

**Exports:**
- `default` — the `config` object (default export)

**Key functions / sections:**
- `loadEnvFile()` — minimal `.env` parser (no dependency); real env vars take precedence over file values
- `config.validate()` — returns an array of human-readable error strings for invalid settings (bad keys, out-of-range values, malformed addresses)
- `config.getSellMode(target)` / `config.shouldCopySells(target)` — resolve per-target overrides vs global defaults
- Target normalization block — lowercases addresses, fills defaults for `copyRatio`, `maxUsdc`, `sellMode`, `copySells`

**Connections:** Imported by every other module. No outbound dependencies on project code.

---

### `src/index.js`

**Purpose:** Entry point. Validates config, prints the startup banner, loads persisted state, initializes the trader client, wires the on-chain monitor to the trade callback, starts the exit manager, and manages graceful shutdown.

**Exports:** None (top-level script).

**Key functions:**
- `main()` — orchestrates startup: validate → load state → init trader → sync positions → start monitor → start exit manager → periodic health/watchdog timers
- `writeHealth()` — writes `data/health.json` every 60 s with uptime, event count, position count
- `wrappedCallback(target, activity)` — glue between monitor and trader; records stats, delegates to `placeCopyTrade` or `dryRunCopyTrade`
- Signal handlers: `SIGUSR1` toggles dry-run, `SIGUSR2` prints stats/positions/portfolio, `SIGINT`/`SIGTERM` trigger graceful shutdown (flush state, save files)
- `shutdown(signal)` — stops all timers, flushes positions/stats/whale-tracker/journal, sends webhook notification

**Connections:**
- Imports: `config`, `trader` (initTrader, placeCopyTrade, dryRunCopyTrade, getWalletAddress, getClient), `monitor` (OnChainMonitor), `exit-manager` (startExitManager, stopExitManager), `whale-tracker`, `stats`, `positions`, `logger`

---

### `src/api.js`

**Purpose:** Polymarket REST API client layer. Provides rate-limited, retrying, cached access to the Gamma metadata API, CLOB trading API, and Data API. Also contains pure-function helpers for spread/depth/edge calculations and market filtering.

**Exports:**
- `cleanExpiredCache()` — purge stale TTL cache entries
- `getMarketByCondition(conditionId)` / `getMarketByToken(tokenId)` — fetch market metadata from Gamma (cached 5 min, deduplicated)
- `isMarketActive(market)` — checks closed/resolved/active flags
- `getComplementaryToken(market, tokenId)` — returns the YES↔NO counterpart token ID
- `getMidpoint(tokenId)` — live midpoint price (never cached)
- `getOrderBook(tokenId)` — full order book snapshot
- `getSpread(book)` — computes bid-ask spread, spread %, best bid/ask, mid
- `getBookDepth(book)` — total USDC on each side of the book
- `getExecutionPriceFromBook(book, side, amount)` — walks book levels to estimate avg fill price and fill %
- `fetchActivity(address)` / `fetchPositions(address)` / `fetchBalance(address)` — Data API wrappers
- `extractMarketParams(market)` — pulls `tickSize` and `negRisk` from market object
- `getHoursUntilExpiry(market)` — hours until market end date
- `getMarketQuality(market)` — 0–1 quality score based on volume and liquidity
- `calcEdgeScore({...})` — 0–1 composite score combining whale quality, signal boost, spread, depth, price, and market quality
- `passesMarketFilter(market)` — checks market question against blocklist/allowlist keywords

**Internal helpers:**
- `_rateLimit()` — sliding-window limiter (max 8 req/s)
- `fetchT(url, opts)` — fetch with AbortController timeout (8 s)
- `withRetry(fn, label, retries)` — exponential-backoff retry; skips 4xx (except 429)
- `cacheGet` / `cacheSet` / `dedup` — TTL cache + in-flight request coalescing

**Connections:** Imports `config`. Used by `trader`, `exit-manager`, `positions`, `test`, `audit-test`.

---

### `src/monitor.js`

**Purpose:** Real-time on-chain event listener. Connects to Polygon via WebSocket (or HTTP fallback), subscribes to `OrderFilled` events on both Polymarket exchange contracts, decodes fills, batches partial fills per transaction, and fires the copy-trade callback.

**Exports:**
- `OnChainMonitor` class

**Key methods:**
- `start()` — begins listening; sets up heartbeat and dedup-cleanup timers
- `stop()` — tears down provider, clears all timers, flushes pending batches
- `_connect()` — creates an `ethers.WebSocketProvider` (or JSON-RPC fallback), subscribes to `OrderFilled` events with dual topic filters (maker + taker), starts 30 s keepalive pings, handles reconnect on close/error with connection-ID guard to prevent stale-close races
- `_onLog(evt)` — decodes `OrderFilled` event, determines if the target wallet was maker or taker, computes side/tokenId/amounts, deduplicates, and adds to a batch accumulator
- `_flushBatch(key, batch)` — sums partial fills, logs the aggregated trade, and calls `this.onTrade(target, activity)`
- `_scheduleReconnect()` — exponential backoff (2 s → 30 s cap)
- `_cleanSeen()` — purges the dedup map every 10 min

**Connections:** Imports `ethers`, `config`, `logger`. Instantiated in `index.js` with a `targetMap` and the trade callback.

---

### `src/trader.js`

**Purpose:** Core order execution engine. Applies all smart filters (price, spread, depth, edge score, market quality, expiry, portfolio exposure, drawdown breaker, losing-streak cooldown), calculates position size (Kelly criterion + whale performance + signal boost), executes orders via the Polymarket CLOB client (FAK or GTC with timeout/fallback), tracks in-flight balance, and records trades in positions/stats/whale-tracker.

**Exports:**
- `initTrader()` — creates `ClobClient` with wallet signer + API key derivation
- `getClient()` — returns the initialized CLOB client
- `getWalletAddress()` — returns the bot's lowercase wallet address
- `recordExitPnl(pnl)` — records realized P&L for the daily drawdown breaker (called by exit-manager)
- `placeCopyTrade(target, activity)` — live order entry point with kill switch, idempotency, cooldown, lock, and all filters
- `dryRunCopyTrade(target, activity)` — simulates the same logic without placing real orders; still tracks positions and daily spend for accurate dry-run stats

**Key internal functions:**
- `_execute(target, activity)` — the full filter + execute pipeline: fetches market/mid/book in parallel, runs every filter, calculates amount, optionally smart-routes via complementary token, applies drift guard and daily limit, places FAK or GTC order with retry (up to 2 retries for transient errors), records position and P&L
- `_executeGtcOrder(...)` — places a GTC limit order offset from mid, polls for fill, falls back to FAK if unfilled after timeout
- `_calcAmount(target, activity, mid)` — computes order size from `copyRatio × whaleUsdc × signalBoost × whaleMultiplier`, capped by `maxUsdc`, `maxTradeUsdc`, `maxPositionUsdc`, and Kelly fraction; for sells, resolves `all`/`proportional`/`ratio` modes
- `_getSignalBoost(tokenId, side)` / `_recordSignal(...)` — multi-whale convergence detection within `signalWindowMs`
- `_getBalance()` — cached balance fetch with in-flight USDC adjustment
- `_alignToTick(price, tickSize, roundUp)` — rounds price to valid Polymarket tick, clamps to `[tick, 1-tick]`
- `_wouldExceedDaily(amount)` / `_recordSpend(amount)` / `_recordDailyPnl(pnl)` — daily spend and drawdown tracking with auto-reset at midnight

**Connections:** Imports `ClobClient`/`Side`/`OrderType` from `@polymarket/clob-client`, `Wallet` from `@ethersproject/wallet`, `config`, `positions`, `whale-tracker`, `logger`, and many functions from `api`. Called by `index.js`. `recordExitPnl` is called by `exit-manager`.

---

### `src/positions.js`

**Purpose:** In-memory position book with cost-basis tracking, realized P&L accounting, debounced disk persistence, on-chain sync, and portfolio snapshot with live prices.

**Exports:**
- `positions` — singleton `PositionManager` instance

**Key methods:**
- `load()` / `flush()` — read/write `data/positions.json`
- `_scheduleSave()` / `_doSave()` — debounced save (2 s delay, `unref`'d so CLI scripts can exit)
- `syncFromChain(walletAddress)` — fetches on-chain positions via `fetchPositions`, reconciles with local state (adds missing, updates share counts, removes stale), protected by a mutex
- `recordBuy(tokenId, shares, usdcSpent, opts)` — creates or updates a position with cost basis and avg entry price
- `recordSell(tokenId, sharesSold, usdcReceived)` — computes realized P&L, reduces shares/cost basis, removes position on full exit and accumulates `_closedPnl`
- `getPosition` / `getShares` / `hasPosition` / `getAll` / `getCount` / `getTotalCostBasis` / `getTotalRealizedPnl` — query helpers
- `getSnapshot()` — fetches live midpoints for all positions, computes unrealized P&L per position and totals
- `print()` — console table of open positions
- `printPortfolio()` — console table with live prices and unrealized P&L

**Connections:** Imports `config`, `api` (fetchPositions, getMidpoint), `logger`. Used by `trader`, `exit-manager`, `index`, `stats`, `test`, `simulate`, `show-positions`, `show-portfolio`.

---

### `src/exit-manager.js`

**Purpose:** Periodic position scanner that auto-exits positions based on configurable rules: stop-loss, take-profit, trailing stop, profit ratchet, time-based exit, and EV-based exit. Operates in both live and dry-run modes.

**Exports:**
- `startExitManager(client)` — starts the interval timer (`exitCheckIntervalMs`)
- `stopExitManager()` — clears the timer

**Key internal functions:**
- `_checkPositions()` — iterates all open positions, calls `_evaluatePosition` for each (mutex to prevent overlap)
- `_evaluatePosition(pos)` — fetches live midpoint, computes P&L %, then checks exit rules in priority order: EV exit (price > 0.95 or < 0.05) → profit ratchet → stop-loss → take-profit → trailing stop → time exit
- `_exitPosition(pos, mid, reason)` — in dry-run: simulates the sell and records P&L; in live: fetches market params, creates a FAK sell order via the CLOB client, records P&L, logs, and sends webhook
- `_cleanup(tokenId)` — removes trailing-stop, ratchet, and time-tracking state for a closed position

**State maps:**
- `_trailingState` — `Map<tokenId, { highWaterMark, highMid }>` for trailing stops
- `_ratchetState` — `Map<tokenId, { activated, floorValue }>` for profit ratchets
- `_timeState` — `Map<tokenId, { lastMid, lastMoveAt }>` for stale-position detection

**Connections:** Imports `@polymarket/clob-client` (Side, OrderType), `config`, `positions`, `whale-tracker`, `trader` (recordExitPnl), `logger`, `api` (getMidpoint, getOrderBook, getExecutionPriceFromBook, extractMarketParams, getMarketByToken, isMarketActive). Started by `index.js`.

---

### `src/stats.js`

**Purpose:** Runtime statistics collector. Tracks event counts, trade outcomes (filled/skipped/rejected/errors), per-target breakdowns, and skip reasons. Persists to disk across restarts.

**Exports:**
- `stats` — singleton `Stats` instance

**Key methods:**
- `recordEvent(label, side)` — increments event counters (total + buy/sell + per-target)
- `recordTrade(label, result, usdcAmount, side)` — classifies trade result (filled, skipped, rejected, error) and updates counters + per-target stats with buy/sell breakdowns
- `load()` / `save()` — read/write `data/stats.json`
- `startReporting(intervalMs)` / `stop()` — periodic console stats dump (default every 5 min)
- `uptime()` — formatted uptime string (`Xh Ym`)
- `getSummary()` — serializable snapshot of all stats
- `print()` — formatted console output with per-target breakdown and skip reasons

**Connections:** Imports `config`, `logger`. Used by `index.js` (event/trade recording, lifecycle), `audit-test`.

---

### `src/logger.js`

**Purpose:** Structured logging with four levels, a JSON Lines trade journal with file rotation, and fire-and-forget webhook notifications (Slack/Discord).

**Exports:**
- `debug(tag, msg, ...args)` / `info(...)` / `warn(...)` / `error(...)` — console logging gated by `config.logLevel`
- `journal(entry)` — appends a JSON object to the trade journal buffer
- `flushJournal()` — flushes the buffered journal lines to disk
- `notify(event, data)` — queues a webhook POST (capped at 100 items, serialized sending, 5 s timeout)
- `trade(tag, entry)` — convenience wrapper that logs to console + journal in one call, formatting differently for filled/skip/rejected/error/dry_run actions

**Internal details:**
- `_flush()` — serialized file writer (prevents concurrent appends)
- 60 s rotation timer checks `logMaxBytes` and renames the file; timer is `unref`'d for CLI scripts
- `_drainWebhook()` — serialized webhook sender, silently drops on failure

**Connections:** Imports `config`. Used by every other module.

---

### `src/whale-tracker.js`

**Purpose:** Tracks per-whale trading performance over a rolling window (default 30 days). Computes win rate (Bayesian-smoothed), profit factor, current streak, half-Kelly fraction, and a dynamic copy multiplier. Persists to disk.

**Exports:**
- `whaleTracker` — singleton `WhaleTracker` instance

**Key methods:**
- `recordTrade(address, { tokenId, side, entryPrice, exitPrice, pnlPct, usdcPnl, market })` — appends trade, trims window, recalculates all derived stats
- `_recalculate(record)` — computes: win/loss counts, win rate (with +2 Bayesian pseudo-observations), profit factor, streak, half-Kelly fraction (`f* = (p·b − q) / b`, capped at 50%), and dynamic `copyMultiplier` based on win rate + profit factor + streak (clamped to `[whaleMinMultiplier, whaleMaxMultiplier]`)
- `getMultiplier(address)` / `getKellyFraction(address)` / `getStats(address)` / `getAllStats()` — read accessors
- `load()` / `flush()` / `_scheduleSave()` — persistence with 5 s debounced save
- `print()` — console table sorted by total P&L

**Connections:** Imports `config`, `logger`. Used by `trader` (copy ratio adjustment), `exit-manager` (recording exit P&L per whale), `index` (load/flush/print).

---

### `src/test.js`

**Purpose:** Online connectivity and integration test script. Verifies config validity, Polygon RPC connection, position manager buy/sell/P&L math, Data API (activity, positions, balance), Gamma API (market metadata, active check, filter check), and CLOB API (midpoint, order book, execution estimates with slippage).

**Exports:** None (top-level script, run via `npm test`).

**Connections:** Imports `ethers`, `config`, `api` (fetchActivity, getMarketByToken, extractMarketParams, getMidpoint, getOrderBook, getExecutionPriceFromBook, fetchPositions, fetchBalance, isMarketActive, passesMarketFilter), `positions`.

---

### `src/simulate.js`

**Purpose:** Comprehensive offline test suite (149 tests). Validates all bot logic without network access: position math, config validation, tick alignment, spread/depth calculations, execution price estimation, smart filters, sell modes, signal boost, stats tracking, exit manager thresholds, market filters, and order book walking.

**Exports:** None (top-level script, run via `npm run simulate`).

**Connections:** Imports `positions`, `api` (getSpread, getBookDepth, getExecutionPriceFromBook, passesMarketFilter, getMarketQuality, calcEdgeScore, getHoursUntilExpiry, isMarketActive, getComplementaryToken), `stats`, `config`.

---

### `src/audit-test.js`

**Purpose:** Audit-focused test suite that covers auth/trader initialization, market fetching, copy logic, dry-run order placement, and speed benchmarks. Runs with or without API keys (API-dependent tests are skipped gracefully).

**Exports:** None (top-level script, run via `node src/audit-test.js`).

**Connections:** Imports `config`, `positions`, `stats`, `api` (getMidpoint, getOrderBook, getSpread, getBookDepth, getExecutionPriceFromBook, getMarketByToken, extractMarketParams, fetchBalance, fetchPositions, fetchActivity, isMarketActive, passesMarketFilter, getMarketQuality, calcEdgeScore), and conditionally `trader` (initTrader, getWalletAddress).

---

### `src/show-positions.js`

**Purpose:** CLI utility that loads and prints current open positions from `data/positions.json`.

**Exports:** None (top-level script, run via `npm run positions`).

**Connections:** Imports `positions`.

---

### `src/show-portfolio.js`

**Purpose:** CLI utility that loads positions and prints a portfolio summary with live midpoint prices and unrealized P&L.

**Exports:** None (top-level script, run via `npm run portfolio`).

**Connections:** Imports `positions` (which internally calls `api.getMidpoint` for live pricing).
