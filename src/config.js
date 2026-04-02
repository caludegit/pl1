// src/config.js — Configuration with env-var support, market profiles & deep validation
//
// PROFILE-BASED CONFIG: Set MARKET_PROFILE env var to switch between market types.
// Each profile overrides only what differs from the base defaults.
//
//   MARKET_PROFILE=btc-5m   node src/index.js   # Bitcoin Up/Down 5-min
//   MARKET_PROFILE=general  node src/index.js   # Standard prediction markets
//
// All secrets are read from environment variables first, then fall back to
// the values below.  NEVER commit real keys — use .env or export vars.

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
            if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                val = val.slice(1, -1);
            }
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


// ══════════════════════════════════════════════════════════════════════════════
//  MARKET PROFILES — each profile only overrides what differs from base
// ══════════════════════════════════════════════════════════════════════════════
//
//  To add a new profile:
//    1. Add an entry to PROFILES below with only the fields that differ
//    2. Set MARKET_PROFILE=your-profile-name in .env
//    3. Restart the bot — no other code changes needed
//
const PROFILES = {

    // ── Bitcoin Up or Down — 5 Minutes ──────────────────────────────────────
    // 288 markets/day, binary (Up/Down), CTF Exchange, Chainlink resolution.
    // Strategy: many small bets, fast turnover, speed over precision.
    'btc-5m': {
        // Core — speed is everything
        slippage:            0.03,    // 3% tighter; predictable 5-min spreads
        maxPriceDrift:       0.05,    // 5% halved; stale signal in 5-min window
        cooldownMs:          5_000,   // 5s; 30s would eat 10% of market lifetime
        txBatchWindowMs:     300,     // faster batching for speed
        watchdogIntervalMs:  30_000,  // check health more often
        watchdogMaxSilenceMs: 120_000, // alert sooner; 288 markets/day = busy

        // Entry filters — relaxed for thin 5-min liquidity
        maxBuyPrice:         0.95,    // whale conviction at $0.95 is meaningful
        minSellPrice:        0.05,    // let exit manager handle bad positions
        maxSpreadPct:        0.12,    // 5-min markets are inherently wider
        minBookDepthUsdc:    10,      // thin books, small orders ($5-15)

        // Execution — FAK only, GTC can't fill in 5 minutes
        orderMode:           'fak',
        gtcTimeoutMs:        5_000,

        // Multi-whale — tighter convergence window
        signalWindowMs:      180_000, // 3 min; must converge fast

        // Auto exit — aggressive for 5-min resolution cycle
        stopLossPct:         -0.15,   // -15%; wrong signal = cut fast
        takeProfitPct:       0.25,    // +25%; take quick profits
        trailingStopPct:     0.08,    // 8%; fast markets reverse fast
        exitCheckIntervalMs: 8_000,   // 8s; react in seconds not minutes
        ratchetThreshold:    0.10,    // +10%; lock profits sooner
        timeExitHours:       0.15,    // ~9 min; free stale capital fast
        timeExitMinMovePct:  0.03,    // 3% "hasn't moved" threshold
        evExitMaxPrice:      0.93,    // lock gains near resolution
        evExitMinPrice:      0.07,    // salvage before resolution to $0

        // Risk — many small bets, higher throughput
        maxDailyUsdc:        parseInt(env.MAX_DAILY_USDC     || '200', 10),
        maxOpenPositions:    20,      // fast turnover = more concurrent
        maxPositionUsdc:     parseInt(env.MAX_POSITION_USDC  || '25',  10),
        minBalanceUsdc:      parseInt(env.MIN_BALANCE_USDC   || '30',  10),
        maxTradeUsdc:        parseInt(env.MAX_TRADE_USDC     || '15',  10),
        maxPortfolioExposurePct: 0.70,
        maxDailyDrawdownUsdc: parseInt(env.MAX_DAILY_DRAWDOWN_USDC || '50', 10),
        minExpiryHours:      0,       // CRITICAL: 24h default would skip ALL 5-min markets
        maxLosingStreak:     5,       // 3 losses is normal variance here
        streakCooldownMs:    600_000, // 10 min; don't miss too much

        // Whale tracking — faster adaptation
        whaleTrackWindowMs:  7 * 24 * 60 * 60_000, // 7-day window (tons of data)
        whaleMinTrades:      10,      // require more evidence before adjusting

        // Filters — relaxed for high-frequency binary markets
        minEdgeScore:        0.20,    // noisier signals, don't over-filter
        minMarketVolume:     500,     // individual 5-min windows are thin
        antiSnipeMaxMs:      200,     // speed > stealth

        // Target defaults
        _targetDefaults: { copyRatio: 0.04, maxUsdc: 15 },
    },

    // ── Bitcoin Up or Down — 1 Minute ───────────────────────────────────────
    // Even faster: 1,440 markets/day. Maximum speed, minimum size.
    'btc-1m': {
        slippage:            0.02,
        maxPriceDrift:       0.03,
        cooldownMs:          2_000,   // 2s; markets last only 60 seconds
        txBatchWindowMs:     200,
        watchdogIntervalMs:  15_000,
        watchdogMaxSilenceMs: 60_000,

        maxBuyPrice:         0.95,
        minSellPrice:        0.05,
        maxSpreadPct:        0.15,    // even wider for 1-min windows
        minBookDepthUsdc:    5,       // ultra-thin books

        orderMode:           'fak',
        signalWindowMs:      60_000,  // 1 min convergence window

        stopLossPct:         -0.12,
        takeProfitPct:       0.20,
        trailingStopPct:     0.06,
        exitCheckIntervalMs: 5_000,   // 5s checks
        ratchetThreshold:    0.08,
        timeExitHours:       0.05,    // ~3 min
        timeExitMinMovePct:  0.02,
        evExitMaxPrice:      0.93,
        evExitMinPrice:      0.07,

        maxDailyUsdc:        parseInt(env.MAX_DAILY_USDC     || '250', 10),
        maxOpenPositions:    30,
        maxPositionUsdc:     parseInt(env.MAX_POSITION_USDC  || '15',  10),
        minBalanceUsdc:      parseInt(env.MIN_BALANCE_USDC   || '30',  10),
        maxTradeUsdc:        parseInt(env.MAX_TRADE_USDC     || '10',  10),
        maxPortfolioExposurePct: 0.60,
        maxDailyDrawdownUsdc: parseInt(env.MAX_DAILY_DRAWDOWN_USDC || '60', 10),
        minExpiryHours:      0,
        maxLosingStreak:     7,
        streakCooldownMs:    300_000, // 5 min cooldown

        whaleTrackWindowMs:  3 * 24 * 60 * 60_000, // 3-day window
        whaleMinTrades:      20,

        minEdgeScore:        0.15,
        minMarketVolume:     200,
        antiSnipeMaxMs:      100,

        _targetDefaults: { copyRatio: 0.03, maxUsdc: 10 },
    },

    // ── General prediction markets (politics, sports, events) ───────────────
    // Multi-day/week resolution, deeper liquidity, fewer markets.
    // This is the "original" default config.
    'general': {
        slippage:            0.05,
        maxPriceDrift:       0.10,
        cooldownMs:          30_000,
        txBatchWindowMs:     500,
        watchdogIntervalMs:  60_000,
        watchdogMaxSilenceMs: 300_000,

        maxBuyPrice:         0.92,
        minSellPrice:        0.08,
        maxSpreadPct:        0.08,
        minBookDepthUsdc:    50,

        orderMode:           'fak',
        gtcTimeoutMs:        15_000,
        signalWindowMs:      300_000,

        stopLossPct:         -0.20,
        takeProfitPct:       0.40,
        trailingStopPct:     0.12,
        exitCheckIntervalMs: 30_000,
        ratchetThreshold:    0.15,
        timeExitHours:       72,
        timeExitMinMovePct:  0.05,
        evExitMaxPrice:      0.95,
        evExitMinPrice:      0.05,

        maxDailyUsdc:        parseInt(env.MAX_DAILY_USDC     || '100', 10),
        maxOpenPositions:    10,
        maxPositionUsdc:     parseInt(env.MAX_POSITION_USDC  || '50',  10),
        minBalanceUsdc:      parseInt(env.MIN_BALANCE_USDC   || '20',  10),
        maxTradeUsdc:        parseInt(env.MAX_TRADE_USDC     || '25',  10),
        maxPortfolioExposurePct: 0.80,
        maxDailyDrawdownUsdc: parseInt(env.MAX_DAILY_DRAWDOWN_USDC || '30', 10),
        minExpiryHours:      24,
        maxLosingStreak:     3,
        streakCooldownMs:    3_600_000,

        whaleTrackWindowMs:  30 * 24 * 60 * 60_000,
        whaleMinTrades:      5,

        minEdgeScore:        0.30,
        minMarketVolume:     5000,
        antiSnipeMaxMs:      500,

        _targetDefaults: { copyRatio: 0.05, maxUsdc: 25 },
    },

    // ── Crypto hourly markets (BTC/ETH/SOL 1-hour) ─────────────────────────
    // 24 markets/day per asset. Medium frequency, moderate liquidity.
    'crypto-1h': {
        slippage:            0.04,
        maxPriceDrift:       0.07,
        cooldownMs:          15_000,
        txBatchWindowMs:     400,
        watchdogIntervalMs:  45_000,
        watchdogMaxSilenceMs: 180_000,

        maxBuyPrice:         0.93,
        minSellPrice:        0.07,
        maxSpreadPct:        0.10,
        minBookDepthUsdc:    25,

        orderMode:           'fak',
        signalWindowMs:      300_000, // 5 min for 1-hour markets

        stopLossPct:         -0.18,
        takeProfitPct:       0.35,
        trailingStopPct:     0.10,
        exitCheckIntervalMs: 15_000,
        ratchetThreshold:    0.12,
        timeExitHours:       2,       // 2 hours stale threshold
        timeExitMinMovePct:  0.04,
        evExitMaxPrice:      0.94,
        evExitMinPrice:      0.06,

        maxDailyUsdc:        parseInt(env.MAX_DAILY_USDC     || '150', 10),
        maxOpenPositions:    15,
        maxPositionUsdc:     parseInt(env.MAX_POSITION_USDC  || '35',  10),
        minBalanceUsdc:      parseInt(env.MIN_BALANCE_USDC   || '25',  10),
        maxTradeUsdc:        parseInt(env.MAX_TRADE_USDC     || '20',  10),
        maxPortfolioExposurePct: 0.75,
        maxDailyDrawdownUsdc: parseInt(env.MAX_DAILY_DRAWDOWN_USDC || '40', 10),
        minExpiryHours:      0,
        maxLosingStreak:     4,
        streakCooldownMs:    1_800_000, // 30 min

        whaleTrackWindowMs:  14 * 24 * 60 * 60_000, // 14-day window
        whaleMinTrades:      8,

        minEdgeScore:        0.25,
        minMarketVolume:     2000,
        antiSnipeMaxMs:      300,

        _targetDefaults: { copyRatio: 0.04, maxUsdc: 20 },
    },
};

