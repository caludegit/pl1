// src/config.js — Configuration with env-var support & deep validation
//
// OPTIMIZED FOR: Polymarket "Bitcoin Up or Down - 5 Minutes" markets
//
// These markets resolve every 5 minutes (288/day), are binary (Up/Down),
// use standard CTF Exchange, have low per-window liquidity, and are
// resolved via Chainlink BTC/USD data stream. Every parameter below has
// been tuned for this ultra-short-duration market type.
//
// All secrets are read from environment variables first, then fall back to
// the values below.  NEVER commit real keys — use .env or export vars.
//
// Usage:
//   PRIVATE_KEY=0x... WSS_URL=wss://... node src/index.js
//   # or just create a .env file (auto-loaded)

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ── Minimal .env loader (no external dependency) ─────────────────────────────
function loadEnvFile() {
    try {
        const envPath = resolve(process.cwd(), '.env');
        const content = readFileSync(envPath, 'utf-8');
        for (const line of content.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const eqIdx = trimmed.indexOf('=');
            if (eqIdx < 0) continue;
            const key = trimmed.slice(0, eqIdx).trim();
            let val = trimmed.slice(eqIdx + 1).trim();
            // Strip surrounding quotes
            if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                val = val.slice(1, -1);
            }
            // Only set if not already defined (real env vars take precedence)
            if (!(key in process.env)) {
                process.env[key] = val;
            }
        }
    } catch {
        // No .env file — that's fine, use env vars directly
    }
}
loadEnvFile();

const env = process.env;

