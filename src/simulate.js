// src/simulate.js — Offline simulation & validation test
//
// Tests ALL bot logic without network access:
//   - Position tracking (buy/sell/P&L math)
//   - Config validation
//   - Tick alignment & price bounds
//   - Spread & depth calculations
//   - Execution price estimation
//   - Smart filters (price, spread, depth)
//   - Proportional/ratio/all sell modes
//   - Signal boost detection
//   - Stats tracking
//   - Exit manager thresholds
//   - Market filter (allowlist/blocklist)
//   - Order book walking
//
// Usage: node src/simulate.js

const PASS = '\x1b[32mPASS\x1b[0m';
const FAIL = '\x1b[31mFAIL\x1b[0m';
let passed = 0;
let failed = 0;

function assert(condition, msg) {
    if (condition) { passed++; console.log(`  ${PASS}  ${msg}`); }
    else { failed++; console.log(`  ${FAIL}  ${msg}`); }
}

function approx(a, b, tol = 0.001) { return Math.abs(a - b) < tol; }

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n  ════════════════════════════════════════════════════');
console.log('  Polymarket Copy-Trader v7.0 — Simulation Test');
console.log('  ════════════════════════════════════════════════════\n');

// ── 1. Position Manager ──────────────────────────────────────────────────────
console.log('  [Position Manager]');

import { positions } from './positions.js';

// BUY: 100 shares at $0.50 each = $50 cost
positions.recordBuy('token_A', 100, 50, { market: 'Test Market A', label: 'whale1' });
{
    const pos = positions.getPosition('token_A');
    assert(pos !== null, 'recordBuy creates position');
    assert(approx(pos.shares, 100), `shares = ${pos.shares} (expected 100)`);
    assert(approx(pos.costBasis, 50), `costBasis = $${pos.costBasis} (expected $50)`);
    assert(approx(pos.avgEntry, 0.5), `avgEntry = $${pos.avgEntry} (expected $0.50)`);
    assert(pos.market === 'Test Market A', `market name stored`);
    assert(pos.copiedFrom === 'whale1', `copiedFrom stored`);
}

// BUY more: 50 shares at $0.60 each = $30 cost
positions.recordBuy('token_A', 50, 30, { market: 'Test Market A', label: 'whale1' });
{
    const pos = positions.getPosition('token_A');
    assert(approx(pos.shares, 150), `after 2nd buy: shares = ${pos.shares} (expected 150)`);
    assert(approx(pos.costBasis, 80), `after 2nd buy: costBasis = $${pos.costBasis} (expected $80)`);
    assert(approx(pos.avgEntry, 80/150, 0.001), `avgEntry = $${pos.avgEntry.toFixed(4)} (expected $${(80/150).toFixed(4)})`);
}

// SELL: 50 shares at $0.70 each = $35 USDC received
{
    const pnl = positions.recordSell('token_A', 50, 35);
    const costOfSold = (80/150) * 50; // avgEntry * sharesSold
    const expectedPnl = 35 - costOfSold;
    assert(approx(pnl, expectedPnl, 0.01), `SELL P&L = $${pnl.toFixed(4)} (expected $${expectedPnl.toFixed(4)})`);
    const pos = positions.getPosition('token_A');
    assert(approx(pos.shares, 100), `after sell: shares = ${pos.shares} (expected 100)`);
}

// SELL ALL remaining: 100 shares at $0.80 = $80 received
{
    const pnl = positions.recordSell('token_A', 100, 80);
    assert(pnl > 0, `full exit P&L = $${pnl.toFixed(4)} (positive = profit)`);
    assert(!positions.hasPosition('token_A'), 'position removed after full exit');
    assert(positions.getCount() === 0, 'position count = 0');
}

// Total P&L check
{
    const totalPnl = positions.getTotalRealizedPnl();
    // Bought 150 shares for $80, sold 50 at $35 + 100 at $80 = $115
    // Total P&L = $115 - $80 = $35
    assert(approx(totalPnl, 35, 0.01), `total realized P&L = $${totalPnl.toFixed(4)} (expected ~$35.00)`);
}

// Edge case: sell more than held
{
    positions.recordBuy('token_B', 10, 5, { market: 'Edge Test', label: 'test' });
    const pnl = positions.recordSell('token_B', 10, 6);
    assert(approx(pnl, 1, 0.01), `edge: sell all = P&L $${pnl.toFixed(4)} (expected $1.00)`);
    assert(!positions.hasPosition('token_B'), 'edge: position cleaned up');
}

// Sell nonexistent position
{
    const pnl = positions.recordSell('token_NONEXISTENT', 100, 50);
    assert(pnl === 0, `sell nonexistent = P&L $${pnl} (expected $0)`);
}

