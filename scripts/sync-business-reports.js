#!/usr/bin/env node
/**
 * Sync Business Reports and compare units with orders_raw.
 *
 * Usage:
 *   node scripts/sync-business-reports.js [dateFrom] [dateTo]
 *   node scripts/sync-business-reports.js 2026-02-01 2026-03-02
 *
 * dateTo is INCLUSIVE (like Shopkeeper).
 *
 * Steps:
 *   1. Run migration if business_report_daily table doesn't exist
 *   2. Sync GET_SALES_AND_TRAFFIC_REPORT for all marketplaces
 *   3. Compare Business Report units vs orders_raw units
 */
require('dotenv').config();

const db = require('../src/database/pool');
const AccountService = require('../src/modules/accounts/account.service');
const BusinessReportsService = require('../src/modules/business-reports/business-reports.service');

const ACCOUNT_ID = 1;

async function main() {
  const dateFrom = process.argv[2] || '2026-02-01';
  const dateTo = process.argv[3] || '2026-03-02';

  console.log(`\n=== Business Reports Sync & Compare ===`);
  console.log(`  Range: ${dateFrom} → ${dateTo} (inclusive)\n`);

  // Step 0: Ensure table exists
  await ensureTable();

  // Step 1: Sync for all marketplaces
  console.log(`--- Step 1: Syncing Business Reports ---\n`);

  const targets = await AccountService.getActiveSyncTargets();
  const accountTargets = targets.filter((t) => t.account_id === ACCOUNT_ID);

  for (const target of accountTargets) {
    try {
      console.log(`  ${target.country_code}: syncing...`);
      const result = await BusinessReportsService.sync(target, { dateFrom, dateTo });
      console.log(`  ${target.country_code}: ✓ ${result.upserted} rows upserted`);
    } catch (err) {
      console.error(`  ${target.country_code}: ✗ ${err.message}`);
    }
  }

  // Step 2: Compare
  console.log(`\n--- Step 2: Comparison ---\n`);

  const comparison = await db.query(`
    SELECT
      mk.country_code,
      -- Business Reports (same source as Shopkeeper)
      COALESCE((
        SELECT SUM(brd.units_ordered)
        FROM business_report_daily brd
        WHERE brd.account_id = $1 AND brd.marketplace_id = mk.id
          AND brd.asin = '_TOTAL'
          AND brd.report_date >= $2::date AND brd.report_date <= $3::date
      ), 0) AS br_units,
      -- Orders API (timezone-aware to match Business Reports local dates)
      COALESCE((
        SELECT SUM(o.quantity)
        FROM orders_raw o
        WHERE o.account_id = $1 AND o.marketplace_id = mk.id
          AND UPPER(o.order_status) NOT IN ('CANCELLED','CANCELED')
          AND (o.purchase_date AT TIME ZONE
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
            END)::date >= $2::date
          AND (o.purchase_date AT TIME ZONE
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
            END)::date <= $3::date
      ), 0) AS orders_api_units
    FROM marketplaces mk
    WHERE mk.id IN (
      SELECT DISTINCT marketplace_id FROM business_report_daily
      WHERE account_id = $1 AND report_date >= $2::date AND report_date <= $3::date
      UNION
      SELECT DISTINCT marketplace_id FROM orders_raw
      WHERE account_id = $1
        AND (purchase_date AT TIME ZONE 'UTC')::date >= ($2::date - 1)
        AND (purchase_date AT TIME ZONE 'UTC')::date <= ($3::date + 1)
    )
    ORDER BY mk.country_code
  `, [ACCOUNT_ID, dateFrom, dateTo]);

  let totalBr = 0;
  let totalOrders = 0;

  console.log('  country | BR_units (=Shopkeeper) | Orders_API | delta | dashboard_units');
  console.log('  --------|------------------------|------------|-------|----------------');

  for (const row of comparison.rows) {
    const br = parseInt(row.br_units, 10);
    const oa = parseInt(row.orders_api_units, 10);
    const delta = br - oa;
    const deltaStr = delta === 0 ? '  0' : (delta > 0 ? ` +${delta}` : ` ${delta}`);
    // Dashboard uses BR when available, falls back to Orders API
    const dashboard = br > 0 ? br : oa;

    console.log(`  ${row.country_code.padEnd(7)} | ${String(br).padStart(22)} | ${String(oa).padStart(10)} | ${deltaStr.padStart(5)} | ${String(dashboard).padStart(14)}`);
    totalBr += br;
    totalOrders += oa;
  }

  const totalDelta = totalBr - totalOrders;
  const totalDashboard = totalBr > 0 ? totalBr : totalOrders;
  console.log('  --------|------------------------|------------|-------|----------------');
  console.log(`  TOTAL   | ${String(totalBr).padStart(22)} | ${String(totalOrders).padStart(10)} | ${String(totalDelta > 0 ? `+${totalDelta}` : totalDelta).padStart(5)} | ${String(totalDashboard).padStart(14)}`);

  console.log(`\n  BR_units       = Business Reports (stessa fonte di Shopkeeper)`);
  console.log(`  Orders_API     = SUM(quantity) da orders_raw (excl. cancelled)`);
  console.log(`  dashboard_units = valore usato nel sistema (BR quando disponibile)`);
  console.log(`  Il delta residuo è dovuto a ordini PENDING invalidati internamente da Amazon\n`);

  console.log('Done.');
  await db.shutdown();
}

/**
 * Create business_report_daily table if it doesn't exist.
 */
async function ensureTable() {
  const check = await db.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_name = 'business_report_daily'
    ) AS exists
  `);

  if (!check.rows[0].exists) {
    console.log('  Creating business_report_daily table...');
    await db.query(`
      CREATE TABLE business_report_daily (
        id              SERIAL PRIMARY KEY,
        account_id      INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        marketplace_id  INTEGER NOT NULL REFERENCES marketplaces(id),
        report_date     DATE NOT NULL,
        asin            VARCHAR(20) NOT NULL,
        sku             VARCHAR(50),
        units_ordered   INTEGER NOT NULL DEFAULT 0,
        ordered_product_sales   NUMERIC(14,2) NOT NULL DEFAULT 0,
        ordered_product_sales_b2b NUMERIC(14,2) NOT NULL DEFAULT 0,
        total_order_items       INTEGER NOT NULL DEFAULT 0,
        browser_sessions        INTEGER NOT NULL DEFAULT 0,
        mobile_app_sessions     INTEGER NOT NULL DEFAULT 0,
        sessions                INTEGER NOT NULL DEFAULT 0,
        browser_page_views      INTEGER NOT NULL DEFAULT 0,
        mobile_app_page_views   INTEGER NOT NULL DEFAULT 0,
        page_views              INTEGER NOT NULL DEFAULT 0,
        buy_box_percentage      NUMERIC(7,4) NOT NULL DEFAULT 0,
        unit_session_percentage NUMERIC(7,4) NOT NULL DEFAULT 0,
        currency        VARCHAR(5) NOT NULL DEFAULT 'EUR',
        synced_at       TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (account_id, marketplace_id, report_date, asin)
      );
      CREATE INDEX idx_brd_lookup ON business_report_daily(account_id, marketplace_id, report_date);
      CREATE INDEX idx_brd_asin ON business_report_daily(account_id, asin, report_date);
    `);
    console.log('  ✓ Table created\n');
  } else {
    console.log('  Table business_report_daily already exists\n');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
