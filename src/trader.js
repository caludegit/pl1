// src/trader.js — Smart CLOB order execution engine v7.0
//
// Profit-optimized copy trading execution:
//   - Whale performance tracking: auto-adjust copy ratios by whale quality
//   - Kelly criterion sizing: mathematically optimal position sizes
//   - Edge scoring: composite score to filter low-quality trades
//   - Smart entry filters: skip bad prices (buy too high, sell too low)
//   - Spread & liquidity checks: skip illiquid markets
//   - Smart order routing: compare direct vs complementary token fills
//   - GTC limit orders: optional better-price execution
//   - Multi-whale signal boost: increase size on convergence
//   - Anti-front-running: random delay before order placement
//   - In-flight balance tracking: accurate spend control
//   - Market quality filter: skip low-volume/illiquid markets

import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';
import config from './config.js';
import { positions } from './positions.js';
import { whaleTracker } from './whale-tracker.js';
import * as log from './logger.js';
import { HttpError, TransientError } from './errors.js';
import {
    getMarketByCondition, getMarketByToken, extractMarketParams,
    getMidpoint, getOrderBook, getExecutionPriceFromBook,
    getSpread, getBookDepth, getComplementaryToken,
    isMarketActive, passesMarketFilter, fetchBalance,
    getMarketQuality, calcEdgeScore, getHoursUntilExpiry,
} from './api.js';

let client = null;
let _walletAddress = null;
let _cachedBalance = null;
let _balanceCheckedAt = 0;
const BALANCE_CACHE_MS = 60_000;

// ── State ─────────────────────────────────────────────────────────────────────
const cooldowns  = new Map();
const locks      = new Set();
let _dailyUsdc   = 0;
let _dailyDate   = _todayKey();
let _inflightUsdc = 0;  // in-flight spend tracking
let _dailyRealizedPnl = 0; // daily realized P&L for drawdown breaker
let _drawdownHalted = false; // true when drawdown breaker trips

// ── Idempotency: track recent order keys to prevent duplicate placements ─────
// Key = "txHash:tokenId:side", expires after 10 minutes
const _recentOrders = new Map();
const _orderCleanupTimer = setInterval(() => {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [k, ts] of _recentOrders) {
        if (ts < cutoff) _recentOrders.delete(k);
    }
}, 5 * 60_000);
_orderCleanupTimer.unref();

// ── Multi-whale signal tracker ────────────────────────────────────────────────
// Tracks recent whale buys per token to detect convergence
// Map<tokenId, Array<{wallet, timestamp, side}>>
const _whaleSignals = new Map();

// ── Losing streak cooldown state ─────────────────────────────────────────────
// Map<walletAddress, timestamp> — when the cooldown started
const _streakCooldowns = new Map();

function _todayKey() { return new Date().toISOString().slice(0, 10); }
function _dailyReset() {
    const today = _todayKey();
    if (today !== _dailyDate) {
        _dailyUsdc = 0;
        _dailyDate = today;
        _dailyRealizedPnl = 0;
        _drawdownHalted = false;
    }
}
// Record a realized P&L and check if drawdown breaker should trip
function _recordDailyPnl(pnl) {
    _dailyReset();
    _dailyRealizedPnl += pnl;
    if (config.enableDrawdownBreaker && _dailyRealizedPnl < 0
        && Math.abs(_dailyRealizedPnl) >= config.maxDailyDrawdownUsdc) {
        if (!_drawdownHalted) {
            _drawdownHalted = true;
            log.warn('RISK', `DRAWDOWN BREAKER TRIPPED — daily losses $${Math.abs(_dailyRealizedPnl).toFixed(2)} >= $${config.maxDailyDrawdownUsdc} — halting new BUYs for today`);
            log.notify('drawdown_breaker', { dailyPnl: _dailyRealizedPnl, threshold: config.maxDailyDrawdownUsdc });
        }
    }
}
function _wouldExceedDaily(amount) {
    _dailyReset();
    return config.maxDailyUsdc > 0 && (_dailyUsdc + _inflightUsdc + amount > config.maxDailyUsdc);
}
function _recordSpend(amount) { _dailyReset(); _dailyUsdc += amount; }
function _onCooldown(wallet, token) {
    const last = cooldowns.get(`${wallet}:${token}`);
    return last && (Date.now() - last < config.cooldownMs);
}
function _stampCooldown(wallet, token) { cooldowns.set(`${wallet}:${token}`, Date.now()); }
function _tryLock(wallet, token) {
    const k = `${wallet}:${token}`;
    if (locks.has(k)) return false;
    locks.add(k); return true;
}
function _unlock(wallet, token) { locks.delete(`${wallet}:${token}`); }

// ── Periodic cleanup to prevent memory leaks on long runs ────────────────────
const _cleanupTimer = setInterval(() => {
    const now = Date.now();
    // Purge expired cooldowns (entries older than cooldownMs)
    for (const [key, ts] of cooldowns) {
        if (now - ts > config.cooldownMs * 2) cooldowns.delete(key);
    }
    // Purge expired whale signals (entries older than signalWindowMs)
    for (const [tokenId, signals] of _whaleSignals) {
        const cutoff = now - config.signalWindowMs;
        while (signals.length > 0 && signals[0].timestamp < cutoff) signals.shift();
        if (signals.length === 0) _whaleSignals.delete(tokenId);
    }
}, 5 * 60_000); // every 5 minutes
_cleanupTimer.unref();

