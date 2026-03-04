#!/usr/bin/env node
/**
 * Reconcile missing orders via Reports API, then recompute profits.
 *
 * Usage:
 *   node scripts/reconcile-and-recompute.js [dateFrom] [dateTo]
 *   node scripts/reconcile-and-recompute.js 2026-02-01 2026-03-02
 *
 * dateTo is INCLUSIVE (same as Shopkeeper).
 * Pipeline queries use < dateTo+1 internally.
 */
require('dotenv').config();

const db = require('../src/database/pool');
const AccountService = require('../src/modules/accounts/account.service');
const ReconciliationService = require('../src/modules/orders/orders-reconciliation.service');
const ProfitService = require('../src/modules/profit-engine/profit.service');
const AggregationService = require('../src/modules/aggregation/aggregation.service');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
dayjs.extend(utc);

const ACCOUNT_ID = 1;

async function main() {
  const dateFrom = process.argv[2] || '2026-02-01';
  const dateToInclusive = process.argv[3] || '2026-03-02';
  // Exclusive upper bound for pipeline queries
  const dateToExclusive = dayjs(dateToInclusive).add(1, 'day').format('YYYY-MM-DD');

  console.log(`\n=== Reconcile & Recompute ===`);
  console.log(`  Range: ${dateFrom} → ${dateToInclusive} (inclusive)`);
  console.log(`  Pipeline dateTo: ${dateToExclusive} (exclusive)\n`);

  // --- Step 0: Snapshot before reconciliation ---
  console.log(`--- BEFORE reconciliation ---`);
  await printUnits(dateFrom, dateToExclusive);

  // --- Step 1: Reconcile orders for all active marketplaces ---
  console.log(`\n--- Step 1: Reconciling orders via Reports API ---\n`);

  const targets = await AccountService.getActiveSyncTargets();
  const accountTargets = targets.filter((t) => t.account_id === ACCOUNT_ID);

  let totalInserted = 0;

  for (const target of accountTargets) {
    try {
      console.log(`  ${target.country_code}: requesting report...`);
      const result = await ReconciliationService.reconcile(target, {
        dateFrom,
        dateTo: dateToInclusive,
      });
      console.log(`  ${target.country_code}: ✓ report=${result.reportRows} rows, inserted=${result.inserted}, skipped=${result.skipped}`);
      totalInserted += result.inserted;
    } catch (err) {
      console.error(`  ${target.country_code}: ✗ ${err.message}`);
    }
  }

  console.log(`\n  Total new orders inserted: ${totalInserted}`);

  if (totalInserted === 0) {
    console.log(`\n  No new orders found — the gap may be due to:`);
    console.log(`    - Timezone boundary differences (UTC vs local)`);
    console.log(`    - Different counting logic (Shopkeeper vs our pipeline)`);
    console.log(`    - Pending/Unshipped orders counted differently`);
    console.log(`\n  Running recompute anyway to ensure consistency...\n`);
  }

  // --- Step 2: Recompute profits + aggregation ---
  console.log(`\n--- Step 2: Recompute profits + aggregation ---\n`);

  const mpResult = await db.query(`
    SELECT DISTINCT mk.id, mk.country_code
    FROM marketplaces mk
    JOIN orders_raw o ON o.marketplace_id = mk.id AND o.account_id = $1
    WHERE o.purchase_date >= $2 AND o.purchase_date < $3
    ORDER BY mk.id
  `, [ACCOUNT_ID, dateFrom, dateToExclusive]);

  for (const mp of mpResult.rows) {
    try {
      console.log(`  ${mp.country_code}: profit compute...`);
      const profitResult = await ProfitService.computeForRange(ACCOUNT_ID, mp.id, dateFrom, dateToExclusive);
      console.log(`  ${mp.country_code}: ✓ ${profitResult.processed} orders`);

      console.log(`  ${mp.country_code}: aggregation...`);
      await AggregationService.aggregate(ACCOUNT_ID, mp.id, dateFrom, dateToExclusive);
      console.log(`  ${mp.country_code}: ✓ done\n`);
    } catch (err) {
      console.error(`  ${mp.country_code}: ✗ ${err.message}\n`);
    }
  }

  // --- Step 3: Final verification ---
  console.log(`\n--- AFTER reconciliation + recompute ---`);
  await printUnits(dateFrom, dateToExclusive);

  console.log('\nDone.');
  await db.shutdown();
}

/**
 * Print units per marketplace for comparison with Shopkeeper.
 */
async function printUnits(dateFrom, dateTo) {
  const result = await db.query(`
    SELECT
      mk.country_code,
      COALESCE(SUM(o.quantity), 0) AS units
    FROM orders_raw o
    JOIN marketplaces mk ON mk.id = o.marketplace_id
    WHERE o.account_id = $1
      AND UPPER(o.order_status) NOT IN ('CANCELLED','CANCELED','PENDING')
      AND o.purchase_date >= $2 AND o.purchase_date < $3
    GROUP BY mk.country_code
    ORDER BY units DESC
  `, [ACCOUNT_ID, dateFrom, dateTo]);

  const total = result.rows.reduce((sum, r) => sum + parseInt(r.units, 10), 0);
  console.log(`\n  Marketplace | Units`);
  console.log(`  ------------|------`);
  for (const row of result.rows) {
    console.log(`  ${row.country_code.padEnd(11)} | ${row.units}`);
  }
  console.log(`  ------------|------`);
  console.log(`  TOTAL       | ${total}\n`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
