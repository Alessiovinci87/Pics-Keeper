#!/usr/bin/env node
/**
 * Diagnose the delta between Business Reports units and Orders API units.
 *
 * Usage:
 *   node scripts/diagnose-delta.js [dateFrom] [dateTo]
 *   node scripts/diagnose-delta.js 2026-02-22 2026-02-28
 *
 * Runs DB-only queries (no API calls) to identify what causes the mismatch.
 */
require('dotenv').config();

const db = require('../src/database/pool');

const ACCOUNT_ID = 1;

const TZ_MAP = `
  CASE mk.country_code
    WHEN 'IT' THEN 'Europe/Rome'
    WHEN 'DE' THEN 'Europe/Berlin'
    WHEN 'FR' THEN 'Europe/Paris'
    WHEN 'ES' THEN 'Europe/Madrid'
    WHEN 'GB' THEN 'Europe/London'
    WHEN 'NL' THEN 'Europe/Amsterdam'
    WHEN 'SE' THEN 'Europe/Stockholm'
    WHEN 'PL' THEN 'Europe/Warsaw'
    WHEN 'TR' THEN 'Europe/Istanbul'
    WHEN 'BE' THEN 'Europe/Brussels'
    WHEN 'US' THEN 'America/Los_Angeles'
    WHEN 'CA' THEN 'America/Toronto'
    ELSE 'UTC'
  END
`;

