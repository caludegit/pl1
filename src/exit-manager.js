// src/exit-manager.js — Advanced auto-exit position manager v7.0
//
// THE key to making money with copy trading — cut losers, let winners run:
//   - Stop-loss: cut losses at configurable threshold
//   - Take-profit: lock gains at configurable threshold
//   - Trailing stop: track high watermark, exit on pullback
//   - Profit ratchet: once up X%, NEVER go negative (breakeven floor)
//   - Time-based exit: stale positions eat capital — free it up
//   - EV-based exit: exit near-extreme prices (tiny edge left)

import { Side, OrderType } from '@polymarket/clob-client';
import config from './config.js';
import { positions } from './positions.js';
import { whaleTracker } from './whale-tracker.js';
import * as log from './logger.js';
import { getMidpoint, getOrderBook, getExecutionPriceFromBook, extractMarketParams, getMarketByToken } from './api.js';

let _timer = null;
let _running = false;
let _client = null;

// Trailing stop: track the highest value seen per position
// Map<tokenId, { highWaterMark: number, highMid: number }>
const _trailingState = new Map();

// Profit ratchet: once activated, position has a floor
// Map<tokenId, { activated: boolean, floorValue: number }>
const _ratchetState = new Map();

// Time tracking: record when each position last had significant price movement
// Map<tokenId, { lastMid: number, lastMoveAt: number }>
const _timeState = new Map();

export function startExitManager(client) {
    if (!config.enableAutoExit) return;
    _client = client;
    _timer = setInterval(() => _checkPositions(), config.exitCheckIntervalMs);
    log.info('EXIT', `Auto-exit enabled: SL ${(config.stopLossPct * 100).toFixed(0)}% / TP +${(config.takeProfitPct * 100).toFixed(0)}% / Trail ${(config.trailingStopPct * 100).toFixed(0)}%`);
    if (config.enableProfitRatchet) log.info('EXIT', `  Profit ratchet: activate at +${(config.ratchetThreshold * 100).toFixed(0)}%, floor at +${(config.ratchetFloor * 100).toFixed(0)}%`);
    if (config.enableTimeExit) log.info('EXIT', `  Time exit: ${config.timeExitHours}h stale threshold`);
    if (config.enableEvExit) log.info('EXIT', `  EV exit: sell if price > $${config.evExitMaxPrice} or < $${config.evExitMinPrice}`);
}

export function stopExitManager() {
    clearInterval(_timer);
    _timer = null;
}

async function _checkPositions() {
    if (_running) return;
    _running = true;

    try {
        const allPositions = positions.getAll();
        if (allPositions.length === 0) return;

        for (const pos of allPositions) {
            try {
                await _evaluatePosition(pos);
            } catch (err) {
                log.debug('EXIT', `Check failed for ...${pos.tokenId.slice(-12)}: ${err.message}`);
            }
        }
    } finally {
        _running = false;
    }
}

