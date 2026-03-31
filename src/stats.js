// src/stats.js — Runtime statistics with persistence
//
// Persists to disk on shutdown and loads on startup so stats survive restarts.

import config from './config.js';
import * as log from './logger.js';
import { JsonStore } from './store.js';

class Stats {
    constructor() {
        this._reset();
        this._interval = null;
        this._store = new JsonStore(config.statsFile, { tag: 'STATS' });
    }

    _reset() {
        this.startedAt  = Date.now();
        this.events     = 0;
        this.buyEvents  = 0;
        this.sellEvents = 0;
        this.trades     = { attempted: 0, filled: 0, rejected: 0, skipped: 0, errors: 0 };
        this.buys       = { filled: 0, totalUsdc: 0 };
        this.sells      = { filled: 0, totalUsdc: 0 };
        this.byTarget   = new Map();
        this.byReason   = new Map();
    }

    _ensureTarget(label) {
        if (!this.byTarget.has(label)) {
            this.byTarget.set(label, {
                events: 0, filled: 0, skipped: 0, totalUsdc: 0, rejections: 0, errors: 0,
                buys: { filled: 0, totalUsdc: 0 },
                sells: { filled: 0, totalUsdc: 0 },
            });
        }
        const t = this.byTarget.get(label);
        // Ensure sub-objects exist (guards against corrupted/old stats files)
        if (!t.buys)  t.buys  = { filled: 0, totalUsdc: 0 };
        if (!t.sells) t.sells = { filled: 0, totalUsdc: 0 };
        return t;
    }

    // ── Record events ─────────────────────────────────────────────────────
    recordEvent(label, side) {
        this.events++;
        if (side === 'BUY') this.buyEvents++;
        else if (side === 'SELL') this.sellEvents++;
        this._ensureTarget(label).events++;
    }

    recordTrade(label, result, usdcAmount = 0, side = '') {
        this.trades.attempted++;
        const t = this._ensureTarget(label);
        const effectiveSide = result.side || side;
        const isFilled = result.ok || result.dryRun;

        if (isFilled && result.amount !== 0) {
            this.trades.filled++;
            t.filled++;
            t.totalUsdc += usdcAmount;
            if (effectiveSide === 'BUY') {
                this.buys.filled++;  this.buys.totalUsdc += usdcAmount;
                t.buys.filled++;     t.buys.totalUsdc += usdcAmount;
            } else if (effectiveSide === 'SELL') {
                this.sells.filled++; this.sells.totalUsdc += usdcAmount;
                t.sells.filled++;    t.sells.totalUsdc += usdcAmount;
            }
        } else if (result.error) {
            if (result.error.toLowerCase().includes('reject')) {
                this.trades.rejected++; t.rejections++;
            } else {
                this.trades.errors++; t.errors++;
            }
        } else {
            this.trades.skipped++; t.skipped++;
            const reason = result.reason || 'unknown';
            this.byReason.set(reason, (this.byReason.get(reason) || 0) + 1);
        }
    }

    // ── Persistence ───────────────────────────────────────────────────────
    async load() {
        try {
            const data = await this._store.load();
            if (!data) return;
            // Restore previous session stats (replace, don't accumulate — prevents double-counting)
            this.events     = data.events || 0;
            this.buyEvents  = data.buyEvents || 0;
            this.sellEvents = data.sellEvents || 0;
            for (const [k, v] of Object.entries(data.trades || {})) {
                this.trades[k] = v || 0;
            }
            this.buys.filled    = data.buys?.filled || 0;
            this.buys.totalUsdc = data.buys?.totalUsdc || 0;
            this.sells.filled    = data.sells?.filled || 0;
            this.sells.totalUsdc = data.sells?.totalUsdc || 0;
            if (data.byTarget) {
                for (const [label, s] of Object.entries(data.byTarget)) {
                    this.byTarget.set(label, { ...s });
                }
            }
            if (data.byReason) {
                for (const [reason, count] of Object.entries(data.byReason)) {
                    this.byReason.set(reason, count);
                }
            }
            log.info('STATS', `Loaded stats: ${this.events} events, ${this.trades.filled} fills`);
        } catch (err) {
            log.warn('STATS', `Load failed: ${err.message}`);
        }
    }

    async save() {
        this._store.scheduleSave(() => this.getSummary());
        await this._store.flush();
    }

    // ── Reporting ─────────────────────────────────────────────────────────
    startReporting(intervalMs = 300_000) {
        this._interval = setInterval(() => this.print(), intervalMs);
        this._interval.unref();
    }

    stop() { clearInterval(this._interval); }

    uptime() {
        const ms = Date.now() - this.startedAt;
        const h = Math.floor(ms / 3_600_000);
        const m = Math.floor((ms % 3_600_000) / 60_000);
        return `${h}h ${m}m`;
    }

    getSummary() {
        return {
            uptimeMs: Date.now() - this.startedAt,
            events: this.events, buyEvents: this.buyEvents, sellEvents: this.sellEvents,
            trades: { ...this.trades },
            buys: { ...this.buys }, sells: { ...this.sells },
            byTarget: Object.fromEntries([...this.byTarget.entries()].map(([k, v]) => [k, { ...v }])),
            byReason: Object.fromEntries(this.byReason),
        };
    }

    print() {
        const W = 60;
        const ln = (s) => `  ${String(s).padEnd(W)}`;

        console.log(`\n  ${'─'.repeat(W)}`);
        console.log(ln(`STATS — ${new Date().toISOString().slice(0, 16)} — up ${this.uptime()}`));
        console.log(`  ${'─'.repeat(W)}`);
        console.log(ln(`Events:    ${this.events} (${this.buyEvents} buys, ${this.sellEvents} sells)`));
        console.log(ln(`Filled:    ${this.trades.filled}  Skipped: ${this.trades.skipped}  Rejected: ${this.trades.rejected}  Errors: ${this.trades.errors}`));
        console.log(ln(`Buys:      ${this.buys.filled} filled — $${this.buys.totalUsdc.toFixed(2)} spent`));
        console.log(ln(`Sells:     ${this.sells.filled} filled — $${this.sells.totalUsdc.toFixed(2)} value`));

        if (this.byReason.size > 0) {
            const reasons = [...this.byReason.entries()].map(([r, c]) => `${r}:${c}`).join('  ');
            console.log(ln(`Skips:     ${reasons}`));
        }

        if (this.byTarget.size > 0) {
            console.log(`  ${'─'.repeat(W)}`);
            for (const [label, s] of this.byTarget) {
                console.log(ln(`${label}  events:${s.events}  filled:${s.filled}  skipped:${s.skipped}`));
                console.log(ln(`  buys:${s.buys.filled}/$${s.buys.totalUsdc.toFixed(2)}  sells:${s.sells.filled}/$${s.sells.totalUsdc.toFixed(2)}`));
            }
        }
        console.log(`  ${'─'.repeat(W)}\n`);
    }
}

export const stats = new Stats();
