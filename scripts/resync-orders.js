#!/usr/bin/env node
/**
 * Force re-sync orders from Amazon SP-API for a specific date range.
 * This script bypasses the HTTP server — runs directly.
 * Splits large date ranges into monthly chunks to avoid SP-API rate limits.
 *
 * Usage:
 *   node scripts/resync-orders.js 2026-02-27              # resync from Feb 27 to now, all marketplaces
 *   node scripts/resync-orders.js 2026-02-27 IT           # resync only IT
 *   node scripts/resync-orders.js 2026-02-27 IT,FR,ES     # resync IT, FR, ES
 */
require('dotenv').config();
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
dayjs.extend(utc);

const OrdersService = require('../src/modules/orders/orders.service');
const AccountService = require('../src/modules/accounts/account.service');
const db = require('../src/database/pool');
const { sleep } = require('../src/utils/helpers');

const dateFrom = process.argv[2];
const countryFilter = process.argv[3] ? process.argv[3].toUpperCase().split(',') : null;

if (!dateFrom) {
  console.error('Usage: node scripts/resync-orders.js <YYYY-MM-DD> [country1,country2,...]');
  console.error('Example: node scripts/resync-orders.js 2026-02-27 IT,FR,ES');
  process.exit(1);
}

/**
 * Split a date range into monthly chunks.
 * Returns array of { from, to } objects.
 */
function buildMonthlyChunks(startDate, endDate) {
  const chunks = [];
  let cursor = dayjs.utc(startDate).startOf('day');
  const end = dayjs.utc(endDate);

  while (cursor.isBefore(end)) {
    const chunkEnd = cursor.add(1, 'month');
    chunks.push({
      from: cursor.format('YYYY-MM-DD'),
      to: (chunkEnd.isAfter(end) ? end : chunkEnd).format('YYYY-MM-DD'),
    });
    cursor = chunkEnd;
  }

  return chunks;
}

(async () => {
  try {
    const now = dayjs.utc();
    const chunks = buildMonthlyChunks(dateFrom, now.format('YYYY-MM-DD'));

    console.log(`\n${'='.repeat(60)}`);
    console.log(`  RESYNC ORDINI dal ${dateFrom}`);
    if (countryFilter) console.log(`  Filtro paesi: ${countryFilter.join(', ')}`);
    console.log(`  Suddiviso in ${chunks.length} chunk mensili`);
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
      let totalProcessed = 0;
      let totalInserted = 0;
      let totalErrors = 0;
      let chunksFailed = 0;
      const start = Date.now();

      console.log(`  [${target.country_code}] Starting resync — ${chunks.length} monthly chunks\n`);

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const chunkLabel = `${chunk.from} → ${chunk.to}`;
        console.log(`    [${target.country_code}] Chunk ${i + 1}/${chunks.length}: ${chunkLabel}`);

        try {
          const result = await OrdersService.syncOrders(target, { dateFrom: chunk.from, dateTo: chunk.to });
          totalProcessed += result.processed;
          totalInserted += result.inserted;
          totalErrors += result.errors || 0;
          console.log(`    [${target.country_code}] Chunk ${i + 1} DONE — processed: ${result.processed}, inserted: ${result.inserted}, skipped: ${result.skipped}`);
        } catch (err) {
          chunksFailed++;
          console.error(`    [${target.country_code}] Chunk ${i + 1} FAILED — ${err.message}`);
        }

        // Pause between chunks to let rate-limit tokens recover
        if (i < chunks.length - 1) {
          console.log(`    ... pausa 10s tra chunk per rate limit ...\n`);
          await sleep(10000);
        }
      }

      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`\n  [${target.country_code}] RESYNC COMPLETATO in ${elapsed}s`);
      console.log(`    Totale: processed=${totalProcessed}, inserted=${totalInserted}, errors=${totalErrors}, chunks_failed=${chunksFailed}\n`);
    }

    console.log(`  Resync completato!\n`);
    await db.shutdown();
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
})();
