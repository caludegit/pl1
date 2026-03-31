// src/logger.js — Structured logging, trade journal, webhook notifications
//
// Features:
//   - Log levels: debug, info, warn, error
//   - Console output with timestamps and prefixes
//   - Trade journal (trades.jsonl) with rotation
//   - Optional webhook notifications for fills, errors, P&L

import { appendFile, stat, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import config from './config.js';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

function _ts() { return new Date().toISOString().slice(11, 23); }

function _levelNum() { return LEVELS[config.logLevel] ?? 1; }

// ── Console logging ───────────────────────────────────────────────────────────
export function debug(tag, msg, ...args) {
    if (_levelNum() > 0) return;
    console.log(`[${_ts()}][${tag}] ${msg}`, ...args);
}

export function info(tag, msg, ...args) {
    if (_levelNum() > 1) return;
    console.log(`[${_ts()}][${tag}] ${msg}`, ...args);
}

export function warn(tag, msg, ...args) {
    if (_levelNum() > 2) return;
    console.warn(`[${_ts()}][${tag}] ${msg}`, ...args);
}

export function error(tag, msg, ...args) {
    console.error(`[${_ts()}][${tag}] ${msg}`, ...args);
}

// ── Trade journal (JSON Lines) ────────────────────────────────────────────────
let _buf = [];

async function _ensureDir(filePath) {
    try { await mkdir(dirname(filePath), { recursive: true }); } catch {}
}

let _flushing = false;

async function _flush() {
    if (_buf.length === 0) return;
    // Serialize flushes: if already flushing, skip (the current flush
    // will pick up any new entries added since it started on next call)
    if (_flushing) return;
    _flushing = true;
    try {
        while (_buf.length > 0) {
            const lines = _buf.splice(0);
            try {
                await _ensureDir(config.logFile);
                await appendFile(config.logFile, lines.join(''));
            } catch (e) {
                // Don't lose lines on transient errors — push them back
                // concat avoids spread which can RangeError on large arrays
                _buf = lines.concat(_buf);
                break; // stop retrying this cycle, will retry next call
            }
        }
    } finally {
        _flushing = false;
    }
}

// Rotate check every 60s — .unref() so this timer doesn't prevent process exit
// in CLI scripts (show-positions, simulate, test, etc.)
const _rotateTimer = setInterval(async () => {
    await _flush();
    try {
        const s = await stat(config.logFile);
        if (s.size > config.logMaxBytes) {
            const rotated = config.logFile.replace('.jsonl', `.${Date.now()}.jsonl`);
            await rename(config.logFile, rotated).catch(() => {});
        }
    } catch {}
}, 60_000);
_rotateTimer.unref();

export function journal(entry) {
    _buf.push(JSON.stringify({ ...entry, ts: new Date().toISOString() }) + '\n');
    _flush().catch(() => {});
}

export async function flushJournal() {
    await _flush();
}

// ── Webhook notifications ─────────────────────────────────────────────────────
// Fire-and-forget — never blocks trading logic
const _webhookQueue = [];
let _webhookSending = false;

const MAX_WEBHOOK_QUEUE = 100;

export function notify(event, data = {}) {
    if (!config.webhookUrl) return;
    // Prevent unbounded queue growth if webhook endpoint is down
    if (_webhookQueue.length >= MAX_WEBHOOK_QUEUE) {
        _webhookQueue.splice(0, _webhookQueue.length - MAX_WEBHOOK_QUEUE + 1);
    }
    _webhookQueue.push({ event, ...data, ts: new Date().toISOString() });
    _drainWebhook();
}

async function _drainWebhook() {
    if (_webhookSending || _webhookQueue.length === 0) return;
    _webhookSending = true;
    while (_webhookQueue.length > 0) {
        const payload = _webhookQueue.shift();
        try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 5_000);
            await fetch(config.webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: ctrl.signal,
            }).finally(() => clearTimeout(timer));
        } catch {
            // Webhook failures should never affect trading — drop silently
        }
    }
    _webhookSending = false;
}

// ── Convenience: log + journal in one call ────────────────────────────────────
export function trade(tag, entry) {
    const { side, market, action, amount } = entry;
    const unit = side === 'BUY' ? 'USDC' : 'shares';
    if (action === 'filled') {
        info(tag, `${side} ${amount} ${unit} "${(market || '').slice(0, 50)}" — FILLED`);
    } else if (action === 'skip') {
        debug(tag, `SKIP ${side} "${(market || '').slice(0, 40)}" — ${entry.reason}`);
    } else if (action === 'rejected') {
        warn(tag, `${side} REJECTED: ${entry.error}`);
    } else if (action === 'error') {
        error(tag, `${side} ERROR: ${entry.error}`);
    } else if (action === 'dry_run') {
        info(tag, `[DRY] Would ${side} ${amount} ${unit} "${(market || '').slice(0, 50)}"`);
    }
    journal({ label: tag, ...entry });
}