// ── Multi-whale signal detection ──────────────────────────────────────────────
function _recordSignal(tokenId, wallet, side) {
    const now = Date.now();
    if (!_whaleSignals.has(tokenId)) _whaleSignals.set(tokenId, []);
    const signals = _whaleSignals.get(tokenId);
    signals.push({ wallet, timestamp: now, side });
    // Clean old signals
    const cutoff = now - config.signalWindowMs;
    while (signals.length > 0 && signals[0].timestamp < cutoff) signals.shift();
}

function _getSignalBoost(tokenId, side) {
    const signals = _whaleSignals.get(tokenId);
    if (!signals) return 1.0;
    const cutoff = Date.now() - config.signalWindowMs;
    // Count unique wallets with same side in the window
    const uniqueWallets = new Set(
        signals.filter(s => s.timestamp >= cutoff && s.side === side).map(s => s.wallet)
    );
    if (uniqueWallets.size <= 1) return 1.0;
    // Each additional whale boosts by signalBoostRatio
    const boost = Math.pow(config.signalBoostRatio, uniqueWallets.size - 1);
    return Math.min(boost, config.signalMaxBoost);
}

// ── Tick alignment (with proper Polymarket bounds clamping) ───────────────────
export function _alignToTick(price, tickSize, roundUp) {
    const tick = parseFloat(tickSize);
    const decimals = tickSize.split('.')[1]?.length || 0;
    const aligned = roundUp
        ? Math.ceil(price / tick) * tick
        : Math.floor(price / tick) * tick;
    // Clamp to valid Polymarket price range: [tick, 1-tick]
    const clamped = Math.max(tick, Math.min(aligned, 1 - tick));
    return parseFloat(clamped.toFixed(decimals));
}

// ── Price validation (proper Polymarket bounds) ───────────────────────────────
export function _priceValid(price, tickSize) {
    const tick = parseFloat(tickSize);
    return price >= tick && price <= 1 - tick;
}

// ── Balance check (cached + in-flight aware) ──────────────────────────────────
async function _getBalance() {
    if (!_walletAddress) return null;
    if (Date.now() - _balanceCheckedAt < BALANCE_CACHE_MS && _cachedBalance != null) {
        return Math.max(0, _cachedBalance - _inflightUsdc);
    }
    _cachedBalance = await fetchBalance(_walletAddress);
    _balanceCheckedAt = Date.now();
    // Don't reset _inflightUsdc here — concurrent trades may still be in-flight.
    // _inflightUsdc is decremented in the finally block of each trade.
    return _cachedBalance != null ? Math.max(0, _cachedBalance - _inflightUsdc) : null;
}

// ── Order size calculation (with signal boost + whale tracking + Kelly) ────────
function _calcAmount(target, activity, mid) {
    const { copyRatio, maxUsdc, address: walletAddr } = target;
    const { side, size, price, usdcSize, asset: tokenId } = activity;
    const sellMode = config.getSellMode(target);

    // Multi-whale signal boost for buys
    const signalBoost = side === 'BUY' ? _getSignalBoost(tokenId, side) : 1.0;

    // Whale performance multiplier (auto-adjusts based on track record)
    const whaleMultiplier = config.enableWhaleTracking
        ? whaleTracker.getMultiplier(walletAddr)
        : 1.0;

    if (side === 'BUY') {
        const whaleUsdc = usdcSize || size * price;
        let baseCopyRatio = copyRatio;

        // Kelly criterion sizing: adjust copyRatio based on whale's proven edge
        if (config.enableKellySizing) {
            const kellyFraction = whaleTracker.getKellyFraction(walletAddr);
            if (kellyFraction <= 0.01) {
                baseCopyRatio = copyRatio * 0.25; // minimal allocation for negative-edge whales
            } else {
                baseCopyRatio = copyRatio * Math.min(kellyFraction / 0.5, 2.0);
            }
        }

        let amount = Math.min(
            whaleUsdc * baseCopyRatio * signalBoost * whaleMultiplier,
            maxUsdc * Math.min(whaleMultiplier, 2.0)  // cap the max scaling
        );

        // Cap by per-trade max risk
        if (config.maxTradeUsdc > 0) {
            amount = Math.min(amount, config.maxTradeUsdc);
        }

        // Cap by max position size
        if (config.maxPositionUsdc > 0) {
            const existing = positions.getPosition(tokenId);
            const currentCost = existing ? existing.costBasis : 0;
            const remaining = config.maxPositionUsdc - currentCost;
            if (remaining <= 0) return { amount: 0, signalBoost, whaleMultiplier };
            amount = Math.min(amount, remaining);
        }

        return { amount: parseFloat(amount.toFixed(2)), signalBoost, whaleMultiplier };
    }

    // SELL
    const ourShares = positions.getShares(tokenId);
    if (ourShares <= 0) return { amount: 0, signalBoost: 1, whaleMultiplier: 1 };

    if (sellMode === 'all') {
        return { amount: parseFloat(ourShares.toFixed(4)), signalBoost: 1, whaleMultiplier: 1 };
    }

    if (sellMode === 'proportional') {
        // Estimate what fraction of their position the whale sold.
        // We don't have the whale's total holding, so infer it:
        //   estimatedWhalePositionUsdc = maxUsdc / copyRatio  (reverse-scales our cap back to whale size)
        //   whaleSoldUsdc              = usdcSize from the event (actual USDC received by whale)
        // fraction = whaleSoldUsdc / estimatedWhalePositionUsdc → sell same % of our position
        const effectiveMid = mid > 0 ? mid : Math.max(price, 0.01);
        const whaleSoldUsdc = usdcSize || size * effectiveMid;
        const estimatedWhalePositionUsdc = copyRatio > 0 ? maxUsdc / copyRatio : maxUsdc;
        const fraction = Math.min(1, whaleSoldUsdc / estimatedWhalePositionUsdc);
        const sellShares = ourShares * fraction;
        const maxShares = maxUsdc / effectiveMid;
        return { amount: parseFloat(Math.min(sellShares, maxShares, ourShares).toFixed(4)), signalBoost: 1, whaleMultiplier: 1 };
    }

    // 'ratio' mode
    const rawShares = size * copyRatio;
    const effectiveMid = mid > 0 ? mid : Math.max(price, 0.01);
    const maxShares = maxUsdc / effectiveMid;
    return { amount: parseFloat(Math.min(rawShares, maxShares, ourShares).toFixed(4)), signalBoost: 1, whaleMultiplier: 1 };
}

