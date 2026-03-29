// src/positions.js — Position manager with P&L, persistence, chain sync
//
// Tracks every position with:
//   - Cost basis and average entry price
//   - Realized P&L on partial/full sells
//   - Market name and which target triggered it
//   - Entry/exit timestamps
//   - Persists to disk (debounced) and syncs from chain on startup

import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import config from './config.js';
import { fetchPositions, getMidpoint } from './api.js';
import * as log from './logger.js';

const SAVE_DEBOUNCE = 2_000;

class PositionManager {
    constructor() {
        this.positions = new Map();   // tokenId → position
        this._closedPnl = 0;         // accumulated P&L from fully exited positions
        this._saveTimer = null;
        this._dirty = false;
        this._syncing = false;       // mutex: true while chain sync is running
    }

    // ── Load from disk ─────────────────────────────────────────────────────
    async load() {
        try {
            const raw = await readFile(config.positionFile, 'utf-8');
            const data = JSON.parse(raw);
            if (data.positions) {
                for (const p of data.positions) {
                    if (p.tokenId && p.shares > 0) this.positions.set(p.tokenId, p);
                }
            }
            this._closedPnl = data.closedPnl || 0;
            log.info('POS', `Loaded ${this.positions.size} position(s), closed P&L: $${this._closedPnl.toFixed(2)}`);
        } catch (err) {
            if (err.code !== 'ENOENT') log.warn('POS', `Load failed: ${err.message}`);
            else log.info('POS', 'Starting with empty position book');
        }
    }

    // ── Save to disk (debounced) ───────────────────────────────────────────
    _scheduleSave() {
        this._dirty = true;
        if (this._saveTimer) return;
        this._saveTimer = setTimeout(() => {
            this._saveTimer = null;
            this._doSave();
        }, SAVE_DEBOUNCE);
        // Don't prevent process exit in CLI scripts (show-positions, simulate, etc.)
        this._saveTimer.unref();
    }

    async _doSave() {
        if (!this._dirty) return;
        this._dirty = false;
        const payload = {
            closedPnl: this._closedPnl,
            positions: [...this.positions.values()],
            savedAt: new Date().toISOString(),
        };
        try {
            await mkdir(dirname(config.positionFile), { recursive: true });
            await writeFile(config.positionFile, JSON.stringify(payload, null, 2));
        } catch (err) {
            log.warn('POS', `Save failed: ${err.message}`);
        }
    }

    async flush() {
        clearTimeout(this._saveTimer);
        this._saveTimer = null;
        await this._doSave();
    }

    // ── Sync from chain (with mutex to prevent race with recordBuy/recordSell) ─
    async syncFromChain(walletAddress) {
        if (!walletAddress) return;
        if (this._syncing) {
            log.warn('POS', 'Chain sync already running, skipping');
            return;
        }
        this._syncing = true;
        try {
            const onChain = await fetchPositions(walletAddress);
            if (!Array.isArray(onChain)) return;

            let synced = 0;
            const onChainTokens = new Set();

            for (const pos of onChain) {
                const tokenId = pos.asset || pos.token_id || pos.tokenId;
                const shares = parseFloat(pos.size || pos.shares || pos.amount || 0);
                if (!tokenId || shares <= 0) continue;
                onChainTokens.add(tokenId);

                if (!this.positions.has(tokenId)) {
                    this.positions.set(tokenId, {
                        tokenId, shares,
                        costBasis: 0, avgEntry: 0, realizedPnl: 0,
                        market: pos.title || pos.question || '',
                        firstBuyAt: new Date().toISOString(),
                        lastUpdateAt: new Date().toISOString(),
                        copiedFrom: 'chain-sync',
                    });
                    synced++;
                } else {
                    const local = this.positions.get(tokenId);
                    if (Math.abs(local.shares - shares) > 0.0001) {
                        local.shares = shares;
                        local.lastUpdateAt = new Date().toISOString();
                        synced++;
                    }
                }
            }

            // Remove local positions not on chain
            for (const tokenId of this.positions.keys()) {
                if (!onChainTokens.has(tokenId)) {
                    this.positions.delete(tokenId);
                    synced++;
                }
            }

            if (synced > 0) this._scheduleSave();
            log.info('POS', `Chain sync: ${this.positions.size} position(s), ${synced} updated`);
        } catch (err) {
            log.warn('POS', `Chain sync failed: ${err.message} — using local state`);
        } finally {
            this._syncing = false;
        }
    }

    // ── Record BUY ─────────────────────────────────────────────────────────
    recordBuy(tokenId, shares, usdcSpent, { market = '', label = '' } = {}) {
        const now = new Date().toISOString();
        if (this.positions.has(tokenId)) {
            const pos = this.positions.get(tokenId);
            pos.costBasis += usdcSpent;
            pos.shares += shares;
            pos.avgEntry = pos.shares > 0 ? pos.costBasis / pos.shares : 0;
            pos.lastUpdateAt = now;
            if (market) pos.market = market;
        } else {
            this.positions.set(tokenId, {
                tokenId, shares,
                costBasis: usdcSpent,
                avgEntry: shares > 0 ? usdcSpent / shares : 0,
                realizedPnl: 0,
                market, firstBuyAt: now, lastUpdateAt: now, copiedFrom: label,
            });
        }
        this._scheduleSave();
    }

