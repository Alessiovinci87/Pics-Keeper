#!/usr/bin/env node
/**
 * Recompute profit engine + aggregation for a historical date range.
 *
 * The scheduled job only processes the last 7 days. After a historical resync
 * of orders (resync-orders.js), this script MUST be run to populate
 * order_profit and asin_daily_metrics for the full date range.
 *
 * Processes month-by-month to keep memory usage manageable.
 *
 * Usage:
 *   node scripts/recompute-profits.js 2024-01-01                # from date to today, all marketplaces
 *   node scripts/recompute-profits.js 2024-01-01 IT             # only IT marketplace
 *   node scripts/recompute-profits.js 2024-01-01 IT,FR,ES       # multiple marketplaces
 *   node scripts/recompute-profits.js 2024-01-01 IT 2024-06-30  # specific end date
 */
require('dotenv').config();
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
dayjs.extend(utc);

const ProfitService = require('../src/modules/profit-engine/profit.service');
const AggregationService = require('../src/modules/aggregation/aggregation.service');
const AccountService = require('../src/modules/accounts/account.service');
const db = require('../src/database/pool');

const dateFromArg = process.argv[2];
const countryFilter = process.argv[3] ? process.argv[3].toUpperCase().split(',') : null;
const dateToArg = process.argv[4] || null;

if (!dateFromArg) {
  console.error('Usage: node scripts/recompute-profits.js <YYYY-MM-DD> [country1,country2,...] [YYYY-MM-DD]');
  console.error('Example: node scripts/recompute-profits.js 2024-01-01 IT');
  console.error('Example: node scripts/recompute-profits.js 2024-01-01 IT,FR 2024-06-30');
  process.exit(1);
}

/**
 * Generate monthly chunks: [{ from: '2024-01-01', to: '2024-02-01' }, ...]
 * Uses exclusive upper bound (< dateTo) matching the aggregation SQL.
 */
function monthlyChunks(startDate, endDate) {
  const chunks = [];
  let current = dayjs.utc(startDate).startOf('month');
  const end = dayjs.utc(endDate);

  while (current.isBefore(end)) {
    const chunkFrom = current.format('YYYY-MM-DD');
    const nextMonth = current.add(1, 'month');
    const chunkTo = nextMonth.isAfter(end)
      ? end.format('YYYY-MM-DD')
      : nextMonth.format('YYYY-MM-DD');
    chunks.push({ from: chunkFrom, to: chunkTo });
    current = nextMonth;
  }

  return chunks;
}

(async () => {
  const globalStart = Date.now();

  try {
    const dateFrom = dateFromArg;
    const dateTo = dateToArg || dayjs.utc().add(1, 'day').format('YYYY-MM-DD');

    console.log(`\n${'='.repeat(60)}`);
    console.log(`  RECOMPUTE PROFITS + AGGREGATION`);
    console.log(`  Date range: ${dateFrom} → ${dateTo} (exclusive)`);
    if (countryFilter) console.log(`  Country filter: ${countryFilter.join(', ')}`);
    console.log(`${'='.repeat(60)}\n`);

    const targets = await AccountService.getActiveSyncTargets();
    const filtered = countryFilter
      ? targets.filter(t => countryFilter.includes(t.country_code))
      : targets;

    if (filtered.length === 0) {
      console.log('No sync targets found. Check account_marketplaces.');
      await db.shutdown();
      process.exit(0);
    }

    console.log(`  Targets: ${filtered.map(t => t.country_code).join(', ')}`);

    const chunks = monthlyChunks(dateFrom, dateTo);
    console.log(`  Monthly chunks: ${chunks.length}`);
    for (const c of chunks) {
      console.log(`    ${c.from} → ${c.to}`);
    }
    console.log('');

    for (const target of filtered) {
      console.log(`  [${'='.repeat(40)}]`);
      console.log(`  [${target.country_code}] Starting profit + aggregation...`);

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const label = `[${target.country_code}] ${chunk.from} → ${chunk.to}`;

        try {
          // Step 1: Profit computation
          const profitStart = Date.now();
          process.stdout.write(`    ${label} profit...`);
          const profitResult = await ProfitService.computeForRange(
            target.account_id,
            target.account_marketplace_id,
            chunk.from,
            chunk.to
          );
          const profitElapsed = ((Date.now() - profitStart) / 1000).toFixed(1);
          console.log(` ${profitResult.processed} orders (${profitElapsed}s)`);

          // Step 2: Aggregation
          const aggStart = Date.now();
          process.stdout.write(`    ${label} aggregation...`);
          await AggregationService.aggregate(
            target.account_id,
            target.account_marketplace_id,
            chunk.from,
            chunk.to
          );
          const aggElapsed = ((Date.now() - aggStart) / 1000).toFixed(1);
          console.log(` done (${aggElapsed}s)`);
        } catch (err) {
          console.error(` FAILED: ${err.message}`);
        }
      }

      console.log(`  [${target.country_code}] DONE\n`);
    }

    const totalElapsed = ((Date.now() - globalStart) / 1000).toFixed(1);
    console.log(`  Recompute completato in ${totalElapsed}s!\n`);
    await db.shutdown();
  } catch (err) {
    console.error('Error:', err.message);
    await db.shutdown();
    process.exit(1);
  }
})();
