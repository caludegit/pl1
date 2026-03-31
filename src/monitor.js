// src/monitor.js — On-chain OrderFilled monitor
//
// Reliable real-time monitoring of Polymarket trades via Polygon events:
//   - Dual subscription (maker + taker) catches all fill directions
//   - ConnectionId prevents stale-close reconnect races
//   - 30s ping detects silent WSS drops (common on Alchemy/QuickNode)
//   - Partial fill batching (configurable window) before firing copy
//   - All timers stored and cleaned on stop()

import { ethers } from 'ethers';
import config from './config.js';
import * as log from './logger.js';

// ── Polymarket exchange contracts on Polygon ──────────────────────────────────
const EXCHANGES = [
    ethers.utils.getAddress('0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e'),  // CTF Exchange
    ethers.utils.getAddress('0xc5d563a36ae78145c45a50134d48a1215220f80a'),  // NegRisk CTF Exchange
];
const EXCHANGE_SET = new Set(EXCHANGES.map(a => a.toLowerCase()));

// Both USDC (collateral) and outcome tokens use 6 decimals on Polymarket
const TOKEN_DECIMALS = 6;

const ORDER_FILLED_TOPIC = ethers.utils.id(
    'OrderFilled(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)'
);

const IFACE = new ethers.utils.Interface([
    'event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint256 makerAssetId, uint256 takerAssetId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee)',
]);

const fmt = (bn) => parseFloat(ethers.utils.formatUnits(bn, TOKEN_DECIMALS));


export class OnChainMonitor {
    constructor(targetMap, onTrade) {
        this.targetMap = targetMap;   // Map<lowercaseAddr, targetConfig>
        this.onTrade   = onTrade;    // async (target, activity) => result

        this.running       = false;
        this.provider      = null;
        this._connectionId = 0;       // increments on every connect attempt
        this._reconnectDelay = 2_000;

        // Timers — all stored so stop() can clear them cleanly
        this._reconnectTimer  = null;
        this._pingTimer       = null;
        this._heartbeatTimer  = null;
        this._cleanSeenTimer  = null;

        // Dedup: "txHash:targetAddr:orderHash" → timestamp
        // orderHash is unique per order so this never double-fires
        this._seen    = new Map();

        // Batch accumulator: "txHash:targetAddr:tokenId:side" → batch object
        // Collects partial fills in the same tx before firing the copy callback
        this._pending = new Map();
    }

    // ── Public API ─────────────────────────────────────────────────────────────

    async start() {
        if (this.targetMap.size === 0) throw new Error('No targets configured');
        this.running = true;

        this._cleanSeenTimer = setInterval(() => this._cleanSeen(), 10 * 60_000);

        this._heartbeatTimer = setInterval(() => {
            log.info('MON', `alive — watching ${this.targetMap.size} wallet(s), ${this._pending.size} pending`);
        }, 10 * 60_000);

        await this._connect();
    }

    stop() {
        this.running = false;
        clearTimeout(this._reconnectTimer);
        clearInterval(this._pingTimer);
        clearInterval(this._heartbeatTimer);
        clearInterval(this._cleanSeenTimer);
        this._destroyProvider();

        // Flush any tx groups that were mid-window when stop() was called
        for (const [key, txGroup] of this._pending) {
            clearTimeout(txGroup.timer);
            this._flushTxGroup(txGroup);
        }
        this._pending.clear();
        log.info('MON', 'Stopped');
    }

    // ── Connection management ──────────────────────────────────────────────────

