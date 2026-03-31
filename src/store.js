// src/store.js — Shared debounced JSON file persistence
//
// Consolidates the load/save/flush pattern used by positions.js, stats.js, and whale-tracker.js.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export class JsonStore {
    constructor(filePath, { debounceMs = 0, tag = 'STORE' } = {}) {
        this._path = filePath;
        this._debounceMs = debounceMs;
        this._tag = tag;
        this._timer = null;
        this._dirty = false;
        this._serialize = null;
    }

    async load() {
        try {
            const raw = await readFile(this._path, 'utf-8');
            return JSON.parse(raw);
        } catch (err) {
            if (err.code === 'ENOENT') return null;
            throw err;
        }
    }

    scheduleSave(serializeFn) {
        this._serialize = serializeFn;
        this._dirty = true;
        if (this._debounceMs <= 0) {
            this._doSave();
            return;
        }
        if (this._timer) return;
        this._timer = setTimeout(() => {
            this._timer = null;
            this._doSave();
        }, this._debounceMs);
        this._timer.unref();
    }

    async _doSave() {
        if (!this._dirty || !this._serialize) return;
        this._dirty = false;
        try {
            await mkdir(dirname(this._path), { recursive: true });
            await writeFile(this._path, JSON.stringify(this._serialize(), null, 2));
        } catch {
            this._dirty = true; // retry on next flush
        }
    }

    async flush() {
        clearTimeout(this._timer);
        this._timer = null;
        await this._doSave();
    }
}
