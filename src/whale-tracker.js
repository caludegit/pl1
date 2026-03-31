// src/whale-tracker.js — Whale performance tracking & dynamic copy ratio
//
// THE SINGLE BIGGEST EDGE IN COPY TRADING:
// Track every whale's results, auto-adjust how much you copy them.
// Copy more from winners, less from losers, stop copying the worst.
//
// Features:
//   - Per-whale win rate, P&L, profit factor, Sharpe ratio
//   - Rolling performance window (decay old trades)
//   - Kelly criterion optimal sizing based on whale's track record
//   - Auto-boost/dampen copy ratios
//   - Persisted to disk across restarts
//   - Minimum sample size before adjusting

import config from './config.js';
import * as log from './logger.js';
import { JsonStore } from './store.js';

class WhaleTracker {
    constructor() {
        // Map<walletAddress, WhaleRecord>
        this.whales = new Map();
        this._store = new JsonStore(config.whaleTrackFile || 'data/whale-tracker.json', { debounceMs: 5_000, tag: 'WHALE' });
    }

    // ── WhaleRecord structure ──────────────────────────────────────────────
    _newRecord(address, label) {
        return {
            address,
            label,
            trades: [],           // { tokenId, side, entryPrice, exitPrice, pnlPct, usdcPnl, timestamp, market }
            totalTrades: 0,
            wins: 0,
            losses: 0,
            totalPnlUsdc: 0,
            avgPnlPct: 0,
            winRate: 0.5,         // default 50% until we have data
            profitFactor: 1.0,    // gross profit / gross loss
            currentStreak: 0,     // positive = win streak, negative = loss streak
            lastTradeAt: null,
            kellyFraction: 0.5,   // half-Kelly default
            copyMultiplier: 1.0,  // dynamic multiplier applied to copyRatio
        };
    }

    _ensure(address, label) {
        if (!this.whales.has(address)) {
            this.whales.set(address, this._newRecord(address, label));
        }
        return this.whales.get(address);
    }

    // ── Record a completed trade (called when position is closed) ──────────
    recordTrade(address, { tokenId, side, entryPrice, exitPrice, pnlPct, usdcPnl, market }) {
        const target = config.targets.find(t => t.address === address);
        const label = target?.label || address.slice(0, 10);
        const record = this._ensure(address, label);
        const now = Date.now();

        const trade = {
            tokenId, side, entryPrice, exitPrice,
            pnlPct: pnlPct || 0,
            usdcPnl: usdcPnl || 0,
            market: market || '',
            timestamp: now,
        };

        record.trades.push(trade);
        record.totalTrades++;
        record.lastTradeAt = now;

        // Trim old trades outside performance window
        const windowMs = config.whaleTrackWindowMs || 30 * 24 * 60 * 60_000; // 30 days default
        const cutoff = now - windowMs;
        record.trades = record.trades.filter(t => t.timestamp >= cutoff);

        // Recalculate stats from window
        this._recalculate(record);
        this._scheduleSave();

        log.info('WHALE', `${label}: trade #${record.totalTrades} | P&L: ${usdcPnl >= 0 ? '+' : ''}$${usdcPnl.toFixed(2)} (${(pnlPct * 100).toFixed(1)}%) | WR: ${(record.winRate * 100).toFixed(0)}% | Kelly: ${record.kellyFraction.toFixed(2)} | mult: x${record.copyMultiplier.toFixed(2)}`);
    }

    // ── Recalculate all stats from trade window ────────────────────────────
    _recalculate(record) {
        const trades = record.trades;
        if (trades.length === 0) {
            record.winRate = 0.5;
            record.profitFactor = 1.0;
            record.kellyFraction = 0.5;
            record.copyMultiplier = 1.0;
            return;
        }

        // Win/loss stats
        let wins = 0, losses = 0, grossProfit = 0, grossLoss = 0;
        let totalPnlPct = 0;

        for (const t of trades) {
            if (t.usdcPnl > 0) {
                wins++;
                grossProfit += t.usdcPnl;
            } else if (t.usdcPnl < 0) {
                losses++;
                grossLoss += Math.abs(t.usdcPnl);
            }
            totalPnlPct += t.pnlPct;
        }

        record.wins = wins;
        record.losses = losses;
        record.totalPnlUsdc = grossProfit - grossLoss;
        record.avgPnlPct = totalPnlPct / trades.length;

        // Win rate (with Bayesian smoothing: add 2 pseudo-observations at 50%)
        // This prevents extreme ratios from small samples
        const smoothedWins = wins + 1;
        const smoothedTotal = trades.length + 2;
        record.winRate = smoothedWins / smoothedTotal;

        // Profit factor (gross profit / gross loss)
        record.profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 10 : 1);

        // Streak
        let streak = 0;
        for (let i = trades.length - 1; i >= 0; i--) {
            const isWin = trades[i].usdcPnl > 0;
            if (i === trades.length - 1) {
                streak = isWin ? 1 : -1;
            } else {
                if (isWin && streak > 0) streak++;
                else if (!isWin && streak < 0) streak--;
                else break;
            }
        }
        record.currentStreak = streak;