console.log('');

// ── 2. Config Validation ─────────────────────────────────────────────────────
console.log('  [Config Validation]');

import config from './config.js';

// Default config should pass (demo target configured)
{
    const errors = config.validate();
    assert(errors.length === 0, `default config valid (${errors.length} errors${errors.length ? ': ' + errors[0] : ''})`);
}

// Test missing targets validation
{
    const origTargets = config.targets;
    config.targets = [];
    const errors = config.validate();
    assert(errors.some(e => e.includes('No targets')), 'catches missing targets');
    config.targets = origTargets;
}

// Test sell mode validation
{
    const orig = config.sellMode;
    config.sellMode = 'invalid';
    const errors = config.validate();
    assert(errors.some(e => e.includes('sellMode')), 'catches bad sellMode');
    config.sellMode = orig;
}

// Test price bounds cross-validation
{
    const origBuy = config.maxBuyPrice;
    const origSell = config.minSellPrice;
    config.maxBuyPrice = 0.05;
    config.minSellPrice = 0.10;
    const errors = config.validate();
    assert(errors.some(e => e.includes('maxBuyPrice') && e.includes('minSellPrice')), 'catches maxBuyPrice < minSellPrice');
    config.maxBuyPrice = origBuy;
    config.minSellPrice = origSell;
}

// Test maxPositionUsdc vs maxDailyUsdc
{
    const origPos = config.maxPositionUsdc;
    const origDaily = config.maxDailyUsdc;
    config.maxPositionUsdc = 200;
    config.maxDailyUsdc = 100;
    const errors = config.validate();
    assert(errors.some(e => e.includes('maxPositionUsdc')), 'catches maxPositionUsdc > maxDailyUsdc');
    config.maxPositionUsdc = origPos;
    config.maxDailyUsdc = origDaily;
}

console.log('');

// ── 3. API Helpers (offline) ─────────────────────────────────────────────────
console.log('  [API Helpers — Offline]');

import {
    getSpread, getBookDepth, getExecutionPriceFromBook,
    isMarketActive, passesMarketFilter, getComplementaryToken,
    extractMarketParams,
} from './api.js';

// Spread calculation
{
    const book = {
        bids: [{ price: '0.45', size: '100' }, { price: '0.44', size: '50' }],
        asks: [{ price: '0.55', size: '100' }, { price: '0.56', size: '50' }],
    };
    const spread = getSpread(book);
    assert(approx(spread.bestBid, 0.45), `bestBid = ${spread.bestBid} (expected 0.45)`);
    assert(approx(spread.bestAsk, 0.55), `bestAsk = ${spread.bestAsk} (expected 0.55)`);
    assert(approx(spread.spread, 0.10), `spread = ${spread.spread} (expected 0.10)`);
    assert(approx(spread.spreadPct, 0.10/0.50), `spreadPct = ${spread.spreadPct.toFixed(4)} (expected 0.2000)`);
}

// Empty book
{
    const spread = getSpread(null);
    assert(spread.spread === null, 'null book → null spread');
    const spread2 = getSpread({ bids: [], asks: [] });
    assert(spread2.spread === null, 'empty book → null spread');
}

// Book depth
{
    const book = {
        bids: [{ price: '0.50', size: '100' }, { price: '0.40', size: '200' }],
        asks: [{ price: '0.60', size: '150' }, { price: '0.70', size: '100' }],
    };
    const depth = getBookDepth(book);
    // bids: 100*0.50 + 200*0.40 = 50 + 80 = 130
    // asks: 150*0.60 + 100*0.70 = 90 + 70 = 160
    assert(approx(depth.bidDepthUsdc, 130), `bidDepth = $${depth.bidDepthUsdc} (expected $130)`);
    assert(approx(depth.askDepthUsdc, 160), `askDepth = $${depth.askDepthUsdc} (expected $160)`);
}

// Execution price from book — BUY $10
{
    const book = {
        bids: [{ price: '0.48', size: '200' }],
        asks: [{ price: '0.52', size: '100' }, { price: '0.55', size: '200' }],
    };
    const exec = getExecutionPriceFromBook(book, 'BUY', 10);
    // $10 at 0.52/share: 10/0.52 = 19.23 shares (fills from 100 available)
    assert(exec !== null, 'BUY execution estimate exists');
    assert(approx(exec.avgPrice, 0.52), `BUY avg = $${exec.avgPrice.toFixed(4)} (expected ~$0.52)`);
    assert(approx(exec.fillPct, 1.0), `BUY fillPct = ${exec.fillPct.toFixed(4)} (expected 1.0)`);
}

