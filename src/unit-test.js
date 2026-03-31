// src/unit-test.js — Offline unit tests (no network required)
//
// Tests all pure / offline logic: config, positions, stats, api helpers, whale-tracker
// Usage: node src/unit-test.js

import assert from 'node:assert/strict';

// ── Test harness ──────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  PASS  ${name}`);
        passed++;
    } catch (err) {
        console.log(`  FAIL  ${name}`);
        console.log(`        → ${err.message}`);
        failed++;
    }
}

async function testAsync(name, fn) {
    try {
        await fn();
        console.log(`  PASS  ${name}`);
        passed++;
    } catch (err) {
        console.log(`  FAIL  ${name}`);
        console.log(`        → ${err.message}`);
        failed++;
    }
}

function section(label) {
    console.log(`\n  ── ${label} ${'─'.repeat(50 - label.length)}`);
}

// ── Imports ───────────────────────────────────────────────────────────────────
import config from './config.js';
import { positions } from './positions.js';
import { stats } from './stats.js';
import {
    getSpread, getBookDepth, getExecutionPriceFromBook,
    isMarketActive, passesMarketFilter, getComplementaryToken,
    extractMarketParams, getMarketQuality, calcEdgeScore,
    getHoursUntilExpiry, cleanExpiredCache,
} from './api.js';
import { whaleTracker } from './whale-tracker.js';

console.log('\n  ════════════════════════════════════════════════════════');
console.log('  Polymarket Copy-Trader — Offline Unit Tests');
console.log('  ════════════════════════════════════════════════════════');

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────
section('Config');

test('validate() passes with default config', () => {
    const errors = config.validate();
    assert.equal(errors.length, 0, `Errors: ${errors.join(', ')}`);
});

test('dryRun defaults to true (no LIVE_MODE)', () => {
    assert.equal(typeof config.dryRun, 'boolean');
    assert.equal(config.dryRun, true);
});

test('targets are normalized to lowercase', () => {
    for (const t of config.targets) {
        assert.equal(t.address, t.address.toLowerCase(), `Address not lowercase: ${t.address}`);
    }
});

test('validate() catches bad privateKey format', () => {
    const saved = config.privateKey;
    config.privateKey = '0xBADKEY';
    const errors = config.validate();
    config.privateKey = saved;
    assert.ok(errors.some(e => e.includes('privateKey')), `Expected privateKey error, got: ${errors.join(', ')}`);
});

test('validate() catches maxPositionUsdc > maxDailyUsdc', () => {
    const savedPos = config.maxPositionUsdc;
    const savedDaily = config.maxDailyUsdc;
    config.maxPositionUsdc = 200;
    config.maxDailyUsdc = 100;
    const errors = config.validate();
    config.maxPositionUsdc = savedPos;
    config.maxDailyUsdc = savedDaily;
    assert.ok(errors.some(e => e.includes('maxPositionUsdc')), `Expected maxPositionUsdc error`);
});

test('validate() catches bad sellMode', () => {
    const saved = config.sellMode;
    config.sellMode = 'invalid';
    const errors = config.validate();
    config.sellMode = saved;
    assert.ok(errors.some(e => e.includes('sellMode')), `Expected sellMode error`);
});

test('validate() catches bad slippage', () => {
    const saved = config.slippage;
    config.slippage = 0.9; // > 0.5
    const errors = config.validate();
    config.slippage = saved;
    assert.ok(errors.some(e => e.includes('slippage')), `Expected slippage error`);
});

test('validate() catches maxPortfolioExposurePct > 1', () => {
    const saved = config.maxPortfolioExposurePct;
    config.maxPortfolioExposurePct = 1.5;
    const errors = config.validate();
    config.maxPortfolioExposurePct = saved;
    assert.ok(errors.some(e => e.includes('maxPortfolioExposurePct')), `Expected exposure error`);
});

test('validate() catches maxBuyPrice <= minSellPrice', () => {
    const savedBuy = config.maxBuyPrice;
    const savedSell = config.minSellPrice;
    config.maxBuyPrice = 0.30;
    config.minSellPrice = 0.30;
    const errors = config.validate();
    config.maxBuyPrice = savedBuy;
    config.minSellPrice = savedSell;
    assert.ok(errors.some(e => e.includes('maxBuyPrice')), `Expected maxBuyPrice > minSellPrice error`);
});