// ── Init ──────────────────────────────────────────────────────────────────────
export async function initTrader() {
    const signer = new Wallet(config.privateKey);
    _walletAddress = signer.address.toLowerCase();
    const temp = new ClobClient(config.clobHost, config.chainId, signer);
    const creds = await temp.createOrDeriveApiKey();

    client = config.signatureType === 0
        ? new ClobClient(config.clobHost, config.chainId, signer, creds)
        : new ClobClient(config.clobHost, config.chainId, signer, creds, config.signatureType, config.funderAddress);

    const bal = await _getBalance();
    if (bal != null) log.info('TRADE', `USDC balance: $${bal.toFixed(2)}`);

    log.info('TRADE', 'CLOB client ready');
    return client;
}

export function getClient() { return client; }
export function getWalletAddress() { return _walletAddress; }
export function recordExitPnl(pnl) { _recordDailyPnl(pnl); }

// ── Shared preflight checks (kill switch, dedup, cooldowns, guards) ──────────
// Returns null if all checks pass, or a reason string if the trade should be skipped.
function _preflight(target, activity, TAG) {
    const { address: wallet, label } = target;
    const { asset: tokenId, side, transactionHash } = activity;
    const isBuy = side === 'BUY';

    if (config.killSwitch) return 'kill_switch';

    const dedupKey = `${transactionHash || 'no-tx'}:${tokenId}:${side}`;
    if (_recentOrders.has(dedupKey)) return 'duplicate';

    _recordSignal(tokenId, wallet, side);

    if (!isBuy && !config.shouldCopySells(target)) return 'sells_disabled';
    if (!isBuy && config.sellOnlyIfHeld && !positions.hasPosition(tokenId)) return 'not_held';

    if (isBuy && config.maxOpenPositions > 0 && !positions.hasPosition(tokenId)) {
        if (positions.getCount() >= config.maxOpenPositions) return 'max_positions';
    }

    if (isBuy && _drawdownHalted) return 'drawdown_breaker';

    if (isBuy && config.enableStreakCooldown) {
        const cooldownUntil = _streakCooldowns.get(wallet);
        if (cooldownUntil && Date.now() < cooldownUntil) return 'streak_cooldown';
        const whaleStats = whaleTracker.getStats(wallet);
        if (whaleStats && whaleStats.currentStreak <= -(config.maxLosingStreak || 3)) {
            _streakCooldowns.set(wallet, Date.now() + (config.streakCooldownMs || 3_600_000));
            log.warn(TAG, `STREAK COOLDOWN — ${label} has ${Math.abs(whaleStats.currentStreak)} consecutive losses, pausing for ${(config.streakCooldownMs / 60_000).toFixed(0)}min`);
            return 'streak_cooldown';
        }
    }

    if (_onCooldown(wallet, tokenId)) return 'cooldown';

    return null;
}

// ── Public entry: live trade ──────────────────────────────────────────────────
export async function placeCopyTrade(target, activity) {
    if (!client) throw new Error('Call initTrader() first');

    const { address: wallet, label } = target;
    const { asset: tokenId, side, transactionHash } = activity;
    const TAG = label;
    const isBuy = side === 'BUY';

    const skipReason = _preflight(target, activity, TAG);
    if (skipReason) {
        log.trade(TAG, { side, tokenId, action: 'skip', reason: skipReason });
        return { ok: false, reason: skipReason };
    }

    if (!_tryLock(wallet, tokenId)) {
        log.trade(TAG, { side, tokenId, action: 'skip', reason: 'locked' });
        return { ok: false, reason: 'locked' };
    }

    try {
        const result = await _execute(target, activity);
        // Mark as seen only on successful execution attempt (not skips from _execute)
        if (result.ok) _recentOrders.set(dedupKey, Date.now());
        return result;
    } finally {
        _unlock(wallet, tokenId);
    }
}