async function _evaluatePosition(pos) {
    const { tokenId, shares, costBasis, avgEntry, market: marketName } = pos;
    if (shares <= 0.0001 || costBasis <= 0) return;

    // Get live price
    let mid;
    try {
        mid = await getMidpoint(tokenId);
    } catch {
        return; // can't price it, skip
    }

    if (mid == null || mid <= 0) return;

    const currentValue = shares * mid;
    const pnlPct = (currentValue - costBasis) / costBasis;
    const pnlUsdc = currentValue - costBasis;

    // ── EV-BASED EXIT: exit near-extreme prices ──────────────────────────
    // If price is > 0.95, there's only 5c upside but huge downside if wrong
    // If price is < 0.05, it's likely going to zero — salvage what you can
    if (config.enableEvExit) {
        if (mid >= config.evExitMaxPrice) {
            log.info('EXIT', `EV-EXIT "${(marketName || tokenId).slice(0, 40)}" — price $${mid.toFixed(4)} near max (lock in gains)`);
            await _exitPosition(pos, mid, 'ev_exit_high');
            _cleanup(tokenId);
            return;
        }
        if (mid <= config.evExitMinPrice && pnlPct < -0.10) {
            log.info('EXIT', `EV-EXIT "${(marketName || tokenId).slice(0, 40)}" — price $${mid.toFixed(4)} near zero (salvage)`);
            await _exitPosition(pos, mid, 'ev_exit_low');
            _cleanup(tokenId);
            return;
        }
    }

    // ── STOP-LOSS: exit if position is down past threshold ────────────────
    // Check profit ratchet floor first — if ratchet is active, use ratchet floor
    if (config.enableProfitRatchet) {
        const ratchet = _ratchetState.get(tokenId);
        if (ratchet?.activated && pnlPct <= config.ratchetFloor) {
            log.info('EXIT', `RATCHET-EXIT "${(marketName || tokenId).slice(0, 40)}" — profit dropped to +${(pnlPct * 100).toFixed(1)}%, floor was +${(config.ratchetFloor * 100).toFixed(0)}%`);
            await _exitPosition(pos, mid, 'profit_ratchet');
            _cleanup(tokenId);
            return;
        }
        // Activate ratchet if past threshold
        if (!ratchet?.activated && pnlPct >= config.ratchetThreshold) {
            _ratchetState.set(tokenId, { activated: true, floorValue: costBasis * (1 + config.ratchetFloor) });
            log.info('EXIT', `RATCHET ACTIVATED "${(marketName || tokenId).slice(0, 35)}" — +${(pnlPct * 100).toFixed(1)}% profit protected`);
        }
    }

    // Regular stop-loss (only if ratchet not active or not yet triggered)
    if (pnlPct <= config.stopLossPct) {
        log.info('EXIT', `STOP-LOSS "${(marketName || tokenId).slice(0, 40)}" — down ${(pnlPct * 100).toFixed(1)}% ($${pnlUsdc.toFixed(2)})`);
        await _exitPosition(pos, mid, 'stop_loss');
        _cleanup(tokenId);
        return;
    }

    // ── TAKE-PROFIT: exit if position is up past threshold ────────────────
    if (pnlPct >= config.takeProfitPct) {
        log.info('EXIT', `TAKE-PROFIT "${(marketName || tokenId).slice(0, 40)}" — up +${(pnlPct * 100).toFixed(1)}% (+$${pnlUsdc.toFixed(2)})`);
        await _exitPosition(pos, mid, 'take_profit');
        _cleanup(tokenId);
        return;
    }

    // ── TRAILING STOP: once in profit, track the high and exit on pullback ──
    if (config.enableTrailingStop && pnlPct > 0) {
        if (!_trailingState.has(tokenId)) {
            _trailingState.set(tokenId, { highWaterMark: currentValue, highMid: mid });
        }
        const ts = _trailingState.get(tokenId);
        if (currentValue > ts.highWaterMark) {
            ts.highWaterMark = currentValue;
            ts.highMid = mid;
        }
        // If price dropped trailingStopPct from the high, exit
        const dropFromHigh = (ts.highWaterMark - currentValue) / ts.highWaterMark;
        if (dropFromHigh >= config.trailingStopPct && pnlPct > 0.05) {
            log.info('EXIT', `TRAILING-STOP "${(marketName || tokenId).slice(0, 40)}" — dropped ${(dropFromHigh * 100).toFixed(1)}% from high (+$${pnlUsdc.toFixed(2)} profit locked)`);
            await _exitPosition(pos, mid, 'trailing_stop');
            _cleanup(tokenId);
            return;
        }
    }

    // ── TIME-BASED EXIT: free capital from stale positions ────────────────
    if (config.enableTimeExit) {
        const now = Date.now();
        if (!_timeState.has(tokenId)) {
            _timeState.set(tokenId, { lastMid: mid, lastMoveAt: now });
        }
        const ts = _timeState.get(tokenId);
        const priceMovePct = Math.abs(mid - ts.lastMid) / ts.lastMid;
        if (priceMovePct >= config.timeExitMinMovePct) {
            // Price moved significantly — reset the clock
            ts.lastMid = mid;
            ts.lastMoveAt = now;
        }
        const hoursStale = (now - ts.lastMoveAt) / (60 * 60_000);
        if (hoursStale >= config.timeExitHours) {
            log.info('EXIT', `TIME-EXIT "${(marketName || tokenId).slice(0, 40)}" — stale for ${hoursStale.toFixed(0)}h (P&L: ${pnlPct >= 0 ? '+' : ''}${(pnlPct * 100).toFixed(1)}%)`);
            await _exitPosition(pos, mid, 'time_exit');
            _cleanup(tokenId);
            return;
        }
    }
}

