// src/show-portfolio.js — CLI: view portfolio with live P&L
// Usage: npm run portfolio

import { positions } from './positions.js';

async function main() {
    await positions.load();
    if (positions.getCount() === 0) {
        console.log('\n  No open positions.\n');
        process.exit(0);
    }
    await positions.printPortfolio();
    process.exit(0);
}

main().catch(err => { console.error(err.message); process.exit(1); });