// ── Core execution (with all smart filters) ───────────────────────────────────
async function _execute(target, activity) {
    const { label, address: walletAddr } = target;
    const { conditionId, asset: tokenId, side, price, usdcSize, transactionHash, fillCount } = activity;
    const isBuy = side === 'BUY';
    const _perfStart = config.enablePerfTiming ? performance.now() : 0;
    const TAG = label;

    // Fetch market + midpoint + book in parallel
    const [market, midpoint, book] = await Promise.all([
        conditionId ? getMarketByCondition(conditionId) : getMarketByToken(tokenId),
        getMidpoint(tokenId).catch(() => null),
        getOrderBook(tokenId).catch(() => null),
    ]);

    const { tickSize, negRisk } = extractMarketParams(market);
    const mid = (midpoint != null && !isNaN(midpoint)) ? midpoint : price;
    const name = market.question || market.title || `...${tokenId.slice(-12)}`;

    // Guard against NaN/zero mid — can't price the trade
    if (mid == null || isNaN(mid) || mid <= 0) {
        log.trade(TAG, { side, market: name, action: 'skip', reason: 'no_price', mid });
        return { ok: false, reason: 'no_price' };
    }

    // ── Market status check ───────────────────────────────────────────────
    if (!isMarketActive(market)) {
        log.trade(TAG, { side, market: name, action: 'skip', reason: 'market_closed' });
        return { ok: false, reason: 'market_closed' };
    }

    if (!passesMarketFilter(market)) {
        log.trade(TAG, { side, market: name, action: 'skip', reason: 'market_filtered' });
        return { ok: false, reason: 'market_filtered' };
    }

    // ── MARKET QUALITY FILTER ────────────────────────────────────────────
    if (config.enableMarketQuality && isBuy) {
        const quality = getMarketQuality(market);
        if (quality.score < 0.3) {
            log.trade(TAG, { side, market: name, action: 'skip', reason: 'low_quality', quality: quality.score });
            log.info(TAG, `SKIP BUY "${name.slice(0, 40)}" — low quality (${quality.reasons.join(', ')})`);
            return { ok: false, reason: 'low_quality' };
        }
    }

    // ── EXPIRY FILTER: skip markets expiring too soon ──────────────────────
    if (isBuy && config.minExpiryHours > 0) {
        const hoursLeft = getHoursUntilExpiry(market);
        if (hoursLeft < config.minExpiryHours) {
            log.trade(TAG, { side, market: name, action: 'skip', reason: 'expiring_soon', hoursLeft: +hoursLeft.toFixed(1) });
            log.info(TAG, `SKIP BUY "${name.slice(0, 40)}" — expires in ${hoursLeft.toFixed(1)}h (min ${config.minExpiryHours}h)`);
            return { ok: false, reason: 'expiring_soon' };
        }
    }

    // ── PORTFOLIO EXPOSURE CAP: don't over-commit bankroll ───────────────
    if (isBuy && config.maxPortfolioExposurePct > 0) {
        const balance = await _getBalance();
        if (balance != null) {
            const totalExposure = positions.getTotalCostBasis();
            const bankroll = balance + totalExposure;
            if (bankroll > 0 && totalExposure / bankroll >= config.maxPortfolioExposurePct) {
                log.trade(TAG, { side, market: name, action: 'skip', reason: 'portfolio_exposure', exposure: +(totalExposure / bankroll).toFixed(2) });
                log.info(TAG, `SKIP BUY — portfolio exposure ${(totalExposure / bankroll * 100).toFixed(0)}% >= cap ${(config.maxPortfolioExposurePct * 100).toFixed(0)}%`);
                return { ok: false, reason: 'portfolio_exposure' };
            }
        }
    }

    // ── SMART FILTER: Price-based entry filter ────────────────────────────
    // Don't buy near the top — limited upside, high downside risk
    if (isBuy && mid > config.maxBuyPrice) {
        log.trade(TAG, { side, market: name, action: 'skip', reason: 'price_too_high', mid });
        log.info(TAG, `SKIP BUY "${name.slice(0, 40)}" — mid $${mid.toFixed(4)} > max $${config.maxBuyPrice} (limited upside)`);
        return { ok: false, reason: 'price_too_high' };
    }
    // Don't sell near the bottom — locks in big loss for tiny recovery
    if (!isBuy && mid < config.minSellPrice) {
        log.trade(TAG, { side, market: name, action: 'skip', reason: 'price_too_low', mid });
        log.info(TAG, `SKIP SELL "${name.slice(0, 40)}" — mid $${mid.toFixed(4)} < min $${config.minSellPrice} (hold for recovery)`);
        return { ok: false, reason: 'price_too_low' };
    }

    // ── SMART FILTER: Spread check ────────────────────────────────────────
    const spreadInfo = getSpread(book);
    if (spreadInfo.spreadPct != null && spreadInfo.spreadPct > config.maxSpreadPct) {
        log.trade(TAG, { side, market: name, action: 'skip', reason: 'wide_spread', spread: +spreadInfo.spreadPct.toFixed(4) });
        log.info(TAG, `SKIP "${name.slice(0, 40)}" — spread ${(spreadInfo.spreadPct * 100).toFixed(1)}% > max ${(config.maxSpreadPct * 100).toFixed(1)}%`);
        return { ok: false, reason: 'wide_spread' };
    }

    // ── SMART FILTER: Book depth check ────────────────────────────────────
    const depth = getBookDepth(book);
    const relevantDepth = isBuy ? depth.askDepthUsdc : depth.bidDepthUsdc;
    if (relevantDepth < config.minBookDepthUsdc) {
        log.trade(TAG, { side, market: name, action: 'skip', reason: 'low_liquidity', depth: +relevantDepth.toFixed(2) });
        log.info(TAG, `SKIP "${name.slice(0, 40)}" — ${side} depth $${relevantDepth.toFixed(0)} < min $${config.minBookDepthUsdc}`);
        return { ok: false, reason: 'low_liquidity' };
    }

    // Calculate our order size
    const { amount, signalBoost, whaleMultiplier } = _calcAmount(target, activity, mid);

    // ── EDGE SCORE FILTER: only take trades with positive expected edge ───
    if (config.enableEdgeFilter && isBuy) {
        const quality = getMarketQuality(market);
        const edgeScore = calcEdgeScore({
            whaleMultiplier,
            signalBoost,
            spreadPct: spreadInfo.spreadPct,
            depthUsdc: relevantDepth,
            mid,
            side,
            marketQuality: quality.score,
        });
        if (edgeScore < config.minEdgeScore) {
            log.trade(TAG, { side, market: name, action: 'skip', reason: 'low_edge', edgeScore: +edgeScore.toFixed(3) });
            log.info(TAG, `SKIP BUY "${name.slice(0, 40)}" — edge ${edgeScore.toFixed(2)} < min ${config.minEdgeScore}`);
            return { ok: false, reason: 'low_edge' };
        }
    }

    // Min order check
    const valueCheck = isBuy ? amount : amount * mid;
    if (valueCheck < config.minOrderUsdc) {
        log.trade(TAG, { side, market: name, action: 'skip', reason: 'too_small', amount });
        return { ok: false, reason: 'too_small' };
    }

    // For sells: verify we have enough shares
    if (!isBuy) {
        const ourShares = positions.getShares(tokenId);
        if (amount > ourShares + 0.0001) {
            log.trade(TAG, { side, market: name, action: 'skip', reason: 'insufficient_shares', want: amount, have: ourShares });
            return { ok: false, reason: 'insufficient_shares' };
        }
    }

    // Balance check for buys
    if (isBuy) {
        const balance = await _getBalance();
        if (balance != null && balance < config.minBalanceUsdc) {
            log.trade(TAG, { side, market: name, action: 'skip', reason: 'low_balance', balance });
            return { ok: false, reason: 'low_balance' };
        }
        if (balance != null && balance < amount) {
            log.trade(TAG, { side, market: name, action: 'skip', reason: 'insufficient_balance', need: amount, have: balance });
            return { ok: false, reason: 'insufficient_balance' };
        }
    }

    // Execution price estimate from book
    const execPrice = book ? getExecutionPriceFromBook(book, side, amount) : null;
    const refPrice = execPrice?.avgPrice ?? mid;

    // ── SMART ROUTING: Check complementary token for better fill ──────────
    let useComplement = false;
    let complementTokenId = null;
    if (config.useSmartRouting && market) {
        complementTokenId = getComplementaryToken(market, tokenId);
        if (complementTokenId) {
            try {
                const compBook = await getOrderBook(complementTokenId);
                // If we want to BUY token A, we can also SELL token B (complement)
                // BUY A at price P is equivalent to SELL B at price (1-P)
                const compSide = isBuy ? 'SELL' : 'BUY';
                const compAmount = isBuy ? (refPrice > 0 ? amount / refPrice : 0) : amount; // shares for complement
                const compExec = getExecutionPriceFromBook(compBook, compSide, compAmount);
                if (compExec) {
                    // Compare: for BUY, lower is better; for SELL, higher is better
                    const directCost = refPrice;
                    const complementCost = 1 - compExec.avgPrice;
                    if (isBuy && complementCost < directCost * 0.995) {
                        useComplement = true;
                        log.info(TAG, `  Smart route: complement saves ${((directCost - complementCost) / directCost * 100).toFixed(1)}%`);
                    } else if (!isBuy && complementCost > directCost * 1.005) {
                        useComplement = true;
                        log.info(TAG, `  Smart route: complement gains ${((complementCost - directCost) / directCost * 100).toFixed(1)}%`);
                    }
                }
            } catch {
                // Smart routing is best-effort, fall through to direct
            }
        }
    }

    // Drift guard
    const drift = price > 0
        ? (isBuy ? (refPrice - price) / price : (price - refPrice) / price)
        : 0;
    if (drift > config.maxPriceDrift) {
        log.trade(TAG, { side, market: name, action: 'skip', reason: 'drift', drift: +drift.toFixed(4) });
        return { ok: false, reason: 'drift' };
    }

    // Daily spend guard (buys only)
    if (isBuy && _wouldExceedDaily(amount)) {
        log.trade(TAG, { side, market: name, action: 'skip', reason: 'daily_limit', dailyUsdc: _dailyUsdc });
        return { ok: false, reason: 'daily_limit' };
    }

    // ── Determine order execution strategy ────────────────────────────────
    const effectiveTokenId = useComplement ? complementTokenId : tokenId;
    const effectiveSide = useComplement ? (isBuy ? Side.SELL : Side.BUY) : (isBuy ? Side.BUY : Side.SELL);

    // Worst price calculation with proper Polymarket bounds
    let worstPrice;
    const tick = parseFloat(tickSize);
    if (isBuy) {
        worstPrice = _alignToTick(Math.min(refPrice * (1 + config.slippage), 1 - tick), tickSize, true);
        worstPrice = Math.min(worstPrice, _alignToTick(1 - tick, tickSize, false));
    } else {
        worstPrice = _alignToTick(Math.max(refPrice * (1 - config.slippage), tick), tickSize, false);
        worstPrice = Math.max(worstPrice, _alignToTick(tick, tickSize, true));
    }

    // Final price validation
    if (!_priceValid(worstPrice, tickSize)) {
        log.trade(TAG, { side, market: name, action: 'skip', reason: 'invalid_price', worstPrice });
        return { ok: false, reason: 'invalid_price' };
    }

    const boostStr = signalBoost > 1 ? ` | BOOST x${signalBoost.toFixed(1)}` : '';
    const whaleStr = whaleMultiplier !== 1.0 ? ` | WHALE x${whaleMultiplier.toFixed(1)}` : '';
    const routeStr = useComplement ? ' | SMART-ROUTE' : '';
    const holdInfo = !isBuy ? ` | hold:${positions.getShares(tokenId).toFixed(2)}` : '';
    log.info(TAG, `${side} "${name.slice(0, 50)}"${routeStr}${boostStr}${whaleStr}`);
    log.info(TAG, `  ${amount} ${isBuy ? 'USDC' : 'shares'} | worst $${worstPrice} | mid $${mid.toFixed(4)} | ref $${refPrice.toFixed(4)} | tick=${tickSize}${holdInfo}`);

    // ── ANTI-FRONT-RUNNING: random delay to prevent being sniped ─────────
    if (config.enableAntiSnipe && config.antiSnipeMaxMs > 0) {
        const delay = Math.floor(Math.random() * config.antiSnipeMaxMs);
        if (delay > 50) await new Promise(r => setTimeout(r, delay));
    }

    // Track in-flight spend
    if (isBuy) _inflightUsdc += amount;

    try {
        // ── Execute order (with retry for transient errors) ───────────────
        let result;
        const MAX_ORDER_RETRIES = 2;

        for (let attempt = 0; attempt <= MAX_ORDER_RETRIES; attempt++) {
            try {
                if (config.orderMode === 'gtc' && isBuy) {
                    result = await _executeGtcOrder(effectiveTokenId, effectiveSide, amount, mid, tickSize, negRisk, TAG);
                } else {
                    result = await client.createAndPostMarketOrder(
                        { tokenID: effectiveTokenId, side: effectiveSide, amount, price: worstPrice, feeRateBps: 0 },
                        { tickSize, negRisk },
                        OrderType.FAK,
                    );
                }
                break; // success, exit retry loop
            } catch (orderErr) {
                const msg = orderErr.message || '';
                const isTransient = (orderErr instanceof HttpError && orderErr.retryable)
                    || orderErr instanceof TransientError
                    || msg.includes('timeout') || msg.includes('ECONNRESET');
                if (isTransient && attempt < MAX_ORDER_RETRIES) {
                    log.warn(TAG, `Order attempt ${attempt + 1} failed (${msg}), retrying in ${(attempt + 1) * 500}ms...`);
                    await new Promise(r => setTimeout(r, (attempt + 1) * 500));
                    continue;
                }
                throw orderErr; // non-transient or out of retries
            }
        }

        if (result?.error) {
            log.trade(TAG, { side, market: name, action: 'rejected', error: result.error, amount, worstPrice });
            return { ok: false, error: result.error };
        }

        // Success — update state
        _stampCooldown(target.address, tokenId);

        // Save entry price BEFORE recordSell (which may delete the position)
        const prePos = positions.getPosition(tokenId);
        const savedAvgEntry = prePos?.avgEntry || 0;

        let pnl = 0;
        if (isBuy) {
            _recordSpend(amount);
            _cachedBalance = null;
            const estShares = refPrice > 0 ? amount / refPrice : amount;
            positions.recordBuy(tokenId, estShares, amount, { market: name, label });
        } else {
            const estUsdc = amount * refPrice;
            pnl = positions.recordSell(tokenId, amount, estUsdc);
            _cachedBalance = null;
            _recordDailyPnl(pnl);
        }

        const orderId = result?.orderID ?? result?.orderHash ?? JSON.stringify(result);
        const pnlStr = !isBuy ? ` | P&L: $${pnl.toFixed(2)}` : '';
        log.info(TAG, `FILLED ${orderId}${isBuy ? ` | daily $${_dailyUsdc.toFixed(2)}` : ''}${pnlStr}${boostStr}`);

        log.trade(TAG, {
            side, market: name, action: 'filled', orderID: orderId,
            amount, worstPrice, mid, refPrice: +refPrice.toFixed(4),
            targetPrice: price, targetTx: transactionHash,
            dailyUsdc: _dailyUsdc, pnl, signalBoost,
            smartRoute: useComplement,
            positionShares: positions.getShares(tokenId),
        });

        log.notify('trade_filled', { label, side, market: name, amount, orderId, pnl, signalBoost, whaleMultiplier });

        // Record sell results for whale performance tracking
        // Use savedAvgEntry captured before recordSell (position may be deleted after full exit)
        if (!isBuy && config.enableWhaleTracking) {
            const entryPrice = savedAvgEntry || price;
            whaleTracker.recordTrade(walletAddr, {
                tokenId, side, entryPrice, exitPrice: refPrice,
                pnlPct: entryPrice > 0 ? (refPrice - entryPrice) / entryPrice : 0,
                usdcPnl: pnl, market: name,
            });
        }

        if (config.enablePerfTiming) {
            const elapsed = (performance.now() - _perfStart).toFixed(0);
            log.info(TAG, `⏱ signal-to-order: ${elapsed}ms`);
        }
        return { ok: true, orderID: orderId, side };

    } catch (err) {
        log.trade(TAG, { side, market: name, action: 'error', error: err.message, amount, worstPrice });
        log.notify('trade_error', { label, side, market: name, error: err.message });
        return { ok: false, error: err.message };
    } finally {
        if (isBuy) _inflightUsdc = Math.max(0, _inflightUsdc - amount);
    }
}

