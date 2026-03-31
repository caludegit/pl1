// src/index.js — Entry point
//
// Polymarket Copy-Trader  v7.0  (Profit-Optimized)
//   - Smart entry filters (price, spread, liquidity)
//   - Multi-whale signal detection
//   - Smart order routing (YES↔NO comparison)
//   - Auto stop-loss & take-profit
//   - GTC limit order support
//   - In-flight balance tracking
//
// Usage:
//   PRIVATE_KEY=0x... WSS_URL=wss://... node src/index.js
//
// Runtime controls:
//   kill -USR1 <pid>     toggle dryRun
//   kill -USR2 <pid>     print stats + positions + portfolio

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import config from './config.js';
import { initTrader, placeCopyTrade, dryRunCopyTrade, getWalletAddress, getClient } from './trader.js';
import { OnChainMonitor } from './monitor.js';
import { startExitManager, stopExitManager } from './exit-manager.js';
import { whaleTracker } from './whale-tracker.js';
import { stats } from './stats.js';
import { positions } from './positions.js';
import * as log from './logger.js';

// ── Health file ───────────────────────────────────────────────────────────────
async function writeHealth() {
    try {
        const data = {
            alive: true,
            uptime: stats.uptime(),
            events: stats.events,
            filled: stats.trades.filled,
            positions: positions.getCount(),
            dryRun: config.dryRun,
            ts: new Date().toISOString(),
        };
        await mkdir(dirname(config.healthFile), { recursive: true });
        await writeFile(config.healthFile, JSON.stringify(data));
    } catch (err) {
        log.debug('HEALTH', `Health write failed: ${err.message}`);
    }
}

