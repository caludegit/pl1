// src/show-positions.js — CLI: view current positions
// Usage: npm run positions

import { positions } from './positions.js';

async function main() {
    await positions.load();
    positions.print();
    process.exit(0);
}

main().catch(err => { console.error(err.message); process.exit(1); });
