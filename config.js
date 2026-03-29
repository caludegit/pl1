// src/config.js — Configuration with env-var support & deep validation
//
// All secrets are read from environment variables first, then fall back to
// the values below.  NEVER commit real keys — use .env or export vars.
//
// Usage:
//   PRIVATE_KEY=0x... WSS_URL=wss://... node src/index.js
//   # or use a .env loader like dotenv-cli:
//   dotenv -- node src/index.js

const env = process.env;

const config = {

    // ── Wallet (secrets — use env vars!) ──────────────────────────────────────
    privateKey:    env.PRIVATE_KEY    || '',
    funderAddress: env.FUNDER_ADDRESS || '',
    signatureType: parseInt(env.SIGNATURE_TYPE || '0', 10),  // 0=EOA, 1=Magic, 2=Safe
    wssUrl:        env.WSS_URL        || '',
    rpcUrl:        env.RPC_URL        || 'https://polygon-rpc.com',

    // ── Core trading parameters ───────────────────────────────────────────────
    slippage:        0.05,       // 5%  worst-price tolerance
    maxPriceDrift:   0.10,       // 10% skip if market moved since whale fill
    cooldownMs:      30_000,     // 30s  between copies of same token+wallet
    minOrderUsdc:    1,          // skip trades below $1
    txBatchWindowMs: 400,        // ms to wait for partial fills in same tx
    dryRun:          env.LIVE_MODE === '1' ? false : true,

    // ── Smart entry filters (THE KEY TO MAKING MONEY) ─────────────────────────
    // Don't buy near the top — limited upside, high risk of loss
    maxBuyPrice:     0.92,       // skip BUY if mid price > 0.92 (only 8¢ upside)
    // Don't sell near the bottom — limited downside to save, lock in loss
    minSellPrice:    0.08,       // skip SELL if mid price < 0.08
    // Spread filter — skip illiquid markets with wide spreads
    maxSpreadPct:    0.08,       // skip if bid-ask spread > 8% (illiquid = bad fills)
    // Minimum book depth — skip if not enough liquidity to fill us
    minBookDepthUsdc: 50,        // skip if relevant book side has < $50 depth

    // ── Smart order execution ─────────────────────────────────────────────────
    // 'fak' = Fill-and-Kill (instant, partial fills OK)
    // 'gtc' = Good-til-Cancel limit order (better price, may not fill)
    orderMode:       'fak',      // 'fak' for speed, 'gtc' for better prices
    // For GTC mode: how far inside the spread to place limit orders
    gtcOffsetPct:    0.01,       // 1% better than mid (buy lower, sell higher)
    gtcTimeoutMs:    15_000,     // cancel unfilled GTC orders after 15s
    // Check complementary token (YES↔NO) for better fill price
    useSmartRouting: true,       // compare direct vs complementary execution

    // ── Multi-whale signal detection ──────────────────────────────────────────
    // When multiple tracked whales buy the same market, it's a stronger signal
    signalWindowMs:    300_000,  // 5 min window to detect convergence
    signalBoostRatio:  1.5,     // multiply copyRatio by 1.5x when 2+ whales agree
    signalMaxBoost:    3.0,     // cap the boost multiplier

    // ── Auto position management (stop-loss / take-profit / trailing stop) ─────
    enableAutoExit:    true,     // auto-manage positions
    stopLossPct:       -0.20,   // exit if position is down 20% (tighter = protect capital)
    takeProfitPct:     0.40,    // exit if position is up 40% (take profits sooner)
    enableTrailingStop: true,   // once in profit, track the high and exit on pullback
    trailingStopPct:   0.12,    // exit if price drops 12% from its high (tighter trailing)
    exitCheckIntervalMs: 30_000, // check positions every 30s (faster reaction)
    // ── Profit ratchet: once up X%, set floor at breakeven ───────────────
    enableProfitRatchet: true,   // once in profit past ratchetThreshold, never go negative
    ratchetThreshold:    0.15,   // activate ratchet at +15% profit
    ratchetFloor:        0.02,   // minimum +2% locked in once ratchet activates
    // ── Time-based exit: don't let capital sit in dead positions ──────────
    enableTimeExit:      true,   // exit stale positions
    timeExitHours:       72,     // exit if position hasn't moved >5% in 72 hours
    timeExitMinMovePct:  0.05,   // threshold for "hasn't moved"
    // ── EV-based exit: exit negative expected value positions early ───────
    enableEvExit:        true,   // exit if price is near extreme (low EV)
    evExitMaxPrice:      0.95,   // if holding and price > 0.95, sell (tiny upside left)
    evExitMinPrice:      0.05,   // if holding and price < 0.05, sell (likely total loss)

    // ── Risk controls ─────────────────────────────────────────────────────────
    maxDailyUsdc:      100,      // daily BUY spend cap
    maxOpenPositions:  10,       // max concurrent positions
    maxPositionUsdc:   50,       // max cost basis per position
    minBalanceUsdc:    20,       // reserve — stop buying if USDC balance < this

    // ── Sell configuration ────────────────────────────────────────────────────
    copySells:      true,        // copy target sells
    sellMode:       'all',       // exit full position when whale sells (safest)
    sellOnlyIfHeld: true,        // skip sell if we don't hold the token

    // ── Whale performance tracking (THE BIGGEST EDGE) ──────────────────────────
    enableWhaleTracking:  true,     // track whale win rates, auto-adjust sizing
    whaleTrackFile:       'data/whale-tracker.json',
    whaleTrackWindowMs:   30 * 24 * 60 * 60_000, // 30-day rolling window
    whaleMinTrades:       5,        // min trades before adjusting copy ratio
    whaleMinMultiplier:   0.1,      // floor: never completely stop copying
    whaleMaxMultiplier:   3.0,      // ceiling: never go above 3x base ratio
    enableKellySizing:    true,     // use Kelly criterion for position sizing

    // ── Edge scoring: minimum edge to take a trade ───────────────────────────
    enableEdgeFilter:     true,     // only copy trades with positive expected edge
    minEdgeScore:         0.3,      // 0-1 scale, higher = more selective (0.3 = moderate)

    // ── Market quality filter ────────────────────────────────────────────────
    enableMarketQuality:  true,     // skip low-quality markets
    minMarketVolume:      5000,     // skip markets with < $5000 total volume

    // ── Anti-front-running ───────────────────────────────────────────────────
    enableAntiSnipe:      true,     // add random delay to prevent being front-run
    antiSnipeMaxMs:       1500,     // random 0-1500ms delay before placing order

    // ── Position tracking ─────────────────────────────────────────────────────
    syncPositionsOnStart: true,
    positionFile:        'data/positions.json',
    statsFile:           'data/stats.json',
    healthFile:          'data/health.json',

    // ── Logging & notifications ───────────────────────────────────────────────
    logLevel:     'info',
    logFile:      'data/trades.jsonl',
    logMaxBytes:  10 * 1024 * 1024,
    webhookUrl:   env.WEBHOOK_URL || '',

    // ── Market filters ────────────────────────────────────────────────────────
    marketBlocklist: [],
    marketAllowlist: [],

    // ── Wallets to copy ───────────────────────────────────────────────────────
    targets: [
        // {
        //   address:   '0xABC...',
        //   label:     'Whale-Alpha',
        //   copyRatio: 0.05,         // copy 5% of whale's trade size
        //   maxUsdc:   25,           // max $25 per trade
        //   sellMode:  'all',
        // },
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
    if (this.slippage < 0 || this.slippage > 0.5) errors.push('slippage must be 0–0.5');
    if (!['ratio', 'proportional', 'all'].includes(this.sellMode)) {
        errors.push("sellMode must be 'ratio', 'proportional', or 'all'");
    }
    if (this.maxBuyPrice <= 0.5 || this.maxBuyPrice > 0.99) errors.push('maxBuyPrice must be 0.5–0.99');
    if (this.minSellPrice < 0.01 || this.minSellPrice >= 0.5) errors.push('minSellPrice must be 0.01–0.5');
    if (!['fak', 'gtc'].includes(this.orderMode)) errors.push("orderMode must be 'fak' or 'gtc'");
    if (this.maxPositionUsdc > 0 && this.maxDailyUsdc > 0 && this.maxPositionUsdc > this.maxDailyUsdc) {
        errors.push(`maxPositionUsdc ($${this.maxPositionUsdc}) should not exceed maxDailyUsdc ($${this.maxDailyUsdc})`);
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