        // ── Kelly Criterion for binary markets ────────────────────────────
        // f* = (p * b - q) / b
        // where p = win probability, q = 1-p, b = avg win / avg loss ratio
        // We use HALF-Kelly for safety (full Kelly is too aggressive)
        const p = record.winRate;
        const q = 1 - p;
        const avgWin = wins > 0 ? grossProfit / wins : 0;
        const avgLoss = losses > 0 ? grossLoss / losses : 1;
        const b = avgLoss > 0 ? avgWin / avgLoss : 1;

        let kelly = (p * b - q) / b;
        kelly = Math.max(0, Math.min(kelly, 0.5)); // cap at 50%
        // Half-Kelly for safety
        record.kellyFraction = kelly * 0.5;

        // ── Dynamic copy multiplier ────────────────────────────────────────
        // Based on: win rate + profit factor + streak
        // Min samples before adjusting: configurable (default 5)
        const minSamples = config.whaleMinTrades || 5;

        if (trades.length < minSamples) {
            // Not enough data — use default
            record.copyMultiplier = 1.0;
        } else {
            let mult = 1.0;

            // Win rate component: 0.5x at 30% WR, 1.0x at 50%, 2.0x at 70%+
            if (record.winRate >= 0.65) mult *= 1.5;
            else if (record.winRate >= 0.55) mult *= 1.2;
            else if (record.winRate >= 0.45) mult *= 1.0;
            else if (record.winRate >= 0.35) mult *= 0.5;
            else mult *= 0.2; // terrible whale, nearly stop copying

            // Profit factor component
            if (record.profitFactor >= 2.0) mult *= 1.3;
            else if (record.profitFactor >= 1.5) mult *= 1.1;
            else if (record.profitFactor < 0.7) mult *= 0.6;

            // Streak component (mild adjustment)
            if (record.currentStreak >= 3) mult *= 1.1;      // hot streak
            else if (record.currentStreak <= -3) mult *= 0.8; // cold streak

            // Clamp to reasonable range
            record.copyMultiplier = Math.max(
                config.whaleMinMultiplier || 0.1,
                Math.min(mult, config.whaleMaxMultiplier || 3.0)
            );
        }
    }

    // ── Get the dynamic copy multiplier for a whale ────────────────────────
    getMultiplier(address) {
        const record = this.whales.get(address);
        return record?.copyMultiplier ?? 1.0;
    }

    // ── Get Kelly fraction for a whale ─────────────────────────────────────
    getKellyFraction(address) {
        const record = this.whales.get(address);
        return record?.kellyFraction ?? 0.5;
    }

    // ── Get whale stats summary ────────────────────────────────────────────
    getStats(address) {
        return this.whales.get(address) || null;
    }

    // ── Get all whale summaries ────────────────────────────────────────────
    getAllStats() {
        return [...this.whales.values()].map(r => ({
            label: r.label,
            address: r.address,
            totalTrades: r.totalTrades,
            windowTrades: r.trades.length,
            wins: r.wins,
            losses: r.losses,
            winRate: r.winRate,
            profitFactor: r.profitFactor,
            totalPnlUsdc: r.totalPnlUsdc,
            avgPnlPct: r.avgPnlPct,
            kellyFraction: r.kellyFraction,
            copyMultiplier: r.copyMultiplier,
            currentStreak: r.currentStreak,
        }));
    }

    // ── Persistence ────────────────────────────────────────────────────────
    _scheduleSave() {
        this._store.scheduleSave(() => ({
            whales: Object.fromEntries(
                [...this.whales.entries()].map(([k, v]) => [k, {
                    ...v,
                    trades: v.trades.slice(-200),
                }])
            ),
            savedAt: new Date().toISOString(),
        }));
    }

    async flush() {
        await this._store.flush();
    }

    async load() {
        try {
            const data = await this._store.load();
            if (data?.whales) {
                for (const [address, record] of Object.entries(data.whales)) {
                    this.whales.set(address, {
                        ...this._newRecord(address, record.label),
                        ...record,
                    });
                    this._recalculate(this.whales.get(address));
                }
            }
            log.info('WHALE', `Loaded ${this.whales.size} whale record(s)`);
        } catch (err) {
            log.warn('WHALE', `Load failed: ${err.message}`);
        }
    }

    // ── Console output ─────────────────────────────────────────────────────
    print() {
        const stats = this.getAllStats();
        if (stats.length === 0) {
            console.log('\n  No whale performance data yet\n');
            return;
        }

        const W = 76;
        console.log(`\n  ${'═'.repeat(W)}`);
        console.log(`  WHALE PERFORMANCE TRACKER`);
        console.log(`  ${'═'.repeat(W)}`);

        // Sort by total P&L descending
        stats.sort((a, b) => b.totalPnlUsdc - a.totalPnlUsdc);

        for (const s of stats) {
            const pnlSign = s.totalPnlUsdc >= 0 ? '+' : '';
            const streakStr = s.currentStreak > 0 ? `W${s.currentStreak}` : s.currentStreak < 0 ? `L${Math.abs(s.currentStreak)}` : '-';
            console.log(`  ${s.label.padEnd(18)} WR:${(s.winRate*100).toFixed(0)}% | PF:${s.profitFactor.toFixed(1)} | P&L:${pnlSign}$${s.totalPnlUsdc.toFixed(2)} | Kelly:${s.kellyFraction.toFixed(2)} | mult:x${s.copyMultiplier.toFixed(1)} | ${streakStr} | ${s.windowTrades} trades`);
        }
        console.log(`  ${'═'.repeat(W)}\n`);
    }
}

export const whaleTracker = new WhaleTracker();