const config = {

    // ── Kill switch — set KILL_SWITCH=1 to immediately halt all new trades ───
    killSwitch:    env.KILL_SWITCH === '1' || env.KILL_SWITCH === 'true',

    // ── Wallet (secrets — use env vars!) ──────────────────────────────────────
    privateKey:    env.PRIVATE_KEY    || '',
    funderAddress: env.FUNDER_ADDRESS || '',
    signatureType: parseInt(env.SIGNATURE_TYPE || '0', 10),  // 0=EOA, 1=Magic, 2=Safe
    wssUrl:        env.WSS_URL        || '',
    rpcUrl:        env.RPC_URL        || 'https://polygon-rpc.com',

    // ══════════════════════════════════════════════════════════════════════════
    //  CORE TRADING — tuned for 5-minute binary BTC markets
    // ══════════════════════════════════════════════════════════════════════════

    slippage:        0.03,       // 3% — tighter than default; 5-min markets have predictable
                                 //       spreads and we need to minimize cost on many small trades
    maxPriceDrift:   0.05,       // 5% — halved from 10%; in a 5-min window prices shouldn't
                                 //       drift far. If they did, the signal is stale.
    cooldownMs:      5_000,      // 5s — aggressively reduced from 30s. Markets only last 5 min,
                                 //       so 30s cooldown would block follow-up trades entirely.
    minOrderUsdc:    1,          // $1 minimum — keep low to allow fractional copy sizing
    txBatchWindowMs: 300,        // 300ms — slightly tighter batching; 5-min markets need speed
    watchdogIntervalMs: 30_000,  // 30s — check health more often (fast markets = fast failures)
    watchdogMaxSilenceMs: 120_000, // 2 min — alert sooner; with 288 markets/day silence is unusual
    dryRun:          (env.DRY_RUN === 'false' || env.DRY_RUN === '0')
                         ? false
                         : (env.DRY_RUN === 'true' || env.DRY_RUN === '1')
                             ? true
                             : env.LIVE_MODE !== '1',
    enablePerfTiming: true,

    // ══════════════════════════════════════════════════════════════════════════
    //  SMART ENTRY FILTERS — relaxed for 5-min binary markets
    // ══════════════════════════════════════════════════════════════════════════

    // Price bounds — wider range for 5-min markets since they're pure coin-flip
    // bets near 0.50. Whales buying at 0.60-0.70 is a strong directional signal.
    maxBuyPrice:     0.95,       // raised from 0.92 — even at $0.95, whale conviction at this
                                 //       price in a 5-min window means they're very confident
    minSellPrice:    0.05,       // lowered from 0.08 — let the exit manager handle bad positions

    // Spread filter — relaxed for low-liquidity 5-min windows
    maxSpreadPct:    0.12,       // raised from 0.08 — 5-min markets are inherently wider.
                                 //       Filtering at 8% would skip most opportunities.
    // Book depth — much lower for 5-min windows (small individual market liquidity)
    minBookDepthUsdc: 10,        // reduced from $50 — individual 5-min BTC markets have thin
                                 //       books. We're placing small orders ($5-25) so $10 depth
                                 //       is sufficient to fill without major slippage.

    // ══════════════════════════════════════════════════════════════════════════
    //  ORDER EXECUTION — speed optimized for ultra-short markets
    // ══════════════════════════════════════════════════════════════════════════

    orderMode:       'fak',      // FAK only — GTC is pointless for 5-min markets.
                                 //   The market resolves before a limit order could fill.
    gtcOffsetPct:    0.01,       // (unused with FAK, kept for compatibility)
    gtcTimeoutMs:    5_000,      // (unused with FAK, reduced just in case)
    useSmartRouting: true,       // keep enabled — Up/Down complement routing saves on spread

    // ══════════════════════════════════════════════════════════════════════════
    //  MULTI-WHALE SIGNAL DETECTION — tighter window for 5-min markets
    // ══════════════════════════════════════════════════════════════════════════

    signalWindowMs:    180_000,  // 3 min — reduced from 5 min. In a 5-min market, convergence
                                 //   must happen fast to be actionable before resolution.
    signalBoostRatio:  1.5,      // 1.5x per additional whale — same as default (proven good)
    signalMaxBoost:    3.0,      // 3x cap — same as default

    // ══════════════════════════════════════════════════════════════════════════
    //  AUTO EXIT — aggressive for 5-min resolution cycle
    // ══════════════════════════════════════════════════════════════════════════

    enableAutoExit:    true,
    stopLossPct:       -0.15,    // -15% — tighter than -20% default. In a 5-min binary,
                                 //   if you're down 15% the signal was wrong. Cut fast.
    takeProfitPct:     0.25,     // +25% — reduced from 40%. In 5-min markets, take quick
                                 //   profits. A move from $0.50→$0.625 is +25% and excellent.
    enableTrailingStop: true,
    trailingStopPct:   0.08,     // 8% — tighter from 12%. Fast markets reverse fast.
    exitCheckIntervalMs: 8_000,  // 8s — much faster than 30s default. With 5-min markets
                                 //   you need to react within seconds, not half a minute.

    // ── Profit ratchet — faster activation for quick markets ──────────
    enableProfitRatchet: true,
    ratchetThreshold:    0.10,   // +10% — lowered from 15%. Lock in profits sooner.
    ratchetFloor:        0.02,   // +2% minimum locked — same as default

    // ── Time-based exit — drastically shortened ──────────────────────
    enableTimeExit:      true,
    timeExitHours:       0.15,   // ~9 minutes — instead of 72 hours! If a 5-min market hasn't
                                 //   resolved and price is flat, free the capital immediately.
    timeExitMinMovePct:  0.03,   // 3% — tighter threshold for "hasn't moved"

    // ── EV-based exit — tuned for binary resolution at $0 or $1 ──────
    enableEvExit:        true,
    evExitMaxPrice:      0.93,   // sell if price > $0.93 — lock in gains near resolution
    evExitMinPrice:      0.07,   // sell if price < $0.07 — salvage before resolution to $0

    // ══════════════════════════════════════════════════════════════════════════
    //  RISK CONTROLS — conservative per-trade, aggressive daily volume
    // ══════════════════════════════════════════════════════════════════════════

    //  With 288 markets/day, you want higher daily cap but smaller per-trade size.
    //  Think of it as many small bets, not a few large ones.

    maxDailyUsdc:      parseInt(env.MAX_DAILY_USDC      || '200', 10),  // $200/day — doubled from $100.
                                 //   With 288 markets/day and small per-trade sizes, you need
                                 //   higher daily throughput to capture enough opportunities.
    maxOpenPositions:  20,       // 20 — doubled from 10. 5-min markets turn over fast,
                                 //   so you'll hold many concurrent positions briefly.
    maxPositionUsdc:   parseInt(env.MAX_POSITION_USDC   || '25',  10),  // $25 — halved from $50.
                                 //   Smaller per-position since these are coin-flip bets.
    minBalanceUsdc:    parseInt(env.MIN_BALANCE_USDC    || '30',  10),  // $30 — slightly higher reserve
                                 //   to ensure gas + margin for rapid trading.
    maxTradeUsdc:      parseInt(env.MAX_TRADE_USDC      || '15',  10),  // $15 — reduced from $25.
                                 //   Each 5-min bet should be small. Edge comes from volume,
                                 //   not from sizing up individual bets.
    maxPortfolioExposurePct: 0.70, // 70% — slightly tighter than 80%. Many small concurrent
                                 //   positions can add up fast.

    // ── Daily drawdown circuit breaker ────────────────────────────────────────
    enableDrawdownBreaker: true,
    maxDailyDrawdownUsdc:  parseInt(env.MAX_DAILY_DRAWDOWN_USDC || '50', 10),  // $50 — raised from $30.
                                 //   Higher because you'll have more trades/day. $30 would
                                 //   trip too easily with 288 markets worth of variance.

    // ── Market expiry filter — CRITICAL CHANGE ──────────────────────────────
    minExpiryHours:    0,        // ZERO — disabled! Default of 24h would skip ALL 5-min markets.
                                 //   These markets expire in 5 minutes by design.

    // ── Losing streak cooldown — faster recovery ─────────────────────────────
    enableStreakCooldown: true,
    maxLosingStreak:     5,      // 5 — raised from 3. With many small bets, 3 consecutive
                                 //   losses is expected variance, not a signal to stop.
    streakCooldownMs:    600_000, // 10 min — reduced from 1 hour. Missing 10 minutes of
                                 //   opportunity is enough cooling off.

    // ── Sell configuration ────────────────────────────────────────────────────
    copySells:      true,
    sellMode:       'all',       // exit full position when whale sells
    sellOnlyIfHeld: true,

    // ══════════════════════════════════════════════════════════════════════════
    //  WHALE PERFORMANCE TRACKING
    // ══════════════════════════════════════════════════════════════════════════

    enableWhaleTracking:  true,
    whaleTrackFile:       'data/whale-tracker.json',
    whaleTrackWindowMs:   7 * 24 * 60 * 60_000,  // 7-day rolling window — reduced from 30 days.
                                 //   BTC 5-min markets generate tons of data; 7 days gives
                                 //   enough signal while adapting to changing whale quality.
    whaleMinTrades:       10,    // 10 — raised from 5. With 288 markets/day, whales generate
                                 //   data fast. Require more evidence before adjusting.
    whaleMinMultiplier:   0.1,
    whaleMaxMultiplier:   3.0,
    enableKellySizing:    true,

    // ── Edge scoring — slightly relaxed for high-frequency markets ────────────
    enableEdgeFilter:     true,
    minEdgeScore:         0.20,  // lowered from 0.3. These are binary markets with inherently
                                 //   noisier edge signals. Being too selective means missing
                                 //   whale signals that are the whole point of copy trading.

    // ── Market quality filter — relaxed for 5-min windows ────────────────────
    enableMarketQuality:  true,
    minMarketVolume:      500,   // $500 — reduced from $5000. Individual 5-min BTC windows
                                 //   have lower volume than multi-day prediction markets.
                                 //   $500 filters out truly dead markets while allowing
                                 //   normal 5-min window liquidity through.

    // ── Anti-front-running — minimal delay for speed ─────────────────────────
    enableAntiSnipe:      true,
    antiSnipeMaxMs:       200,   // 200ms — reduced from 500ms. In a 5-min market, every
                                 //   second counts. 200ms adds enough jitter to avoid
                                 //   deterministic front-running without costing alpha.

    // ── Position tracking ─────────────────────────────────────────────────────
    syncPositionsOnStart: true,
    positionFile:        'data/positions.json',
    statsFile:           'data/stats.json',
    healthFile:          'data/health.json',

    // ── Logging ───────────────────────────────────────────────────────────────
    logLevel:     env.LOG_LEVEL || 'info',
    logFile:      'data/trades.jsonl',
    logMaxBytes:  10 * 1024 * 1024,
    webhookUrl:   env.WEBHOOK_URL || '',

    // ── Market filters ────────────────────────────────────────────────────────
    // Allowlist: Only copy trades on BTC Up/Down markets
    // Leave empty to copy all markets, or populate to restrict to BTC 5-min only.
    marketBlocklist: [],
    marketAllowlist: [],         // Tip: add keywords like 'Bitcoin', 'BTC' to restrict
                                 //   to BTC markets only if your whales trade other markets too.

    // ══════════════════════════════════════════════════════════════════════════
    //  WALLETS TO COPY — add your BTC 5-min whales here
    // ══════════════════════════════════════════════════════════════════════════
    //
    //  Finding good whales for BTC 5-min markets:
    //    1. Go to polymarket.com/activity and filter for BTC Up/Down markets
    //    2. Look for wallets with consistent high volume and positive P&L
    //    3. Check their win rate over 50+ trades (>55% is strong for binary)
    //    4. Use higher copyRatio for proven whales, lower for unproven
    //
    //  Recommended settings per whale for 5-min BTC:
    //    copyRatio: 0.02-0.08 (small bets, many trades)
    //    maxUsdc:   10-20 (cap per individual bet)
    //    sellMode:  'all' (exit fully when whale exits)

    targets: [
        ...(env.TEST_ADDRESS ? [{
            address:   env.TEST_ADDRESS,
            label:     'Test-Whale',
            copyRatio: 0.04,     // 4% — slightly lower ratio for frequent trading
            maxUsdc:   15,       // $15 cap — small bets for 5-min binary
            sellMode:  'all',
        }] : [{
            address:   '0xbd77b83d0c21a86b7a8d8ca324db089bc6e1dc7e',
            label:     'Demo-Whale',
            copyRatio: 0.04,
            maxUsdc:   15,
            sellMode:  'all',
        }]),
    ],

    // ── Test address (for npm test) ───────────────────────────────────────────
    testAddress: env.TEST_ADDRESS || '',

    // ── Polymarket endpoints (do not change) ──────────────────────────────────
    clobHost:    'https://clob.polymarket.com',
    clobWss:     'wss://ws-subscriptions-clob.polymarket.com/ws/market',
    gammaHost:   'https://gamma-api.polymarket.com',
    dataApiHost: 'https://data-api.polymarket.com',
    chainId:     137,
};