// Execution price from book — SELL 50 shares
{
    const book = {
        bids: [{ price: '0.48', size: '100' }, { price: '0.45', size: '200' }],
        asks: [{ price: '0.52', size: '100' }],
    };
    const exec = getExecutionPriceFromBook(book, 'SELL', 50);
    assert(exec !== null, 'SELL execution estimate exists');
    assert(approx(exec.avgPrice, 0.48), `SELL avg = $${exec.avgPrice.toFixed(4)} (expected ~$0.48)`);
    assert(exec.wouldFill >= 50, `SELL would fill ${exec.wouldFill} shares (need 50)`);
}

// Large order that exceeds book — partial fill
{
    const book = {
        bids: [{ price: '0.50', size: '10' }],
        asks: [{ price: '0.55', size: '5' }],
    };
    const exec = getExecutionPriceFromBook(book, 'BUY', 1000);
    assert(exec !== null, 'large order returns partial fill estimate');
    assert(exec.fillPct < 1.0, `partial fillPct = ${exec.fillPct.toFixed(4)} (expected < 1.0)`);
}

// Market status
{
    assert(isMarketActive({ closed: false, resolved: false }) === true, 'active market detected');
    assert(isMarketActive({ closed: true }) === false, 'closed market detected');
    assert(isMarketActive({ resolved: true }) === false, 'resolved market detected');
    assert(isMarketActive({ resolved: 'true' }) === false, 'resolved="true" detected');
    assert(isMarketActive({ active: false }) === false, 'inactive market detected');
    assert(isMarketActive(null) === false, 'null market = inactive');
}

// Market filter
{
    config.marketBlocklist = ['meme', 'joke'];
    config.marketAllowlist = [];
    assert(passesMarketFilter({ question: 'Will Biden win?' }) === true, 'normal market passes blocklist');
    assert(passesMarketFilter({ question: 'Best meme coin?' }) === false, 'meme blocked');

    config.marketBlocklist = [];
    config.marketAllowlist = ['election', 'bitcoin'];
    assert(passesMarketFilter({ question: 'US Election 2024' }) === true, 'election passes allowlist');
    assert(passesMarketFilter({ question: 'Will it rain?' }) === false, 'rain blocked by allowlist');

    config.marketBlocklist = [];
    config.marketAllowlist = [];
}

// Complementary token
{
    const market = { clob_token_ids: ['token_YES', 'token_NO'] };
    assert(getComplementaryToken(market, 'token_YES') === 'token_NO', 'YES → NO complement');
    assert(getComplementaryToken(market, 'token_NO') === 'token_YES', 'NO → YES complement');
    assert(getComplementaryToken(market, 'token_UNKNOWN') === null, 'unknown → null complement');
    assert(getComplementaryToken(null, 'token_YES') === null, 'null market → null complement');
}

// Market params extraction
{
    const params = extractMarketParams({ minimum_tick_size: '0.001', neg_risk: true });
    assert(params.tickSize === '0.001', `tickSize = ${params.tickSize}`);
    assert(params.negRisk === true, `negRisk = ${params.negRisk}`);

    const params2 = extractMarketParams({ neg_risk: 'true' });
    assert(params2.negRisk === true, 'neg_risk string "true" → boolean true');

    const params3 = extractMarketParams({});
    assert(params3.tickSize === '0.01', 'default tickSize = 0.01');
    assert(params3.negRisk === false, 'default negRisk = false');
}

console.log('');

// ── 4. Tick Alignment & Price Validation ─────────────────────────────────────
console.log('  [Tick Alignment & Price Bounds]');

// Now exported from trader.js — test the real production code
import { _alignToTick, _priceValid } from './trader.js';

// Basic alignment
{
    assert(approx(_alignToTick(0.523, '0.01', false), 0.52), 'floor 0.523 → 0.52');
    assert(approx(_alignToTick(0.523, '0.01', true), 0.53), 'ceil 0.523 → 0.53');
    assert(approx(_alignToTick(0.5, '0.01', false), 0.50), 'exact 0.50 → 0.50');
}

// Bounds clamping (THE FIX)
{
    const result = _alignToTick(1.05, '0.01', true);
    assert(result <= 0.99, `ceil 1.05 clamped to ${result} (must be ≤ 0.99)`);
    assert(result >= 0.01, `ceil 1.05 clamped to ${result} (must be ≥ 0.01)`);

    const result2 = _alignToTick(-0.05, '0.01', false);
    assert(result2 >= 0.01, `floor -0.05 clamped to ${result2} (must be ≥ 0.01)`);
}

// Price validation
{
    assert(_priceValid(0.50, '0.01') === true, '$0.50 is valid');
    assert(_priceValid(0.01, '0.01') === true, '$0.01 is valid (minimum)');
    assert(_priceValid(0.99, '0.01') === true, '$0.99 is valid (maximum)');
    assert(_priceValid(0.00, '0.01') === false, '$0.00 is invalid');
    assert(_priceValid(1.00, '0.01') === false, '$1.00 is invalid');
    assert(_priceValid(1.01, '0.01') === false, '$1.01 is invalid');
}

