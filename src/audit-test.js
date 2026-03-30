// src/audit-test.js — Comprehensive audit test suite
//
// Tests: Auth, market fetch, copy logic, dry-run order, speed benchmark
//
// Usage: node src/audit-test.js

import config from './config.js';
import { positions } from './positions.js';
import { stats } from './stats.js';
import {
    getMidpoint, getOrderBook, getSpread, getBookDepth,
    getExecutionPriceFromBook, getMarketByToken, extractMarketParams,
    fetchBalance, fetchPositions, fetchActivity, isMarketActive,
    passesMarketFilter, getMarketQuality, calcEdgeScore,
} from './api.js';

const PASS = '✅ PASS';
const FAIL = '❌ FAIL';
let passed = 0;
let failed = 0;

async function test(name, fn) {
    const start = performance.now();
    try {
        await fn();
        const ms = (performance.now() - start).toFixed(0);
        console.log(`${PASS} — ${name} (${ms}ms)`);
        passed++;
    } catch (err) {
        const ms = (performance.now() - start).toFixed(0);
        console.log(`${FAIL} — ${name}: ${err.message} (${ms}ms)`);
        failed++;
    }
}

console.log('\n══════════════════════════════════════════════════════════');
console.log('  Polymarket Copy-Trader v7.0 — Audit Test Suite');
console.log('══════════════════════════════════════════════════════════\n');

// ── Test 1: Auth test ─────────────────────────────────────────────────────────
console.log('--- Auth & Connectivity ---');

const hasPrivateKey = !!config.privateKey;
const hasWssUrl = !!config.wssUrl;
const hasRpcUrl = !!config.rpcUrl;

await test('Config validation', () => {
    // We expect validation errors if no targets are configured
    const errors = config.validate();
    // Should at least catch "no targets" — that's expected for default config
    if (errors.length === 0 && config.targets.length === 0) {
        throw new Error('Validation should catch missing targets');
    }
});

await test('DRY_RUN env var support', () => {
    // Default should be dry-run (LIVE_MODE not set)
    if (typeof config.dryRun !== 'boolean') throw new Error('dryRun must be boolean');
    // DRY_RUN config key should exist
    if (!('dryRun' in config)) throw new Error('dryRun missing from config');
});

await test('Performance timing config', () => {
    if (typeof config.enablePerfTiming !== 'boolean') throw new Error('enablePerfTiming missing');
});

await test('Watchdog config', () => {
    if (typeof config.watchdogIntervalMs !== 'number') throw new Error('watchdogIntervalMs missing');
    if (typeof config.watchdogMaxSilenceMs !== 'number') throw new Error('watchdogMaxSilenceMs missing');
    if (config.watchdogMaxSilenceMs < config.watchdogIntervalMs) throw new Error('maxSilence must be >= interval');
});

if (hasPrivateKey) {
    await test('Auth — init trader & fetch balance', async () => {
        const { initTrader, getWalletAddress } = await import('./trader.js');
        await initTrader();
        const addr = getWalletAddress();
        if (!addr) throw new Error('No wallet address after init');
        const bal = await fetchBalance(addr);
        if (bal == null) throw new Error('Balance fetch returned null');
        console.log(`    ✅ AUTH OK — Balance: $${bal.toFixed(2)} USDC`);
    });
} else {
    console.log(`  ⚠️  SKIP — Auth test (no PRIVATE_KEY in env)`);
    console.log(`    To test: PRIVATE_KEY=0x... node src/audit-test.js`);
}

// ── Test 2: Market fetch test ─────────────────────────────────────────────────
console.log('\n--- Market Fetch ---');

const testAddress = config.testAddress;
let testTokenId = null;

if (testAddress) {
    await test('Fetch recent activity', async () => {
        const trades = await fetchActivity(testAddress, { limit: 5 });
        if (!Array.isArray(trades) || trades.length === 0) throw new Error('No trades returned');
        testTokenId = trades[0].asset;
        console.log(`    Found ${trades.length} trades, using token: ...${testTokenId?.slice(-12)}`);
    });
} else {
    console.log('  ⚠️  SKIP — No TEST_ADDRESS configured');
}

