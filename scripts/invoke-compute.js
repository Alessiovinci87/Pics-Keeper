#!/usr/bin/env node
/**
 * Invoke profit compute + aggregation directly (no HTTP server needed).
 *
 * Usage:
 *   node scripts/invoke-compute.js [dateFrom] [dateTo]
 *   node scripts/invoke-compute.js 2026-02-01 2026-03-03
 *
 * Defaults to last 7 days if no dates given.
 */
require('dotenv').config();

const ProfitService = require('../src/modules/profit-engine/profit.service');
const AggregationService = require('../src/modules/aggregation/aggregation.service');
const db = require('../src/database/pool');
const logger = require('../src/utils/logger');

const ACCOUNT_ID = 1;
const MARKETPLACE_IDS = [1, 2, 3]; // DE, FR, IT
const MARKETPLACE_NAMES = { 1: 'DE', 2: 'FR', 3: 'IT' };

async function main() {
  const dateFrom = process.argv[2] || '2026-02-01';
  const dateTo = process.argv[3] || '2026-03-03';

  console.log(`\n=== Compute + Aggregate: ${dateFrom} → ${dateTo} ===\n`);

  for (const mpId of MARKETPLACE_IDS) {
    const name = MARKETPLACE_NAMES[mpId];
    console.log(`--- ${name} (marketplace_id=${mpId}) ---`);

    try {
      console.log(`  [1/2] Profit compute...`);
      const profitResult = await ProfitService.computeForRange(ACCOUNT_ID, mpId, dateFrom, dateTo);
      console.log(`  ✓ Profit: ${profitResult.processed} orders processed`);

      console.log(`  [2/2] Aggregation...`);
      await AggregationService.aggregate(ACCOUNT_ID, mpId, dateFrom, dateTo);
      console.log(`  ✓ Aggregation complete\n`);
    } catch (err) {
      console.error(`  ✗ ${name} failed: ${err.message}\n`);
    }
  }

  // Verification query
  console.log(`=== Verification (${dateFrom} → ${dateTo}) ===\n`);
  const verification = await db.query(`
    SELECT
      mk.country_code,
      (SELECT SUM(o2.quantity) FROM orders_raw o2
       WHERE o2.account_id = $1 AND o2.marketplace_id = mk.id
       AND UPPER(o2.order_status) NOT IN ('CANCELLED','CANCELED')
       AND o2.purchase_date >= $2 AND o2.purchase_date < $3) AS raw_units,
      (SELECT SUM(op2.quantity) FROM order_profit op2
       JOIN orders_raw o3 ON o3.account_id = op2.account_id
         AND o3.amazon_order_id = op2.amazon_order_id AND o3.asin = op2.asin
       WHERE op2.account_id = $1 AND op2.marketplace_id = mk.id
       AND UPPER(o3.order_status) NOT IN ('CANCELLED','CANCELED')
       AND o3.purchase_date >= $2 AND o3.purchase_date < $3) AS profit_units,
      (SELECT SUM(adm.units_sold) FROM asin_daily_metrics adm
       WHERE adm.account_id = $1 AND adm.marketplace_id = mk.id
       AND adm.metric_date >= $2 AND adm.metric_date < $3) AS asin_metric_units,
      (SELECT SUM(ak.units_sold) FROM account_daily_kpi ak
       WHERE ak.account_id = $1 AND ak.marketplace_id = mk.id
       AND ak.kpi_date >= $2 AND ak.kpi_date < $3) AS kpi_units
    FROM marketplaces mk
    WHERE mk.id IN (1, 2, 3)
    ORDER BY mk.country_code
  `, [ACCOUNT_ID, dateFrom, dateTo]);

  console.log('  country | raw_units | profit | asin_metric | kpi');
  console.log('  --------|-----------|--------|-------------|----');
  for (const row of verification.rows) {
    console.log(`  ${row.country_code.padEnd(7)} | ${String(row.raw_units || 0).padStart(9)} | ${String(row.profit_units || 0).padStart(6)} | ${String(row.asin_metric_units || 0).padStart(11)} | ${row.kpi_units || 0}`);
  }

  console.log('\nDone.');
  await db.end();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