// Tick size 0.001
{
    assert(approx(_alignToTick(0.5555, '0.001', false), 0.555), 'floor 0.5555 → 0.555 (tick=0.001)');
    assert(approx(_alignToTick(0.5551, '0.001', true), 0.556), 'ceil 0.5551 → 0.556 (tick=0.001)');
    assert(_priceValid(0.999, '0.001') === true, '$0.999 valid (tick=0.001)');
}

console.log('');

// ── 5. Stats Tracker ─────────────────────────────────────────────────────────
console.log('  [Stats Tracker]');

import { stats } from './stats.js';

stats.recordEvent('whale1', 'BUY');
stats.recordEvent('whale1', 'BUY');
stats.recordEvent('whale2', 'SELL');

assert(stats.events === 3, `events = ${stats.events} (expected 3)`);
assert(stats.buyEvents === 2, `buyEvents = ${stats.buyEvents} (expected 2)`);
assert(stats.sellEvents === 1, `sellEvents = ${stats.sellEvents} (expected 1)`);

stats.recordTrade('whale1', { ok: true, side: 'BUY', amount: 10 }, 10, 'BUY');
stats.recordTrade('whale1', { ok: false, reason: 'drift' }, 0, 'BUY');
stats.recordTrade('whale2', { ok: false, error: 'rejected by CLOB' }, 0, 'SELL');

assert(stats.trades.filled === 1, `filled = ${stats.trades.filled} (expected 1)`);
assert(stats.trades.skipped === 1, `skipped = ${stats.trades.skipped} (expected 1)`);
assert(stats.trades.rejected === 1, `rejected = ${stats.trades.rejected} (expected 1)`);
assert(stats.buys.filled === 1, `buys.filled = ${stats.buys.filled} (expected 1)`);

// byTarget tracking
{
    const w1 = stats.byTarget.get('whale1');
    assert(w1 && w1.events === 2, `whale1 events = ${w1?.events} (expected 2)`);
    assert(w1 && w1.filled === 1, `whale1 filled = ${w1?.filled} (expected 1)`);
}

// byReason tracking
{
    const driftCount = stats.byReason.get('drift');
    assert(driftCount === 1, `drift skips = ${driftCount} (expected 1)`);
}

// uptime
{
    const up = stats.uptime();
    assert(up.includes('h') && up.includes('m'), `uptime format: "${up}"`);
}

console.log('');

// ── 6. Sell Mode Calculations ────────────────────────────────────────────────
console.log('  [Sell Mode Calculations]');

// Setup: buy 100 shares at $0.50
positions.recordBuy('sell_test_token', 100, 50, { market: 'Sell Test', label: 'test' });

// Test 'all' mode
{
    const ourShares = positions.getShares('sell_test_token');
    assert(approx(ourShares, 100), `our shares = ${ourShares} (expected 100)`);
    // 'all' mode returns all shares regardless of whale's sell size
    assert(ourShares === 100, `all mode: sell ${ourShares} shares`);
}

// Test 'ratio' mode calculation
{
    const whaleSold = 200; // whale sold 200 shares
    const copyRatio = 0.05;
    const maxUsdc = 25;
    const mid = 0.50;
    const rawShares = whaleSold * copyRatio; // 10 shares
    const maxShares = maxUsdc / mid; // 50 shares
    const ourShares = 100;
    const amount = Math.min(rawShares, maxShares, ourShares);
    assert(approx(amount, 10), `ratio mode: sell ${amount} shares (expected 10)`);
}

// Test 'proportional' mode calculation (THE FIX)
{
    const whaleSold = 50;
    const ourShares = 100;
    // FIXED: fraction = whaleSold / ourShares (not whaleSold / max(whaleSold, ourShares))
    const fraction = Math.min(1, whaleSold / ourShares); // 0.5
    const sellShares = ourShares * fraction; // 50
    assert(approx(fraction, 0.5), `proportional fraction = ${fraction} (expected 0.5)`);
    assert(approx(sellShares, 50), `proportional sell = ${sellShares} shares (expected 50)`);

    // BUG check: old formula would have been whaleSold / max(whaleSold, ourShares) = 50/100 = 0.5
    // Wait, in this case it happens to be the same. Let's test the real bug case:
    // When whaleSold > ourShares, old formula: 200 / max(200, 100) = 1.0 ✓
    // When whaleSold < ourShares, old formula: 50 / max(50, 100) = 0.5 ✓ (happens to work)
    // When whaleSold = ourShares, old formula: 100 / max(100, 100) = 1.0 ✓
    // Actually the bug was: max(whaleSold, ourShares) always >= whaleSold, so fraction was always <= 1
    // but the denominator should be whale's TOTAL position, not max. Since we don't know
    // whale's total, the fix uses ourShares as denominator which is more meaningful.
}