async function main() {
  const dateFrom = process.argv[2] || '2026-02-22';
  const dateTo = process.argv[3] || '2026-02-28';

  console.log(`\n=== Delta Diagnosis: ${dateFrom} → ${dateTo} ===\n`);

  // 1. Order status breakdown per country
  console.log('--- 1. Order status breakdown (orders_raw) ---\n');
  const statusBreakdown = await db.query(`
    SELECT
      mk.country_code,
      UPPER(o.order_status) AS status,
      COUNT(*) AS order_lines,
      SUM(o.quantity) AS total_qty
    FROM orders_raw o
    JOIN marketplaces mk ON mk.id = o.marketplace_id
    WHERE o.account_id = $1
      AND (o.purchase_date AT TIME ZONE ${TZ_MAP})::date >= $2::date
      AND (o.purchase_date AT TIME ZONE ${TZ_MAP})::date <= $3::date
    GROUP BY mk.country_code, UPPER(o.order_status)
    ORDER BY mk.country_code, total_qty DESC
  `, [ACCOUNT_ID, dateFrom, dateTo]);

  console.log('  country | status      | lines | qty');
  console.log('  --------|-------------|-------|----');
  for (const row of statusBreakdown.rows) {
    console.log(`  ${row.country_code.padEnd(7)} | ${row.status.padEnd(11)} | ${String(row.order_lines).padStart(5)} | ${String(row.total_qty).padStart(4)}`);
  }

  // 2. Compare excluding PENDING vs only excluding CANCELLED
  console.log('\n--- 2. Impact of different status filters ---\n');
  const filterComparison = await db.query(`
    SELECT
      mk.country_code,
      COALESCE((
        SELECT SUM(brd.units_ordered)
        FROM business_report_daily brd
        WHERE brd.account_id = $1 AND brd.marketplace_id = mk.id
          AND brd.asin = '_TOTAL'
          AND brd.report_date >= $2::date AND brd.report_date <= $3::date
      ), 0) AS br_units,
      -- All non-cancelled (current logic)
      COALESCE((
        SELECT SUM(o.quantity)
        FROM orders_raw o
        WHERE o.account_id = $1 AND o.marketplace_id = mk.id
          AND UPPER(o.order_status) NOT IN ('CANCELLED','CANCELED')
          AND (o.purchase_date AT TIME ZONE ${TZ_MAP})::date >= $2::date
          AND (o.purchase_date AT TIME ZONE ${TZ_MAP})::date <= $3::date
      ), 0) AS excl_cancelled,
      -- Exclude PENDING too
      COALESCE((
        SELECT SUM(o.quantity)
        FROM orders_raw o
        WHERE o.account_id = $1 AND o.marketplace_id = mk.id
          AND UPPER(o.order_status) NOT IN ('CANCELLED','CANCELED','PENDING')
          AND (o.purchase_date AT TIME ZONE ${TZ_MAP})::date >= $2::date
          AND (o.purchase_date AT TIME ZONE ${TZ_MAP})::date <= $3::date
      ), 0) AS excl_pending,
      -- Only SHIPPED
      COALESCE((
        SELECT SUM(o.quantity)
        FROM orders_raw o
        WHERE o.account_id = $1 AND o.marketplace_id = mk.id
          AND UPPER(o.order_status) = 'SHIPPED'
          AND (o.purchase_date AT TIME ZONE ${TZ_MAP})::date >= $2::date
          AND (o.purchase_date AT TIME ZONE ${TZ_MAP})::date <= $3::date
      ), 0) AS only_shipped
    FROM marketplaces mk
    WHERE mk.id IN (
      SELECT DISTINCT marketplace_id FROM business_report_daily
      WHERE account_id = $1 AND report_date >= $2::date AND report_date <= $3::date
    )
    ORDER BY mk.country_code
  `, [ACCOUNT_ID, dateFrom, dateTo]);

  console.log('  country | BR_units | excl_cancel | excl_pending | only_shipped');
  console.log('  --------|----------|-------------|--------------|-------------');
  let totBr = 0, totCancel = 0, totPending = 0, totShipped = 0;
  for (const row of filterComparison.rows) {
    const br = parseInt(row.br_units, 10);
    const ec = parseInt(row.excl_cancelled, 10);
    const ep = parseInt(row.excl_pending, 10);
    const os = parseInt(row.only_shipped, 10);
    console.log(`  ${row.country_code.padEnd(7)} | ${String(br).padStart(8)} | ${String(ec).padStart(11)} | ${String(ep).padStart(12)} | ${String(os).padStart(12)}`);
    totBr += br; totCancel += ec; totPending += ep; totShipped += os;
  }
  console.log('  --------|----------|-------------|--------------|-------------');
  console.log(`  TOTAL   | ${String(totBr).padStart(8)} | ${String(totCancel).padStart(11)} | ${String(totPending).padStart(12)} | ${String(totShipped).padStart(12)}`);
  console.log(`\n  Deltas vs BR:  excl_cancel=${totCancel - totBr}  excl_pending=${totPending - totBr}  only_shipped=${totShipped - totBr}`);

  // 3. Per-ASIN comparison for countries with delta (DE, FR, IT)
  console.log('\n--- 3. Per-ASIN delta for countries with mismatch ---\n');
  const deltaCountries = ['DE', 'FR', 'IT'];

  for (const cc of deltaCountries) {
    const asinDelta = await db.query(`
      SELECT
        COALESCE(br.asin, oa.asin) AS asin,
        COALESCE(br.br_qty, 0) AS br_qty,
        COALESCE(oa.oa_qty, 0) AS oa_qty,
        COALESCE(oa.oa_qty, 0) - COALESCE(br.br_qty, 0) AS delta
      FROM (
        SELECT brd.asin, SUM(brd.units_ordered) AS br_qty
        FROM business_report_daily brd
        JOIN marketplaces mk ON mk.id = brd.marketplace_id AND mk.country_code = $4
        WHERE brd.account_id = $1
          AND brd.asin != '_TOTAL'
          AND brd.report_date >= $2::date AND brd.report_date <= $3::date
        GROUP BY brd.asin
      ) br
      FULL OUTER JOIN (
        SELECT o.asin, SUM(o.quantity) AS oa_qty
        FROM orders_raw o
        JOIN marketplaces mk ON mk.id = o.marketplace_id AND mk.country_code = $4
        WHERE o.account_id = $1
          AND UPPER(o.order_status) NOT IN ('CANCELLED','CANCELED')
          AND (o.purchase_date AT TIME ZONE ${TZ_MAP})::date >= $2::date
          AND (o.purchase_date AT TIME ZONE ${TZ_MAP})::date <= $3::date
        GROUP BY o.asin
      ) oa ON br.asin = oa.asin
      WHERE COALESCE(oa.oa_qty, 0) - COALESCE(br.br_qty, 0) != 0
      ORDER BY ABS(COALESCE(oa.oa_qty, 0) - COALESCE(br.br_qty, 0)) DESC
    `, [ACCOUNT_ID, dateFrom, dateTo, cc]);

    if (asinDelta.rows.length > 0) {
      console.log(`  ${cc}: ASINs with delta:`);
      console.log('    asin           | BR_qty | OA_qty | delta');
      console.log('    ---------------|--------|--------|------');
      for (const row of asinDelta.rows) {
        console.log(`    ${row.asin.padEnd(14)} | ${String(row.br_qty).padStart(6)} | ${String(row.oa_qty).padStart(6)} | ${row.delta > 0 ? '+' : ''}${row.delta}`);
      }
    } else {
      console.log(`  ${cc}: No per-ASIN delta found (mismatch may be in _TOTAL aggregation)`);
    }
    console.log('');
  }

  // 4. Check for orders with quantity > 1 (potential partial cancellations)
  console.log('--- 4. Multi-quantity orders in delta countries ---\n');
  const multiQty = await db.query(`
    SELECT
      mk.country_code,
      o.amazon_order_id,
      o.asin,
      o.quantity,
      o.order_status,
      o.purchase_date
    FROM orders_raw o
    JOIN marketplaces mk ON mk.id = o.marketplace_id
    WHERE o.account_id = $1
      AND mk.country_code IN ('DE','FR','IT')
      AND o.quantity > 1
      AND UPPER(o.order_status) NOT IN ('CANCELLED','CANCELED')
      AND (o.purchase_date AT TIME ZONE ${TZ_MAP})::date >= $2::date
      AND (o.purchase_date AT TIME ZONE ${TZ_MAP})::date <= $3::date
    ORDER BY mk.country_code, o.quantity DESC
    LIMIT 30
  `, [ACCOUNT_ID, dateFrom, dateTo]);

  if (multiQty.rows.length > 0) {
    console.log('  country | order_id            | asin           | qty | status');
    console.log('  --------|---------------------|----------------|-----|--------');
    for (const row of multiQty.rows) {
      console.log(`  ${row.country_code.padEnd(7)} | ${row.amazon_order_id.padEnd(19)} | ${row.asin.padEnd(14)} | ${String(row.quantity).padStart(3)} | ${row.order_status}`);
    }
  } else {
    console.log('  No multi-quantity orders found.');
  }

  // 5. Check for duplicate ASIN entries (same order_id, same asin, different rows)
  console.log('\n--- 5. Potential duplicate order lines ---\n');
  const dupes = await db.query(`
    SELECT
      mk.country_code,
      o.amazon_order_id,
      o.asin,
      COUNT(*) AS row_count,
      SUM(o.quantity) AS total_qty
    FROM orders_raw o
    JOIN marketplaces mk ON mk.id = o.marketplace_id
    WHERE o.account_id = $1
      AND mk.country_code IN ('DE','FR','IT')
      AND (o.purchase_date AT TIME ZONE ${TZ_MAP})::date >= $2::date
      AND (o.purchase_date AT TIME ZONE ${TZ_MAP})::date <= $3::date
    GROUP BY mk.country_code, o.amazon_order_id, o.asin
    HAVING COUNT(*) > 1
    ORDER BY COUNT(*) DESC
    LIMIT 20
  `, [ACCOUNT_ID, dateFrom, dateTo]);

  if (dupes.rows.length > 0) {
    console.log('  Duplicates found:');
    for (const row of dupes.rows) {
      console.log(`  ${row.country_code} | ${row.amazon_order_id} | ${row.asin} | ${row.row_count} rows | qty=${row.total_qty}`);
    }
  } else {
    console.log('  No duplicates found (UNIQUE constraint is working).');
  }

  // 6. Boundary orders (around midnight local time on range edges)
  console.log('\n--- 6. Boundary orders (near midnight on date edges) ---\n');
  const boundary = await db.query(`
    SELECT
      mk.country_code,
      o.amazon_order_id,
      o.asin,
      o.quantity,
      o.order_status,
      o.purchase_date AT TIME ZONE 'UTC' AS purchase_utc,
      o.purchase_date AT TIME ZONE ${TZ_MAP} AS purchase_local,
      (o.purchase_date AT TIME ZONE ${TZ_MAP})::date AS local_date
    FROM orders_raw o
    JOIN marketplaces mk ON mk.id = o.marketplace_id
    WHERE o.account_id = $1
      AND mk.country_code IN ('DE','FR','IT')
      AND UPPER(o.order_status) NOT IN ('CANCELLED','CANCELED')
      AND (
        -- Near start boundary
        (o.purchase_date AT TIME ZONE ${TZ_MAP})::date = $2::date
        AND EXTRACT(HOUR FROM o.purchase_date AT TIME ZONE ${TZ_MAP}) < 2
        OR
        -- Near end boundary
        (o.purchase_date AT TIME ZONE ${TZ_MAP})::date = $3::date
        AND EXTRACT(HOUR FROM o.purchase_date AT TIME ZONE ${TZ_MAP}) >= 22
        OR
        -- Orders that fall OUTSIDE range in local time but INSIDE in UTC
        (o.purchase_date AT TIME ZONE ${TZ_MAP})::date = ($3::date + 1)
        AND EXTRACT(HOUR FROM o.purchase_date AT TIME ZONE ${TZ_MAP}) < 2
      )
    ORDER BY mk.country_code, o.purchase_date
    LIMIT 30
  `, [ACCOUNT_ID, dateFrom, dateTo]);

  if (boundary.rows.length > 0) {
    console.log('  country | order_id            | qty | status  | UTC                  | local                | local_date');
    console.log('  --------|---------------------|-----|---------|----------------------|----------------------|-----------');
    for (const row of boundary.rows) {
      console.log(`  ${row.country_code.padEnd(7)} | ${row.amazon_order_id.padEnd(19)} | ${String(row.quantity).padStart(3)} | ${row.order_status.padEnd(7)} | ${String(row.purchase_utc).substring(0, 19)} | ${String(row.purchase_local).substring(0, 19)} | ${row.local_date}`);
    }
  } else {
    console.log('  No boundary orders found.');
  }

  console.log('\nDiagnosis complete.');
  await db.shutdown();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
