# Polymarket Copy-Trader v7.0 — Complete Setup Guide (From Zero)

This guide takes you from a blank machine to a running copy-trading bot, step by step.

---

## Table of Contents

1. [What This Bot Does](#1-what-this-bot-does)
2. [Prerequisites](#2-prerequisites)
3. [Get Your Keys](#3-get-your-keys)
4. [Find Whale Wallets to Copy](#4-find-whale-wallets-to-copy)
5. [Clone & Install](#5-clone--install)
6. [Configure the Bot](#6-configure-the-bot)
7. [Set Environment Variables](#7-set-environment-variables)
8. [Test Everything](#8-test-everything)
9. [Run the Bot](#9-run-the-bot)
10. [Run with Docker (Recommended)](#10-run-with-docker-recommended)
11. [Production Deployment](#11-production-deployment)
12. [Monitor & Manage](#12-monitor--manage)
13. [Configuration Reference](#13-configuration-reference)
14. [Strategy Guide](#14-strategy-guide)
15. [Troubleshooting](#15-troubleshooting)

---

## 1. What This Bot Does

This bot **automatically copies trades from profitable Polymarket whale wallets** in real-time.

When a tracked whale buys or sells on Polymarket, the bot:
1. Detects the trade on-chain within seconds
2. Runs it through smart filters (price, spread, liquidity, edge score)
3. Calculates optimal position size (Kelly criterion + whale performance)
4. Places the same trade on your behalf, scaled to your risk tolerance
5. Auto-manages positions (stop-loss, take-profit, trailing stop)

**You make money when the whales you copy make money.**

---

## 2. Prerequisites

You need these before starting:

| Requirement | Why | How to Get It |
|-------------|-----|---------------|
| **A computer or VPS** | Bot needs to run 24/7 | Any Linux VPS ($5/mo on DigitalOcean, Hetzner, etc.) |
| **Node.js >= 18** | Runtime for the bot | See Step 5 below |
| **OR Docker** | Easier deployment | See Step 10 below |
| **A Polygon wallet** | To trade on Polymarket | MetaMask or any EVM wallet |
| **USDC on Polygon** | Trading funds | Bridge from Ethereum or buy on Polygon |
| **A Polygon WSS endpoint** | Real-time on-chain detection | Free from Alchemy (see Step 3) |
| **Whale wallet addresses** | Who to copy | See Step 4 |

---

## 3. Get Your Keys

You need two keys to run the bot.

### 3A. Polygon Wallet Private Key

This is the wallet that will execute trades on Polymarket.

> **IMPORTANT: Use a DEDICATED wallet. Never use your main wallet.**

1. Open MetaMask (or any EVM wallet)
2. Create a **new account** specifically for this bot
3. Switch to the **Polygon** network
4. Fund it with **USDC on Polygon** (start with $50–100)
5. Export the private key:
   - MetaMask → click the 3 dots → Account details → Show private key
   - It looks like: `0x4c0883a6910395b1e8ce...` (64 hex characters after 0x)

> Make sure your wallet has been **approved on Polymarket** first. Go to [polymarket.com](https://polymarket.com), connect this wallet, and complete any approval prompts.

### 3B. Polygon WebSocket (WSS) Endpoint

This lets the bot listen to real-time on-chain events.

1. Go to [alchemy.com](https://www.alchemy.com/) and create a free account
2. Click **"Create App"**
3. Choose:
   - Chain: **Polygon**
   - Network: **Polygon Mainnet**
4. Once created, click the app → **"API Key"**
5. Copy the **WebSocket** URL (not HTTPS)
   - It looks like: `wss://polygon-mainnet.g.alchemy.com/v2/AbCdEf123456`

> Free tier gives 300M compute units/month — more than enough.

---

## 4. Find Whale Wallets to Copy

This is the **most important step**. Your profits depend on copying the right people.

### Method A: Polymarket Leaderboard (Easiest)

1. Go to [polymarket.com/leaderboard](https://polymarket.com/leaderboard)
2. Sort by **"Profit"** (not volume — volume doesn't mean profitable)
3. Click on top traders → view their trade history
4. Copy their **wallet address** (starts with `0x...`)

### Method B: On-Chain Analysis (Advanced)

1. Go to [polygonscan.com](https://polygonscan.com)
2. Look at the Polymarket CTF Exchange contract: `0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E`
3. Filter for large trades (>$1000)
4. Track wallets that consistently profit

### Method C: Social / Community

1. Follow Polymarket traders on Twitter/X
2. Look for wallets shared in trading communities
3. Some traders post their wallets publicly

### What Makes a Good Whale

| Metric | Good | Bad |
|--------|------|-----|
| Win rate | >60% | <50% |
| Avg profit/trade | +10–30% | Huge losses mixed in |
| Trade frequency | 5–20/week | <1/week or 100+/day |
| Market diversity | Many markets | Only one niche |
| Hold time | Hours to days | Seconds (bots) or months |

> **Tip**: Start with 3–5 whales. The bot's whale tracker will automatically learn which ones are profitable and adjust sizing.

---

## 5. Clone & Install

### Option A: Run Directly with Node.js

```bash
# Install Node.js 20 (if not installed)
# Ubuntu/Debian:
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt install -y nodejs

# macOS:
brew install node@20

# Verify
node --version   # should be >= 18
```

```bash
# Clone the repo
git clone https://github.com/caludegit/pl1.git
cd pl1

# Install dependencies
npm install
```

### Option B: Use Docker (skip to Step 10)

If you prefer Docker, skip ahead to [Step 10](#10-run-with-docker-recommended). You don't need Node.js installed locally.

---

## 6. Configure the Bot

Edit `src/config.js` to add your whale targets:

```bash
nano src/config.js    # or use any text editor
```

Find the `targets: []` array (around line 125) and add your whales:

```js
targets: [
    {
        address:   '0x1234567890abcdef1234567890abcdef12345678',  // whale wallet (lowercase!)
        label:     'Whale-Alpha',      // friendly name for logs
        copyRatio: 0.05,               // copy 5% of whale's trade size
        maxUsdc:   25,                 // max $25 per trade from this whale
        sellMode:  'all',              // full exit when they sell
    },
    {
        address:   '0xabcdef1234567890abcdef1234567890abcdef12',
        label:     'Whale-Beta',
        copyRatio: 0.03,
        maxUsdc:   15,
        sellMode:  'all',
    },
    // Add more whales here...
],
```

### Target Fields Explained

| Field | Required | Description |
|-------|----------|-------------|
| `address` | Yes | Whale's wallet address, **must be lowercase** |
| `label` | Yes | Name shown in logs (any string) |
| `copyRatio` | Yes | Fraction of whale's trade size to copy (0.05 = 5%) |
| `maxUsdc` | Yes | Max $ per trade from this whale |
| `sellMode` | No | `'all'` (default), `'ratio'`, or `'proportional'` |
| `copySells` | No | Override global copySells for this whale |

### Other Config You Might Want to Change

Most defaults are good, but consider adjusting these:

```js
// Risk controls — adjust to your budget
maxDailyUsdc:      100,      // total daily spend cap (lower if small budget)
maxOpenPositions:  10,       // max positions at once
maxPositionUsdc:   50,       // max per single position
minBalanceUsdc:    20,       // stop buying if balance drops below this

// Auto-exit — the defaults are solid, but you can tighten them
stopLossPct:       -0.20,   // exit at -20% loss (use -0.15 for tighter)
takeProfitPct:     0.40,    // exit at +40% profit
trailingStopPct:   0.12,    // trailing stop at 12% pullback
```

> **Don't change the smart filters** (`maxBuyPrice`, `minSellPrice`, `maxSpreadPct`) unless you really know what you're doing. They protect you from bad trades.

---

## 7. Set Environment Variables

### Option A: Export in Terminal

```bash
export PRIVATE_KEY=0xYourPrivateKeyHere
export WSS_URL=wss://polygon-mainnet.g.alchemy.com/v2/YOUR_ALCHEMY_KEY
```

### Option B: Use a .env File (Recommended)

```bash
# Copy the example
cp .env.example .env

# Edit with your real values
nano .env
```

Fill in your `.env`:

```bash
# ── Required ──────────────────────────────────────────────
PRIVATE_KEY=0xYourPrivateKeyHere
WSS_URL=wss://polygon-mainnet.g.alchemy.com/v2/YOUR_ALCHEMY_KEY

# ── Optional ──────────────────────────────────────────────
# RPC_URL=https://polygon-rpc.com
# LIVE_MODE=1
# DRY_RUN=true
# WEBHOOK_URL=https://hooks.slack.com/services/xxx/yyy/zzz
# TEST_ADDRESS=0xSomeWhaleAddress
# FUNDER_ADDRESS=0x...
# SIGNATURE_TYPE=0
```

### All Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PRIVATE_KEY` | Yes (live mode) | Your trading wallet private key |
| `WSS_URL` | Recommended | Polygon WebSocket URL (real-time detection) |
| `RPC_URL` | No | HTTP RPC fallback (default: `https://polygon-rpc.com`) |
| `LIVE_MODE` | No | Set to `1` for live trading. Default: dry-run |
| `DRY_RUN` | No | Set to `true` or `1` for dry-run. Overrides `LIVE_MODE` |
| `WEBHOOK_URL` | No | Slack/Discord webhook for trade alerts |
| `TEST_ADDRESS` | No | Wallet address for `npm test` checks |
| `FUNDER_ADDRESS` | No | For proxy/smart wallets only |
| `SIGNATURE_TYPE` | No | `0`=EOA (default), `1`=Magic, `2`=Safe |

> **NEVER commit your `.env` file.** It's in `.gitignore` already.

---

## 8. Test Everything

Run these in order before going live:

### Step 8A: Offline Logic Tests (No Keys Needed)

```bash
npm run simulate
```

Runs 152 offline tests — position math, filters, exits, whale tracking. Everything should pass.

### Step 8B: Audit Test Suite

```bash
node src/audit-test.js
```

Tests auth, market fetch, copy logic, dry-run orders, and speed benchmarks. Runs with or without API keys (API-dependent tests are skipped gracefully when keys are missing).

### Step 8C: Connectivity Test

```bash
npm test
```

Tests RPC connection, Polymarket API access, and order book analysis. Needs `RPC_URL` or `WSS_URL`.

### Step 8D: Dry-Run (Watch Mode)

```bash
npm start
```

Starts in **dry-run mode** — detects whale trades and simulates copies **without spending real money**. Watch the logs:

- `[BUY-DRY]` = would have bought
- `[SELL-DRY]` = would have sold
- `[SKIP]` = filtered out (with reason)

> **Run dry-run for at least a few hours** (ideally 1–2 days) to verify it's detecting trades and the filters make sense.

---

## 9. Run the Bot (Without Docker)

### Dry-Run Mode (Default)

```bash
npm start
```

Or explicitly:

```bash
DRY_RUN=true npm start
```

### Live Mode

```bash
LIVE_MODE=1 npm start
```

Or if using `.env`, add `LIVE_MODE=1` to your `.env` file, then:

```bash
npm start
```

> **Note**: `DRY_RUN=true` or `DRY_RUN=1` in your environment forces dry-run regardless of `LIVE_MODE`.

### Keep It Running with PM2

```bash
# Install PM2
npm install -g pm2

# Start the bot
pm2 start src/index.js --name poly-trader

# Auto-restart on reboot
pm2 startup
pm2 save

# View logs
pm2 logs poly-trader

# Print stats
pm2 sendSignal SIGUSR2 poly-trader

# Stop
pm2 stop poly-trader
```

---

## 10. Run with Docker (Recommended)

Docker is the easiest way to deploy. You don't need Node.js installed.

### Step 10A: Install Docker

```bash
# Ubuntu/Debian
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# Log out and back in, then verify:
docker --version

# macOS: install Docker Desktop from https://docker.com
```

### Step 10B: Create Your .env File

```bash
cp .env.example .env
nano .env
# Fill in PRIVATE_KEY and WSS_URL (see Step 7)
```

### Step 10C: Configure Targets

Edit `src/config.js` and add whale addresses (see Step 6).

### Step 10D: Build & Run

```bash
# Build the image
docker compose build

# Run in dry-run mode (default)
docker compose up -d

# View logs
docker compose logs -f

# Stop
docker compose down
```

### Step 10E: Go Live

Add `LIVE_MODE=1` to your `.env` file, then:

```bash
docker compose down
docker compose up -d
```

### Docker Commands Reference

```bash
# Build
docker compose build

# Start (background)
docker compose up -d

# View live logs
docker compose logs -f

# Stop
docker compose down

# Restart
docker compose restart

# Print stats (send SIGUSR2)
docker kill --signal=SIGUSR2 poly-trader

# Toggle dry-run at runtime (send SIGUSR1)
docker kill --signal=SIGUSR1 poly-trader

# Shell into container
docker exec -it poly-trader sh

# View positions file
cat data/positions.json | jq .

# Rebuild after config changes
docker compose down && docker compose build && docker compose up -d
```

### Data Persistence

The `data/` folder is mounted as a Docker volume, so all state (positions, stats, whale tracker) survives container restarts:

```
data/
  positions.json        # your open positions
  stats.json            # trade statistics
  health.json           # health check (updated every 60s)
  trades.jsonl          # trade journal
  whale-tracker.json    # whale performance data
```

---

## 11. Production Deployment

### Recommended VPS Setup

1. Get a **$5–10/mo VPS** (DigitalOcean, Hetzner, Vultr) — pick a region close to Polygon nodes (US East or EU)
2. SSH in and install Docker (Step 10A)
3. Clone the repo, configure, and run with Docker

### Webhook Alerts (Slack / Discord)

Get notified on every trade:

1. **Slack**: Create an [Incoming Webhook](https://api.slack.com/messaging/webhooks) → copy the URL
2. **Discord**: Server Settings → Integrations → Webhooks → New Webhook → copy the URL
3. Add to `.env`:
   ```
   WEBHOOK_URL=https://hooks.slack.com/services/xxx/yyy/zzz
   ```

### Health Monitoring

The bot writes `data/health.json` every 60 seconds:

```json
{
  "alive": true,
  "uptime": "2h 15m",
  "events": 42,
  "filled": 8,
  "positions": 5,
  "dryRun": false,
  "ts": "2026-03-29T12:00:00.000Z"
}
```

Use any uptime monitor (UptimeRobot, Healthchecks.io) to check this file.

### systemd Alternative (No Docker)

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
sudo cp poly-trader.service /etc/systemd/system/
sudo systemctl enable poly-trader
sudo systemctl start poly-trader
sudo journalctl -u poly-trader -f
```

---

## 12. Monitor & Manage

### Daily Routine

```bash
# Check portfolio & P&L
npm run portfolio
# or with Docker:
docker exec poly-trader node src/show-portfolio.js

# Check positions
npm run positions
# or:
docker exec poly-trader node src/show-positions.js
```

### Runtime Signals

| Signal | What It Does |
|--------|-------------|
| `Ctrl+C` | Graceful shutdown (saves all state) |
| `kill -USR1 <pid>` | Toggle dry-run on/off |
| `kill -USR2 <pid>` | Print stats + positions + portfolio |

Docker equivalents:
```bash
docker kill --signal=SIGUSR1 poly-trader   # toggle dry-run
docker kill --signal=SIGUSR2 poly-trader   # print stats
```

---

## 13. Configuration Reference

### Core Trading

| Parameter | Default | Description |
|-----------|---------|-------------|
| `slippage` | 0.05 (5%) | Max price tolerance for FAK orders |
| `maxPriceDrift` | 0.10 (10%) | Skip if market moved >10% since whale's fill |
| `cooldownMs` | 30000 (30s) | Min time between copies of same token+wallet |
| `minOrderUsdc` | 1 | Skip trades below $1 |
| `txBatchWindowMs` | 400 | ms to wait for partial fills in same tx before firing copy |
| `dryRun` | true | Set `LIVE_MODE=1` or `DRY_RUN=false` for live trading |
| `enablePerfTiming` | true | Log signal-to-order latency (ms) for each trade |

### Smart Filters (Don't Disable These)

| Parameter | Default | Why It Matters |
|-----------|---------|----------------|
| `maxBuyPrice` | 0.92 | Don't buy above $0.92 — only 8c upside, 92c downside |
| `minSellPrice` | 0.08 | Don't panic-sell at $0.08 — hold for recovery |
| `maxSpreadPct` | 0.08 | Skip illiquid markets (wide spread = bad fills) |
| `minBookDepthUsdc` | 50 | Skip if order book too thin |
| `useSmartRouting` | true | Compare YES vs NO token for best fill |

### Multi-Whale Signal Detection

| Parameter | Default | Description |
|-----------|---------|-------------|
| `signalWindowMs` | 300000 (5m) | Window to detect whale convergence |
| `signalBoostRatio` | 1.5 | Multiply copyRatio per additional whale |
| `signalMaxBoost` | 3.0 | Cap the boost multiplier |

### Auto-Exit

| Parameter | Default | Description |
|-----------|---------|-------------|
| `enableAutoExit` | true | Auto-manage all positions |
| `stopLossPct` | -0.20 | Exit at -20% loss |
| `takeProfitPct` | 0.40 | Exit at +40% profit |
| `enableTrailingStop` | true | Track high, exit on pullback |
| `trailingStopPct` | 0.12 | Exit if price drops 12% from high |
| `enableProfitRatchet` | true | Once +15%, never go negative |
| `ratchetThreshold` | 0.15 | Activate ratchet at +15% profit |
| `ratchetFloor` | 0.02 | Lock in +2% minimum once ratchet activates |
| `enableTimeExit` | true | Exit stale positions after 72h |
| `timeExitHours` | 72 | Hours of no movement before exit |
| `timeExitMinMovePct` | 0.05 | Price must move >5% to reset stale timer |
| `enableEvExit` | true | Exit near-extreme prices |
| `evExitMaxPrice` | 0.95 | Sell if price > $0.95 (tiny upside left) |
| `evExitMinPrice` | 0.05 | Sell if price < $0.05 (likely total loss) |
| `exitCheckIntervalMs` | 30000 | Check positions every 30s |

### Risk Controls

| Parameter | Default | Description |
|-----------|---------|-------------|
| `maxDailyUsdc` | 100 | Daily spend cap |
| `maxOpenPositions` | 10 | Max concurrent positions |
| `maxPositionUsdc` | 50 | Max per position |
| `minBalanceUsdc` | 20 | Reserve — stop buying below this |

### Order Execution

| Parameter | Default | Description |
|-----------|---------|-------------|
| `orderMode` | 'fak' | `'fak'` = instant fill, `'gtc'` = limit order |
| `gtcOffsetPct` | 0.01 | 1% inside spread for GTC orders |
| `gtcTimeoutMs` | 15000 | Cancel unfilled GTC after 15s |

### Whale Performance Tracking

| Parameter | Default | Description |
|-----------|---------|-------------|
| `enableWhaleTracking` | true | Track whale win rates, auto-adjust sizing |
| `enableKellySizing` | true | Use Kelly criterion for optimal position sizes |
| `whaleTrackWindowMs` | 30 days | Rolling window for whale stats |
| `whaleMinTrades` | 5 | Min trades before adjusting copy ratio |
| `whaleMinMultiplier` | 0.1 | Floor: never completely stop copying a whale |
| `whaleMaxMultiplier` | 3.0 | Ceiling: never go above 3x base ratio |

### Edge & Quality Filters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `enableEdgeFilter` | true | Only copy trades with positive expected edge |
| `minEdgeScore` | 0.3 | 0–1 scale composite score threshold |
| `enableMarketQuality` | true | Skip low-quality markets |
| `minMarketVolume` | 5000 | Skip markets with < $5000 total volume |

### Anti-Front-Running

| Parameter | Default | Description |
|-----------|---------|-------------|
| `enableAntiSnipe` | true | Add random delay to prevent being front-run |
| `antiSnipeMaxMs` | 1500 | Max random delay before placing order (0–1500ms) |

### Watchdog & Stability

| Parameter | Default | Description |
|-----------|---------|-------------|
| `watchdogIntervalMs` | 60000 | How often to check for silence |
| `watchdogMaxSilenceMs` | 300000 | Warn if no events for 5 minutes |

### Sell Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| `copySells` | true | Copy whale sell trades |
| `sellMode` | 'all' | `'all'`, `'ratio'`, or `'proportional'` |
| `sellOnlyIfHeld` | true | Skip sell if we don't hold the token |

---

## 14. Strategy Guide

### Beginner (Start Here)

```js
// In src/config.js:
copyRatio: 0.02,           // 2% of whale's size
maxUsdc: 10,               // $10 max per trade
maxDailyUsdc: 50,          // $50/day max
maxOpenPositions: 5,
```

Fund wallet with **$50–100 USDC**. Run dry-run for 2 days, then go live.

### Moderate (After 2+ Weeks of Profit)

```js
copyRatio: 0.05,
maxUsdc: 25,
maxDailyUsdc: 100,
maxOpenPositions: 10,
```

### Aggressive (Only with Proven Whales)

```js
copyRatio: 0.10,
maxUsdc: 50,
maxDailyUsdc: 200,
maxOpenPositions: 15,
```

### Multi-Whale Strategy (Best Approach)

Track 3–5 whales with different copy ratios:

```js
targets: [
    { address: '0x...', label: 'Top-Earner',   copyRatio: 0.05, maxUsdc: 25, sellMode: 'all' },
    { address: '0x...', label: 'News-Trader',   copyRatio: 0.03, maxUsdc: 15, sellMode: 'all' },
    { address: '0x...', label: 'High-Volume',   copyRatio: 0.02, maxUsdc: 10, sellMode: 'ratio' },
],
```

The bot automatically:
- **Boosts** size when 2+ whales buy the same market (signal convergence)
- **Tracks** each whale's win rate and adjusts copy ratio over time (whale tracker)
- **Sizes** positions using Kelly criterion for mathematically optimal bets

---

## 15. Troubleshooting

| Problem | Solution |
|---------|----------|
| `"No targets configured"` | Add whale addresses to `targets` in `src/config.js` |
| `"privateKey required"` | Set `PRIVATE_KEY` in `.env` or env var |
| Bot runs but no events | Verify whales are actively trading; check WSS_URL is correct |
| All trades show `[SKIP]` | Check skip reasons in logs — filters are protecting you |
| `"drift"` skips | Market moved since whale traded — filter working correctly |
| `"wide_spread"` skips | Market is illiquid — filter protecting from bad fills |
| `"price_too_high"` skips | Token above $0.92 — limited upside |
| Orders rejected | Check USDC balance on Polygon; ensure wallet approved on Polymarket |
| WSS disconnects | Normal on free tiers — bot auto-reconnects |
| Balance shows $0 | Make sure USDC is on **Polygon network**, not Ethereum |
| Docker: container exits | Run `docker compose logs` to see the error |
| Docker: no data folder | Created automatically on first run |

---

## Security Checklist

- [ ] Using a **dedicated trading wallet** (not your main wallet)
- [ ] Private key is in `.env` file (not hardcoded in config.js)
- [ ] `.env` is in `.gitignore` (already configured)
- [ ] Started with **dry-run mode** first
- [ ] Using **small copyRatio** (0.02–0.05) to start
- [ ] Set **maxDailyUsdc** to limit daily exposure
- [ ] WSS endpoint URL is kept private
- [ ] VPS has firewall enabled (only SSH port open)

---

## Quick Reference: File Structure

```
pl1/
├── src/
│   ├── index.js            # Entry point
│   ├── config.js           # All configuration (edit this!)
│   ├── trader.js           # Order execution with smart filters
│   ├── monitor.js          # On-chain event listener
│   ├── api.js              # Polymarket API with caching
│   ├── positions.js        # Position tracking & P&L
│   ├── exit-manager.js     # Auto stop-loss / take-profit
│   ├── stats.js            # Runtime statistics
│   ├── logger.js           # Logging & webhooks
│   ├── whale-tracker.js    # Whale performance tracking
│   ├── test.js             # Connectivity tests
│   ├── simulate.js         # Offline logic tests (152 tests)
│   ├── audit-test.js       # Comprehensive audit test suite
│   ├── show-positions.js   # CLI: view positions
│   └── show-portfolio.js   # CLI: view portfolio
├── data/                   # Auto-created, persisted state
├── .env                    # Your secrets (git-ignored)
├── .env.example            # Template for .env
├── .gitignore
├── Dockerfile
├── docker-compose.yml
├── package.json
└── guide.md                # This file
```