function _cleanup(tokenId) {
    _trailingState.delete(tokenId);
    _ratchetState.delete(tokenId);
    _timeState.delete(tokenId);
}

async function _exitPosition(pos, mid, reason) {
    const { tokenId, shares, market: marketName, copiedFrom } = pos;
    const TAG = 'EXIT';

    if (!_client) {
        log.info(TAG, `[DRY] Would sell ${shares.toFixed(4)} shares @ $${mid.toFixed(4)} (${reason})`);
        // Still record in dry-run
        const estUsdc = shares * mid;
        const pnl = positions.recordSell(tokenId, shares, estUsdc);
        log.info(TAG, `[DRY] Realized P&L: $${pnl.toFixed(2)}`);

        // Record for whale tracking
        if (config.enableWhaleTracking && copiedFrom) {
            const target = config.targets.find(t => t.label === copiedFrom);
            if (target) {
                whaleTracker.recordTrade(target.address, {
                    tokenId, side: 'SELL', entryPrice: pos.avgEntry, exitPrice: mid,
                    pnlPct: pos.avgEntry > 0 ? (mid - pos.avgEntry) / pos.avgEntry : 0,
                    usdcPnl: pnl, market: marketName,
                });
            }
        }
        return;
    }

    try {
        // Get market params for order
        const market = await getMarketByToken(tokenId);
        const { tickSize, negRisk } = extractMarketParams(market);
        const tick = parseFloat(tickSize);

        // Worst price for sell: floor to tick, clamp to valid range [tick, 1-tick]
        const decimals = tickSize.split('.')[1]?.length || 2;
        const rawWorst = Math.max(tick, mid * (1 - config.slippage));
        const aligned = Math.floor(rawWorst / tick) * tick;
        const worstPrice = parseFloat(Math.max(tick, Math.min(aligned, 1 - tick)).toFixed(decimals));

        const result = await _client.createAndPostMarketOrder(
            { tokenID: tokenId, side: Side.SELL, amount: parseFloat(shares.toFixed(4)), price: worstPrice, feeRateBps: 0 },
            { tickSize, negRisk },
            OrderType.FAK,
        );

        if (result?.error) {
            log.warn(TAG, `${reason} sell failed: ${result.error}`);
            return;
        }

        const estUsdc = shares * mid;
        const pnl = positions.recordSell(tokenId, shares, estUsdc);
        const orderId = result?.orderID ?? result?.orderHash ?? 'unknown';

        log.info(TAG, `${reason.toUpperCase()} FILLED ${orderId} — P&L: $${pnl.toFixed(2)}`);
        log.trade(TAG, {
            side: 'SELL', market: marketName, action: 'filled',
            orderID: orderId, amount: shares, reason, pnl,
        });
        log.notify(`auto_${reason}`, {
            market: marketName, shares, mid, pnl, orderId,
        });

        // Record for whale tracking
        if (config.enableWhaleTracking && copiedFrom) {
            const target = config.targets.find(t => t.label === copiedFrom);
            if (target) {
                whaleTracker.recordTrade(target.address, {
                    tokenId, side: 'SELL', entryPrice: pos.avgEntry, exitPrice: mid,
                    pnlPct: pos.avgEntry > 0 ? (mid - pos.avgEntry) / pos.avgEntry : 0,
                    usdcPnl: pnl, market: marketName,
                });
            }
        }

    } catch (err) {
        log.error(TAG, `${reason} execution error: ${err.message}`);
    }
}
