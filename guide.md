# Polymarket Copy-Trader v7.0 -- Complete Guide

## What This Bot Does

This bot **automatically copies trades from profitable Polymarket whale wallets** in real-time. When a tracked whale buys or sells, the bot detects it on-chain within seconds and places the same trade on your behalf -- scaled to your risk tolerance.

**v7.0 adds**: Whale performance tracking, Kelly criterion sizing, edge scoring, profit ratchet, time-based exits, EV-based exits, market quality filter, and anti-front-running.

## Architecture

```
src/
  index.js              Entry point -- wires everything, health monitoring
  config.js             Config with env var support, per-target overrides
  trader.js             Order execution -- BUY + SELL with smart filters + retry
  monitor.js            On-chain OrderFilled listener (Polygon WSS)
  api.js                REST API -- TTL cache, rate limiting, market analysis
  positions.js          Position tracking, P&L, persistence, chain sync
  exit-manager.js       Advanced auto-exit (stop-loss, take-profit, trailing, ratchet, time, EV)
  stats.js              Runtime stats with persistence across restarts
  logger.js             Structured logging, trade journal, webhooks
  whale-tracker.js      Whale performance tracking & dynamic copy ratios
  test.js               Connectivity & feature test suite
  simulate.js           Offline simulation & validation (152 tests)
  show-positions.js     CLI: view positions
  show-portfolio.js     CLI: view portfolio with live P&L
data/
  positions.json        Auto-managed: position state
  stats.json            Auto-managed: stats across restarts
  health.json           Auto-managed: health check for monitoring
  trades.jsonl          Auto-managed: trade journal (rotates at 10MB)
  whale-tracker.json    Auto-managed: whale performance data
```

## Features

| Feature | Description |
|---------|-------------|
| **Copy BUY + SELL** | Mirrors both buy and sell trades from target wallets |
| **Smart Entry Filters** | Skip bad prices (buy too high, sell too low), wide spreads, thin books |
| **Smart Order Routing** | Compare YES vs NO token fills, route to better price |
| **Multi-Whale Signals** | Boost position size when 2+ whales buy the same market |
| **Whale Performance Tracking** | Track each whale's win rate, P&L, and auto-adjust sizing |
| **Kelly Criterion Sizing** | Mathematically optimal position sizes based on whale edge |
| **Edge Scoring** | Composite score to filter low-quality trades |
| **Market Quality Filter** | Skip low-volume/illiquid markets automatically |
| **Anti-Front-Running** | Random delay before orders to prevent being sniped |
| **Stop-Loss** | Cut losses at configurable threshold (default -20%) |
| **Take-Profit** | Lock gains at configurable threshold (default +40%) |
| **Trailing Stop-Loss** | Track high watermark, exit on pullback (default 12%) |
| **Profit Ratchet** | Once up +15%, never go negative (breakeven floor) |
| **Time-Based Exit** | Free capital from stale positions (72h no movement) |
| **EV-Based Exit** | Exit near-extreme prices (>$0.95 or <$0.05) |
| **Order Retry** | Automatically retry on transient network/API errors |
| **Rate Limiting** | Built-in API rate limiter (8 req/s) prevents bans |
| **3 Sell Modes** | `ratio`, `proportional`, `all` -- configurable per target |
| **Position Tracking** | Cost basis, avg entry, realized P&L -- persisted to disk |
| **Balance Checking** | Verifies USDC balance before buying |
| **Risk Guards** | Daily cap, max positions, max per position, min balance reserve |
| **GTC Limit Orders** | Optional better-price execution with timeout fallback |
| **Chain Sync** | Reconciles local state with on-chain positions at boot |
| **Health Monitoring** | `data/health.json` updated every 60s for external monitors |
| **Webhook Alerts** | Slack/Discord notifications for trades, errors, P&L |

---

## Quick Start (5 Minutes)

### Step 1: Install

```bash
git clone <your-repo-url> && cd pm
npm install
```