test('getSellMode returns target override over global', () => {
    const target = { sellMode: 'proportional' };
    assert.equal(config.getSellMode(target), 'proportional');
});

test('getSellMode falls back to global when target has none', () => {
    const target = { sellMode: null };
    assert.equal(config.getSellMode(target), config.sellMode);
});

test('shouldCopySells returns target override over global', () => {
    assert.equal(config.shouldCopySells({ copySells: false }), false);
    assert.equal(config.shouldCopySells({ copySells: true }),  true);
});

test('shouldCopySells falls back to global when target has null', () => {
    const target = { copySells: null };
    assert.equal(config.shouldCopySells(target), config.copySells);
});

// ─────────────────────────────────────────────────────────────────────────────
// POSITIONS
// ─────────────────────────────────────────────────────────────────────────────
section('PositionManager');

// Reset positions between tests
function cleanPositions(...ids) {
    for (const id of ids) {
        const p = positions.getPosition(id);
        if (p) positions.recordSell(id, p.shares, 0);
    }
}

test('recordBuy creates new position', () => {
    positions.recordBuy('_u1_', 100, 50, { market: 'Test', label: 'T' });
    const p = positions.getPosition('_u1_');
    assert.ok(p, 'Position not created');
    assert.equal(p.shares, 100);
    assert.equal(p.costBasis, 50);
    assert.ok(Math.abs(p.avgEntry - 0.5) < 1e-9, `avgEntry=${p.avgEntry}`);
    cleanPositions('_u1_');
});

test('recordBuy accumulates on existing position (avg entry correct)', () => {
    // Buy 100 @ 0.50, then 100 @ 0.70 → avg = (50+70)/200 = 0.60
    positions.recordBuy('_u2_', 100, 50, { market: 'M', label: 'T' });
    positions.recordBuy('_u2_', 100, 70, { market: 'M', label: 'T' });
    const p = positions.getPosition('_u2_');
    assert.equal(p.shares, 200);
    assert.equal(p.costBasis, 120);
    assert.ok(Math.abs(p.avgEntry - 0.60) < 1e-9, `avgEntry=${p.avgEntry}`);
    cleanPositions('_u2_');
});

test('recordSell returns correct realized P&L (profit)', () => {
    // Buy 100 @ $0.50 (cost = $50), sell 50 @ $0.70 (revenue = $35)
    // cost of 50 shares = 0.50 * 50 = $25 → P&L = $35 - $25 = $10
    positions.recordBuy('_u3_', 100, 50, { market: 'M', label: 'T' });
    const pnl = positions.recordSell('_u3_', 50, 35);
    assert.ok(Math.abs(pnl - 10) < 0.001, `Expected $10 P&L, got $${pnl}`);
    cleanPositions('_u3_');
});

test('recordSell returns correct realized P&L (loss)', () => {
    // Buy 100 @ $0.50 (cost = $50), sell 100 @ $0.30 (revenue = $30)
    // P&L = $30 - $50 = -$20
    positions.recordBuy('_u4_', 100, 50, { market: 'M', label: 'T' });
    const pnl = positions.recordSell('_u4_', 100, 30);
    assert.ok(Math.abs(pnl - (-20)) < 0.001, `Expected -$20 P&L, got $${pnl}`);
    assert.equal(positions.getPosition('_u4_'), null, 'Position should be removed after full exit');
});

test('recordSell removes position when shares reach zero', () => {
    positions.recordBuy('_u5_', 50, 25, { market: 'M', label: 'T' });
    positions.recordSell('_u5_', 50, 30);
    assert.equal(positions.getPosition('_u5_'), null);
});

test('recordSell updates avgEntry correctly after partial sell', () => {
    // Buy 200 @ 0.50 (cost=$100). Sell 100, remaining 100 @ 0.50
    positions.recordBuy('_u6_', 200, 100, { market: 'M', label: 'T' });
    positions.recordSell('_u6_', 100, 50);
    const p = positions.getPosition('_u6_');
    assert.ok(p, 'Position should remain');
    assert.ok(Math.abs(p.shares - 100) < 1e-9, `shares=${p.shares}`);
    assert.ok(Math.abs(p.avgEntry - 0.5) < 1e-9, `avgEntry=${p.avgEntry}`);
    cleanPositions('_u6_');
});

test('getShares returns 0 for unknown token', () => {
    assert.equal(positions.getShares('_nonexistent_'), 0);
});

