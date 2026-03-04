#!/usr/bin/env node
/**
 * Quick DB-only comparison for a date range (e.g. a full week). No API calls.
 *
 * Usage:
 *   node scripts/compare-week.js 2026-02-22 2026-02-28
 */
require('dotenv').config();

const db = require('../src/database/pool');
const dayjs = require('dayjs');

const ACCOUNT_ID = 1;

async function main() {
  const startDate = process.argv[2] || '2026-02-22';
  const endDate = process.argv[3] || '2026-02-28';
  // endDate is inclusive, so we go to the day after for < comparisons
  const endExclusive = dayjs(endDate).add(1, 'day').format('YYYY-MM-DD');

  console.log(`\n=== Confronto settimana: ${startDate} → ${endDate} (solo DB, nessuna chiamata API) ===\n`);

  // --- Step 1: per-day totals ---
  console.log('--- Step 1: Totali giornalieri ---\n');

  const dailyRows = await db.query(`
    SELECT
      d.day::date AS report_date,
      COALESCE(SUM(brd.units_ordered), 0) AS br_units,
      COALESCE((
        SELECT SUM(o.quantity)
        FROM orders_raw o
        WHERE o.account_id = $1
          AND UPPER(o.order_status) NOT IN ('CANCELLED','CANCELED')
          AND o.purchase_date >= d.day AND o.purchase_date < d.day + interval '1 day'
      ), 0) AS orders_api_units
    FROM generate_series($2::date, $3::date, '1 day'::interval) AS d(day)
    LEFT JOIN business_report_daily brd
      ON brd.account_id = $1
      AND brd.asin = '_TOTAL'
      AND brd.report_date = d.day::date
    GROUP BY d.day
    ORDER BY d.day
  `, [ACCOUNT_ID, startDate, endDate]);

  let weekBr = 0;
  let weekOrders = 0;

  console.log('  date       | BR_units | Orders_API | delta');
  console.log('  -----------|----------|------------|------');

  for (const row of dailyRows.rows) {
    const dt = dayjs(row.report_date).format('YYYY-MM-DD');
    const br = parseInt(row.br_units, 10);
    const oa = parseInt(row.orders_api_units, 10);
    const delta = br - oa;
    const deltaStr = delta === 0 ? '  0' : (delta > 0 ? ` +${delta}` : ` ${delta}`);

    console.log(`  ${dt} | ${String(br).padStart(8)} | ${String(oa).padStart(10)} | ${deltaStr}`);
    weekBr += br;
    weekOrders += oa;
  }

  const weekDelta = weekBr - weekOrders;
  console.log('  -----------|----------|------------|------');
  console.log(`  TOTALE     | ${String(weekBr).padStart(8)} | ${String(weekOrders).padStart(10)} | ${weekDelta === 0 ? '  0' : (weekDelta > 0 ? ` +${weekDelta}` : ` ${weekDelta}`)}`);
  console.log();

  // --- Step 2: per-country totals for the whole range ---
  console.log('--- Step 2: Totali per country (intera settimana) ---\n');

  const countryRows = await db.query(`
    SELECT
      mk.country_code,
      COALESCE((
        SELECT SUM(brd.units_ordered)
        FROM business_report_daily brd
        WHERE brd.account_id = $1 AND brd.marketplace_id = mk.id
          AND brd.asin = '_TOTAL'
          AND brd.report_date >= $2::date AND brd.report_date <= $3::date
      ), 0) AS br_units,
      COALESCE((
        SELECT SUM(o.quantity)
        FROM orders_raw o
        WHERE o.account_id = $1 AND o.marketplace_id = mk.id
          AND UPPER(o.order_status) NOT IN ('CANCELLED','CANCELED')
          AND o.purchase_date >= $2 AND o.purchase_date < $4
      ), 0) AS orders_api_units
    FROM marketplaces mk
    WHERE mk.id IN (
      SELECT DISTINCT marketplace_id FROM business_report_daily
      WHERE account_id = $1 AND asin = '_TOTAL'
        AND report_date >= $2::date AND report_date <= $3::date
      UNION
      SELECT DISTINCT marketplace_id FROM orders_raw
      WHERE account_id = $1 AND purchase_date >= $2 AND purchase_date < $4
    )
    ORDER BY mk.country_code
  `, [ACCOUNT_ID, startDate, endDate, endExclusive]);

  let totalBr = 0;
  let totalOrders = 0;

  console.log('  country | BR_units | Orders_API | delta');
  console.log('  --------|----------|------------|------');

  for (const row of countryRows.rows) {
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