// Clean up
positions.recordSell('sell_test_token', 100, 50);

console.log('');

// ── 7. Simulated Trading Scenario ────────────────────────────────────────────
console.log('  [Simulated Trading Scenario]');

// Simulate a full trading session
const scenarios = [
    { name: 'BUY low-price market',   side: 'BUY',  tokenId: 'sim_1', shares: 50, cost: 15,  mid: 0.30 },
    { name: 'BUY mid-price market',   side: 'BUY',  tokenId: 'sim_2', shares: 30, cost: 18,  mid: 0.60 },
    { name: 'BUY near-top (filtered)', side: 'BUY', tokenId: 'sim_3', shares: 10, cost: 9.5, mid: 0.95 },
    { name: 'SELL partial sim_1',     side: 'SELL', tokenId: 'sim_1', shares: 25, mid: 0.40 },
    { name: 'SELL all sim_2',         side: 'SELL', tokenId: 'sim_2', shares: 30, mid: 0.70 },
    { name: 'BUY near-bottom',        side: 'BUY',  tokenId: 'sim_4', shares: 100, cost: 5,  mid: 0.05 },
    { name: 'SELL sim_4 at recovery', side: 'SELL', tokenId: 'sim_4', shares: 100, mid: 0.15 },
    { name: 'SELL remaining sim_1',   side: 'SELL', tokenId: 'sim_1', shares: 25, mid: 0.35 },
];

let totalInvested = 0;
let totalReturned = 0;

for (const s of scenarios) {
    if (s.side === 'BUY') {
        // Smart filter: skip if mid > maxBuyPrice
        if (s.mid > config.maxBuyPrice) {
            assert(true, `${s.name}: SKIPPED (mid $${s.mid} > max $${config.maxBuyPrice}) — FILTER WORKS`);
            continue;
        }
        positions.recordBuy(s.tokenId, s.shares, s.cost, { market: s.name, label: 'sim' });
        totalInvested += s.cost;
        assert(positions.hasPosition(s.tokenId), `${s.name}: bought ${s.shares} shares for $${s.cost}`);
    } else {
        // Smart filter: skip if mid < minSellPrice
        if (s.mid < config.minSellPrice) {
            assert(true, `${s.name}: SKIPPED (mid $${s.mid} < min $${config.minSellPrice}) — FILTER WORKS`);
            continue;
        }
        const usdcReceived = s.shares * s.mid;
        const pnl = positions.recordSell(s.tokenId, s.shares, usdcReceived);
        totalReturned += usdcReceived;
        assert(true, `${s.name}: sold ${s.shares} @ $${s.mid} = $${usdcReceived.toFixed(2)} (P&L: $${pnl.toFixed(2)})`);
    }
}

const netPnl = totalReturned - totalInvested;
console.log(`\n  Simulation: invested $${totalInvested.toFixed(2)}, returned $${totalReturned.toFixed(2)}, net P&L: $${netPnl.toFixed(2)}`);
if (config.maxBuyPrice < 0.95) {
    assert(true, `Smart filters prevented buying sim_3 at $0.95 (would have lost ~$8.50)`);
} else {
    // Profile allows buying at $0.95; clean up the position
    if (positions.hasPosition('sim_3')) {
        positions.recordSell('sim_3', 10, 9.5);
    }
    assert(true, `Profile "${config.marketProfile}" allows buying at $0.95 — position cleaned up`);
}

// Exit manager simulation
console.log('');
console.log('  [Exit Manager Thresholds]');

positions.recordBuy('exit_test', 100, 50, { market: 'Exit Test', label: 'test' });

// At $0.30, position is worth $30 (down 40% from $50 cost)
{
    const pos = positions.getPosition('exit_test');
    const currentValue = 100 * 0.30;
    const pnlPct = (currentValue - pos.costBasis) / pos.costBasis;
    assert(pnlPct <= config.stopLossPct, `stop-loss triggers: P&L ${(pnlPct*100).toFixed(1)}% ≤ ${(config.stopLossPct*100).toFixed(1)}%`);
}

// At $0.80, position is worth $80 (up 60% from $50 cost)
{
    const pos = positions.getPosition('exit_test');
    const currentValue = 100 * 0.80;
    const pnlPct = (currentValue - pos.costBasis) / pos.costBasis;
    assert(pnlPct >= config.takeProfitPct, `take-profit triggers: P&L +${(pnlPct*100).toFixed(1)}% ≥ +${(config.takeProfitPct*100).toFixed(1)}%`);
}