Requires **Node.js >= 18**.

### Step 2: Get Your Keys

You need two things:

1. **Polygon Wallet Private Key** -- the wallet that will trade on Polymarket
   - Use a **dedicated trading wallet** (NOT your main wallet)
   - Fund it with USDC on Polygon
   - Export the private key from MetaMask or your wallet

2. **Polygon WSS Endpoint** -- for real-time on-chain event detection
   - Sign up at [Alchemy](https://www.alchemy.com/) (free tier works)
   - Create a Polygon app, copy the WebSocket URL
   - Looks like: `wss://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY`

### Step 3: Find Whale Wallets to Copy

This is the most important step. See **"Strategy Guide"** section below.

### Step 4: Configure

Edit `src/config.js` and add your target wallets:

```js
targets: [
    {
        address:   '0x1234...abcd',   // whale wallet address (lowercase)
        label:     'Whale-Alpha',      // friendly name for logs
        copyRatio: 0.05,               // copy 5% of their trade size
        maxUsdc:   25,                 // max $25 per trade
        sellMode:  'all',              // full exit when they sell
    },
],
```

### Step 5: Set Environment Variables

```bash
export PRIVATE_KEY=0xYourPrivateKey
export WSS_URL=wss://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY
```

Or fill them in `start.sh`.

Optional environment variables:

| Variable | Description |
|----------|-------------|
| `PRIVATE_KEY` | Trading wallet private key (required for live mode) |
| `WSS_URL` | Polygon WebSocket endpoint (recommended for real-time) |
| `RPC_URL` | HTTP RPC fallback (default: `https://polygon-rpc.com`) |
| `LIVE_MODE` | Set to `1` for live trading (default: dry-run) |
| `WEBHOOK_URL` | Slack/Discord webhook URL (optional) |
| `TEST_ADDRESS` | Wallet address for `npm test` API checks |
| `FUNDER_ADDRESS` | For proxy/Smart wallets only |
| `SIGNATURE_TYPE` | `0`=EOA (default), `1`=Magic, `2`=Safe |

### Step 6: Validate Logic (Offline)

```bash
npm run simulate
```

Runs 152 offline tests covering position math, filters, exits, whale tracking, and more. **No network or keys needed.**

### Step 7: Test Connectivity

```bash
npm test
```

Tests RPC connectivity, API access, position tracking, and order book analysis. Needs at least `RPC_URL` and optionally `TEST_ADDRESS`.

### Step 8: Run in Dry-Run Mode First

```bash
npm start
```

This runs in **dry-run mode** -- it will detect whale trades and simulate copies without spending real money. Watch for a few hours or days to verify it's working correctly.

### Step 9: Go Live

```bash
# Option A: via start.sh
./start.sh live

# Option B: via env var
LIVE_MODE=1 PRIVATE_KEY=0x... WSS_URL=wss://... node src/index.js
```

---

## Configuration Reference

### Core Trading

| Parameter | Default | Description |
|-----------|---------|-------------|
| `slippage` | 0.05 (5%) | Max price tolerance for FAK orders |
| `maxPriceDrift` | 0.10 (10%) | Skip if market moved >10% since whale's fill |
| `cooldownMs` | 30000 (30s) | Min time between copies of same token+wallet |
| `minOrderUsdc` | 1 | Skip trades below $1 |
| `txBatchWindowMs` | 400 | Wait for partial fills in same tx |
| `dryRun` | true | Set `LIVE_MODE=1` to trade |

### Smart Filters (KEY TO PROFITABILITY)

| Parameter | Default | Why It Makes Money |
|-----------|---------|-------------------|
| `maxBuyPrice` | 0.92 | Don't buy above $0.92 -- only 8c upside, huge downside |
| `minSellPrice` | 0.08 | Don't sell below $0.08 -- hold for potential recovery |
| `maxSpreadPct` | 0.08 (8%) | Skip illiquid markets with wide spreads (bad fills) |
| `minBookDepthUsdc` | 50 | Skip if order book side has < $50 depth |
| `useSmartRouting` | true | Compare YES vs NO token for better fill |

### Auto-Exit (CRITICAL FOR PROFITS)

| Parameter | Default | Description |
|-----------|---------|-------------|
| `enableAutoExit` | true | Auto-manage positions |
| `stopLossPct` | -0.20 (-20%) | Exit if position is down 20% |
| `takeProfitPct` | 0.40 (+40%) | Exit if position is up 40% |
| `enableTrailingStop` | true | Track high watermark, exit on pullback |
| `trailingStopPct` | 0.12 (12%) | Exit if price drops 12% from its high |
| `exitCheckIntervalMs` | 30000 (30s) | How often to check positions |

### Profit Ratchet (NEW in v7.0)

| Parameter | Default | Description |
|-----------|---------|-------------|
| `enableProfitRatchet` | true | Once in profit past threshold, never go negative |
| `ratchetThreshold` | 0.15 (+15%) | Activate ratchet at this profit level |
| `ratchetFloor` | 0.02 (+2%) | Minimum locked-in profit once ratchet activates |

### Time-Based Exit (NEW in v7.0)

| Parameter | Default | Description |
|-----------|---------|-------------|
| `enableTimeExit` | true | Exit stale positions that aren't moving |
| `timeExitHours` | 72 | Exit if position hasn't moved in 72 hours |
| `timeExitMinMovePct` | 0.05 (5%) | Threshold for "hasn't moved" |

### EV-Based Exit (NEW in v7.0)

| Parameter | Default | Description |
|-----------|---------|-------------|
| `enableEvExit` | true | Exit near-extreme prices (low expected value) |
| `evExitMaxPrice` | 0.95 | Sell if price >$0.95 (tiny upside left) |
| `evExitMinPrice` | 0.05 | Sell if price <$0.05 (likely total loss) |

### Whale Performance Tracking (NEW in v7.0)

| Parameter | Default | Description |
|-----------|---------|-------------|
| `enableWhaleTracking` | true | Track each whale's win rate, auto-adjust copy sizing |
| `whaleTrackWindowMs` | 30 days | Rolling performance evaluation window |
| `whaleMinTrades` | 5 | Min trades before adjusting copy ratio |
| `whaleMinMultiplier` | 0.1 | Floor: never completely stop copying a whale |
| `whaleMaxMultiplier` | 3.0 | Ceiling: never exceed 3x base copy ratio |
| `enableKellySizing` | true | Use Kelly criterion for optimal position sizing |

### Edge Scoring (NEW in v7.0)

| Parameter | Default | Description |
|-----------|---------|-------------|
| `enableEdgeFilter` | true | Only copy trades with positive expected edge |
| `minEdgeScore` | 0.3 | 0-1 scale, higher = more selective |

### Market Quality Filter (NEW in v7.0)

| Parameter | Default | Description |
|-----------|---------|-------------|
| `enableMarketQuality` | true | Skip low-quality markets automatically |
| `minMarketVolume` | 5000 | Skip markets with <$5000 total volume |

### Anti-Front-Running (NEW in v7.0)

| Parameter | Default | Description |
|-----------|---------|-------------|
| `enableAntiSnipe` | true | Add random delay before placing orders |
| `antiSnipeMaxMs` | 1500 | Random 0-1500ms delay |

### Risk Controls

| Parameter | Default | Description |
|-----------|---------|-------------|
| `maxDailyUsdc` | 100 | Daily BUY spend cap |
| `maxOpenPositions` | 10 | Max concurrent positions |
| `maxPositionUsdc` | 50 | Max cost basis per position |
| `minBalanceUsdc` | 20 | Stop buying if USDC < this |

### Order Execution

| Parameter | Default | Description |
|-----------|---------|-------------|
| `orderMode` | 'fak' | 'fak' = instant, 'gtc' = limit order for better price |
| `gtcOffsetPct` | 0.01 | 1% inside the spread for GTC orders |
| `gtcTimeoutMs` | 15000 | Cancel unfilled GTC after 15s, fall back to FAK |

### Signal Detection

| Parameter | Default | Description |
|-----------|---------|-------------|
| `signalWindowMs` | 300000 (5m) | Time window to detect whale convergence |
| `signalBoostRatio` | 1.5 | Multiply size by 1.5x when 2+ whales agree |
| `signalMaxBoost` | 3.0 | Cap the boost multiplier |

### Sell Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| `copySells` | true | Copy target sell trades |
| `sellMode` | 'all' | `all`=full exit, `ratio`=same ratio as buy, `proportional`=match whale's fraction |
| `sellOnlyIfHeld` | true | Skip sell if we don't hold the token |

### Market Filters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `marketBlocklist` | [] | Keywords to block (e.g., `['meme', 'celebrity']`) |
| `marketAllowlist` | [] | If set, ONLY trade markets matching these keywords |

---

## Runtime Commands

| Command | Description |
|---------|-------------|
| `npm start` | Start bot (dry-run by default) |
| `npm test` | Test connectivity and API access |
| `npm run simulate` | Run 152 offline logic tests (no keys needed) |
| `npm run positions` | View current holdings |
| `npm run portfolio` | View portfolio with live P&L |
| `./start.sh` | Start in dry-run mode |
| `./start.sh live` | Start in LIVE mode |
| `./start.sh test` | Run connectivity tests |
| `kill -USR1 <pid>` | Toggle dryRun on/off at runtime |
| `kill -USR2 <pid>` | Print stats + positions + portfolio to console |
| `Ctrl+C` | Graceful shutdown (saves all state) |

---

## How It Works (Flow)

1. **Boot** (`index.js`): Validates config, loads saved state (positions, stats, whale data), initializes CLOB client, syncs positions from chain
2. **Monitor** (`monitor.js`): Subscribes to Polygon `OrderFilled` events via WebSocket for all target wallets. Batches partial fills from the same transaction
3. **Detect**: When a target whale's trade is detected, the callback fires with trade details (token, side, size, price)
4. **Filter** (`trader.js`): The trade passes through multiple smart filters:
   - Cooldown check (same wallet+token)
   - Max positions limit
   - Market active/closed check
   - Market quality score
   - Price filter (maxBuyPrice / minSellPrice)
   - Spread filter (maxSpreadPct)
   - Book depth filter (minBookDepthUsdc)
   - Edge score filter (composite quality score)
   - Daily spend limit
   - Balance check
5. **Size**: Calculate order size using copyRatio, signal boost (multi-whale), whale performance multiplier, and Kelly criterion
6. **Route**: Smart routing compares direct token vs complementary token (YES/NO) for better fill
7. **Execute**: Place order via Polymarket CLOB API (FAK or GTC mode)
8. **Track**: Update positions, stats, whale tracker, and trade journal
9. **Manage** (`exit-manager.js`): Every 30 seconds, evaluate all positions for:
   - Stop-loss (-20%)
   - Take-profit (+40%)
   - Trailing stop (12% from high)
   - Profit ratchet (lock breakeven after +15%)
   - Time exit (72h stale)
   - EV exit (price >$0.95 or <$0.05)

---

## Strategy Guide: How to Find Profitable Whales

### The Copy Trading Edge

Copy trading works because:
- **Information asymmetry**: Whales often have better research, models, or insider knowledge
- **Speed**: They trade before the market moves; you piggyback on their alpha
- **Risk management**: The bot's filters protect you from their bad trades
- **v7.0 whale tracking**: The bot automatically learns which whales are profitable and copies them more

### Step 1: Find Whale Wallets

**Method A: Polymarket Leaderboard**
1. Go to [polymarket.com/leaderboard](https://polymarket.com/leaderboard)
2. Sort by "Profit" or "Volume"
3. Click on top traders to see their trade history
4. Copy their wallet addresses

**Method B: On-Chain Analysis**
1. Use [Polygonscan](https://polygonscan.com)
2. Look at the Polymarket CTF Exchange contract: `0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E`
3. Filter for large trades (>$1000 USDC)
4. Track wallets that consistently profit

**Method C: Social Research**
1. Follow Polymarket traders on Twitter/X
2. Some post their trades publicly
3. Look for wallets mentioned in trading communities

### Step 2: Evaluate Whale Quality

Not all whales are worth copying. Look for:

| Metric | Good Sign | Bad Sign |
|--------|-----------|----------|
| Win rate | >60% of positions profitable | <50% win rate |
| Avg profit per trade | Consistent +10-30% returns | Huge variance, many -50% losses |
| Trade frequency | 5-20 trades/week | Too rare (<1/week) or too frequent (100+/day) |
| Market type | Diverse markets | Only one niche (could be lucky) |
| Position sizing | Consistent sizing | Erratic, YOLO bets |
| Hold time | Hours to days | Seconds (bots) or months (illiquid) |

### Step 3: Recommended Configuration by Strategy

**Conservative (Recommended for Beginners)**
```js
copyRatio: 0.02,           // 2% of whale's size
maxUsdc: 10,               // $10 max per trade
maxDailyUsdc: 50,          // $50/day max
maxOpenPositions: 5,
stopLossPct: -0.15,        // tight stop loss
takeProfitPct: 0.30,       // take profits early
trailingStopPct: 0.10,     // tight trailing stop
```

**Moderate**
```js
copyRatio: 0.05,           // 5% of whale's size
maxUsdc: 25,               // $25 max per trade
maxDailyUsdc: 100,
maxOpenPositions: 10,
stopLossPct: -0.20,        // default
takeProfitPct: 0.40,       // default
trailingStopPct: 0.12,     // default
```

**Aggressive (Only with Proven Whales)**
```js
copyRatio: 0.10,           // 10% of whale's size
maxUsdc: 50,               // $50 max per trade
maxDailyUsdc: 200,
maxOpenPositions: 15,
stopLossPct: -0.30,
takeProfitPct: 0.75,
trailingStopPct: 0.20,
```

### Step 4: Multi-Whale Strategy (Best Approach)

Track 3-5 whales with different strengths:

```js
targets: [
    {
        address: '0x...', label: 'Leaderboard-Top5',
        copyRatio: 0.05, maxUsdc: 25,
        sellMode: 'all',
    },
    {
        address: '0x...', label: 'News-Trader',
        copyRatio: 0.03, maxUsdc: 15,
        sellMode: 'all',
    },
    {
        address: '0x...', label: 'High-Volume',
        copyRatio: 0.02, maxUsdc: 10,
        sellMode: 'ratio', copySells: true,
    },
]
```

The bot's **signal boost** feature automatically increases position size when 2+ whales buy the same market (strong consensus signal).

With **whale tracking** enabled (default), the bot automatically learns which whales are profitable over time and adjusts copy ratios accordingly -- copying more from winners and less from losers.

---

## Key Profit Principles

### 1. The Filters Are Everything
The smart filters (maxBuyPrice, minSellPrice, spread, depth) prevent you from entering bad trades. **Do not disable them.**

- `maxBuyPrice: 0.92` means you never buy a YES token above $0.92. At $0.92 you can only gain 8 cents but could lose 92 cents. Bad risk/reward.
- `minSellPrice: 0.08` means you don't panic-sell at the bottom. A token at $0.08 can only lose 8 more cents -- might as well hold.
- `maxSpreadPct: 0.08` means you skip markets where the bid-ask spread is >8%. Wide spreads = illiquid = bad fills = losses.

### 2. Stop Losses Are Mandatory
Without stop losses, one bad trade can wipe out 10 good ones. The trailing stop is even better -- it lets winners run while protecting profits. The profit ratchet (v7.0) ensures that once you're up +15%, you'll never go negative.

### 3. Diversify Across Whales
Don't copy just one wallet. They might have one lucky streak then lose everything. 3-5 wallets across different market types is ideal. Whale tracking will auto-adjust.

### 4. Start Small, Scale Up
Begin with $50-100 total budget, `copyRatio: 0.02`, and dry-run mode. Only increase after 2+ weeks of consistent profits.

### 5. Monitor Daily
Run `npm run portfolio` daily. Check which whales are profitable and which aren't. Remove underperforming whales (or let whale tracking auto-dampen them).

---

## Production Deployment

### PM2 (Recommended)
```bash
npm install -g pm2
pm2 start src/index.js --name poly-trader
pm2 startup && pm2 save
pm2 logs poly-trader
pm2 sendSignal SIGUSR2 poly-trader   # print stats
```

### systemd
```ini
[Unit]
Description=Polymarket Copy Trader v7.0
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/pm
EnvironmentFile=/home/ubuntu/pm/.env
ExecStart=/usr/bin/node src/index.js
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

### .env File Format

Create a `.env` file (it's gitignored) for use with `dotenv-cli` or systemd `EnvironmentFile`:

```bash
PRIVATE_KEY=0xYourPrivateKeyHere
WSS_URL=wss://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY
# RPC_URL=https://polygon-rpc.com
# WEBHOOK_URL=https://hooks.slack.com/services/xxx
# LIVE_MODE=1
```

---

## Data Files

All auto-managed in the `data/` directory:

| File | Purpose | Format |
|------|---------|--------|
| `positions.json` | Open positions with cost basis, P&L | JSON |
| `stats.json` | Trade statistics across restarts | JSON |
| `health.json` | Health check (updated every 60s) | JSON |
| `trades.jsonl` | Trade journal (rotates at 10MB) | JSON Lines |
| `whale-tracker.json` | Whale performance data | JSON |

These files are gitignored and created automatically on first run.

---

## Security Checklist

- [ ] **Never commit keys** -- use env vars or .env file
- [ ] **Dedicated trading wallet** -- not your main wallet
- [ ] **Start with dry-run** -- verify behavior before risking money
- [ ] **Small copyRatio first** -- 0.02-0.05 to start
- [ ] **Set maxDailyUsdc** -- limit daily exposure
- [ ] **Set maxPositionUsdc** -- limit single-market exposure
- [ ] **Monitor health.json** -- set up external uptime monitoring
- [ ] **Review portfolio daily** -- especially in the first 2 weeks
- [ ] **Keep your WSS endpoint private** -- it has your API key
- [ ] **Use a VPS** -- low latency to Polygon nodes matters

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "No targets configured" | Add whale addresses to `config.targets` in `src/config.js` |
| "privateKey required for live mode" | Set `PRIVATE_KEY` env var |
| Bot connects but no events | Check whale wallets are actively trading; verify WSS URL |
| All trades skipped | Check skip reasons in logs -- may need to adjust filters |
| "drift" skips | Whale's old trades have stale prices; this is the filter working correctly |
| "wide_spread" skips | Market is illiquid; this protects you from bad fills |
| "price_too_high" skips | Token above $0.92; limited upside, filter is protecting you |
| "low_quality" skips | Market has low volume; market quality filter is working |
| "low_edge" skips | Trade doesn't pass edge score threshold; try lowering `minEdgeScore` |
| Orders rejected | Check USDC balance on Polygon; ensure wallet approved Polymarket |
| WSS disconnects | Normal on free tiers; bot auto-reconnects with backoff |
| Balance shows $0 | Ensure USDC is on **Polygon** (not Ethereum mainnet) |
| Simulate tests fail | Run `npm install` first; requires Node.js >= 18 |

---

## Disclaimer

This bot is a tool for copy trading on Polymarket. There is no guarantee of profits. Prediction markets carry risk, and even the best whales can lose money. Always:
- Only trade with money you can afford to lose
- Start with small amounts and dry-run testing
- Monitor your positions regularly
- Understand that past whale performance does not guarantee future results