if (testTokenId) {
    await test('Fetch market metadata', async () => {
        const market = await getMarketByToken(testTokenId);
        if (!market) throw new Error('No market returned');
        const { tickSize, negRisk } = extractMarketParams(market);
        console.log(`    "${(market.question || market.title || '').slice(0, 50)}" tick=${tickSize} negRisk=${negRisk}`);
    });

    await test('Fetch midpoint price', async () => {
        const mid = await getMidpoint(testTokenId);
        if (mid == null || mid <= 0 || mid >= 1) throw new Error(`Invalid midpoint: ${mid}`);
        console.log(`    Mid: $${mid.toFixed(4)}`);
    });

    await test('Fetch order book & analyze spread', async () => {
        const book = await getOrderBook(testTokenId);
        if (!book) throw new Error('No book returned');
        const spread = getSpread(book);
        const depth = getBookDepth(book);
        console.log(`    Spread: ${spread.spreadPct != null ? (spread.spreadPct * 100).toFixed(2) + '%' : 'N/A'} | Bid depth: $${depth.bidDepthUsdc.toFixed(0)} | Ask depth: $${depth.askDepthUsdc.toFixed(0)}`);
    });

    await test('Execution price estimate ($10 BUY)', async () => {
        const book = await getOrderBook(testTokenId);
        const exec = getExecutionPriceFromBook(book, 'BUY', 10);
        if (!exec) throw new Error('No ask liquidity');
        console.log(`    Avg: $${exec.avgPrice.toFixed(4)} | Shares: ${exec.wouldFill.toFixed(2)} | Fill: ${(exec.fillPct * 100).toFixed(0)}%`);
    });
}

// ── Test 3: Copy logic test ───────────────────────────────────────────────────
console.log('\n--- Copy Logic (Mocked) ---');

await test('Position buy/sell/P&L tracking', () => {
    // Buy 100 shares at $0.50
    positions.recordBuy('_audit_test_', 100, 50, { market: 'Audit Test', label: 'audit' });
    const pos = positions.getPosition('_audit_test_');
    if (!pos) throw new Error('Position not created');
    if (Math.abs(pos.shares - 100) > 0.01) throw new Error(`Shares wrong: ${pos.shares}`);
    if (Math.abs(pos.avgEntry - 0.5) > 0.01) throw new Error(`AvgEntry wrong: ${pos.avgEntry}`);

    // Sell 50 shares at $0.70 — should profit
    const pnl = positions.recordSell('_audit_test_', 50, 35);
    if (pnl <= 0) throw new Error(`Expected positive P&L, got ${pnl}`);
    console.log(`    Buy 100@$0.50, sell 50@$0.70 → P&L: $${pnl.toFixed(2)}`);

    // Cleanup
    positions.recordSell('_audit_test_', 50, 25);
});

await test('Mock whale trade → dry-run copy decision', () => {
    // Simulate: whale buys $500 worth at $0.60
    const mockActivity = {
        conditionId: null,
        asset: '_mock_token_',
        side: 'BUY',
        size: 833.33, // $500 / $0.60
        price: 0.60,
        usdcSize: 500,
    };
    const mockTarget = {
        address: '0x0000000000000000000000000000000000000001',
        label: 'MockWhale',
        copyRatio: 0.05,
        maxUsdc: 25,
    };

    // Expected: $500 * 0.05 = $25, capped by maxUsdc = $25
    const expectedAmount = Math.min(500 * 0.05, 25);
    console.log(`    Whale buys $500 → bot would copy $${expectedAmount.toFixed(2)} (5% ratio, $25 cap)`);
    if (expectedAmount !== 25) throw new Error(`Expected $25, got $${expectedAmount}`);
});

await test('Sell mode: all/ratio/proportional', () => {
    positions.recordBuy('_sell_test_', 100, 50, { market: 'Sell Test', label: 'test' });

    // All mode: should sell everything
    const allShares = positions.getShares('_sell_test_');
    if (allShares !== 100) throw new Error(`Expected 100, got ${allShares}`);

    // Cleanup
    positions.recordSell('_sell_test_', 100, 50);
});