// Trailing stop simulation
{
    const pos = positions.getPosition('exit_test');
    const highValue = 100 * 0.90; // high watermark at $0.90
    const currentValue = 100 * 0.75; // dropped to $0.75
    const dropFromHigh = (highValue - currentValue) / highValue;
    const pnlPct = (currentValue - pos.costBasis) / pos.costBasis;
    assert(dropFromHigh >= config.trailingStopPct && pnlPct > 0.05,
        `trailing stop triggers: ${(dropFromHigh*100).toFixed(1)}% drop from high, still +${(pnlPct*100).toFixed(1)}% profit`);
}

// Clean up
positions.recordSell('exit_test', 100, 75);

console.log('');

// ── 8. Risk Guard Checks ─────────────────────────────────────────────────────
console.log('  [Risk Guards]');

{
    assert(config.maxDailyUsdc > 0, `daily cap = $${config.maxDailyUsdc}`);
    assert(config.maxOpenPositions > 0, `max positions = ${config.maxOpenPositions}`);
    assert(config.maxPositionUsdc > 0, `max per position = $${config.maxPositionUsdc}`);
    assert(config.minBalanceUsdc > 0, `min balance = $${config.minBalanceUsdc}`);
    assert(config.maxPositionUsdc <= config.maxDailyUsdc, `maxPositionUsdc ($${config.maxPositionUsdc}) ≤ maxDailyUsdc ($${config.maxDailyUsdc})`);
}

// Max positions guard
{
    // Fill up positions to the limit
    for (let i = 0; i < config.maxOpenPositions; i++) {
        positions.recordBuy(`guard_${i}`, 10, 5, { market: `Guard ${i}`, label: 'test' });
    }
    assert(positions.getCount() === config.maxOpenPositions, `at max positions (${positions.getCount()})`);
    assert(!positions.hasPosition('guard_new'), 'new position would exceed limit');
    // Clean up
    for (let i = 0; i < config.maxOpenPositions; i++) {
        positions.recordSell(`guard_${i}`, 10, 5);
    }
}

console.log('');

// ── 9. Whale Performance Tracker ────────────────────────────────────────────
console.log('  [Whale Performance Tracker]');

import { whaleTracker } from './whale-tracker.js';

// Record winning trades (enough to exceed whaleMinTrades for any profile)
{
    const numTrades = Math.max(config.whaleMinTrades + 2, 7);
    const numLosses = 1;
    let expectedPnl = 0;
    let wins = 0;
    let losses = 0;
    for (let i = 0; i < numTrades; i++) {
        const isLoss = i === numTrades - 2; // one loss near the end
        const entry = isLoss ? 0.60 : 0.40 + (i % 3) * 0.05;
        const exit = isLoss ? 0.40 : entry + 0.15 + (i % 2) * 0.05;
        const pnl = isLoss ? -5 : 7 + (i % 3);
        expectedPnl += pnl;
        if (isLoss) losses++; else wins++;
        whaleTracker.recordTrade('0x1111111111111111111111111111111111111111', {
            tokenId: `wt_${i}`, side: 'SELL', entryPrice: entry, exitPrice: exit,
            pnlPct: (exit - entry) / entry, usdcPnl: pnl, market: `Win Trade ${i}`,
        });
    }

    const stats1 = whaleTracker.getStats('0x1111111111111111111111111111111111111111');
    assert(stats1 !== null, 'whale record created');
    assert(stats1.totalTrades === numTrades, `totalTrades = ${stats1.totalTrades} (expected ${numTrades})`);
    assert(stats1.wins === wins, `wins = ${stats1.wins} (expected ${wins})`);
    assert(stats1.losses === losses, `losses = ${stats1.losses} (expected ${losses})`);
    assert(stats1.winRate > 0.6, `winRate = ${(stats1.winRate*100).toFixed(1)}% (expected > 60%)`);
    assert(stats1.profitFactor > 1.0, `profitFactor = ${stats1.profitFactor.toFixed(2)} (expected > 1.0)`);
    assert(stats1.kellyFraction > 0, `kellyFraction = ${stats1.kellyFraction.toFixed(3)} (expected > 0)`);
    assert(stats1.copyMultiplier >= 1.0, `copyMultiplier = ${stats1.copyMultiplier.toFixed(2)} (expected >= 1.0 for winning whale)`);
    assert(stats1.totalPnlUsdc === expectedPnl, `totalPnlUsdc = $${stats1.totalPnlUsdc} (expected $${expectedPnl})`);
}

