// src/errors.js — Structured error types for retry/classification logic
//
// Replaces ad-hoc string matching (msg.includes('timeout')) with instanceof checks.

export class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.name = 'HttpError';
        this.status = status;
    }

    get retryable() {
        return this.status === 429 || this.status >= 500;
    }

    get clientError() {
        return this.status >= 400 && this.status < 500 && this.status !== 429;
    }
}

export class TransientError extends Error {
    constructor(message) {
        super(message);
        this.name = 'TransientError';
    }
}
