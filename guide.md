# Polymarket Copy-Trader v7.0 — Complete Guide

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Tech Stack](#2-tech-stack)
3. [Project Structure](#3-project-structure)
4. [Getting Started](#4-getting-started)
5. [Environment Variables](#5-environment-variables)
6. [Available Scripts](#6-available-scripts)
7. [Key Concepts & Architecture](#7-key-concepts--architecture)
8. [Feature Breakdown](#8-feature-breakdown)
9. [Common Tasks](#9-common-tasks)
10. [Troubleshooting](#10-troubleshooting)

---

## 1. Project Overview

### What It Does

This is a real-time copy-trading bot for [Polymarket](https://polymarket.com), a prediction market platform on the Polygon blockchain. The bot monitors on-chain `OrderFilled` events emitted by Polymarket's CTF Exchange and NegRisk CTF Exchange contracts, detects trades made by a configurable set of "whale" wallets, and mirrors those trades on your behalf — scaled to your risk tolerance.

### How It Works

1. A tracked whale places a trade on Polymarket (BUY or SELL an outcome token).
2. The `OnChainMonitor` detects the `OrderFilled` event via WebSocket within seconds.
3. Partial fills in the same transaction are batched together (configurable window, default 400 ms).
4. The `trader.js` execution engine runs the trade through a pipeline of smart filters: market status, market quality, expiry, portfolio exposure, price bounds, spread, book depth, edge score, daily cap, balance check, and drift guard.
5. If all filters pass, the bot calculates an optimal position size using the whale's copy ratio, signal boost (multi-whale convergence), whale performance multiplier, and Kelly criterion sizing.
6. The order is placed on the Polymarket CLOB (Central Limit Order Book) as either a Fill-and-Kill (FAK) or Good-til-Cancel (GTC) limit order.
7. The `exit-manager.js` periodically evaluates all open positions against stop-loss, take-profit, trailing stop, profit ratchet, time-based, and EV-based exit rules — and auto-exits when triggered.

### Target Users

Polymarket traders who want to passively copy the trades of profitable wallets without manually monitoring markets. The bot is designed for users comfortable with running a Node.js process on a VPS or Docker container, and who understand the risks of automated on-chain trading.

### Key Characteristics

- **Zero external dependencies beyond the Polymarket SDK and ethers.js** — no database, no web framework, no cron. Everything runs in a single long-lived Node.js process.
- **Dry-run by default** — the bot simulates all trades without spending real money until you explicitly enable live mode.
- **State persisted to JSON files** — positions, stats, and whale performance data survive restarts via debounced writes to the `data/` directory.
- **Defensive by design** — kill switch, drawdown circuit breaker, losing-streak cooldown, anti-front-running delay, idempotency guards, and connection-ID-based reconnect logic to prevent stale-close races.

---

## 2. Tech Stack

| Component | Technology | Version | Purpose |
|-----------|-----------|---------|---------|
| Runtime | Node.js | >= 18 (`.nvmrc`: 18) | JavaScript runtime |
| Package manager | npm | Bundled with Node.js | Dependency management |
| Module system | ES Modules | `"type": "module"` in `package.json` | Native ESM (`import`/`export`) |
| Blockchain interaction | ethers.js | ^5.7.2 | WebSocket provider, event decoding, wallet signing |
| Polymarket SDK | @polymarket/clob-client | ^5 | CLOB order placement, API key derivation |
| Wallet signing | @ethersproject/wallet | ^5.7.0 | Private key to signer for order signing |
| WebSocket client | ws | ^8.18.0 | Underlying WebSocket transport for ethers.js |
| Linting | ESLint | ^9 (flat config) | Code quality (dev dependency only) |
| Containerization | Docker | Alpine Node 20 image | Production deployment |
| Orchestration | Docker Compose | v3.8 schema | Single-service container management |

### External APIs (no SDK, accessed via `fetch`)

| API | Base URL | Purpose |
|-----|----------|---------|
| Polymarket CLOB REST | `https://clob.polymarket.com` | Midpoint prices, order books, order placement |
| Gamma API | `https://gamma-api.polymarket.com` | Market metadata (question, tokens, tick size, neg risk) |
| Data API | `https://data-api.polymarket.com` | Account activity, positions, USDC balance |
| Polygon RPC/WSS | User-provided (e.g., Alchemy) | On-chain event subscription, block number pings |

### No External Dependencies For

- `.env` loading — custom parser in `config.js` (no `dotenv`)
- JSON file persistence — custom `JsonStore` class in `store.js` (no ORM, no database)
- Logging — custom structured logger in `logger.js` (no `winston`, no `pino`)
- Rate limiting — custom ring-buffer implementation in `api.js`
- Testing — custom test harnesses (no `jest`, no `mocha`)

---

## 3. Project Structure

```
pl1/
├── src/                        # All application source code
│   ├── index.js                # Entry point — bootstraps everything
│   ├── config.js               # Central configuration + .env loader + validation
│   ├── trader.js               # Order execution engine (smart filters, sizing, FAK/GTC)
│   ├── monitor.js              # On-chain OrderFilled event listener (WSS/HTTP)
│   ├── api.js                  # Polymarket API client (rate limiting, cache, helpers)
│   ├── positions.js            # Position book: cost basis, P&L, chain sync
│   ├── exit-manager.js         # Auto-exit: SL/TP/trailing/ratchet/time/EV
│   ├── whale-tracker.js        # Per-whale performance tracking + Kelly sizing
│   ├── stats.js                # Runtime statistics (events, fills, skips)
│   ├── logger.js               # Structured logging, trade journal, webhooks
│   ├── store.js                # Shared debounced JSON file persistence utility
│   ├── errors.js               # Structured error types (HttpError, TransientError)
│   ├── test.js                 # Online connectivity + integration tests
│   ├── unit-test.js            # Offline unit tests (pure logic, no network)
│   ├── simulate.js             # Offline simulation + validation test suite
│   ├── audit-test.js           # Audit test suite (auth, markets, copy logic, benchmarks)
│   ├── show-positions.js       # CLI: print current open positions
│   └── show-portfolio.js       # CLI: print portfolio with live P&L
├── data/                       # Runtime data directory (git-ignored, auto-created)
│   ├── positions.json          # Persisted open positions
│   ├── stats.json              # Trade statistics
│   ├── health.json             # Health check output (updated every 60s)
│   ├── trades.jsonl            # Append-only trade journal (JSON Lines)
│   └── whale-tracker.json      # Per-whale performance data
├── .env.example                # Template for environment variables
├── .env                        # Your secrets (git-ignored, create from .env.example)
├── .gitignore                  # Ignores node_modules/, data/, .env, *.log, *.pem, *.key
├── .nvmrc                      # Node version hint: 18
├── Dockerfile                  # Alpine Node 20 container image
├── docker-compose.yml          # Single-service Compose file
├── eslint.config.js            # ESLint 9 flat config
├── package.json                # Project metadata, scripts, dependencies
├── package-lock.json           # Locked dependency tree
├── guide.md                    # This file
└── PROJECT_MAP.md              # Detailed file-by-file project map
```

### Why This Layout

All source code lives in `src/` with no subdirectories. This is intentional — the project is a single-process bot, not a web framework or monorepo. Every module is a peer of every other module, and the dependency graph is shallow (most modules import `config.js` and `logger.js`; the rest form a directed acyclic graph described in `PROJECT_MAP.md`).

The `data/` directory is created at runtime and persists position state, statistics, whale performance data, and the trade journal. It is mounted as a Docker volume for containerized deployments.

---

## 4. Getting Started

### Prerequisites

| Requirement | Minimum | Notes |
|-------------|---------|-------|
| Node.js | >= 18 | `node --version` to check; install via [nodesource](https://github.com/nodesource/distributions) or `nvm` |
| npm | Bundled with Node.js | Used for dependency installation |
| Polygon wallet | An EVM wallet with a private key | **Use a dedicated wallet — never your main wallet** |
| USDC on Polygon | $50–100 recommended to start | Bridge from Ethereum or buy on a Polygon-native DEX |
| Polygon WSS endpoint | Free tier is sufficient | Create a free app on [Alchemy](https://www.alchemy.com/) and copy the WebSocket URL |
| Polymarket approval | Wallet must be approved on Polymarket | Go to [polymarket.com](https://polymarket.com), connect the wallet, complete any approval prompts |

### Installation

```bash
# Clone the repository
git clone <repo-url>
cd pl1

# Install dependencies
npm install
```

### Environment Setup

```bash
# Copy the environment template
cp .env.example .env

# Edit with your real values
nano .env   # or use any text editor
```

At minimum, fill in these two values:

```bash
PRIVATE_KEY=0xYourPrivateKeyHere
WSS_URL=wss://polygon-mainnet.g.alchemy.com/v2/YOUR_ALCHEMY_KEY
```

### Configure Whale Targets

Edit `src/config.js` and find the `targets` array (near the bottom of the file). Replace the demo whale with your own:

```js
targets: [
    {
        address:   '0x1234567890abcdef1234567890abcdef12345678',
        label:     'Whale-Alpha',
        copyRatio: 0.05,    // copy 5% of whale's trade size
        maxUsdc:   25,       // max $25 per trade from this whale
        sellMode:  'all',    // exit full position when whale sells
    },
],
```

Alternatively, set the `TEST_ADDRESS` environment variable to use a single whale address without editing `config.js`.

### Run in Dry-Run Mode (Default)

```bash
npm start
```

The bot starts in **dry-run mode** by default — it detects whale trades and simulates copies without spending real money. Look for lines like:

```
[DRY:WhaleName] [DRY RUN] Would BUY 25.00 USDC of "Will X happen?" at $0.5500
```

### Run in Live Mode

When you are satisfied with dry-run behavior, enable live trading:

```bash
LIVE_MODE=1 npm start
```

Or add `LIVE_MODE=1` to your `.env` file.

### Run with Docker

```bash
# Build the image
docker compose build

# Start in dry-run mode (default)
docker compose up -d

# View logs
docker compose logs -f

# Go live: add LIVE_MODE=1 to .env, then:
docker compose down && docker compose up -d
```

---

## 5. Environment Variables

All environment variables are optional except `PRIVATE_KEY` (required for live mode) and `WSS_URL` (strongly recommended for real-time detection). The bot loads `.env` automatically using a built-in parser in `config.js` — real env vars take precedence over file values.

### Required (for live trading)

| Variable | Example | Description |
|----------|---------|-------------|
| `PRIVATE_KEY` | `0x4c0883a6...` | 64-character hex private key of your trading wallet. Must start with `0x`. |
| `WSS_URL` | `wss://polygon-mainnet.g.alchemy.com/v2/xxx` | Polygon WebSocket endpoint for real-time on-chain event detection. Without this, the bot falls back to HTTP polling with 10–15 s delay. |

### Mode Control

| Variable | Default | Description |
|----------|---------|-------------|
| `LIVE_MODE` | _(unset)_ | Set to `1` to enable live trading. Without this, the bot runs in dry-run mode. |
| `DRY_RUN` | _(unset)_ | Set to `true` or `1` to force dry-run. Overrides `LIVE_MODE`. Set to `false` or `0` to explicitly disable dry-run. |
| `KILL_SWITCH` | `0` | Set to `1` to immediately halt all new trades. The exit manager continues to protect capital. |

### Wallet & Network

| Variable | Default | Description |
|----------|---------|-------------|
| `FUNDER_ADDRESS` | _(empty)_ | Required only if using Magic or Safe signature type (proxy/smart wallets). |
| `SIGNATURE_TYPE` | `0` | Wallet type: `0` = EOA (default), `1` = Magic, `2` = Safe. |
| `RPC_URL` | `https://polygon-rpc.com` | HTTP RPC fallback when `WSS_URL` is not set. |

### Risk Controls (Override Defaults in `config.js`)

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_DAILY_USDC` | `100` | Maximum USDC to spend per day on new BUYs. |
| `MAX_POSITION_USDC` | `50` | Maximum cost basis per open position. |
| `MAX_TRADE_USDC` | `25` | Maximum USDC risked on a single trade. |
| `MIN_BALANCE_USDC` | `20` | Stop buying if USDC balance drops below this. |
| `MAX_DAILY_DRAWDOWN_USDC` | `30` | Halt all new BUYs for the day if daily realized losses exceed this. |

### Logging & Notifications

| Variable | Default | Description |
|----------|---------|-------------|
| `LOG_LEVEL` | `info` | Log verbosity: `debug`, `info`, `warn`, `error`. |
| `WEBHOOK_URL` | _(empty)_ | Slack/Discord incoming webhook URL. Receives trade fills, errors, startup/shutdown, and drawdown alerts. |

### Testing

| Variable | Default | Description |
|----------|---------|-------------|
| `TEST_ADDRESS` | _(empty)_ | Whale wallet address used by `npm test` and `node src/audit-test.js`. Also becomes the default target if set. |

---

## 6. Available Scripts

Defined in `package.json`:

| Command | Script | Description |
|---------|--------|-------------|
| `npm start` | `node src/index.js` | Start the bot. Runs in dry-run mode by default; set `LIVE_MODE=1` for live trading. |
| `npm test` | `node src/test.js` | Online connectivity and integration tests. Tests RPC connection, Polymarket API access, position math, order book analysis. Requires `WSS_URL` or `RPC_URL`; optionally `TEST_ADDRESS`. |
| `npm run test:unit` | `node src/unit-test.js` | Offline unit tests. Tests all pure logic (config validation, position math, spread/depth calculations, market filters, whale tracker, edge scoring) with no network access required. |
| `npm run simulate` | `node src/simulate.js` | Comprehensive offline simulation. Runs 100+ assertions covering positions, config, API helpers, tick alignment, sell modes, trading scenarios, exit manager thresholds, risk guards, whale tracking, market quality, and edge scoring. |
| `npm run positions` | `node src/show-positions.js` | CLI utility: display current open positions from `data/positions.json`. |
| `npm run portfolio` | `node src/show-portfolio.js` | CLI utility: display portfolio summary with live midpoint prices and unrealized P&L. |
| `npm run lint` | `eslint src/` | Run ESLint on all source files using the flat config in `eslint.config.js`. |

### Additional Scripts (Not in `package.json`)

| Command | Description |
|---------|-------------|
| `node src/audit-test.js` | Audit test suite: auth, market fetch, copy logic, dry-run orders, speed benchmarks. Runs with or without API keys (API-dependent tests are skipped gracefully). |

### Runtime Signals (While the Bot Is Running)

| Signal | Effect |
|--------|--------|
| `Ctrl+C` / `SIGINT` / `SIGTERM` | Graceful shutdown: stops monitor, stops exit manager, flushes positions/stats/whale-tracker/journal to disk, sends shutdown webhook. |
| `kill -USR1 <pid>` | Toggle dry-run mode on/off at runtime without restarting. |
| `kill -USR2 <pid>` | Print stats, positions, whale performance, and portfolio to stdout. |

Docker equivalents:

```bash
docker kill --signal=SIGUSR1 poly-trader   # toggle dry-run
docker kill --signal=SIGUSR2 poly-trader   # print stats
```

---

## 7. Key Concepts & Architecture

### Data Flow

```
  Polygon Blockchain (OrderFilled events)
           │
           ▼
  ┌─────────────────┐
  │  monitor.js      │  WebSocket subscription (or HTTP poll)
  │  OnChainMonitor  │  Decodes events, batches partial fills
  └────────┬─────────┘
           │  onTrade(target, activity)
           ▼
  ┌─────────────────┐
  │  index.js        │  wrappedCallback:
  │  (orchestrator)  │  records stats, delegates to trader
  └────────┬─────────┘
           │
           ▼
  ┌─────────────────┐
  │  trader.js       │  Smart filter pipeline → size calc → order placement
  │  (execution)     │  Uses: api.js, positions.js, whale-tracker.js
  └────────┬─────────┘
           │  On fill: update positions, stats, whale-tracker
           ▼
  ┌─────────────────┐        ┌───────────────────┐
  │  positions.js    │◄──────►│  exit-manager.js   │
  │  (state)         │        │  (periodic scanner) │
  └──────────────────┘        └───────────────────┘
           │                           │
           ▼                           ▼
  ┌──────────────────┐        ┌───────────────────┐
  │  data/*.json      │        │  Polymarket CLOB   │
  │  (persistence)    │        │  (order placement)  │
  └──────────────────┘        └───────────────────┘
```

### Key Patterns

**Singleton modules.** `positions`, `stats`, `whaleTracker`, and `config` are all singleton instances exported from their modules. This is safe because the bot is a single-process, single-threaded application.

**Debounced persistence.** The `JsonStore` class (in `store.js`) provides a shared pattern for all persistent state: load from a JSON file on startup, schedule saves with a configurable debounce delay (2 s for positions, 5 s for whale tracker), and flush on shutdown. Save timers use `.unref()` so CLI scripts (`show-positions`, `show-portfolio`) can exit promptly.

**Rate limiting.** `api.js` uses a ring-buffer sliding window to limit outbound API requests to 8 per second. All API calls go through `fetchT()` which adds an 8 s `AbortController` timeout.

**TTL cache with deduplication.** Market metadata from the Gamma API is cached for 5 minutes. Concurrent identical requests are coalesced via an `inflight` map so only one network call is made. A periodic timer (every 10 min) garbage-collects expired entries. The cache is capped at 500 entries with FIFO eviction.

**Connection-ID guard.** The `OnChainMonitor` increments a `_connectionId` on every reconnect attempt. Close/error callbacks from previous connections carry the old ID and are silently ignored, preventing the "stale close triggers double reconnect" race condition common with WebSocket providers.

**Idempotency.** The trader maintains a `_recentOrders` map keyed by `txHash:tokenId:side` to prevent duplicate order placement when the same event is received twice (e.g., from both maker and taker subscriptions).

**In-flight balance tracking.** When a BUY order is initiated, the USDC amount is added to `_inflightUsdc`. This prevents concurrent trades from exceeding the balance. The in-flight amount is decremented in the `finally` block regardless of success or failure.

### Module Dependency Graph (Key Relationships)

```
config.js ──────────────────────────────► (imported by every module)

index.js ───► trader.js ───► api.js
         ├──► monitor.js       ├──► positions.js ───► api.js (fetchPositions, getMidpoint)
         ├──► exit-manager.js  ├──► whale-tracker.js
         ├──► positions.js     ├──► errors.js
         ├──► stats.js         └──► logger.js
         ├──► whale-tracker.js
         └──► logger.js

exit-manager.js ───► positions.js
                ├──► api.js (getMidpoint, getOrderBook, getMarketByToken, ...)
                ├──► whale-tracker.js
                ├──► trader.js (recordExitPnl)
                └──► logger.js

store.js ◄─── positions.js, stats.js, whale-tracker.js (shared persistence utility)
```

---

## 8. Feature Breakdown

### 8.1 On-Chain Trade Detection (`monitor.js`)

Subscribes to `OrderFilled` events on both Polymarket exchange contracts: CTF Exchange (`0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E`) and NegRisk CTF Exchange (`0xC5d563A36AE78145C45a50134d48A1215220f80a`). Uses dual subscription (maker + taker topic filters) to catch all fill directions. Decodes the event to determine: which target wallet was involved, whether they were maker or taker, BUY or SELL, the token ID, USDC amount, and share count. Batches partial fills within the same transaction (configurable `txBatchWindowMs`, default 400 ms). Implements 30 s keepalive pings, exponential backoff reconnection (2 s → 30 s cap, ±20% jitter), and deduplication via `txHash:targetAddr:orderHash` (purged every 10 min, capped at 10k entries).

### 8.2 Smart Filter Pipeline (`trader.js`)

Every detected whale trade passes through these checks in order: kill switch, idempotency, copy-sells toggle, sell-only-if-held, max open positions, drawdown breaker, losing streak cooldown, cooldown timer, market status (closed/resolved), keyword filter (blocklist/allowlist), market quality score, expiry filter, portfolio exposure cap, price bounds (`maxBuyPrice` 0.92 / `minSellPrice` 0.08), spread check (max 8%), book depth check (min $50), edge score composite filter, minimum order size, balance check, execution price estimate, smart routing (YES↔NO comparison), drift guard (max 10%), and daily spend cap.

### 8.3 Position Sizing (`trader.js → _calcAmount`)

For BUY orders: base amount is `whaleUsdc × copyRatio`, adjusted by Kelly criterion fraction (based on whale's proven edge), signal boost (multi-whale convergence), and whale performance multiplier. Capped by `maxUsdc` (per-target), `maxTradeUsdc` (per-trade), and `maxPositionUsdc` (per-position remaining capacity).

For SELL orders, three modes are supported: `all` exits the entire position, `ratio` sells `whaleSoldShares × copyRatio` (capped by our shares), and `proportional` estimates what fraction of their position the whale sold and sells the same fraction of ours.

### 8.4 Order Execution (`trader.js`)

Two order modes are supported. **FAK (Fill-and-Kill)** is the default — an immediate market order with worst-price slippage tolerance where partial fills are accepted. **GTC (Good-til-Cancel)** places a limit order slightly inside the spread (configurable offset), polls every 2 s for fill, and falls back to FAK if unfilled after timeout. Smart routing compares execution cost of direct token vs complementary token (YES↔NO) and uses the cheaper path if savings exceed 0.5%. Anti-front-running adds a random 0–1500 ms delay before order placement. Failed orders are retried up to 2 times for transient errors.

### 8.5 Auto-Exit Position Management (`exit-manager.js`)

Runs every 30 s (configurable). Checks each open position against these rules in priority order: EV-based exit (sell if price > 0.95 or < 0.05 with loss), profit ratchet (once up 15%, lock in 2% minimum), stop-loss (exit at -20%), take-profit (exit at +40%), trailing stop (exit on 12% pullback from high while in profit), and time-based exit (exit after 72 h of < 5% movement). Works in both live and dry-run modes.

### 8.6 Whale Performance Tracking (`whale-tracker.js`)

Tracks every completed trade per whale over a rolling 30-day window. Computes win rate (Bayesian-smoothed), profit factor, current streak, and total P&L. Calculates half-Kelly fraction for optimal sizing and a dynamic copy multiplier (0.1x–3.0x) based on win rate, profit factor, and streak. Requires 5 minimum trades before adjusting the multiplier. Persisted to `data/whale-tracker.json`.

### 8.7 Multi-Whale Signal Detection (`trader.js`)

When multiple tracked whales buy the same token within 5 minutes, the copy ratio is boosted by 1.5x per additional whale, up to 3.0x max.

### 8.8 Risk Controls

Daily spend cap (auto-resets at midnight UTC), daily drawdown circuit breaker, per-trade max, per-position max, portfolio exposure cap (80% of bankroll), minimum balance reserve, losing streak cooldown (3 losses → 1 hour pause per whale), and kill switch (halts new trades, exit manager still runs).

### 8.9 Logging & Notifications (`logger.js`)

Four log levels gated by `config.logLevel`. Trade journal appended to `data/trades.jsonl` in JSON Lines format with auto-rotation at 10 MB. Webhook notifications via fire-and-forget POST to configured URL with 100-item queue cap and 5 s timeout.

### 8.10 Health & Watchdog (`index.js`)

Health file (`data/health.json`) written every 60 s. Watchdog warns if no events received for 5 minutes.

---

## 9. Common Tasks

### Add a New Whale Target

Edit `src/config.js` and add an entry to the `targets` array:

```js
{
    address:   '0xnewwhaleaddress...',  // must be lowercase
    label:     'New-Whale',
    copyRatio: 0.05,
    maxUsdc:   25,
    sellMode:  'all',
}
```

Restart the bot. No code changes needed elsewhere.

### Change Risk Parameters at Runtime

Toggle dry-run: `kill -USR1 <pid>`. For all other parameters, edit `.env` or `src/config.js` and restart.

### Add a New Environment Variable

1. Add the variable to `.env.example` with a comment.
2. Read it in `src/config.js` via `env.YOUR_NEW_VAR`.
3. Add validation in `config.validate()` if the variable has constraints.
4. Document it in this guide.

### Add a New Smart Filter

In `src/trader.js`, add your filter check inside `_execute()` (between market fetch and order placement):

```js
if (isBuy && someCondition) {
    log.trade(TAG, { side, market: name, action: 'skip', reason: 'your_reason' });
    return { ok: false, reason: 'your_reason' };
}
```

Add the same filter in `dryRunCopyTrade()` for consistency.

### Add a New Exit Strategy

In `src/exit-manager.js`, add your check inside `_evaluatePosition()`:

```js
if (config.enableYourExit && someCondition) {
    log.info('EXIT', `YOUR-EXIT "${(marketName || tokenId).slice(0, 40)}" — reason`);
    await _exitPosition(pos, mid, 'your_exit');
    _cleanup(tokenId);
    return;
}
```

Add the corresponding config parameters in `config.js`.

### View Positions and P&L

```bash
npm run positions          # Quick position list
npm run portfolio          # Full portfolio with live prices
kill -USR2 $(pgrep -f "node src/index.js")   # Full stats dump while running
```

### Deploy with PM2

```bash
npm install -g pm2
pm2 start src/index.js --name poly-trader
pm2 startup && pm2 save
pm2 logs poly-trader
```

### Deploy with Docker

```bash
docker compose build
docker compose up -d
docker compose logs -f
```

### Deploy with systemd

Create `/etc/systemd/system/poly-trader.service`:

```ini
[Unit]
Description=Polymarket Copy Trader v7.0
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/pl1
EnvironmentFile=/home/ubuntu/pl1/.env
ExecStart=/usr/bin/node src/index.js
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable poly-trader
sudo systemctl start poly-trader
```

---

## 10. Troubleshooting

### Startup Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `[FATAL] Configuration errors:` followed by a list | `config.validate()` found invalid settings | Read the error messages. Common: missing targets, bad address format, `maxPositionUsdc > maxDailyUsdc`. |
| `[FATAL] Live mode requires PRIVATE_KEY` | `LIVE_MODE=1` but no `PRIVATE_KEY` set | Set `PRIVATE_KEY` in `.env` or environment. |
| `No targets configured` | Empty `targets` array and no `TEST_ADDRESS` | Add whale addresses to `targets` in `config.js` or set `TEST_ADDRESS`. |

### Runtime Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| Bot runs but no events | Whales not actively trading, or WSS failed | Verify `WSS_URL` is correct. Watch for reconnection messages. Confirm whales are trading. |
| All trades `[SKIP]` | Smart filters catching everything | Check skip reason in logs. These are protective — `drift`, `wide_spread`, `price_too_high`, `low_quality`, `low_edge` all indicate the filters are working. |
| `drift` skips | Market moved since whale's fill | Normal on fast markets. Lower `maxPriceDrift` only to accept more slippage risk. |
| `wide_spread` skips | Illiquid market | Filter protecting from bad fills. |
| `price_too_high` skips | Token above `maxBuyPrice` (0.92) | Limited upside. Filter working correctly. |
| Orders rejected by CLOB | Insufficient balance, wallet not approved, or invalid params | Check USDC on Polygon (not Ethereum). Complete Polymarket wallet approval. |
| WSS disconnects | Provider instability | Auto-reconnects with backoff. Upgrade provider if frequent. |
| `WATCHDOG: No events for Xs` | Possible silent WSS drop | Usually auto-recovers. Check provider status if persistent. |

### Docker Issues

| Symptom | Fix |
|---------|-----|
| Container exits immediately | `docker compose logs` to see error. Usually config validation failure. |
| Config changes not reflected | `docker compose down && docker compose build && docker compose up -d` |

### Test Failures

| Test | Likely Cause |
|------|-------------|
| `npm run simulate` fails | Logic bug in code change. All tests pass on unmodified code. |
| `npm test` fails on RPC | `WSS_URL`/`RPC_URL` not set, or provider down. |
| `npm test` skips API checks | `TEST_ADDRESS` not set. |

### Security Checklist

- [ ] Using a dedicated trading wallet (not your main wallet)
- [ ] `PRIVATE_KEY` is in `.env` (not hardcoded in `config.js`)
- [ ] `.env` is in `.gitignore` (already configured)
- [ ] Started with dry-run mode first
- [ ] Using conservative `copyRatio` (0.02–0.05) to start
- [ ] Set `maxDailyUsdc` to limit daily exposure
- [ ] WSS endpoint URL is kept private
- [ ] VPS firewall enabled (only SSH port open)