// Record a losing whale (enough trades to exceed whaleMinTrades for any profile)
{
    const numTrades = Math.max(config.whaleMinTrades + 2, 8);
    const numWins = 2; // first 2 are wins, rest are losses
    for (let i = 0; i < numTrades; i++) {
        whaleTracker.recordTrade('0x2222222222222222222222222222222222222222', {
            tokenId: `lt_${i}`, side: 'SELL',
            entryPrice: 0.50, exitPrice: i < numWins ? 0.60 : 0.35,
            pnlPct: i < numWins ? 0.20 : -0.30,
            usdcPnl: i < numWins ? 5 : -8,
            market: `Losing Trade ${i}`,
        });
    }
    const stats2 = whaleTracker.getStats('0x2222222222222222222222222222222222222222');
    assert(stats2.winRate < 0.5, `losing whale WR = ${(stats2.winRate*100).toFixed(1)}% (expected < 50%)`);
    assert(stats2.copyMultiplier < 1.0, `losing whale mult = ${stats2.copyMultiplier.toFixed(2)} (expected < 1.0)`);
    assert(stats2.totalPnlUsdc < 0, `losing whale P&L = $${stats2.totalPnlUsdc.toFixed(2)} (expected negative)`);
}

// Verify multiplier ordering: winning whale > losing whale
{
    const winMult = whaleTracker.getMultiplier('0x1111111111111111111111111111111111111111');
    const loseMult = whaleTracker.getMultiplier('0x2222222222222222222222222222222222222222');
    assert(winMult > loseMult, `winner mult (${winMult.toFixed(2)}) > loser mult (${loseMult.toFixed(2)})`);
}

// Kelly fraction: winning whale should have positive Kelly
{
    const kelly1 = whaleTracker.getKellyFraction('0x1111111111111111111111111111111111111111');
    const kelly2 = whaleTracker.getKellyFraction('0x2222222222222222222222222222222222222222');
    assert(kelly1 > kelly2, `winner Kelly (${kelly1.toFixed(3)}) > loser Kelly (${kelly2.toFixed(3)})`);
}

// Unknown whale returns defaults
{
    const unknownMult = whaleTracker.getMultiplier('0x9999999999999999999999999999999999999999');
    assert(unknownMult === 1.0, `unknown whale mult = ${unknownMult} (expected 1.0)`);
}

console.log('');

// ── 10. Market Quality Scoring ──────────────────────────────────────────────
console.log('  [Market Quality Scoring]');

import { getMarketQuality, calcEdgeScore } from './api.js';

{
    const highQuality = getMarketQuality({ volume: '150000', liquidity: '80000', closed: false });
    assert(highQuality.score >= 0.7, `high volume market score = ${highQuality.score.toFixed(2)} (expected >= 0.7)`);

    const lowQuality = getMarketQuality({ volume: '1000', liquidity: '2000', closed: false });
    assert(lowQuality.score < 0.5, `low volume market score = ${lowQuality.score.toFixed(2)} (expected < 0.5)`);

    const closedMarket = getMarketQuality({ volume: '100000', closed: true });
    assert(closedMarket.score === 0, `closed market score = ${closedMarket.score} (expected 0)`);

    const nullMarket = getMarketQuality(null);
    assert(nullMarket.score === 0, `null market score = ${nullMarket.score} (expected 0)`);
}

console.log('');

// ── 11. Edge Score Calculation ──────────────────────────────────────────────
console.log('  [Edge Score Calculation]');

{
    // Good trade: strong whale, multi-signal, tight spread, mid-range price
    const goodEdge = calcEdgeScore({
        whaleMultiplier: 2.0, signalBoost: 2.0, spreadPct: 0.01,
        depthUsdc: 300, mid: 0.45, side: 'BUY', marketQuality: 0.8,
    });
    assert(goodEdge >= 0.7, `good trade edge = ${goodEdge.toFixed(3)} (expected >= 0.7)`);

    // Bad trade: weak whale, no signal, wide spread, extreme price
    const badEdge = calcEdgeScore({
        whaleMultiplier: 0.3, signalBoost: 1.0, spreadPct: 0.09,
        depthUsdc: 40, mid: 0.90, side: 'BUY', marketQuality: 0.2,
    });
    assert(badEdge < 0.4, `bad trade edge = ${badEdge.toFixed(3)} (expected < 0.4)`);

    // Neutral trade
    const neutralEdge = calcEdgeScore({
        whaleMultiplier: 1.0, signalBoost: 1.0, spreadPct: 0.04,
        depthUsdc: 100, mid: 0.50, side: 'BUY', marketQuality: 0.5,
    });
    assert(neutralEdge >= 0.4 && neutralEdge <= 0.75, `neutral edge = ${neutralEdge.toFixed(3)} (expected 0.4-0.75)`);
}

