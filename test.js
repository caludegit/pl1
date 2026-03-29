// src/test.js — Comprehensive connectivity & feature test
//
// Usage: node src/test.js

import { ethers } from 'ethers';
import config from './config.js';
import {
    fetchActivity, getMarketByToken, extractMarketParams,
    getMidpoint, getOrderBook, getExecutionPriceFromBook,
    fetchPositions, fetchBalance, isMarketActive, passesMarketFilter,
} from './api.js';
import { positions } from './positions.js';

const address = config.testAddress;

let passed = 0;
let failed = 0;

async function check(title, fn) {
    process.stdout.write(`  ${title}... `);
    try {
        const result = await fn();
        console.log('OK');
        passed++;
        return result;
    } catch (err) {
        console.log(`FAIL  ${err.message}`);
        failed++;
        return null;
    }
}

async function test() {
    console.log('\n  ====================================================');
    console.log('  Polymarket Copy-Trader v7.0 — Test Suite');
    console.log('  ====================================================\n');

    // 1. Config
    console.log('  [Config]');
    const errors = config.validate();
    if (errors.length === 0) { console.log('  OK Config valid'); passed++; }
    else { errors.forEach(e => console.log(`  FAIL ${e}`)); failed++; }
    console.log(`  dryRun=${config.dryRun}  targets=${config.targets.length}  copySells=${config.copySells}  sellMode=${config.sellMode}`);
    console.log(`  env: PRIVATE_KEY=${config.privateKey ? 'set' : 'empty'}  WSS_URL=${config.wssUrl ? 'set' : 'empty'}`);
    console.log('');

    // 2. RPC
    console.log('  [RPC]');
    await check('Connect to Polygon', async () => {
        const provider = config.wssUrl
            ? new ethers.providers.WebSocketProvider(config.wssUrl)
            : new ethers.providers.JsonRpcProvider(config.rpcUrl);
        const net = await provider.getNetwork();
        if (net.chainId !== 137) throw new Error(`Expected chainId 137, got ${net.chainId}`);
        provider.destroy?.();
    });
    console.log('');

    // 3. Position manager
    console.log('  [Position Manager]');
    await check('Load from disk', () => positions.load());
    await check('Buy/sell/P&L tracking', async () => {
        positions.recordBuy('_test_token_', 100, 50, { market: 'Test', label: 'test' });
        const pos = positions.getPosition('_test_token_');
        if (!pos || Math.abs(pos.shares - 100) > 0.01) throw new Error('Buy failed');
        if (Math.abs(pos.avgEntry - 0.5) > 0.01) throw new Error('Avg entry wrong');

        const pnl = positions.recordSell('_test_token_', 50, 30);
        if (Math.abs(pnl - 5) > 0.01) throw new Error(`P&L wrong: expected ~$5, got $${pnl.toFixed(2)}`);

        // cleanup
        positions.recordSell('_test_token_', 50, 25);
        process.stdout.write(`P&L=$${pnl.toFixed(2)}  `);
    });
    console.log('');

    // 4-7 need test address
    if (!address) {
        console.log('  No testAddress — skipping API checks.\n');
        _summary();
        return;
    }

    // 4. Data API
    console.log(`  [Data API — ${address.slice(0, 10)}...]`);
    const trades = await check('Recent trades', () => fetchActivity(address, { limit: 5 }));
    if (trades) {
        for (const t of trades.slice(0, 2)) {
            console.log(`    [${t.side}] $${t.price} x ${t.size} "${(t.title || '').slice(0, 40)}"`);
        }
    }

    await check('On-chain positions', async () => {
        const pos = await fetchPositions(address);
        process.stdout.write(`${Array.isArray(pos) ? pos.length : 0} position(s)  `);
    });

    await check('USDC balance', async () => {
        const bal = await fetchBalance(address);
        process.stdout.write(`$${bal != null ? bal.toFixed(2) : 'N/A'}  `);
    });
    console.log('');

    if (!trades?.length) {
        console.log('  No trades — skipping market checks.\n');
        _summary();
        return;
    }

    const first = trades[0];

    // 5. Gamma
    console.log('  [Gamma API]');
    const market = await check('Market metadata', async () => {
        const m = await getMarketByToken(first.asset);
        const { tickSize, negRisk } = extractMarketParams(m);
        console.log(`\n    "${(m.question || m.title || '').slice(0, 55)}"`);
        process.stdout.write(`    tick=${tickSize} negRisk=${negRisk}  `);
        return m;
    });

    if (market) {
        await check('Market active check', () => {
            const active = isMarketActive(market);
            process.stdout.write(`active=${active}  `);
            return active;
        });
        await check('Market filter check', () => {
            const passes = passesMarketFilter(market);
            process.stdout.write(`passes=${passes}  `);
            return passes;
        });
    }
    console.log('');

    // 6. CLOB
    if (first.asset) {
        console.log('  [CLOB API]');
        const mid = await check('Midpoint', async () => {
            const m = await getMidpoint(first.asset);
            process.stdout.write(`$${m}  `);
            return m;
        });

        const buyExec = await check('$10 BUY estimate', async () => {
            const b = await getOrderBook(first.asset);
            const exec = getExecutionPriceFromBook(b, 'BUY', 10);
            if (!exec) throw new Error('No ask liquidity');
            process.stdout.write(`avg $${exec.avgPrice.toFixed(4)} | ${exec.wouldFill.toFixed(2)} shares  `);
            return exec;
        });

        await check('10 shares SELL estimate', async () => {
            const b = await getOrderBook(first.asset);
            const exec = getExecutionPriceFromBook(b, 'SELL', 10);
            if (!exec) throw new Error('No bid liquidity');
            process.stdout.write(`avg $${exec.avgPrice.toFixed(4)} | ${exec.wouldFill.toFixed(2)} shares  `);
            return exec;
        });

        if (mid && buyExec) {
            const slip = Math.abs(buyExec.avgPrice - mid) / mid * 100;
            console.log(`    Slippage vs mid: ${slip.toFixed(2)}%`);
        }
        console.log('');
    }

    _summary();
}

function _summary() {
    console.log('  ====================================================');
    console.log(`  Results: ${passed} passed, ${failed} failed`);
    console.log('  ====================================================\n');
    process.exit(failed > 0 ? 1 : 0);
}

test().catch(err => {
    console.error('\n[ERROR]', err.message);
    process.exit(1);
});
