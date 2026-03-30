// src/api.js — Polymarket REST API with TTL cache, market awareness, smart routing
//
// Features:
//   - TTL-based market cache (5 min)
//   - Complementary token lookup (YES <-> NO)
//   - Market status + volume checking
//   - Order book analysis: spread, depth, execution price
//   - USDC balance fetch
//   - Proper retry with error classification

import config from './config.js';

const TIMEOUT     = 8_000;
const MAX_RETRIES = 3;
const CACHE_TTL   = 5 * 60_000;

// ── Simple rate limiter to avoid API bans ────────────────────────────────────
const _requestTimes = [];
const MAX_REQUESTS_PER_SEC = 8;

async function _rateLimit() {
    const now = Date.now();
    // Remove timestamps older than 1 second
    while (_requestTimes.length > 0 && _requestTimes[0] < now - 1000) {
        _requestTimes.shift();
    }
    if (_requestTimes.length >= MAX_REQUESTS_PER_SEC) {
        const waitMs = _requestTimes[0] + 1000 - now;
        if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));
    }
    _requestTimes.push(Date.now());
}

// ── Fetch with timeout ────────────────────────────────────────────────────────
// Node.js 18+ native fetch uses HTTP/1.1 keep-alive by default
async function fetchT(url, opts = {}) {
    await _rateLimit();
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT);
    return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

// ── Retry wrapper ─────────────────────────────────────────────────────────────
function httpError(status, msg) {
    const e = new Error(msg);
    e._status = status;
    return e;
}

async function withRetry(fn, label, retries = MAX_RETRIES) {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (err) {
            const status = err._status;
            const nonRetryable = status && status >= 400 && status < 500 && status !== 429;
            if (nonRetryable || i === retries - 1) throw err;
            const delay = 300 * 2 ** i;
            await new Promise(r => setTimeout(r, delay));
        }
    }
}

// ── TTL cache ─────────────────────────────────────────────────────────────────
const cache = new Map();
const inflight = new Map();

function cacheGet(key) {
    const entry = cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
        cache.delete(key);
        return undefined;
    }
    return entry.data;
}

function cacheSet(key, data, ttl = CACHE_TTL) {
    cache.set(key, { data, expiresAt: Date.now() + ttl });
}

// ── Periodic cache cleanup to prevent stale entry accumulation ───────────────
export function cleanExpiredCache() {
    const now = Date.now();
    for (const [key, entry] of cache) {
        if (now > entry.expiresAt) cache.delete(key);
    }
}

const _cacheCleanTimer = setInterval(cleanExpiredCache, 10 * 60_000); // every 10 min
_cacheCleanTimer.unref();

function dedup(key, fn) {
    if (inflight.has(key)) return inflight.get(key);
    const p = fn().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
}

// ── Gamma: market by conditionId ──────────────────────────────────────────────
export async function getMarketByCondition(conditionId) {
    const k = `c:${conditionId}`;
    const cached = cacheGet(k);
    if (cached) return cached;
    return dedup(k, () => withRetry(async () => {
        const res = await fetchT(`${config.gammaHost}/markets?condition_id=${conditionId}`);
        if (!res.ok) throw httpError(res.status, `Gamma condition ${res.status}`);
        const list = await res.json();
        if (!list?.length) throw httpError(404, `No market for condition ${conditionId}`);
        cacheSet(k, list[0]);
        return list[0];
    }, `getMarketByCondition`));
}

// ── Gamma: market by tokenId ──────────────────────────────────────────────────
export async function getMarketByToken(tokenId) {
    const k = `t:${tokenId}`;
    const cached = cacheGet(k);
    if (cached) return cached;
    return dedup(k, () => withRetry(async () => {
        for (const qs of [`clob_token_ids=${tokenId}&closed=false`, `clob_token_ids=${tokenId}`]) {
            const res = await fetchT(`${config.gammaHost}/markets?${qs}`);
            if (res.ok) {
                const list = await res.json();
                if (list?.length) { cacheSet(k, list[0]); return list[0]; }
            }
        }
        throw httpError(404, `No market for token ${tokenId}`);
    }, `getMarketByToken`));
}

// ── Market status helpers ─────────────────────────────────────────────────────
export function isMarketActive(market) {
    if (!market) return false;
    if (market.closed === true || market.closed === 'true') return false;
    if (market.resolved === true || market.resolved === 'true') return false;
    if (market.active === false || market.active === 'false') return false;
    return true;
}

// Get the complementary token (YES <-> NO) for a given tokenId
export function getComplementaryToken(market, tokenId) {
    if (!market) return null;
    const tokens = market.clob_token_ids || market.clobTokenIds || [];
    if (!Array.isArray(tokens) || tokens.length < 2) return null;
    const tokenStr = String(tokenId);
    const idx = tokens.findIndex(t => String(t) === tokenStr);
    if (idx < 0) return null;
    return tokens[idx === 0 ? 1 : 0];
}