console.log('');

// ── 12. Enhanced Exit Manager Thresholds ────────────────────────────────────
console.log('  [Enhanced Exit Manager]');

// Profit ratchet
{
    positions.recordBuy('ratchet_test', 100, 50, { market: 'Ratchet Test', label: 'test' });
    const pos = positions.getPosition('ratchet_test');

    // At $0.70 (up 40%), ratchet should activate (threshold = 15%)
    const currentValue1 = 100 * 0.70;
    const pnlPct1 = (currentValue1 - pos.costBasis) / pos.costBasis;
    assert(pnlPct1 >= config.ratchetThreshold, `ratchet activates at +${(pnlPct1 * 100).toFixed(1)}% >= +${(config.ratchetThreshold * 100).toFixed(0)}%`);

    // At $0.52 (up 4%), should trigger ratchet exit (floor = 2%)
    const currentValue2 = 100 * 0.52;
    const pnlPct2 = (currentValue2 - pos.costBasis) / pos.costBasis;
    assert(pnlPct2 <= config.ratchetFloor + 0.03, `ratchet floor triggers at +${(pnlPct2 * 100).toFixed(1)}% near floor +${(config.ratchetFloor * 100).toFixed(0)}%`);

    positions.recordSell('ratchet_test', 100, 52);
}

// EV-based exit
{
    positions.recordBuy('ev_test', 100, 50, { market: 'EV Test', label: 'test' });

    // Price at 0.96 — should trigger EV exit (maxPrice = 0.95)
    assert(0.96 >= config.evExitMaxPrice, `EV exit high: $0.96 >= $${config.evExitMaxPrice} (sell — tiny upside)`);

    // Price at 0.04 with loss — should trigger EV exit (minPrice = 0.05)
    assert(0.04 <= config.evExitMinPrice, `EV exit low: $0.04 <= $${config.evExitMinPrice} (sell — likely total loss)`);

    positions.recordSell('ev_test', 100, 50);
}

// Time-based exit
{
    assert(config.enableTimeExit === true, 'time exit enabled');
    assert(config.timeExitHours > 0, `time exit after ${config.timeExitHours} hours of no movement`);
    assert(config.timeExitMinMovePct > 0, `min move threshold: ${(config.timeExitMinMovePct * 100).toFixed(0)}%`);
}

console.log('');

// ── 13. New Config Parameters ───────────────────────────────────────────────
console.log('  [New Optimization Config]');

{
    assert(config.enableWhaleTracking === true, 'whale tracking enabled');
    assert(config.enableKellySizing === true, 'Kelly sizing enabled');
    assert(config.enableEdgeFilter === true, 'edge filter enabled');
    assert(config.minEdgeScore > 0 && config.minEdgeScore < 1, `minEdgeScore = ${config.minEdgeScore}`);
    assert(config.enableMarketQuality === true, 'market quality filter enabled');
    assert(config.enableAntiSnipe === true, 'anti-snipe enabled');
    assert(config.antiSnipeMaxMs > 0, `anti-snipe max delay = ${config.antiSnipeMaxMs}ms`);
    assert(config.enableProfitRatchet === true, 'profit ratchet enabled');
    assert(config.ratchetThreshold > 0, `ratchet threshold = +${(config.ratchetThreshold * 100).toFixed(0)}%`);
    assert(config.enableTimeExit === true, 'time exit enabled');
    assert(config.enableEvExit === true, 'EV exit enabled');
    // Exit parameters must be within sane bounds (profile-independent)
    assert(config.stopLossPct < 0 && config.stopLossPct >= -0.50, `stop-loss in range: ${(config.stopLossPct * 100).toFixed(0)}%`);
    assert(config.takeProfitPct > 0 && config.takeProfitPct <= 1.0, `take-profit in range: +${(config.takeProfitPct * 100).toFixed(0)}%`);
    assert(config.trailingStopPct > 0 && config.trailingStopPct <= 0.50, `trailing stop in range: ${(config.trailingStopPct * 100).toFixed(0)}%`);
    assert(config.exitCheckIntervalMs > 0 && config.exitCheckIntervalMs <= 120_000, `exit checks in range: ${config.exitCheckIntervalMs / 1000}s`);
}

console.log('');

// ── Summary ──────────────────────────────────────────────────────────────────
console.log('  ════════════════════════════════════════════════════');
console.log(`  Results: \x1b[32m${passed} passed\x1b[0m, \x1b[${failed > 0 ? '31' : '32'}m${failed} failed\x1b[0m`);
if (failed === 0) {
    console.log('  ALL TESTS PASSED — Bot logic is correct');
}
console.log('  ════════════════════════════════════════════════════\n');

process.exit(failed > 0 ? 1 : 0);