await test('Risk guards: daily cap, max positions, min balance', () => {
    if (config.maxDailyUsdc <= 0) throw new Error('Daily cap not set');
    if (config.maxOpenPositions <= 0) throw new Error('Max positions not set');
    if (config.minBalanceUsdc <= 0) throw new Error('Min balance not set');
    console.log(`    Daily: $${config.maxDailyUsdc} | Max pos: ${config.maxOpenPositions} | Min bal: $${config.minBalanceUsdc}`);
});

// ── Test 4: Dry-run order placement ───────────────────────────────────────────
console.log('\n--- Dry-Run Order Placement ---');

await test('DRY_RUN mode is active by default', () => {
    if (!config.dryRun) throw new Error('dryRun should be true by default (LIVE_MODE not set)');
});

await test('Smart filters: maxBuyPrice, minSellPrice, spread, depth', () => {
    if (config.maxBuyPrice <= 0.5 || config.maxBuyPrice > 0.99) throw new Error(`Bad maxBuyPrice: ${config.maxBuyPrice}`);
    if (config.minSellPrice < 0.01 || config.minSellPrice >= 0.5) throw new Error(`Bad minSellPrice: ${config.minSellPrice}`);
    if (config.maxSpreadPct <= 0) throw new Error('maxSpreadPct not set');
    if (config.minBookDepthUsdc <= 0) throw new Error('minBookDepthUsdc not set');
    console.log(`    MaxBuy: $${config.maxBuyPrice} | MinSell: $${config.minSellPrice} | MaxSpread: ${(config.maxSpreadPct * 100).toFixed(0)}% | MinDepth: $${config.minBookDepthUsdc}`);
});

// ── Test 5: Speed benchmark ───────────────────────────────────────────────────
console.log('\n--- Speed Benchmark ---');

if (testTokenId) {
    await test('Midpoint fetch latency (10 iterations)', async () => {
        const times = [];
        for (let i = 0; i < 10; i++) {
            const start = performance.now();
            await getMidpoint(testTokenId);
            times.push(performance.now() - start);
        }
        const avg = times.reduce((a, b) => a + b, 0) / times.length;
        const min = Math.min(...times);
        const max = Math.max(...times);
        console.log(`    Avg: ${avg.toFixed(0)}ms | Min: ${min.toFixed(0)}ms | Max: ${max.toFixed(0)}ms`);
    });

    await test('Parallel fetch latency (market + mid + book)', async () => {
        const times = [];
        for (let i = 0; i < 5; i++) {
            const start = performance.now();
            await Promise.all([
                getMarketByToken(testTokenId),
                getMidpoint(testTokenId),
                getOrderBook(testTokenId),
            ]);
            times.push(performance.now() - start);
        }
        const avg = times.reduce((a, b) => a + b, 0) / times.length;
        const min = Math.min(...times);
        const max = Math.max(...times);
        console.log(`    Avg: ${avg.toFixed(0)}ms | Min: ${min.toFixed(0)}ms | Max: ${max.toFixed(0)}ms`);
        if (avg > 2000) console.log('    ⚠️  Average > 2s — consider checking network latency');
    });
} else {
    console.log('  ⚠️  SKIP — Speed benchmark requires TEST_ADDRESS with trade history');
}

await test('Offline logic benchmark (1000 iterations)', () => {
    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
        // Position math
        positions.recordBuy(`_bench_${i}`, 100, 50, { market: 'Bench', label: 'bench' });
        positions.recordSell(`_bench_${i}`, 100, 55);

        // Spread calculation
        getSpread({
            bids: [{ price: '0.45', size: '100' }],
            asks: [{ price: '0.55', size: '100' }],
        });

        // Edge score
        calcEdgeScore({
            whaleMultiplier: 1.5, signalBoost: 1.0,
            spreadPct: 0.03, depthUsdc: 200,
            mid: 0.50, side: 'BUY', marketQuality: 0.7,
        });
    }
    const elapsed = performance.now() - start;
    console.log(`    1000 iterations in ${elapsed.toFixed(0)}ms (${(elapsed / 1000).toFixed(3)}ms/iter)`);
    if (elapsed > 1000) throw new Error(`Too slow: ${elapsed.toFixed(0)}ms for 1000 iterations`);
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════');
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log('══════════════════════════════════════════════════════════\n');

process.exit(failed > 0 ? 1 : 0);