    // ── Record SELL — returns realized P&L for this sell ───────────────────
    recordSell(tokenId, sharesSold, usdcReceived) {
        const pos = this.positions.get(tokenId);
        if (!pos) return 0;

        const costOfSold = pos.avgEntry * sharesSold;
        const realized = usdcReceived - costOfSold;
        pos.realizedPnl += realized;
        pos.shares -= sharesSold;
        pos.costBasis = Math.max(0, pos.costBasis - costOfSold);
        pos.lastUpdateAt = new Date().toISOString();

        if (pos.shares <= 0.0001) {
            // Fully exited — accumulate closed P&L and remove
            this._closedPnl += pos.realizedPnl;
            this.positions.delete(tokenId);
        } else {
            pos.avgEntry = pos.shares > 0 ? pos.costBasis / pos.shares : 0;
        }

        this._scheduleSave();
        return realized;
    }

    // ── Queries ────────────────────────────────────────────────────────────
    getPosition(tokenId)  { return this.positions.get(tokenId) || null; }
    getShares(tokenId)    { return this.positions.get(tokenId)?.shares || 0; }
    hasPosition(tokenId)  { return (this.positions.get(tokenId)?.shares || 0) > 0.0001; }
    getAll()              { return [...this.positions.values()]; }
    getCount()            { return this.positions.size; }

    getTotalCostBasis() {
        let s = 0; for (const p of this.positions.values()) s += p.costBasis; return s;
    }
    getTotalRealizedPnl() {
        let s = this._closedPnl;
        for (const p of this.positions.values()) s += p.realizedPnl;
        return s;
    }

    // ── Portfolio snapshot with live prices ─────────────────────────────────
    async getSnapshot() {
        const positions = this.getAll();
        if (positions.length === 0) {
            return {
                count: 0, totalCost: 0, totalValue: 0,
                unrealizedPnl: 0, realizedPnl: this._closedPnl, totalPnl: this._closedPnl,
                positions: [],
            };
        }

        const results = await Promise.allSettled(
            positions.map(async (pos) => {
                let mid = null;
                try { mid = await getMidpoint(pos.tokenId); } catch {}
                const value = mid != null ? pos.shares * mid : null;
                const unrealized = value != null ? value - pos.costBasis : null;
                return {
                    ...pos,
                    currentPrice: mid,
                    marketValue: value,
                    unrealizedPnl: unrealized,
                    unrealizedPct: unrealized != null && pos.costBasis > 0
                        ? (unrealized / pos.costBasis) * 100 : null,
                };
            })
        );

        const resolved = results.map(r => r.status === 'fulfilled' ? r.value : null).filter(Boolean);
        const totalCost = resolved.reduce((s, p) => s + p.costBasis, 0);
        const totalValue = resolved.reduce((s, p) => s + (p.marketValue ?? p.costBasis), 0);
        const unrealizedPnl = resolved.reduce((s, p) => s + (p.unrealizedPnl ?? 0), 0);
        const realizedPnl = this.getTotalRealizedPnl();

        return {
            count: resolved.length, totalCost, totalValue,
            unrealizedPnl, realizedPnl, totalPnl: realizedPnl + unrealizedPnl,
            positions: resolved,
        };
    }

    // ── Console output ─────────────────────────────────────────────────────
    print() {
        const positions = this.getAll();
        if (positions.length === 0) {
            console.log('\n  No open positions\n');
            return;
        }
        const W = 70;
        const line = (s) => `  ${String(s).padEnd(W)}`;
        console.log(`\n  ${'─'.repeat(W)}`);
        console.log(line(`POSITIONS (${positions.length})`));
        console.log(`  ${'─'.repeat(W)}`);
        for (const p of positions) {
            const name = (p.market || `...${p.tokenId.slice(-16)}`).slice(0, W - 2);
            console.log(line(name));
            console.log(line(`  ${p.shares.toFixed(4)} shares | avg $${p.avgEntry.toFixed(4)} | cost $${p.costBasis.toFixed(2)} | rPnL $${p.realizedPnl.toFixed(2)}`));
        }
        console.log(`  ${'─'.repeat(W)}`);
        console.log(line(`Total cost: $${this.getTotalCostBasis().toFixed(2)} | Total realized P&L: $${this.getTotalRealizedPnl().toFixed(2)}`));
        console.log(`  ${'─'.repeat(W)}\n`);
    }

    async printPortfolio() {
        const snap = await this.getSnapshot();
        const W = 72;
        const line = (s) => `  ${String(s).padEnd(W)}`;
        console.log(`\n  ${'='.repeat(W)}`);
        console.log(line(`PORTFOLIO — ${new Date().toISOString().slice(0, 16)}`));
        console.log(`  ${'='.repeat(W)}`);
        if (snap.count === 0) {
            console.log(line('No open positions'));
        } else {
            for (const p of snap.positions) {
                const name = (p.market || `...${p.tokenId.slice(-16)}`).slice(0, W - 4);
                const px = p.currentPrice != null ? `$${p.currentPrice.toFixed(4)}` : 'N/A';
                const uPnl = p.unrealizedPnl != null ? `$${p.unrealizedPnl.toFixed(2)}` : 'N/A';
                const pct = p.unrealizedPct != null ? `${p.unrealizedPct.toFixed(1)}%` : '';
                console.log(line(name));
                console.log(line(`  ${p.shares.toFixed(4)} @ $${p.avgEntry.toFixed(4)} -> ${px} | uPnL: ${uPnl} ${pct} | rPnL: $${p.realizedPnl.toFixed(2)}`));
            }
        }
        console.log(`  ${'─'.repeat(W)}`);
        const sign = snap.totalPnl >= 0 ? '+' : '';
        console.log(line(`Cost: $${snap.totalCost.toFixed(2)} | Value: $${snap.totalValue.toFixed(2)} | P&L: ${sign}$${snap.totalPnl.toFixed(2)}`));
        console.log(line(`  Unrealized: $${snap.unrealizedPnl.toFixed(2)} | Realized: $${snap.realizedPnl.toFixed(2)}`));
        console.log(`  ${'='.repeat(W)}\n`);
    }
}

export const positions = new PositionManager();
