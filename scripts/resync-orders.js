#!/usr/bin/env node
/**
 * Force re-sync orders from Amazon SP-API for a specific date range.
 * This script bypasses the HTTP server — runs directly.
 *
 * Usage:
 *   node scripts/resync-orders.js 2026-02-27              # resync from Feb 27 to now, all marketplaces
 *   node scripts/resync-orders.js 2026-02-27 IT           # resync only IT
 *   node scripts/resync-orders.js 2026-02-27 IT,FR,ES     # resync IT, FR, ES
 */
require('dotenv').config();
const OrdersService = require('../src/modules/orders/orders.service');
const AccountService = require('../src/modules/accounts/account.service');
const db = require('../src/database/pool');

const dateFrom = process.argv[2];
const countryFilter = process.argv[3] ? process.argv[3].toUpperCase().split(',') : null;

if (!dateFrom) {
  console.error('Usage: node scripts/resync-orders.js <YYYY-MM-DD> [country1,country2,...]');
  console.error('Example: node scripts/resync-orders.js 2026-02-27 IT,FR,ES');
  process.exit(1);
}

(async () => {
  try {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`  RESYNC ORDINI dal ${dateFrom}`);
    if (countryFilter) console.log(`  Filtro paesi: ${countryFilter.join(', ')}`);
    console.log(`${'='.repeat(60)}\n`);

    const targets = await AccountService.getActiveSyncTargets();

    const filtered = countryFilter
      ? targets.filter(t => countryFilter.includes(t.country_code))
      : targets;

    if (filtered.length === 0) {
      console.log('Nessun sync target trovato. Controlla account_marketplaces.');
      await db.shutdown();
      process.exit(0);
    }

    console.log(`  Sync targets trovati: ${filtered.length}`);
    for (const t of filtered) {
      console.log(`    - ${t.country_code} (account ${t.account_id})`);
    }
    console.log('');

    for (const target of filtered) {
      console.log(`  [${target.country_code}] Syncing from ${dateFrom}...`);
      const start = Date.now();
      try {
        const result = await OrdersService.syncOrders(target, { dateFrom });
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        console.log(`  [${target.country_code}] DONE in ${elapsed}s — processed: ${result.processed}, inserted: ${result.inserted}, updated: ${result.updated || 0}`);
      } catch (err) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        console.error(`  [${target.country_code}] FAILED after ${elapsed}s — ${err.message}`);
      }
    }

    console.log(`\n  Resync completato!\n`);
    await db.shutdown();
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
})();