// ── GTC limit order with timeout (better fill prices) ─────────────────────────
async function _executeGtcOrder(tokenId, side, amount, mid, tickSize, negRisk, TAG) {
    const isBuy = side === Side.BUY;
    const offset = mid * config.gtcOffsetPct;
    let limitPrice;

    if (isBuy) {
        // Place bid slightly below mid for better entry
        limitPrice = _alignToTick(mid - offset, tickSize, false);
    } else {
        // Place ask slightly above mid for better exit
        limitPrice = _alignToTick(mid + offset, tickSize, true);
    }

    if (!_priceValid(limitPrice, tickSize)) {
        // Fall back to FAK if limit price is out of bounds
        const tick = parseFloat(tickSize);
        const worstPrice = isBuy
            ? _alignToTick(Math.min(mid * (1 + config.slippage), 1 - tick), tickSize, true)
            : _alignToTick(Math.max(mid * (1 - config.slippage), tick), tickSize, false);
        return client.createAndPostMarketOrder(
            { tokenID: tokenId, side, amount, price: worstPrice, feeRateBps: 0 },
            { tickSize, negRisk },
            OrderType.FAK,
        );
    }

    log.info(TAG, `  GTC limit @ $${limitPrice} (${config.gtcTimeoutMs / 1000}s timeout)`);

    const size = isBuy ? (mid > 0 ? amount / mid : amount) : amount;

    const result = await client.createAndPostOrder(
        { tokenID: tokenId, side, price: limitPrice, size: parseFloat(size.toFixed(4)), feeRateBps: 0 },
        { tickSize, negRisk },
        OrderType.GTC,
    );

    if (result?.error) return result;

    const orderId = result?.orderID;
    if (!orderId) return result;

    // Poll for fill instead of blocking for full timeout
    const pollInterval = 2000;
    const maxPolls = Math.ceil(config.gtcTimeoutMs / pollInterval);
    let filled = false;
    for (let i = 0; i < maxPolls && !filled; i++) {
        await new Promise(r => setTimeout(r, pollInterval));
        try {
            // Try to get the order — if it's filled, we're done
            const order = await client.getOrder(orderId);
            if (order?.status === 'MATCHED' || order?.status === 'FILLED') {
                filled = true;
            }
        } catch {
            // Ignore — will try cancel below
        }
    }
    if (filled) return result;

    // Check if filled by trying to cancel — if cancel fails, order was filled
    try {
        await client.cancelOrder({ orderID: orderId });
        log.info(TAG, `  GTC unfilled, cancelled — falling back to FAK`);
        // Fall back to FAK
        const tick = parseFloat(tickSize);
        const worstPrice = isBuy
            ? _alignToTick(Math.min(mid * (1 + config.slippage), 1 - tick), tickSize, true)
            : _alignToTick(Math.max(mid * (1 - config.slippage), tick), tickSize, false);
        return client.createAndPostMarketOrder(
            { tokenID: tokenId, side, amount, price: worstPrice, feeRateBps: 0 },
            { tickSize, negRisk },
            OrderType.FAK,
        );
    } catch {
        // Cancel failed = order was already filled
        return result;
    }
}