// ── CLOB: midpoint (never cached — always live) ──────────────────────────────
export async function getMidpoint(tokenId) {
    const res = await fetchT(`${config.clobHost}/midpoint?token_id=${tokenId}`);
    if (!res.ok) throw httpError(res.status, `CLOB midpoint ${res.status}`);
    const data = await res.json();
    const mid = parseFloat(data.mid);
    if (isNaN(mid)) throw new Error(`Invalid midpoint for token ${tokenId}: ${data.mid}`);
    return mid;
}

// ── CLOB: order book ─────────────────────────────────────────────────────────
export async function getOrderBook(tokenId) {
    const res = await fetchT(`${config.clobHost}/book?token_id=${tokenId}`);
    if (!res.ok) throw httpError(res.status, `CLOB book ${res.status}`);
    return res.json();
}

// ── Spread calculation ───────────────────────────────────────────────────────
export function getSpread(book) {
    if (!book) return { spread: null, spreadPct: null, bestBid: null, bestAsk: null };
    const bids = book.bids || [];
    const asks = book.asks || [];
    if (bids.length === 0 || asks.length === 0) return { spread: null, spreadPct: null, bestBid: null, bestAsk: null };

    const bestBid = Math.max(...bids.map(b => parseFloat(b.price)));
    const bestAsk = Math.min(...asks.map(a => parseFloat(a.price)));
    const mid = (bestBid + bestAsk) / 2;
    const spread = bestAsk - bestBid;
    const spreadPct = mid > 0 ? spread / mid : null;

    return { spread, spreadPct, bestBid, bestAsk, mid };
}

// ── Book depth calculation ───────────────────────────────────────────────────
// Returns total USDC available on each side of the book
export function getBookDepth(book) {
    if (!book) return { bidDepthUsdc: 0, askDepthUsdc: 0 };
    const bidDepthUsdc = (book.bids || []).reduce((s, b) =>
        s + parseFloat(b.size) * parseFloat(b.price), 0);
    const askDepthUsdc = (book.asks || []).reduce((s, a) =>
        s + parseFloat(a.size) * parseFloat(a.price), 0);
    return { bidDepthUsdc, askDepthUsdc };
}

// ── Walk book levels to estimate execution price ─────────────────────────────
export function getExecutionPriceFromBook(book, side, amount) {
    try {
        const levels = side === 'BUY'
            ? (book.asks || []).sort((a, b) => parseFloat(a.price) - parseFloat(b.price))
            : (book.bids || []).sort((a, b) => parseFloat(b.price) - parseFloat(a.price));

        if (side === 'BUY') {
            let remainingUsdc = amount;
            let sharesReceived = 0;
            for (const lvl of levels) {
                const px = parseFloat(lvl.price);
                const sz = parseFloat(lvl.size);
                const usdcAtLevel = sz * px;
                const usdcSpent = Math.min(remainingUsdc, usdcAtLevel);
                sharesReceived += usdcSpent / px;
                remainingUsdc -= usdcSpent;
                if (remainingUsdc <= 0) break;
            }
            const usdcFilled = amount - Math.max(remainingUsdc, 0);
            if (usdcFilled === 0 || sharesReceived === 0) return null;
            return { avgPrice: usdcFilled / sharesReceived, wouldFill: sharesReceived, fillPct: usdcFilled / amount };
        } else {
            let remainingShares = amount;
            let usdcReceived = 0;
            for (const lvl of levels) {
                const px = parseFloat(lvl.price);
                const sz = parseFloat(lvl.size);
                const fill = Math.min(remainingShares, sz);
                usdcReceived += fill * px;
                remainingShares -= fill;
                if (remainingShares <= 0) break;
            }
            const sharesFilled = amount - Math.max(remainingShares, 0);
            if (sharesFilled === 0) return null;
            return { avgPrice: usdcReceived / sharesFilled, wouldFill: sharesFilled, fillPct: sharesFilled / amount };
        }
    } catch {
        return null;
    }
}

// ── Data API: recent activity ─────────────────────────────────────────────────
export async function fetchActivity(address, { limit = 20 } = {}) {
    const url = `${config.dataApiHost}/activity?user=${address}&type=TRADE&limit=${limit}`;
    const res = await fetchT(url);
    if (!res.ok) throw httpError(res.status, `Data API ${res.status}`);
    return res.json();
}

// ── Data API: positions ───────────────────────────────────────────────────────
export async function fetchPositions(address) {
    const url = `${config.dataApiHost}/positions?user=${address}`;
    const res = await fetchT(url);
    if (!res.ok) throw httpError(res.status, `Positions API ${res.status}`);
    return res.json();
}