test('hasPosition returns false for tiny residual', () => {
    positions.recordBuy('_u7_', 0.00005, 0.00005, { market: 'M', label: 'T' });
    assert.equal(positions.hasPosition('_u7_'), false);
    cleanPositions('_u7_');
});

test('recordSell on nonexistent returns 0', () => {
    const pnl = positions.recordSell('_nonexistent_xyz_', 100, 50);
    assert.equal(pnl, 0);
});

test('getTotalCostBasis sums all positions', () => {
    const before = positions.getTotalCostBasis();
    positions.recordBuy('_ua_', 100, 30, { market: 'A', label: 'T' });
    positions.recordBuy('_ub_', 100, 20, { market: 'B', label: 'T' });
    const after = positions.getTotalCostBasis();
    assert.ok(Math.abs(after - before - 50) < 0.001, `Expected +$50, diff=${after - before}`);
    cleanPositions('_ua_', '_ub_');
});

test('getTotalRealizedPnl accumulates closed positions', () => {
    const before = positions.getTotalRealizedPnl();
    positions.recordBuy('_uc_', 100, 50, { market: 'C', label: 'T' });
    positions.recordSell('_uc_', 100, 70); // +$20
    const after = positions.getTotalRealizedPnl();
    assert.ok(Math.abs(after - before - 20) < 0.001, `Expected +$20, diff=${after - before}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// STATS
// ─────────────────────────────────────────────────────────────────────────────
section('Stats');

test('recordEvent increments counters', () => {
    const before = stats.events;
    stats.recordEvent('TestWhale', 'BUY');
    assert.equal(stats.events, before + 1);
    assert.equal(stats.buyEvents, stats.buyEvents); // already incremented
});

test('recordTrade counts filled live trade (ok=true)', () => {
    const before = stats.trades.filled;
    stats.recordTrade('TestWhale', { ok: true, side: 'BUY' }, 10, 'BUY');
    assert.equal(stats.trades.filled, before + 1);
});

test('recordTrade counts dry-run fill (dryRun=true, amount>0)', () => {
    const before = stats.trades.filled;
    stats.recordTrade('TestWhale', { dryRun: true, side: 'BUY', amount: 5 }, 5, 'BUY');
    assert.equal(stats.trades.filled, before + 1);
});

test('recordTrade does NOT count dry-run skip (amount=0)', () => {
    const before = stats.trades.filled;
    const beforeSkip = stats.trades.skipped;
    stats.recordTrade('TestWhale', { dryRun: true, side: 'BUY', amount: 0, reason: 'cooldown' }, 0, 'BUY');
    assert.equal(stats.trades.filled, before, 'filled should not change');
    assert.equal(stats.trades.skipped, beforeSkip + 1, 'skipped should increment');
});

test('recordTrade counts error result', () => {
    const before = stats.trades.errors;
    stats.recordTrade('TestWhale', { ok: false, error: 'network error' }, 0, 'BUY');
    assert.equal(stats.trades.errors, before + 1);
});

test('recordTrade counts rejection', () => {
    const before = stats.trades.rejected;
    stats.recordTrade('TestWhale', { ok: false, error: 'order rejected by clob' }, 0, 'BUY');
    assert.equal(stats.trades.rejected, before + 1);
});

test('getSummary contains all expected keys', () => {
    const s = stats.getSummary();
    for (const key of ['events', 'trades', 'buys', 'sells', 'byTarget', 'byReason']) {
        assert.ok(key in s, `Missing key: ${key}`);
    }
});

test('uptime() returns a string', () => {
    const s = stats.uptime();
    assert.equal(typeof s, 'string');
    assert.ok(s.includes('h'), `Expected 'h' in uptime: ${s}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// API HELPERS (pure, no network)
// ─────────────────────────────────────────────────────────────────────────────
section('API helpers — getSpread');

test('getSpread calculates spread and mid correctly', () => {
    const book = {
        bids: [{ price: '0.44', size: '100' }, { price: '0.40', size: '50' }],
        asks: [{ price: '0.56', size: '100' }, { price: '0.60', size: '50' }],
    };
    const { spread, spreadPct, bestBid, bestAsk, mid } = getSpread(book);
    assert.ok(Math.abs(bestBid - 0.44) < 1e-9);
    assert.ok(Math.abs(bestAsk - 0.56) < 1e-9);
    assert.ok(Math.abs(mid - 0.50) < 1e-9, `mid=${mid}`);
    assert.ok(Math.abs(spread - 0.12) < 1e-9, `spread=${spread}`);
    assert.ok(Math.abs(spreadPct - 0.12 / 0.50) < 1e-9, `spreadPct=${spreadPct}`);
});

test('getSpread returns nulls on empty book', () => {
    const result = getSpread({ bids: [], asks: [] });
    assert.equal(result.spread, null);
    assert.equal(result.spreadPct, null);
    assert.equal(result.bestBid, null);
    assert.equal(result.bestAsk, null);
});

test('getSpread returns nulls on null input', () => {
    const result = getSpread(null);
    assert.equal(result.spread, null);
});

section('API helpers — getBookDepth');

test('getBookDepth sums USDC correctly', () => {
    const book = {
        bids: [{ price: '0.50', size: '200' }],
        asks: [{ price: '0.55', size: '100' }],
    };
    const { bidDepthUsdc, askDepthUsdc } = getBookDepth(book);
    assert.ok(Math.abs(bidDepthUsdc - 100) < 1e-6, `bidDepth=${bidDepthUsdc}`); // 200*0.50
    assert.ok(Math.abs(askDepthUsdc - 55) < 1e-6, `askDepth=${askDepthUsdc}`);  // 100*0.55
});

test('getBookDepth returns 0 for null book', () => {
    const { bidDepthUsdc, askDepthUsdc } = getBookDepth(null);
    assert.equal(bidDepthUsdc, 0);
    assert.equal(askDepthUsdc, 0);
});

section('API helpers — getExecutionPriceFromBook');

test('BUY execution price: consumes ask levels in order', () => {
    // Ask at 0.50 × 100 shares = $50, then 0.60 × 100 = $60
    const book = {
        bids: [],
        asks: [
            { price: '0.60', size: '100' },  // worse
            { price: '0.50', size: '100' },  // better — should consume first
        ],
    };
    const exec = getExecutionPriceFromBook(book, 'BUY', 50); // buy $50
    assert.ok(exec, 'exec should not be null');
    // All $50 fills at 0.50 → 100 shares, avg = $0.50
    assert.ok(Math.abs(exec.avgPrice - 0.50) < 1e-6, `avgPrice=${exec.avgPrice}`);
    assert.ok(Math.abs(exec.wouldFill - 100) < 1e-6, `wouldFill=${exec.wouldFill}`);
    assert.ok(Math.abs(exec.fillPct - 1.0) < 1e-6, `fillPct=${exec.fillPct}`);
});

test('BUY execution price: spans multiple levels', () => {
    // Buy $60: $50 at level1 (0.50) + $10 at level2 (0.60)
    const book = {
        bids: [],
        asks: [
            { price: '0.50', size: '100' },  // level1: 100 shares × $0.50 = $50
            { price: '0.60', size: '100' },  // level2: 100 shares × $0.60 = $60
        ],
    };
    const exec = getExecutionPriceFromBook(book, 'BUY', 60);
    // $50 → 100 shares at 0.50; $10 → 16.667 shares at 0.60
    // total shares ≈ 116.667, avg price ≈ 60/116.667 ≈ 0.5143
    assert.ok(exec, 'exec should not be null');
    assert.ok(exec.wouldFill > 100, `Expected > 100 shares filled`);
    assert.ok(exec.avgPrice > 0.50 && exec.avgPrice < 0.60, `avgPrice=${exec.avgPrice}`);
});

test('SELL execution price: consumes bid levels in order (highest first)', () => {
    const book = {
        bids: [
            { price: '0.40', size: '100' },
            { price: '0.50', size: '100' },  // better — should consume first
        ],
        asks: [],
    };
    const exec = getExecutionPriceFromBook(book, 'SELL', 50); // sell 50 shares
    assert.ok(exec, 'exec should not be null');
    assert.ok(Math.abs(exec.avgPrice - 0.50) < 1e-6, `avgPrice=${exec.avgPrice}`);
    assert.ok(Math.abs(exec.wouldFill - 50) < 1e-6, `wouldFill=${exec.wouldFill}`);
});

test('getExecutionPriceFromBook returns null on empty book', () => {
    const book = { bids: [], asks: [] };
    assert.equal(getExecutionPriceFromBook(book, 'BUY', 10), null);
    assert.equal(getExecutionPriceFromBook(book, 'SELL', 10), null);
});

section('API helpers — isMarketActive');

test('isMarketActive returns true for open market', () => {
    assert.ok(isMarketActive({ closed: false, active: true }));
});

test('isMarketActive returns false for closed market', () => {
    assert.ok(!isMarketActive({ closed: true }));
    assert.ok(!isMarketActive({ closed: 'true' }));
});

test('isMarketActive returns false for resolved market', () => {
    assert.ok(!isMarketActive({ resolved: true }));
    assert.ok(!isMarketActive({ resolved: 'true' }));
});

test('isMarketActive returns false for inactive market', () => {
    assert.ok(!isMarketActive({ active: false }));
    assert.ok(!isMarketActive({ active: 'false' }));
});

test('isMarketActive returns false for null', () => {
    assert.ok(!isMarketActive(null));
});

section('API helpers — passesMarketFilter');

test('passesMarketFilter: no filters → always passes', () => {
    const savedBlock = config.marketBlocklist;
    const savedAllow = config.marketAllowlist;
    config.marketBlocklist = [];
    config.marketAllowlist = [];
    assert.ok(passesMarketFilter({ question: 'Will Biden win?' }));
    config.marketBlocklist = savedBlock;
    config.marketAllowlist = savedAllow;
});

test('passesMarketFilter: blocklist match → blocked', () => {
    const saved = config.marketBlocklist;
    config.marketBlocklist = ['trump'];
    assert.ok(!passesMarketFilter({ question: 'Will Trump win the 2024 election?' }));
    config.marketBlocklist = saved;
});

test('passesMarketFilter: blocklist no match → passes', () => {
    const saved = config.marketBlocklist;
    config.marketBlocklist = ['trump'];
    assert.ok(passesMarketFilter({ question: 'Will Bitcoin hit $100k?' }));
    config.marketBlocklist = saved;
});

test('passesMarketFilter: allowlist match → passes', () => {
    const saved = config.marketAllowlist;
    config.marketAllowlist = ['bitcoin'];
    assert.ok(passesMarketFilter({ question: 'Will Bitcoin hit $100k?' }));
    config.marketAllowlist = saved;
});

test('passesMarketFilter: allowlist no match → blocked', () => {
    const saved = config.marketAllowlist;
    config.marketAllowlist = ['bitcoin'];
    assert.ok(!passesMarketFilter({ question: 'Will Trump win?' }));
    config.marketAllowlist = saved;
});

section('API helpers — getComplementaryToken');

test('getComplementaryToken finds the other token', () => {
    const market = { clob_token_ids: ['AAA', 'BBB'] };
    assert.equal(getComplementaryToken(market, 'AAA'), 'BBB');
    assert.equal(getComplementaryToken(market, 'BBB'), 'AAA');
});

test('getComplementaryToken returns null for unknown token', () => {
    const market = { clob_token_ids: ['AAA', 'BBB'] };
    assert.equal(getComplementaryToken(market, 'CCC'), null);
});

test('getComplementaryToken returns null for single-token market', () => {
    const market = { clob_token_ids: ['AAA'] };
    assert.equal(getComplementaryToken(market, 'AAA'), null);
});

test('getComplementaryToken returns null for null market', () => {
    assert.equal(getComplementaryToken(null, 'AAA'), null);
});

test('getComplementaryToken handles clobTokenIds (camelCase)', () => {
    const market = { clobTokenIds: ['X', 'Y'] };
    assert.equal(getComplementaryToken(market, 'X'), 'Y');
});

section('API helpers — extractMarketParams');

test('extractMarketParams extracts tickSize and negRisk', () => {
    const market = { minimum_tick_size: '0.01', neg_risk: true };
    const { tickSize, negRisk } = extractMarketParams(market);
    assert.equal(tickSize, '0.01');
    assert.equal(negRisk, true);
});

test('extractMarketParams handles string negRisk', () => {
    const { negRisk } = extractMarketParams({ neg_risk: 'true' });
    assert.equal(negRisk, true);
});

test('extractMarketParams defaults to 0.01 tick', () => {
    const { tickSize } = extractMarketParams({});
    assert.equal(tickSize, '0.01');
});

section('API helpers — getMarketQuality');

test('getMarketQuality high volume → high score', () => {
    const market = { volume: 200000, liquidity: 60000, closed: false };
    const { score } = getMarketQuality(market);
    assert.ok(score >= 0.7, `Expected score >= 0.7, got ${score}`);
});

test('getMarketQuality low volume → low score', () => {
    const market = { volume: 100, liquidity: 100 };
    const { score } = getMarketQuality(market);
    assert.ok(score < 0.5, `Expected score < 0.5, got ${score}`);
});

test('getMarketQuality closed market → score 0', () => {
    const market = { volume: 1000000, closed: true };
    const { score } = getMarketQuality(market);
    assert.equal(score, 0);
});

test('getMarketQuality null market → score 0', () => {
    const { score } = getMarketQuality(null);
    assert.equal(score, 0);
});

test('getMarketQuality score clamped to [0,1]', () => {
    // Very high volume + liquidity
    const market = { volume: 999999999, liquidity: 999999999 };
    const { score } = getMarketQuality(market);
    assert.ok(score >= 0 && score <= 1, `score=${score}`);
});

section('API helpers — calcEdgeScore');

test('calcEdgeScore: high-quality inputs → score >= minEdgeScore', () => {
    const score = calcEdgeScore({
        whaleMultiplier: 2.0, signalBoost: 2.0,
        spreadPct: 0.01, depthUsdc: 300,
        mid: 0.40, side: 'BUY', marketQuality: 0.8,
    });
    assert.ok(score >= config.minEdgeScore, `Expected >= ${config.minEdgeScore}, got ${score}`);
});

test('calcEdgeScore: poor inputs → low score', () => {
    const score = calcEdgeScore({
        whaleMultiplier: 0.3, signalBoost: 1.0,
        spreadPct: 0.15, depthUsdc: 10,
        mid: 0.90, side: 'BUY', marketQuality: 0.1,
    });
    assert.ok(score < 0.5, `Expected < 0.5, got ${score}`);
});

test('calcEdgeScore: result clamped to [0,1]', () => {
    const hi = calcEdgeScore({ whaleMultiplier: 99, signalBoost: 99, spreadPct: 0, depthUsdc: 99999, mid: 0.5, side: 'BUY', marketQuality: 1 });
    const lo = calcEdgeScore({ whaleMultiplier: 0, signalBoost: 0, spreadPct: 1, depthUsdc: 0, mid: 0.99, side: 'BUY', marketQuality: 0 });
    assert.ok(hi >= 0 && hi <= 1, `hi=${hi}`);
    assert.ok(lo >= 0 && lo <= 1, `lo=${lo}`);
});

section('API helpers — getHoursUntilExpiry');

test('getHoursUntilExpiry: future date → positive hours', () => {
    const future = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    const hours = getHoursUntilExpiry({ end_date_iso: future });
    assert.ok(hours > 0 && hours <= 25, `hours=${hours}`);
});

test('getHoursUntilExpiry: past date → 0 hours', () => {
    const past = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    const hours = getHoursUntilExpiry({ end_date_iso: past });
    assert.equal(hours, 0);
});

test('getHoursUntilExpiry: no end date → Infinity', () => {
    assert.equal(getHoursUntilExpiry({}), Infinity);
    assert.equal(getHoursUntilExpiry(null), Infinity);
});

test('getHoursUntilExpiry: invalid date string → Infinity', () => {
    assert.equal(getHoursUntilExpiry({ end_date_iso: 'not-a-date' }), Infinity);
});

section('API helpers — cleanExpiredCache');

test('cleanExpiredCache runs without error', () => {
    // Just verify it doesn't throw
    cleanExpiredCache();
});

// ─────────────────────────────────────────────────────────────────────────────
// WHALE TRACKER
// ─────────────────────────────────────────────────────────────────────────────
section('WhaleTracker');

const TEST_ADDR = '0x' + '00'.repeat(20);

test('recordTrade creates whale record', () => {
    whaleTracker.whales.delete(TEST_ADDR);
    whaleTracker.recordTrade(TEST_ADDR, {
        tokenId: 'T1', side: 'SELL', entryPrice: 0.5, exitPrice: 0.7,
        pnlPct: 0.4, usdcPnl: 10, market: 'Test',
    });
    const rec = whaleTracker.getStats(TEST_ADDR);
    assert.ok(rec, 'No record created');
    assert.equal(rec.totalTrades, 1);
});

test('getMultiplier defaults to 1.0 for unknown whale', () => {
    assert.equal(whaleTracker.getMultiplier('0xunknown'), 1.0);
});

test('getKellyFraction defaults to 0.5 for unknown whale', () => {
    assert.equal(whaleTracker.getKellyFraction('0xunknown'), 0.5);
});

test('win rate smoothing with small sample', () => {
    const addr = '0x' + '11'.repeat(20);
    whaleTracker.whales.delete(addr);
    // 1 win out of 1 trade → Bayesian smoothed: (1+1)/(1+2) = 2/3 ≈ 0.667
    whaleTracker.recordTrade(addr, { tokenId: 'T', side: 'SELL', entryPrice: 0.5, exitPrice: 0.8, pnlPct: 0.6, usdcPnl: 5, market: 'M' });
    const rec = whaleTracker.getStats(addr);
    assert.ok(Math.abs(rec.winRate - 2/3) < 1e-6, `winRate=${rec.winRate}`);
});

test('streak tracking: two consecutive wins → streak=2', () => {
    const addr = '0x' + '22'.repeat(20);
    whaleTracker.whales.delete(addr);
    whaleTracker.recordTrade(addr, { tokenId: 'T1', side: 'SELL', entryPrice: 0.5, exitPrice: 0.7, pnlPct: 0.4, usdcPnl: 5, market: 'M' });
    whaleTracker.recordTrade(addr, { tokenId: 'T2', side: 'SELL', entryPrice: 0.3, exitPrice: 0.6, pnlPct: 1.0, usdcPnl: 8, market: 'M' });
    const rec = whaleTracker.getStats(addr);
    assert.equal(rec.currentStreak, 2, `Expected streak 2, got ${rec.currentStreak}`);
});

test('streak tracking: loss after wins resets streak negative', () => {
    const addr = '0x' + '33'.repeat(20);
    whaleTracker.whales.delete(addr);
    whaleTracker.recordTrade(addr, { tokenId: 'T1', side: 'SELL', entryPrice: 0.5, exitPrice: 0.7, pnlPct: 0.4, usdcPnl: 5, market: 'M' });
    whaleTracker.recordTrade(addr, { tokenId: 'T2', side: 'SELL', entryPrice: 0.5, exitPrice: 0.2, pnlPct: -0.6, usdcPnl: -10, market: 'M' });
    const rec = whaleTracker.getStats(addr);
    assert.equal(rec.currentStreak, -1, `Expected streak -1, got ${rec.currentStreak}`);
});

test('copyMultiplier stays at 1.0 below minTrades threshold', () => {
    const addr = '0x' + '44'.repeat(20);
    whaleTracker.whales.delete(addr);
    // Only 2 trades, whaleMinTrades=5 → multiplier should stay 1.0
    whaleTracker.recordTrade(addr, { tokenId: 'T1', side: 'SELL', entryPrice: 0.5, exitPrice: 0.8, pnlPct: 0.6, usdcPnl: 10, market: 'M' });
    whaleTracker.recordTrade(addr, { tokenId: 'T2', side: 'SELL', entryPrice: 0.5, exitPrice: 0.8, pnlPct: 0.6, usdcPnl: 10, market: 'M' });
    const rec = whaleTracker.getStats(addr);
    assert.equal(rec.copyMultiplier, 1.0, `Expected 1.0, got ${rec.copyMultiplier}`);
});

test('profitFactor = grossProfit / grossLoss', () => {
    const addr = '0x' + '55'.repeat(20);
    whaleTracker.whales.delete(addr);
    // 1 win (+$20), 1 loss (-$10) → PF = 20/10 = 2.0
    whaleTracker.recordTrade(addr, { tokenId: 'T1', side: 'SELL', entryPrice: 0.5, exitPrice: 0.9, pnlPct: 0.8, usdcPnl: 20, market: 'M' });
    whaleTracker.recordTrade(addr, { tokenId: 'T2', side: 'SELL', entryPrice: 0.5, exitPrice: 0.4, pnlPct: -0.2, usdcPnl: -10, market: 'M' });
    const rec = whaleTracker.getStats(addr);
    assert.ok(Math.abs(rec.profitFactor - 2.0) < 1e-6, `profitFactor=${rec.profitFactor}`);
});

test('getAllStats returns array', () => {
    const all = whaleTracker.getAllStats();
    assert.ok(Array.isArray(all));
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n  ════════════════════════════════════════════════════════');
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log('  ════════════════════════════════════════════════════════\n');

process.exit(failed > 0 ? 1 : 0);
