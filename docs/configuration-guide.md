# Polymarket Copy-Trader v7.0 — Configuration Guide

Complete reference for every setting in `.env` and `config.js`.

---

## Table of Contents

- [.env File (Secrets)](#env-file-secrets)
- [Core Trading](#1-core-trading)
- [Smart Entry Filters](#2-smart-entry-filters)
- [Risk Controls](#3-risk-controls)
- [Auto-Exit System](#4-auto-exit-system)
- [Whale Performance Tracking](#5-whale-performance-tracking)
- [Edge & Quality Filters](#6-edge--quality-filters)
- [Multi-Whale Signals](#7-multi-whale-signals)
- [Sell Configuration](#8-sell-configuration)
- [Anti-Front-Running](#9-anti-front-running)
- [Losing Streak Cooldown](#10-losing-streak-cooldown)
- [Target Wallets](#11-target-wallets)
- [Logging & Files](#12-logging--files)
- [Polymarket Endpoints](#13-polymarket-endpoints)

---

## .env File (Secrets)

> Never commit this file. Use `.env.example` as a template.

| Variable | Required | Example | Description |
|----------|----------|---------|-------------|
| `PRIVATE_KEY` | **YES for live** | `0xabc...def` | Your Polygon wallet private key (64 hex chars). Needed to sign orders. Not needed in dry-run. |
| `WSS_URL` | **YES** | `wss://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY` | WebSocket RPC endpoint for real-time OrderFilled events. Get a free one from Alchemy, Infura, or QuickNode. This is how the bot hears whale trades. |
| `RPC_URL` | No | `https://polygon-rpc.com` | HTTP fallback if WSS is unavailable. WSS is strongly preferred (faster). |
| `DRY_RUN` | No | `true` / `false` | `true` = simulate trades (no real money). Default is `true` unless `LIVE_MODE=1`. |
| `LIVE_MODE` | No | `1` | Set to `1` to enable real trading. Same as `DRY_RUN=false`. |
| `KILL_SWITCH` | No | `0` or `1` | Emergency stop. Set to `1` and restart — all new trades halt immediately. Existing exit-manager still protects open positions. |
| `FUNDER_ADDRESS` | Only for proxy wallets | `0x...` | Required if using Magic or Safe signature type (`SIGNATURE_TYPE=1` or `2`). This is the actual funding address. |
| `SIGNATURE_TYPE` | No | `0` | `0` = normal EOA wallet (default), `1` = Magic Login, `2` = Safe multisig. Use `0` unless you know otherwise. |
| `TEST_ADDRESS` | No | `0xWhaleAddress` | Overrides the target whale address in config. Quick way to change whale without editing `config.js`. |
| `MAX_DAILY_USDC` | No | `100` | Max total USDC spent on BUYs per day. |
| `MAX_POSITION_USDC` | No | `50` | Max cost basis per single token position. |
| `MAX_TRADE_USDC` | No | `25` | Max USDC risked on a single trade. |
| `MIN_BALANCE_USDC` | No | `20` | Stop buying if wallet USDC balance drops below this. Keeps gas/emergency money. |
| `MAX_DAILY_DRAWDOWN_USDC` | No | `30` | Halt all BUYs if daily realized losses exceed this. |
| `LOG_LEVEL` | No | `info` | `debug` / `info` / `warn` / `error` |
| `WEBHOOK_URL` | No | `https://discord.com/api/webhooks/...` | Send trade notifications to Discord/Slack/etc. Leave empty to disable. |

---

## 1. Core Trading

| Setting | Default | Range | Description |
|---------|---------|-------|-------------|
| `slippage` | `0.05` (5%) | 0.01 – 0.50 | Max price tolerance for worst-price protection. Higher = more fills but worse prices. Lower = fewer fills but better prices. |
| `maxPriceDrift` | `0.10` (10%) | 0.01 – 0.50 | Skip the trade entirely if market already moved >10% since the whale's fill. Protects from chasing stale signals. Example: whale bought at $0.50, now $0.56 (+12%) = skip. |
| `cooldownMs` | `30000` (30s) | 0+ | After copying a trade on token X from whale A, wait 30s before copying another trade on the same token from the same whale. Prevents rapid-fire duplicates. |
| `minOrderUsdc` | `1` | 0+ | Skip trades smaller than $1. Filters out dust/noise. |
| `txBatchWindowMs` | `500` (500ms) | 0 – 2000 | How long to wait for more fills from the same transaction before processing. WSS delivers fills from one tx ~200–350ms apart. 500ms catches them all. Lower = faster reaction but may split same-tx fills. |
| `orderMode` | `'fak'` | `'fak'` / `'gtc'` | `fak` = Fill-and-Kill (market order, instant, partial fills OK). `gtc` = Good-til-Cancel (limit order, better price, may not fill). Use `fak` for speed, `gtc` for better entries on liquid markets. |
| `gtcOffsetPct` | `0.01` (1%) | 0 – 0.05 | GTC mode only. Places limit order 1% better than mid (buy lower, sell higher). |
| `gtcTimeoutMs` | `15000` (15s) | 5000 – 60000 | GTC mode only. Cancel unfilled limit order after 15s and fall back to FAK. |
| `useSmartRouting` | `true` | true / false | Compare direct token vs complementary token (YES / NO) for better fill price. If buying YES at $0.82, check if selling NO at $0.18 is cheaper. Free improvement — keep ON. |

---

## 2. Smart Entry Filters

> These are the most important settings for profitability. They prevent you from taking bad trades.

| Setting | Default | Range | Description |
|---------|---------|-------|-------------|
| `maxBuyPrice` | `0.92` | 0.50 – 0.99 | **Don't buy above this price.** At $0.92, max upside is only 8 cents but downside could be 92 cents. This is your #1 protection against overpaying. Lower = more selective, higher = copies more trades. |
| `minSellPrice` | `0.08` | 0.01 – 0.50 | **Don't sell below this price.** At $0.08, you'd lock in a ~92% loss for 8 cents. Better to hold and hope for recovery. |
| `maxSpreadPct` | `0.08` (8%) | 0.01 – 0.20 | Skip markets where bid-ask spread is >8%. Wide spread = illiquid = bad fills. Lower = pickier, fewer bad fills. |
| `minBookDepthUsdc` | `50` | 0+ | Skip if the orderbook has <$50 on the relevant side. Not enough liquidity to fill your order without heavy slippage. |
| `minExpiryHours` | `24` | 0+ | **Skip markets expiring in less than this many hours.** Set to `0` to copy short-term (5-minute) markets. Set to `24` for longer-term only. This is why short-term whale trades get skipped. |

---

## 3. Risk Controls

> Protect your bankroll from catastrophic loss.

| Setting | Default | Range | Description |
|---------|---------|-------|-------------|
| `maxDailyUsdc` | `100` (env) | 0+ | Total BUY spend cap per day. Resets at midnight UTC. When hit, no more buys until tomorrow. Size this to what you can afford to lose in a day. |
| `maxOpenPositions` | `10` | 0+ | Max number of different tokens held simultaneously. Prevents over-diversification. |
| `maxPositionUsdc` | `50` (env) | 0+ | Max cost basis per single position. Won't buy more of a token once you've spent this much on it. |
| `maxTradeUsdc` | `25` (env) | 0+ | Cap on any single trade. Even if the copy ratio says $40, caps it at $25. Your single-trade max risk. |
| `maxPortfolioExposurePct` | `0.80` (80%) | 0.01 – 1.0 | Max percentage of your bankroll (balance + positions) in open positions. At 80%, keeps 20% in cash. |
| `minBalanceUsdc` | `20` (env) | 0+ | Stop buying if wallet USDC balance drops below this. Keeps gas/emergency money. |
| `enableDrawdownBreaker` | `true` | true / false | Circuit breaker. If daily realized losses exceed `maxDailyDrawdownUsdc`, halt ALL buys for the rest of the day. Exit manager still runs to protect existing positions. |
| `maxDailyDrawdownUsdc` | `30` (env) | 0+ | Drawdown threshold. $30 of losses in one day = stop buying. |

---

## 4. Auto-Exit System

> The most important system for not losing money. Without auto-exits, losing positions bleed forever.

| Setting | Default | Range | Description |
|---------|---------|-------|-------------|
| `enableAutoExit` | `true` | true / false | Master switch for all auto-exit logic. **Keep ON.** |
| `exitCheckIntervalMs` | `30000` (30s) | 10000 – 300000 | How often to check all positions for exit conditions. |

### Stop-Loss

| Setting | Default | Range | Description |
|---------|---------|-------|-------------|
| `stopLossPct` | `-0.20` (-20%) | -0.50 – 0 | Cut losses at -20%. If position drops 20% from cost basis, sell everything. Tighter = less damage per loss but more false exits. |

### Take-Profit

| Setting | Default | Range | Description |
|---------|---------|-------|-------------|
| `takeProfitPct` | `0.40` (+40%) | 0.10 – 5.0 | Lock in gains at +40%. When position is up 40%, sell everything. Lower = take money sooner, higher = let winners run. |

### Trailing Stop

| Setting | Default | Range | Description |
|---------|---------|-------|-------------|
| `enableTrailingStop` | `true` | true / false | Once in profit, track the highest value and exit if it drops from the peak. Lets winners run further while protecting gains. |
| `trailingStopPct` | `0.12` (12%) | 0.05 – 0.30 | If price drops 12% from its highest point (while in profit), sell. Tighter = locks more profit but triggers more often. |

### Profit Ratchet

| Setting | Default | Range | Description |
|---------|---------|-------|-------------|
| `enableProfitRatchet` | `true` | true / false | Once position is up past threshold, NEVER let it go negative — floor is locked. |
| `ratchetThreshold` | `0.15` (+15%) | 0.05 – 0.50 | Activate the ratchet at +15% profit. |
| `ratchetFloor` | `0.02` (+2%) | 0 – ratchetThreshold | Once active, exit if profit drops to +2%. You NEVER go negative on this position. |

### Time-Based Exit

| Setting | Default | Range | Description |
|---------|---------|-------|-------------|
| `enableTimeExit` | `true` | true / false | Exit positions that haven't moved in a long time (dead capital). |
| `timeExitHours` | `72` (3 days) | 1+ | If price hasn't moved significantly in 72 hours, sell. Market is dead — free up capital. |
| `timeExitMinMovePct` | `0.05` (5%) | 0.01 – 0.20 | What counts as "significant movement". <5% movement doesn't reset the stale clock. |

### EV-Based Exit

| Setting | Default | Range | Description |
|---------|---------|-------|-------------|
| `enableEvExit` | `true` | true / false | Exit positions near extreme prices where expected value is poor. |
| `evExitMaxPrice` | `0.95` | 0.90 – 0.99 | If holding and price > $0.95, sell. Only 5 cents upside left — lock the profit. |
| `evExitMinPrice` | `0.05` | 0.01 – 0.10 | If holding and price < $0.05 (and already losing >10%), sell. Salvage what's left. |

---

## 5. Whale Performance Tracking

> Automatically copy more from winning whales, less from losing whales.

| Setting | Default | Range | Description |
|---------|---------|-------|-------------|
| `enableWhaleTracking` | `true` | true / false | Track each whale's win rate and auto-adjust sizing. Big edge — keep ON. |
| `whaleTrackWindowMs` | 30 days | — | Rolling window for performance calculation. |
| `whaleMinTrades` | `5` | 1+ | Don't adjust sizing until whale has 5+ tracked trades (not enough data before that). |
| `whaleMinMultiplier` | `0.1` | 0 – 1.0 | Floor: even terrible whales still get 10% of base copyRatio. Never fully stops copying. |
| `whaleMaxMultiplier` | `3.0` | 1.0 – 10.0 | Ceiling: even amazing whales get max 3x base copyRatio. |
| `enableKellySizing` | `true` | true / false | Use Kelly Criterion (mathematically optimal sizing) based on whale's proven edge. Negative-edge whales get minimal allocation. |

---

## 6. Edge & Quality Filters

| Setting | Default | Range | Description |
|---------|---------|-------|-------------|
| `enableEdgeFilter` | `true` | true / false | Only take trades with a positive composite edge score. Combines whale quality + spread + depth + signal strength + market quality. |
| `minEdgeScore` | `0.3` | 0 – 1.0 | Minimum edge score. Higher = more selective. `0.3` is moderate, `0.5` is strict. |
| `enableMarketQuality` | `true` | true / false | Skip low-quality markets (low volume, thin books). |
| `minMarketVolume` | `5000` | 0+ | Skip markets with less than $5000 total volume. |

---

## 7. Multi-Whale Signals

> When multiple tracked whales buy the same token, it's a stronger signal — increase size.

| Setting | Default | Range | Description |
|---------|---------|-------|-------------|
| `signalWindowMs` | `300000` (5 min) | 60000+ | Time window to detect convergence. If 2+ whales buy the same token within this window, boost size. |
| `signalBoostRatio` | `1.5` | 1.0 – 3.0 | Each additional whale multiplies copy ratio by 1.5x. 2 whales = 1.5x, 3 whales = 2.25x. |
| `signalMaxBoost` | `3.0` | 1.0 – 10.0 | Cap the total boost multiplier. |

---

## 8. Sell Configuration

| Setting | Default | Options | Description |
|---------|---------|---------|-------------|
| `copySells` | `true` | true / false | Copy whale sells too (not just buys). Keep ON — if the whale exits, you should too. |
| `sellMode` | `'all'` | `'all'` / `'proportional'` / `'ratio'` | `all` = sell entire position when whale sells (safest). `proportional` = sell same percentage the whale sold. `ratio` = sell (whale shares x copyRatio). |
| `sellOnlyIfHeld` | `true` | true / false | Don't try to sell tokens you don't own. Keep ON. |

Each target can override `sellMode` and `copySells` individually (see Target Wallets below).

---

## 9. Anti-Front-Running

| Setting | Default | Range | Description |
|---------|---------|-------|-------------|
| `enableAntiSnipe` | `true` | true / false | Add random delay before placing orders. Prevents MEV bots from detecting your copy pattern. |
| `antiSnipeMaxMs` | `500` | 0 – 5000 | Random delay between 0 and 500ms. Lower = faster execution, higher = more stealth. For copy trading, speed matters more — keep low. |

---

## 10. Losing Streak Cooldown

| Setting | Default | Range | Description |
|---------|---------|-------|-------------|
| `enableStreakCooldown` | `true` | true / false | Pause copying a specific whale after consecutive losses. |
| `maxLosingStreak` | `3` | 1+ | After 3 consecutive losing trades from one whale, pause copying them. |
| `streakCooldownMs` | `3600000` (1 hour) | 60000+ | How long to pause. After 1 hour, resume copying. |

---

## 11. Target Wallets

Define which whale wallets to copy. Add multiple entries to track several whales.

```js
targets: [
    {
        address:   '0xbd77b83d...',   // whale's Polygon wallet (lowercase)
        label:     'MyWhale',         // display name in logs
        copyRatio: 0.05,              // copy 5% of whale's trade size
        maxUsdc:   25,                // cap at $25 per trade for this whale
        sellMode:  'all',             // per-whale override (optional)
        copySells: true,              // per-whale override (optional)
    },
    {
        address:   '0xanother...',
        label:     'Whale2',
        copyRatio: 0.10,
        maxUsdc:   50,
    },
]
```

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `address` | **YES** | — | Whale's Polygon wallet address. Must be lowercase `0x` + 40 hex chars. |
| `label` | No | First 10 chars of address | Display name shown in all log output. |
| `copyRatio` | No | `1.0` | Fraction of whale's trade size to copy. `0.05` = 5%. If whale spends $1000, you spend $50. |
| `maxUsdc` | No | `50` | Per-trade USDC cap for this whale. Overrides global sizing if lower. |
| `sellMode` | No | Global `sellMode` | Per-whale sell strategy: `'all'`, `'proportional'`, or `'ratio'`. |
| `copySells` | No | Global `copySells` | Per-whale toggle for copying sells. |

You can also set `TEST_ADDRESS` in `.env` to quickly override the target without editing `config.js`.

---

## 12. Logging & Files

| Setting | Default | Description |
|---------|---------|-------------|
| `logLevel` | `'info'` (env) | `debug` = everything, `info` = normal, `warn` = problems only, `error` = critical only. |
| `logFile` | `'data/trades.jsonl'` | Structured trade log (one JSON per line). |
| `logMaxBytes` | `10485760` (10 MB) | Rotate log file after 10 MB. |
| `webhookUrl` | `''` (env) | Discord/Slack webhook URL for notifications. |
| `positionFile` | `'data/positions.json'` | Persisted position state across restarts. |
| `statsFile` | `'data/stats.json'` | Persisted stats (event counts, fill counts). |
| `healthFile` | `'data/health.json'` | Health status for external monitoring. |
| `whaleTrackFile` | `'data/whale-tracker.json'` | Persisted whale performance records. |
| `syncPositionsOnStart` | `true` | On startup, sync positions from chain API to detect manual trades. |
| `enablePerfTiming` | `true` | Log signal-to-order latency (ms) after each trade. |
| `watchdogIntervalMs` | `60000` (1 min) | How often to check WSS connection health. |
| `watchdogMaxSilenceMs` | `300000` (5 min) | Reconnect WSS if no events received in 5 minutes. |

---

## 13. Polymarket Endpoints

> Do not change these unless Polymarket migrates.

| Setting | Default | Description |
|---------|---------|-------------|
| `clobHost` | `https://clob.polymarket.com` | CLOB API (orders, midpoint, orderbook). |
| `clobWss` | `wss://ws-subscriptions-clob.polymarket.com/ws/market` | CLOB WebSocket (not used by this bot — we use on-chain events). |
| `gammaHost` | `https://gamma-api.polymarket.com` | Gamma API (market metadata, conditions). |
| `dataApiHost` | `https://data-api.polymarket.com` | Data API (positions, balance, activity). |
| `chainId` | `137` | Polygon mainnet chain ID. |

---

## Market Filters

| Setting | Default | Description |
|---------|---------|-------------|
| `marketBlocklist` | `[]` | Array of condition IDs or token IDs to never trade. |
| `marketAllowlist` | `[]` | If non-empty, ONLY trade markets in this list. |

---

## Quick Start Examples

### Conservative (small account, $100–500)

```env
PRIVATE_KEY=0x...
WSS_URL=wss://...
MAX_DAILY_USDC=50
MAX_TRADE_USDC=10
MAX_POSITION_USDC=25
MIN_BALANCE_USDC=30
MAX_DAILY_DRAWDOWN_USDC=20
```

### Aggressive (larger account, $1000+)

```env
PRIVATE_KEY=0x...
WSS_URL=wss://...
LIVE_MODE=1
MAX_DAILY_USDC=500
MAX_TRADE_USDC=100
MAX_POSITION_USDC=200
MIN_BALANCE_USDC=50
MAX_DAILY_DRAWDOWN_USDC=150
```

### 5-Minute Market Whale (short-term)

Set `minExpiryHours: 0` in `config.js` to copy short-expiry markets.

### Multiple Whales

```js
targets: [
    { address: '0xwhale1...', label: 'BigFish',   copyRatio: 0.10, maxUsdc: 50 },
    { address: '0xwhale2...', label: 'SharpGuy',  copyRatio: 0.05, maxUsdc: 25 },
    { address: '0xwhale3...', label: 'Degen',     copyRatio: 0.02, maxUsdc: 10, copySells: false },
]
```