// ── Dry-run ───────────────────────────────────────────────────────────────────
export async function dryRunCopyTrade(target, activity) {
    const { label, address: wallet } = target;
    const { side, price, asset: tokenId, role, fillCount, transactionHash } = activity;
    const isBuy = side === 'BUY';
    const TAG = `DRY:${label}`;

    const skipReason = _preflight(target, activity, TAG);
    if (skipReason) {
        return { dryRun: true, side, amount: 0, reason: skipReason };
    }

    // Fetch market + book for smart filtering
    let market = null;
    let book = null;
    try {
        [market, book] = await Promise.all([
            getMarketByToken(tokenId),
            getOrderBook(tokenId).catch(() => null),
        ]);
    } catch {}

    if (market && !isMarketActive(market)) {
        return { dryRun: true, side, amount: 0, reason: 'market_closed' };
    }
    if (market && !passesMarketFilter(market)) {
        return { dryRun: true, side, amount: 0, reason: 'market_filtered' };
    }

    // Market quality filter (same as live mode)
    if (config.enableMarketQuality && isBuy && market) {
        const quality = getMarketQuality(market);
        if (quality.score < 0.3) {
            log.info(TAG, `SKIP BUY "${(market.question || '').slice(0, 40)}" — low quality (${quality.reasons.join(', ')})`);
            return { dryRun: true, side, amount: 0, reason: 'low_quality' };
        }
    }

    // Expiry filter
    if (isBuy && config.minExpiryHours > 0 && market) {
        const hoursLeft = getHoursUntilExpiry(market);
        if (hoursLeft < config.minExpiryHours) {
            log.info(TAG, `SKIP BUY "${(market.question || '').slice(0, 40)}" — expires in ${hoursLeft.toFixed(1)}h`);
            return { dryRun: true, side, amount: 0, reason: 'expiring_soon' };
        }
    }

    // Portfolio exposure cap
    if (isBuy && config.maxPortfolioExposurePct > 0) {
        const totalExposure = positions.getTotalCostBasis();
        const balance = await _getBalance();
        if (balance != null) {
            const bankroll = balance + totalExposure;
            if (bankroll > 0 && totalExposure / bankroll >= config.maxPortfolioExposurePct) {
                log.info(TAG, `SKIP BUY — portfolio exposure at cap`);
                return { dryRun: true, side, amount: 0, reason: 'portfolio_exposure' };
            }
        }
    }

    let mid = price;
    try {
        const fetched = await getMidpoint(tokenId);
        if (fetched != null && !isNaN(fetched) && fetched > 0) mid = fetched;
    } catch {}

    // Guard against NaN/zero mid
    if (mid == null || isNaN(mid) || mid <= 0) {
        return { dryRun: true, side, amount: 0, reason: 'no_price' };
    }

    // Smart filters in dry-run too
    if (isBuy && mid > config.maxBuyPrice) {
        log.info(TAG, `SKIP BUY — mid $${mid.toFixed(4)} > max $${config.maxBuyPrice}`);
        return { dryRun: true, side, amount: 0, reason: 'price_too_high' };
    }
    if (!isBuy && mid < config.minSellPrice) {
        log.info(TAG, `SKIP SELL — mid $${mid.toFixed(4)} < min $${config.minSellPrice}`);
        return { dryRun: true, side, amount: 0, reason: 'price_too_low' };
    }

    // Spread check
    const spreadInfo = getSpread(book);
    if (spreadInfo.spreadPct != null && spreadInfo.spreadPct > config.maxSpreadPct) {
        log.info(TAG, `SKIP — spread ${(spreadInfo.spreadPct * 100).toFixed(1)}% too wide`);
        return { dryRun: true, side, amount: 0, reason: 'wide_spread' };
    }

    // Depth check
    const depth = getBookDepth(book);
    const relevantDepth = isBuy ? depth.askDepthUsdc : depth.bidDepthUsdc;
    if (relevantDepth < config.minBookDepthUsdc) {
        log.info(TAG, `SKIP — depth $${relevantDepth.toFixed(0)} too thin`);
        return { dryRun: true, side, amount: 0, reason: 'low_liquidity' };
    }

    const { amount, signalBoost, whaleMultiplier } = _calcAmount(target, activity, mid);

    // Min order check (same as live mode)
    const valueCheck = isBuy ? amount : amount * mid;
    if (valueCheck < config.minOrderUsdc) {
        return { dryRun: true, side, amount: 0, reason: 'too_small' };
    }

    // Edge score filter (same as live mode)
    if (config.enableEdgeFilter && isBuy && market) {
        const quality = getMarketQuality(market);
        const edgeScore = calcEdgeScore({
            whaleMultiplier,
            signalBoost,
            spreadPct: spreadInfo.spreadPct,
            depthUsdc: relevantDepth,
            mid,
            side,
            marketQuality: quality.score,
        });
        if (edgeScore < config.minEdgeScore) {
            log.info(TAG, `SKIP BUY "${(market.question || '').slice(0, 40)}" — edge ${edgeScore.toFixed(2)} < min ${config.minEdgeScore}`);
            return { dryRun: true, side, amount: 0, reason: 'low_edge' };
        }
    }

    // Daily spend guard (track in dry-run for accurate simulation)
    if (isBuy && _wouldExceedDaily(amount)) {
        log.debug(TAG, `SKIP BUY — daily limit ($${_dailyUsdc.toFixed(2)}/$${config.maxDailyUsdc})`);
        return { dryRun: true, side, amount: 0, reason: 'daily_limit' };
    }
    const name = market?.question || market?.title || `...${tokenId.slice(-12)}`;
    const holdInfo = !isBuy ? ` | hold:${positions.getShares(tokenId).toFixed(2)}` : '';
    const boostStr = signalBoost > 1 ? ` | BOOST x${signalBoost.toFixed(1)}` : '';
    const whaleStr = whaleMultiplier !== 1.0 ? ` | WHALE x${whaleMultiplier.toFixed(1)}` : '';

    log.trade(TAG, { side, market: name, action: 'dry_run', amount, price, mid, role, fillCount, signalBoost, whaleMultiplier });
    const estFee = isBuy ? amount * 0.002 : amount * mid * 0.002; // ~20bps taker estimate
    const pos = positions.getPosition(tokenId);
    const estProfit = isBuy ? (1 - mid) * (amount / mid) : amount * mid - amount * (pos?.avgEntry || 0);
    log.info(TAG, `[DRY RUN] Would ${side} ${amount} ${isBuy ? 'USDC' : 'shares'} of "${name.slice(0, 50)}" at $${mid.toFixed(4)} | Est. profit: $${estProfit.toFixed(2)} | Fee: $${estFee.toFixed(4)}${holdInfo}${boostStr}${whaleStr}`);

    // Track positions and daily spend in dry-run
    if (isBuy && amount > 0) {
        _recordSpend(amount);
        const estShares = mid > 0 ? amount / mid : amount;
        positions.recordBuy(tokenId, estShares, amount, { market: name, label });
    } else if (!isBuy && amount > 0) {
        // Save entry price before recordSell (which may delete the position)
        const prePos = positions.getPosition(tokenId);
        const savedAvgEntry = prePos?.avgEntry || 0;
        const estUsdc = amount * mid;
        const pnl = positions.recordSell(tokenId, amount, estUsdc);
        if (pnl !== 0) {
            log.info(TAG, `  Simulated P&L: $${pnl.toFixed(2)}`);
            _recordDailyPnl(pnl);
        }

        // Record whale performance in dry-run too (consistent with exit-manager)
        if (config.enableWhaleTracking) {
            const entryPrice = savedAvgEntry || price;
            whaleTracker.recordTrade(wallet, {
                tokenId, side, entryPrice, exitPrice: mid,
                pnlPct: entryPrice > 0 ? (mid - entryPrice) / entryPrice : 0,
                usdcPnl: pnl, market: name,
            });
        }
    }

    if (amount > 0) {
        _recentOrders.set(dedupKey, Date.now());
        _stampCooldown(wallet, tokenId);
    }
    return { dryRun: true, side, amount, signalBoost };
}