async function main() {
    // ── Validate ──────────────────────────────────────────────────────────
    const errors = config.validate();
    if (errors.length > 0) {
        console.error('[FATAL] Configuration errors:');
        errors.forEach(e => console.error(`  - ${e}`));
        console.error('\nEdit src/config.js or set env vars to fix.');
        process.exit(1);
    }

    // ── Banner ────────────────────────────────────────────────────────────
    console.log('');
    console.log('  ╔════════════════════════════════════════════════════════╗');
    console.log('  ║  Polymarket Copy-Trader  v7.0  (Profit-Optimized)     ║');
    console.log('  ║  Whale Tracking | Kelly Sizing | Advanced Exits       ║');
    console.log('  ╚════════════════════════════════════════════════════════╝');
    console.log('');
    if (config.killSwitch) {
        console.log('  ⚠  KILL SWITCH IS ON — no new trades will be placed');
    }
    console.log(`  Mode:          ${config.dryRun ? 'DRY-RUN (no real orders)' : 'LIVE'}`);
    console.log(`  Order mode:    ${config.orderMode.toUpperCase()}${config.orderMode === 'gtc' ? ` (${config.gtcOffsetPct * 100}% offset, ${config.gtcTimeoutMs / 1000}s timeout)` : ''}`);
    console.log(`  Slippage:      ${(config.slippage * 100).toFixed(1)}%`);
    console.log(`  Drift guard:   ${(config.maxPriceDrift * 100).toFixed(1)}%`);
    console.log(`  Cooldown:      ${config.cooldownMs / 1000}s`);
    console.log(`  Min order:     $${config.minOrderUsdc}`);
    console.log('');
    console.log('  Smart Filters:');
    console.log(`    Max buy price:  $${config.maxBuyPrice} (skip buys above this)`);
    console.log(`    Min sell price: $${config.minSellPrice} (hold sells below this)`);
    console.log(`    Max spread:     ${(config.maxSpreadPct * 100).toFixed(1)}% (skip illiquid)`);
    console.log(`    Min depth:      $${config.minBookDepthUsdc} (skip thin books)`);
    console.log(`    Smart routing:  ${config.useSmartRouting ? 'ON (YES↔NO comparison)' : 'OFF'}`);
    console.log('');
    console.log('  Risk Controls:');
    console.log(`    Daily cap:      ${config.maxDailyUsdc > 0 ? '$' + config.maxDailyUsdc : 'unlimited'}`);
    console.log(`    Max positions:  ${config.maxOpenPositions > 0 ? config.maxOpenPositions : 'unlimited'}`);
    console.log(`    Max per pos:    ${config.maxPositionUsdc > 0 ? '$' + config.maxPositionUsdc : 'unlimited'}`);
    console.log(`    Max per trade:  ${config.maxTradeUsdc > 0 ? '$' + config.maxTradeUsdc : 'unlimited'}`);
    console.log(`    Portfolio cap:  ${(config.maxPortfolioExposurePct * 100).toFixed(0)}% of bankroll`);
    console.log(`    Min balance:    $${config.minBalanceUsdc}`);
    console.log(`    Drawdown halt:  ${config.enableDrawdownBreaker ? '$' + config.maxDailyDrawdownUsdc + ' daily loss limit' : 'OFF'}`);
    console.log(`    Expiry filter:  ${config.minExpiryHours > 0 ? config.minExpiryHours + 'h minimum' : 'OFF'}`);
    console.log(`    Streak pause:   ${config.enableStreakCooldown ? config.maxLosingStreak + ' losses → ' + (config.streakCooldownMs / 60_000) + 'min cooldown' : 'OFF'}`);
    console.log('');
    console.log('  Auto-Exit:');
    console.log(`    Enabled:        ${config.enableAutoExit ? 'YES' : 'NO'}`);
    if (config.enableAutoExit) {
        console.log(`    Stop-loss:      ${(config.stopLossPct * 100).toFixed(0)}%`);
        console.log(`    Take-profit:    +${(config.takeProfitPct * 100).toFixed(0)}%`);
        console.log(`    Trailing stop:  ${config.enableTrailingStop ? `ON (${(config.trailingStopPct * 100).toFixed(0)}% pullback)` : 'OFF'}`);
        console.log(`    Check interval: ${config.exitCheckIntervalMs / 1000}s`);
    }
    console.log('');
    console.log('  Signal Detection:');
    console.log(`    Window:         ${config.signalWindowMs / 1000}s`);
    console.log(`    Boost:          x${config.signalBoostRatio} per whale (max x${config.signalMaxBoost})`);
    console.log('');
    console.log(`  Copy sells:    ${config.copySells ? 'YES' : 'NO'}`);
    console.log(`  Sell mode:     ${config.sellMode}`);
    console.log(`  Sell guard:    ${config.sellOnlyIfHeld ? 'only if held' : 'allow all'}`);
    console.log(`  Batch window:  ${config.txBatchWindowMs}ms`);
    console.log(`  Log level:     ${config.logLevel}`);
    console.log(`  RPC:           ${config.wssUrl ? 'WSS' : 'HTTP (slow!)'}`);
    console.log(`  Webhook:       ${config.webhookUrl ? 'configured' : 'none'}`);
    if (config.marketBlocklist.length > 0) {
        console.log(`  Blocklist:     ${config.marketBlocklist.join(', ')}`);
    }
    if (config.marketAllowlist.length > 0) {
        console.log(`  Allowlist:     ${config.marketAllowlist.join(', ')}`);
    }
    console.log('');
    console.log('  Targets:');
    for (const t of config.targets) {
        const overrides = [];
        if (t.sellMode) overrides.push(`sell:${t.sellMode}`);
        if (t.copySells != null) overrides.push(`copySells:${t.copySells}`);
        const extra = overrides.length ? ` [${overrides.join(', ')}]` : '';
        console.log(`    ${t.label.padEnd(16)} ${t.address.slice(0, 8)}...${t.address.slice(-4)} | ${t.copyRatio}x | max $${t.maxUsdc}${extra}`);
    }
    console.log('');

    // ── Load state ────────────────────────────────────────────────────────
    await positions.load();
    await stats.load();
    if (config.enableWhaleTracking) await whaleTracker.load();

    // ── Init trader ───────────────────────────────────────────────────────
    if (config.privateKey) {
        await initTrader();

        if (config.syncPositionsOnStart) {
            const addr = getWalletAddress();
            if (addr) {
                log.info('INIT', `Syncing positions for ${addr.slice(0, 8)}...${addr.slice(-4)}`);
                await positions.syncFromChain(addr);
            }
        }
    } else if (!config.dryRun) {
        console.error('[FATAL] Live mode requires PRIVATE_KEY env var or privateKey in config.js');
        process.exit(1);
    }

    positions.print();

    // ── SIGUSR1: toggle dryRun (works in all modes) ──────────────────────
    process.on('SIGUSR1', () => {
        config.dryRun = !config.dryRun;
        log.info('TRADE', `dryRun -> ${config.dryRun}`);
    });

    // ── Build target map ──────────────────────────────────────────────────
    const targetMap = new Map();
    for (const t of config.targets) targetMap.set(t.address, t);

    // ── Trade callback ────────────────────────────────────────────────────
    const wrappedCallback = async (target, activity) => {
        stats.recordEvent(target.label, activity.side);
        const fn = config.dryRun ? dryRunCopyTrade : placeCopyTrade;
        const result = await fn(target, activity);
        stats.recordTrade(target.label, result, activity.usdcSize || 0, activity.side);
        return result;
    };

    // ── Start monitor ─────────────────────────────────────────────────────
    const monitor = new OnChainMonitor(targetMap, wrappedCallback);
    await monitor.start();

    // ── Start auto-exit manager ───────────────────────────────────────────
    const traderClient = config.dryRun ? null : getClient();
    startExitManager(traderClient);

    // ── Periodic tasks ────────────────────────────────────────────────────
    stats.startReporting(300_000);
    const healthTimer = setInterval(writeHealth, 60_000);
    // ── Watchdog: warn if main loop goes silent ──────────────────────────
    let _lastEventTime = Date.now();
    // Patch stats.recordEvent to track last activity for watchdog
    const origRecordEvent = stats.recordEvent.bind(stats);
    stats.recordEvent = function(...args) {
        _lastEventTime = Date.now();
        return origRecordEvent(...args);
    };
    const watchdogTimer = setInterval(() => {
        const silenceMs = Date.now() - _lastEventTime;
        if (silenceMs > config.watchdogMaxSilenceMs) {
            log.warn('WATCHDOG', `No events for ${(silenceMs / 1000).toFixed(0)}s — check WSS connection`);
        }
    }, config.watchdogIntervalMs);
    watchdogTimer.unref();
    writeHealth();

    // ── Graceful shutdown ─────────────────────────────────────────────────
    let shuttingDown = false;
    const shutdown = async (signal) => {
        if (shuttingDown) return;
        shuttingDown = true;
        log.info('SHUTDOWN', signal);
        clearInterval(healthTimer);
        clearInterval(watchdogTimer);
        monitor.stop();
        stopExitManager();
        stats.stop();

        stats.print();
        positions.print();
        if (config.enableWhaleTracking) whaleTracker.print();

        await Promise.all([
            positions.flush(),
            stats.save(),
            config.enableWhaleTracking ? whaleTracker.flush() : Promise.resolve(),
            log.flushJournal(),
        ]);

        log.notify('shutdown', { signal, uptime: stats.uptime() });

        setTimeout(() => process.exit(0), 500);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    process.on('SIGUSR2', async () => {
        log.info('SIGNAL', 'Stats on demand');
        stats.print();
        positions.print();
        if (config.enableWhaleTracking) whaleTracker.print();
        try { await positions.printPortfolio(); } catch (e) {
            log.warn('SIGNAL', `Portfolio error: ${e.message}`);
        }
    });

    process.on('uncaughtException', (err) => {
        log.error('FATAL', `Uncaught: ${err.message}\n${err.stack}`);
        log.notify('crash', { error: err.message });
        shutdown('UNCAUGHT');
    });

    process.on('unhandledRejection', (reason) => {
        log.error('FATAL', `Unhandled rejection: ${reason}`);
        shutdown('UNHANDLED');
    });

    console.log('');
    log.info('READY', 'Listening for on-chain trades (BUY + SELL) with smart filters');
    console.log('  Ctrl+C = stop  |  kill -USR1 <pid> = toggle dryRun  |  kill -USR2 <pid> = stats');
    console.log('');

    log.notify('startup', {
        mode: config.dryRun ? 'dry-run' : 'live',
        targets: config.targets.length,
        positions: positions.getCount(),
        features: ['smart-filters', 'signal-boost', 'auto-exit', 'smart-routing'],
    });
}

main().catch(err => {
    console.error('[FATAL]', err.message);
    process.exit(1);
});