    async _connect() {
        this._destroyProvider();

        // Each attempt gets a unique ID. Close/error events from previous connections
        // carry the old ID and are silently ignored — this fixes the reconnect race.
        const myId = ++this._connectionId;

        try {
            if (config.wssUrl) {
                this.provider = new ethers.providers.WebSocketProvider(config.wssUrl);

                // Wait for the underlying websocket to actually open (with timeout)
                const ws = this.provider._websocket;
                if (ws && ws.readyState !== 1 /* OPEN */) {
                    await Promise.race([
                        new Promise((resolve, reject) => {
                            ws.on('open', resolve);
                            ws.on('error', reject);
                        }),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('WSS open timeout (10s)')), 10_000)),
                    ]);
                }
            } else {
                log.warn('MON', 'No wssUrl — falling back to HTTP polling (10-15s delay)');
                this.provider = new ethers.providers.JsonRpcProvider(config.rpcUrl);
            }

            // Attach close/error listeners to the underlying ws object
            const ws = this.provider._websocket;
            if (ws) {
                ws.on('close', () => {
                    if (myId !== this._connectionId) return; // stale connection, ignore
                    if (!this.running) return;
                    log.warn('MON', `WSS closed — reconnecting in ${this._reconnectDelay / 1000}s`);
                    clearInterval(this._pingTimer);
                    this._pingTimer = null;
                    this._scheduleReconnect();
                });

                ws.on('error', (e) => {
                    if (myId !== this._connectionId) return;
                    log.error('MON', 'WSS error:', e.message);
                });
            }

            // Confirm the connection is alive before subscribing (with timeout)
            await Promise.race([
                this.provider.getNetwork(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Connection timeout (15s)')), 15_000)),
            ]);
            this._reconnectDelay = 2_000; // reset backoff on success

            // Subscribe to OrderFilled for all targets.
            // Sub 1: target is the maker (topic index 2)
            // Sub 2: target is the taker (topic index 3)
            // ethers v5 treats an array in a topic position as OR logic.
            // NOTE: ethers v5 does NOT support array in the address field of
            // provider.on() filters — it passes the array to resolveName() which
            // fails and falls through to ENS resolution (unsupported on Polygon).
            // Fix: create individual subscriptions per exchange address.
            const paddedAddrs = [...this.targetMap.keys()]
                .map(a => ethers.utils.hexZeroPad(a, 32));

            for (const exchangeAddr of EXCHANGES) {
                this.provider.on(
                    { address: exchangeAddr, topics: [ORDER_FILLED_TOPIC, null, paddedAddrs, null] },
                    (evt) => this._onLog(evt)
                );
                this.provider.on(
                    { address: exchangeAddr, topics: [ORDER_FILLED_TOPIC, null, null, paddedAddrs] },
                    (evt) => this._onLog(evt)
                );
            }

            // Keepalive ping — some providers silently drop idle WSS without closing.
            // getBlockNumber() is a cheap call that confirms the socket is still alive.
            if (ws) {
                clearInterval(this._pingTimer);
                this._pingTimer = setInterval(async () => {
                    if (myId !== this._connectionId) return;
                    try {
                        await this.provider.getBlockNumber();
                    } catch (e) {
                        log.warn('MON', 'Ping failed, reconnecting:', e.message);
                        clearInterval(this._pingTimer);
                        this._pingTimer = null;
                        this._scheduleReconnect();
                    }
                }, 30_000);
            }

            const labels = [...this.targetMap.values()].map(t => t.label).join(', ');
            log.info('MON', `Connected (${config.wssUrl ? 'WSS' : 'HTTP'}). Watching: ${labels}`);

        } catch (err) {
            log.error('MON', 'Connection failed:', err.message);
            if (this.running && myId === this._connectionId) {
                this._scheduleReconnect();
            }
        }
    }

    _scheduleReconnect() {
        clearTimeout(this._reconnectTimer);
        // Add ±20% jitter to prevent thundering herd on provider outages
        const jitter = 1 + (Math.random() * 0.4 - 0.2);
        const delay = Math.round(this._reconnectDelay * jitter);
        this._reconnectTimer = setTimeout(() => {
            if (this.running) this._connect();
        }, delay);
        this._reconnectDelay = Math.min(this._reconnectDelay * 1.5, 30_000);
    }

    _destroyProvider() {
        try { this.provider?.removeAllListeners(); } catch (_) {}
        try { this.provider?.destroy?.();          } catch (_) {}
        this.provider = null;
    }

    // ── Log decoder ────────────────────────────────────────────────────────────

    _onLog(evt) {
        try {
            const parsed = IFACE.parseLog(evt);
            const {
                orderHash,
                maker, taker,
                makerAssetId, takerAssetId,
                makerAmountFilled, takerAmountFilled,
                fee,
            } = parsed.args;

            const makerAddr = maker.toLowerCase();
            const takerAddr = taker.toLowerCase();

            // Determine which target wallet is involved and their role
            let targetAddr, role;
            if (this.targetMap.has(makerAddr)) {
                targetAddr = makerAddr;
                role = 'maker';
            } else if (this.targetMap.has(takerAddr) && !EXCHANGE_SET.has(takerAddr)) {
                // Exclude the exchange contract itself appearing as taker
                targetAddr = takerAddr;
                role = 'taker';
            } else {
                return;
            }

            // Dedup: both subscriptions deliver the same log, only process it once
            const dedupKey = `${evt.transactionHash}:${targetAddr}:${orderHash}`;
            if (this._seen.has(dedupKey)) return;
            this._seen.set(dedupKey, Date.now());

            // Bound the _seen map to prevent memory leaks (max 10k entries)
            if (this._seen.size > 10_000) this._cleanSeen();

            // ── Decode amounts from the target wallet's perspective ─────────────
            //
            // Polymarket token IDs:
            //   0        = USDC (collateral token)
            //   non-zero = outcome token (the share being traded)
            //
            // Both use 6 decimal places on Polygon.
            //
            // OrderFilled event meaning:
            //   makerAmountFilled = units of makerAsset the maker gave
            //   takerAmountFilled = units of takerAsset the taker gave
            //
            // Maker BUY:  makerAssetId=0(USDC), takerAssetId=tokenId
            //   maker gave USDC, taker gave shares
            //   makerAmountFilled = USDC spent
            //   takerAmountFilled = shares received by maker
            //
            // Maker SELL: makerAssetId=tokenId, takerAssetId=0(USDC)
            //   maker gave shares, taker gave USDC
            //   makerAmountFilled = shares given by maker
            //   takerAmountFilled = USDC received by maker

            const makerIsBuying = makerAssetId.isZero();
            let isBuy, tokenId, usdcAmount, tokenAmount;

            if (role === 'maker') {
                isBuy       = makerIsBuying;
                tokenId     = (makerIsBuying ? takerAssetId : makerAssetId).toString();
                usdcAmount  = fmt(makerIsBuying ? makerAmountFilled : takerAmountFilled);
                tokenAmount = fmt(makerIsBuying ? takerAmountFilled : makerAmountFilled);
            } else {
                // Taker's direction is always opposite to maker's
                isBuy = !makerIsBuying;
                if (isBuy) {
                    // Taker is buying: maker was selling (makerAssetId = tokenId)
                    tokenId     = makerAssetId.toString();
                    tokenAmount = fmt(makerAmountFilled); // shares taker received
                    usdcAmount  = fmt(takerAmountFilled); // USDC taker paid
                } else {
                    // Taker is selling: maker was buying (takerAssetId = tokenId)
                    tokenId     = takerAssetId.toString();
                    tokenAmount = fmt(takerAmountFilled); // shares taker gave
                    usdcAmount  = fmt(makerAmountFilled); // USDC taker received
                }
            }

            // Skip malformed or dust events (NaN comparisons return false, so check explicitly)
            if (tokenId === '0' || !(tokenAmount > 0) || !(usdcAmount > 0)) return;

            const side   = isBuy ? 'BUY' : 'SELL';
            const exch   = evt.address.toLowerCase() === EXCHANGES[1].toLowerCase() ? 'NegRisk' : 'CTF';
            const target = this.targetMap.get(targetAddr);

            // ── Batch partial fills per tx ───────────────────────────────────────
            // One tx can emit multiple OrderFilled events:
            //   - Partial fills: same token filled across multiple counterparties
            //   - Multi-token: whale trades different tokens in one tx (batch/multicall)
            //
            // Strategy: group fills by (txHash, target, tokenId, side), but use a
            // single flush timer per (txHash, target). When the timer fires, ALL
            // token batches from that tx are flushed sequentially so balance tracking,
            // daily caps, and inflight accounting stay accurate.

            const fillKey = `${evt.transactionHash}:${targetAddr}:${tokenId}:${side}`;
            const txKey   = `${evt.transactionHash}:${targetAddr}`;

            // Ensure tx-level group exists
            if (!this._pending.has(txKey)) {
                const windowMs = Math.max(config.txBatchWindowMs ?? 400, 0);
                const txGroup = {
                    batches: new Map(),  // fillKey → batch
                    timer:   null,
                };
                txGroup.timer = setTimeout(() => {
                    this._pending.delete(txKey);
                    this._flushTxGroup(txGroup);
                }, windowMs);
                this._pending.set(txKey, txGroup);
            }

            const txGroup = this._pending.get(txKey);

            // Ensure per-token batch within the tx group
            if (!txGroup.batches.has(fillKey)) {
                txGroup.batches.set(fillKey, {
                    target, tokenId, side, exchange: exch, role,
                    fills:  [],
                    txHash: evt.transactionHash,
                });
            }

            const feeUsdc = fmt(fee);
            txGroup.batches.get(fillKey).fills.push({ usdcAmount, tokenAmount, feeUsdc });

        } catch (err) {
            log.error('MON', 'Log decode error:', err.message);
        }
    }

    // ── Flush all batches from one tx sequentially ─────────────────────────────
    // Sequential execution ensures balance checks, daily caps, and inflight
    // accounting are accurate when a whale trades multiple tokens in one tx.

    async _flushTxGroup(txGroup) {
        const batches = [...txGroup.batches.values()];

        if (batches.length > 1) {
            const label = batches[0].target.label;
            const sides = batches.map(b => `${b.side} ...${b.tokenId.slice(-8)}`).join(', ');
            log.info(label, `Multi-token tx: ${batches.length} trades in 1 tx (${sides})`);
        }

        for (const batch of batches) {
            await this._flushBatch(batch);
        }
    }

    async _flushBatch(batch) {
        const { target, tokenId, side, exchange, role, fills, txHash } = batch;

        const totalUsdc   = fills.reduce((s, f) => s + f.usdcAmount,   0);
        const totalTokens = fills.reduce((s, f) => s + f.tokenAmount, 0);
        const totalFees   = fills.reduce((s, f) => s + f.feeUsdc,     0);
        const avgPrice    = totalTokens > 0 ? totalUsdc / totalTokens : 0;

        log.info(target.label, `${side} as ${role.toUpperCase()} on ${exchange} (${fills.length} fill${fills.length > 1 ? 's' : ''})`);
        log.info(target.label, `  ...${tokenId.slice(-20)} | $${totalUsdc.toFixed(2)} USDC | ${totalTokens.toFixed(4)} shares @ avg $${avgPrice.toFixed(4)} | fee $${totalFees.toFixed(2)}`);

        try {
            await this.onTrade(target, {
                conditionId:     null,
                asset:           tokenId,
                side,
                size:            totalTokens,
                price:           avgPrice,
                usdcSize:        totalUsdc,
                totalFees,
                netUsdcSize:     side === 'BUY' ? totalUsdc + totalFees : totalUsdc - totalFees,
                transactionHash: txHash,
                exchange,
                role,
                fillCount:       fills.length,
            });
        } catch (e) {
            log.error(target.label, `Callback error: ${e.message}`);
        }
    }

    // ── Housekeeping ───────────────────────────────────────────────────────────

    _cleanSeen() {
        const cutoff = Date.now() - 10 * 60_000;
        for (const [k, t] of this._seen) {
            if (t < cutoff) this._seen.delete(k);
        }
    }
}