// ── USDC balance on Polygon ───────────────────────────────────────────────────
export async function fetchBalance(address) {
    try {
        const url = `${config.dataApiHost}/balance?user=${address}`;
        const res = await fetchT(url);
        if (!res.ok) return null;
        const data = await res.json();
        return parseFloat(data.balance || data.usdc || data.amount || 0);
    } catch {
        return null;
    }
}

// ── Market tick & negRisk extraction ──────────────────────────────────────────
export function extractMarketParams(market) {
    const tickSize = String(market.minimum_tick_size || market.tick_size || '0.01');
    const negRisk  = market.neg_risk === true || market.neg_risk === 'true';
    return { tickSize, negRisk };
}

// ── Market expiry check ──────────────────────────────────────────────────────
// Returns hours until market expires, or Infinity if no end date
export function getHoursUntilExpiry(market) {
    if (!market) return Infinity;
    const endDate = market.end_date_iso || market.end_date || market.endDate;
    if (!endDate) return Infinity;
    try {
        const expiryMs = new Date(endDate).getTime();
        if (isNaN(expiryMs)) return Infinity;
        return Math.max(0, (expiryMs - Date.now()) / (60 * 60_000));
    } catch {
        return Infinity;
    }
}

// ── Market quality scoring (0-1) ─────────────────────────────────────────────
// Higher = better quality market for copy trading
export function getMarketQuality(market) {
    if (!market) return { score: 0, reasons: ['no_market_data'] };

    let score = 0.5; // baseline
    const reasons = [];

    // Volume: higher is better (more liquid, more efficient)
    const volume = parseFloat(market.volume || market.volumeNum || 0);
    if (volume >= 100_000) { score += 0.2; reasons.push('high_volume'); }
    else if (volume >= 20_000) { score += 0.1; reasons.push('good_volume'); }
    else if (volume < (config.minMarketVolume || 5000)) { score -= 0.3; reasons.push('low_volume'); }

    // Liquidity: check if enough liquidity on both sides
    const liquidity = parseFloat(market.liquidity || 0);
    if (liquidity >= 50_000) { score += 0.1; reasons.push('deep_liquidity'); }
    else if (liquidity < 5_000) { score -= 0.1; reasons.push('thin_liquidity'); }

    // Active trading: has recent trades
    if (market.closed || market.resolved) { score = 0; reasons.push('closed'); }

    // Clamp to [0, 1]
    score = Math.max(0, Math.min(1, score));
    return { score, volume, liquidity, reasons };
}

// ── Edge score calculation ───────────────────────────────────────────────────
// Composite score (0-1) that combines all factors to decide if a trade is worth taking
export function calcEdgeScore({ whaleMultiplier, signalBoost, spreadPct, depthUsdc, mid, side, marketQuality }) {
    let score = 0.5; // baseline

    // Whale quality component (biggest factor: ±0.25)
    if (whaleMultiplier >= 2.0) score += 0.25;
    else if (whaleMultiplier >= 1.3) score += 0.15;
    else if (whaleMultiplier >= 0.8) score += 0.05;
    else if (whaleMultiplier < 0.5) score -= 0.2;

    // Signal boost: multiple whales agree (±0.15)
    if (signalBoost >= 2.0) score += 0.15;
    else if (signalBoost >= 1.5) score += 0.10;

    // Spread quality (±0.1)
    if (spreadPct != null) {
        if (spreadPct < 0.02) score += 0.10;       // very tight spread
        else if (spreadPct < 0.05) score += 0.05;   // decent spread
        else if (spreadPct > 0.07) score -= 0.10;   // wide spread
    }

    // Depth quality (±0.05)
    if (depthUsdc >= 200) score += 0.05;
    else if (depthUsdc < 75) score -= 0.05;

    // Price position: prefer mid-range over extremes for buys (±0.1)
    if (side === 'BUY') {
        if (mid >= 0.15 && mid <= 0.75) score += 0.10;  // sweet spot
        else if (mid > 0.85) score -= 0.10;              // too expensive
    }

    // Market quality (±0.1)
    if (marketQuality >= 0.7) score += 0.10;
    else if (marketQuality < 0.3) score -= 0.10;

    return Math.max(0, Math.min(1, score));
}

// ── Check if market passes keyword filters ────────────────────────────────────
export function passesMarketFilter(market) {
    const question = (market.question || market.title || '').toLowerCase();
    if (!question) return true;

    if (config.marketBlocklist.length > 0) {
        for (const kw of config.marketBlocklist) {
            if (question.includes(kw.toLowerCase())) return false;
        }
    }

    if (config.marketAllowlist.length > 0) {
        return config.marketAllowlist.some(kw => question.includes(kw.toLowerCase()));
    }

    return true;
}