// ── Normalize targets ─────────────────────────────────────────────────────────
config.targets = config.targets.map(t => ({
    address:   (t.address || '').toLowerCase(),
    label:     t.label || t.address?.slice(0, 10) || '???',
    copyRatio: t.copyRatio ?? 1.0,
    maxUsdc:   t.maxUsdc   ?? 50,
    sellMode:  t.sellMode  || null,
    copySells: t.copySells ?? null,
}));

if (!config.testAddress && config.targets.length > 0) {
    config.testAddress = config.targets[0].address;
}

// ── Helpers to resolve per-target overrides ───────────────────────────────────
config.getSellMode = function (target) {
    return target.sellMode || this.sellMode;
};

config.shouldCopySells = function (target) {
    return target.copySells ?? this.copySells;
};

// ── Validation ────────────────────────────────────────────────────────────────
config.validate = function () {
    const errors = [];
    if (!this.dryRun && !this.privateKey)      errors.push('privateKey (or PRIVATE_KEY env) required for live mode');
    if (this.targets.length === 0)             errors.push('No targets configured');
    if (!this.wssUrl && !this.rpcUrl)          errors.push('Need at least rpcUrl (or WSS_URL / RPC_URL env)');
    if (this.slippage < 0 || this.slippage > 0.5) errors.push('slippage must be 0-0.5');
    if (!['ratio', 'proportional', 'all'].includes(this.sellMode)) {
        errors.push("sellMode must be 'ratio', 'proportional', or 'all'");
    }
    if (this.maxBuyPrice < 0.5 || this.maxBuyPrice > 0.99) errors.push('maxBuyPrice must be 0.5-0.99');
    if (this.minSellPrice < 0.01 || this.minSellPrice > 0.5) errors.push('minSellPrice must be 0.01-0.5');
    if (!['fak', 'gtc'].includes(this.orderMode)) errors.push("orderMode must be 'fak' or 'gtc'");
    if (this.maxPositionUsdc > 0 && this.maxDailyUsdc > 0 && this.maxPositionUsdc > this.maxDailyUsdc) {
        errors.push(`maxPositionUsdc ($${this.maxPositionUsdc}) should not exceed maxDailyUsdc ($${this.maxDailyUsdc})`);
    }
    if (this.maxTradeUsdc > 0 && this.maxDailyUsdc > 0 && this.maxTradeUsdc > this.maxDailyUsdc) {
        errors.push(`maxTradeUsdc ($${this.maxTradeUsdc}) should not exceed maxDailyUsdc ($${this.maxDailyUsdc})`);
    }
    if (this.maxPortfolioExposurePct <= 0 || this.maxPortfolioExposurePct > 1) {
        errors.push('maxPortfolioExposurePct must be 0-1');
    }
    if (this.enableDrawdownBreaker && this.maxDailyDrawdownUsdc <= 0) {
        errors.push('maxDailyDrawdownUsdc must be > 0 when drawdown breaker is enabled');
    }
    if (this.privateKey && !/^0x[0-9a-fA-F]{64}$/.test(this.privateKey)) {
        errors.push('privateKey must be a 0x-prefixed 64-character hex string');
    }
    if (this.maxBuyPrice <= this.minSellPrice) {
        errors.push(`maxBuyPrice ($${this.maxBuyPrice}) must be > minSellPrice ($${this.minSellPrice})`);
    }
    for (const t of this.targets) {
        if (!/^0x[0-9a-f]{40}$/.test(t.address)) errors.push(`Bad address for "${t.label}"`);
        if (t.copyRatio <= 0) errors.push(`copyRatio must be > 0 for "${t.label}"`);
        if (t.maxUsdc   <= 0) errors.push(`maxUsdc must be > 0 for "${t.label}"`);
        if (t.sellMode && !['ratio', 'proportional', 'all'].includes(t.sellMode)) {
            errors.push(`Bad sellMode "${t.sellMode}" for "${t.label}"`);
        }
    }
    return errors;
};

export default config;
