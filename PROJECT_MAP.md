# Project Map — Polymarket Copy-Trader v7.0

A real-time copy-trading bot that detects and mirrors trades from profitable Polymarket whale wallets on the Polygon blockchain.

## File Listing

| File | Description |
|------|-------------|
| `package.json` | Project metadata, npm scripts (`start`, `test`, `simulate`, `positions`, `portfolio`), and dependencies |
| `package-lock.json` | Locked dependency tree for reproducible installs |
| `.env.example` | Template for required/optional environment variables (private key, WSS URL, etc.) |
| `.gitignore` | Ignores `node_modules/`, `data/`, `.env`, and `*.log` from version control |
| `Dockerfile` | Alpine Node 20 container image that runs `src/index.js` with a persistent `data/` volume |
| `docker-compose.yml` | Single-service Compose file to build and run the bot with `.env` and `data/` volume |
| `guide.md` | Comprehensive setup guide covering installation, configuration, deployment, and troubleshooting |
| `guide.md.bak` | Backup copy of the setup guide |
| **`src/index.js`** | Entry point — bootstraps the bot, wires modules together, handles process signals |
| **`src/config.js`** | All configuration: whale targets, risk controls, smart filters, auto-exit params, API endpoints |
| **`src/trader.js`** | Order execution engine with smart filters, Kelly sizing, slippage control, and retry logic |
| **`src/monitor.js`** | On-chain event listener — connects via WebSocket to detect whale trades in real time |
| **`src/api.js`** | Polymarket REST/WebSocket API client with rate limiting, TTL cache, and request deduplication |
| **`src/positions.js`** | Position state management, P&L tracking, and on-chain sync |
| **`src/exit-manager.js`** | Auto-exit engine: stop-loss, take-profit, trailing stop, profit ratchet, time/EV exits |
| **`src/stats.js`** | Runtime statistics collector (trades, fills, skips, daily spend) |
| **`src/logger.js`** | Structured logging with log levels, file rotation, and Slack/Discord webhook alerts |
| **`src/whale-tracker.js`** | Tracks per-whale win rate and performance; adjusts copy ratios over time |
| **`src/test.js`** | Connectivity tests — verifies RPC, Polymarket API access, and order book analysis |
| **`src/simulate.js`** | Offline logic test suite (149 tests) covering filters, exits, position math, and whale tracking |
| **`src/audit-test.js`** | Audit test suite — tests auth, market fetch, copy logic, dry-run orders, and benchmarks |
| **`src/show-positions.js`** | CLI utility to display current open positions |
| **`src/show-portfolio.js`** | CLI utility to display portfolio summary and P&L |

## Runtime Data (`data/` — git-ignored, auto-created)

| File | Description |
|------|-------------|
| `data/positions.json` | Persisted open position state |
| `data/stats.json` | Trade statistics |
| `data/health.json` | Health check output (updated every 60s) |
| `data/trades.jsonl` | Append-only trade journal (JSON Lines) |
| `data/whale-tracker.json` | Per-whale performance and win-rate data |
