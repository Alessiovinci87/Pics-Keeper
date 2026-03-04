#!/usr/bin/env node
/**
 * Quick DB-only comparison for a single day. No API calls.
 *
 * Usage:
 *   node scripts/compare-day.js 2026-03-01
 */
require('dotenv').config();

const db = require('../src/database/pool');
const dayjs = require('dayjs');

const ACCOUNT_ID = 1;

async function main() {
  const date = process.argv[2] || '2026-03-01';
  const dateNext = dayjs(date).add(1, 'day').format('YYYY-MM-DD');

  console.log(`\n=== Confronto giorno: ${date} (solo DB, nessuna chiamata API) ===\n`);

  const comparison = await db.query(`
    SELECT
      mk.country_code,
      COALESCE((
        SELECT SUM(brd.units_ordered)
        FROM business_report_daily brd
        WHERE brd.account_id = $1 AND brd.marketplace_id = mk.id
          AND brd.asin = '_TOTAL'
          AND brd.report_date = $2::date
      ), 0) AS br_units,
      COALESCE((
        SELECT SUM(o.quantity)
        FROM orders_raw o
        WHERE o.account_id = $1 AND o.marketplace_id = mk.id
          AND UPPER(o.order_status) NOT IN ('CANCELLED','CANCELED')
          AND o.purchase_date >= $2 AND o.purchase_date < $3
      ), 0) AS orders_api_units
    FROM marketplaces mk
    WHERE mk.id IN (
      SELECT DISTINCT marketplace_id FROM business_report_daily
      WHERE account_id = $1 AND asin = '_TOTAL' AND report_date = $2::date
      UNION
      SELECT DISTINCT marketplace_id FROM orders_raw
      WHERE account_id = $1 AND purchase_date >= $2 AND purchase_date < $3
    )
    ORDER BY mk.country_code
  `, [ACCOUNT_ID, date, dateNext]);

  let totalBr = 0;
  let totalOrders = 0;

  console.log('  country | BR_units | Orders_API | delta');
  console.log('  --------|----------|------------|------');

  for (const row of comparison.rows) {
    const br = parseInt(row.br_units, 10);
    const oa = parseInt(row.orders_api_units, 10);
    const delta = br - oa;
    const deltaStr = delta === 0 ? '  0' : (delta > 0 ? ` +${delta}` : ` ${delta}`);

    console.log(`  ${row.country_code.padEnd(7)} | ${String(br).padStart(8)} | ${String(oa).padStart(10)} | ${deltaStr}`);
    totalBr += br;
    totalOrders += oa;
  }

  const totalDelta = totalBr - totalOrders;
  console.log('  --------|----------|------------|------');
  console.log(`  TOTAL   | ${String(totalBr).padStart(8)} | ${String(totalOrders).padStart(10)} | ${totalDelta === 0 ? '  0' : (totalDelta > 0 ? ` +${totalDelta}` : ` ${totalDelta}`)}`);
  console.log();

  await db.shutdown();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