// ── Resolve which profile to use ─────────────────────────────────────────────
const profileName = (env.MARKET_PROFILE || 'btc-5m').toLowerCase().trim();
const profile = PROFILES[profileName];
if (!profile) {
    const available = Object.keys(PROFILES).join(', ');
    console.error(`[FATAL] Unknown MARKET_PROFILE="${profileName}". Available: ${available}`);
    process.exit(1);
}


// ══════════════════════════════════════════════════════════════════════════════
//  BASE CONFIG — sensible defaults, overridden by the active profile
// ══════════════════════════════════════════════════════════════════════════════

const config = {

    // ── Active profile name (for logging) ────────────────────────────────────
    marketProfile: profileName,

    // ── Kill switch ──────────────────────────────────────────────────────────
    killSwitch:    env.KILL_SWITCH === '1' || env.KILL_SWITCH === 'true',

    // ── Wallet (secrets — use env vars!) ─────────────────────────────────────
    privateKey:    env.PRIVATE_KEY    || '',
    funderAddress: env.FUNDER_ADDRESS || '',
    signatureType: parseInt(env.SIGNATURE_TYPE || '0', 10),
    wssUrl:        env.WSS_URL        || '',
    rpcUrl:        env.RPC_URL        || 'https://polygon-rpc.com',

    // ── Core trading ─────────────────────────────────────────────────────────
    slippage:            0.05,
    maxPriceDrift:       0.10,
    cooldownMs:          30_000,
    minOrderUsdc:        1,
    txBatchWindowMs:     500,
    watchdogIntervalMs:  60_000,
    watchdogMaxSilenceMs: 300_000,
    dryRun:              (env.DRY_RUN === 'false' || env.DRY_RUN === '0')
                             ? false
                             : (env.DRY_RUN === 'true' || env.DRY_RUN === '1')
                                 ? true
                                 : env.LIVE_MODE !== '1',
    enablePerfTiming:    true,

    // ── Smart entry filters ──────────────────────────────────────────────────
    maxBuyPrice:         0.92,
    minSellPrice:        0.08,
    maxSpreadPct:        0.08,
    minBookDepthUsdc:    50,

    // ── Order execution ──────────────────────────────────────────────────────
    orderMode:           'fak',
    gtcOffsetPct:        0.01,
    gtcTimeoutMs:        15_000,
    useSmartRouting:     true,

    // ── Multi-whale signal ───────────────────────────────────────────────────
    signalWindowMs:      300_000,
    signalBoostRatio:    1.5,
    signalMaxBoost:      3.0,

    // ── Auto exit ────────────────────────────────────────────────────────────
    enableAutoExit:      true,
    stopLossPct:         -0.20,
    takeProfitPct:       0.40,
    enableTrailingStop:  true,
    trailingStopPct:     0.12,
    exitCheckIntervalMs: 30_000,
    enableProfitRatchet: true,
    ratchetThreshold:    0.15,
    ratchetFloor:        0.02,
    enableTimeExit:      true,
    timeExitHours:       72,
    timeExitMinMovePct:  0.05,
    enableEvExit:        true,
    evExitMaxPrice:      0.95,
    evExitMinPrice:      0.05,

    // ── Risk controls ────────────────────────────────────────────────────────
    maxDailyUsdc:        parseInt(env.MAX_DAILY_USDC      || '100', 10),
    maxOpenPositions:    10,
    maxPositionUsdc:     parseInt(env.MAX_POSITION_USDC   || '50',  10),
    minBalanceUsdc:      parseInt(env.MIN_BALANCE_USDC    || '20',  10),
    maxTradeUsdc:        parseInt(env.MAX_TRADE_USDC      || '25',  10),
    maxPortfolioExposurePct: 0.80,
    enableDrawdownBreaker: true,
    maxDailyDrawdownUsdc: parseInt(env.MAX_DAILY_DRAWDOWN_USDC || '30', 10),
    minExpiryHours:      24,
    enableStreakCooldown: true,
    maxLosingStreak:     3,
    streakCooldownMs:    3_600_000,

    // ── Sell configuration ───────────────────────────────────────────────────
    copySells:           true,
    sellMode:            'all',
    sellOnlyIfHeld:      true,

    // ── Whale performance tracking ───────────────────────────────────────────
    enableWhaleTracking: true,
    whaleTrackFile:      'data/whale-tracker.json',
    whaleTrackWindowMs:  30 * 24 * 60 * 60_000,
    whaleMinTrades:      5,
    whaleMinMultiplier:  0.1,
    whaleMaxMultiplier:  3.0,
    enableKellySizing:   true,

    // ── Edge & quality filters ───────────────────────────────────────────────
    enableEdgeFilter:    true,
    minEdgeScore:        0.3,
    enableMarketQuality: true,
    minMarketVolume:     5000,

    // ── Anti-front-running ───────────────────────────────────────────────────
    enableAntiSnipe:     true,
    antiSnipeMaxMs:      500,

    // ── Position tracking ────────────────────────────────────────────────────
    syncPositionsOnStart: true,
    positionFile:        'data/positions.json',
    statsFile:           'data/stats.json',
    healthFile:          'data/health.json',

    // ── Logging ──────────────────────────────────────────────────────────────
    logLevel:            env.LOG_LEVEL || 'info',
    logFile:             'data/trades.jsonl',
    logMaxBytes:         10 * 1024 * 1024,
    webhookUrl:          env.WEBHOOK_URL || '',

    // ── Market filters ───────────────────────────────────────────────────────
    marketBlocklist:     [],
    marketAllowlist:     [],

    // ── Wallets to copy ──────────────────────────────────────────────────────
    targets: [
        ...(env.TEST_ADDRESS ? [{
            address:   env.TEST_ADDRESS,
            label:     'Test-Whale',
            copyRatio: 0.05,
            maxUsdc:   25,
            sellMode:  'all',
        }] : [{
            address:   '0xbd77b83d0c21a86b7a8d8ca324db089bc6e1dc7e',
            label:     'Demo-Whale',
            copyRatio: 0.05,
            maxUsdc:   25,
            sellMode:  'all',
        }]),
    ],

    testAddress: env.TEST_ADDRESS || '',

    // ── Polymarket endpoints (do not change) ─────────────────────────────────
    clobHost:    'https://clob.polymarket.com',
    clobWss:     'wss://ws-subscriptions-clob.polymarket.com/ws/market',
    gammaHost:   'https://gamma-api.polymarket.com',
    dataApiHost: 'https://data-api.polymarket.com',
    chainId:     137,
};


// ══════════════════════════════════════════════════════════════════════════════
//  APPLY PROFILE — merge profile overrides onto base config
// ══════════════════════════════════════════════════════════════════════════════

// Extract target defaults before merging (not a real config key)
const targetDefaults = profile._targetDefaults || {};

for (const [key, value] of Object.entries(profile)) {
    if (key === '_targetDefaults') continue;
    config[key] = value;
}

// Apply profile's target defaults if targets are still using base defaults
if (targetDefaults.copyRatio || targetDefaults.maxUsdc) {
    config.targets = config.targets.map(t => ({
        ...t,
        copyRatio: targetDefaults.copyRatio ?? t.copyRatio,
        maxUsdc:   targetDefaults.maxUsdc   ?? t.maxUsdc,
    }));
}


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
