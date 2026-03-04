#!/usr/bin/env node
/**
 * Diagnose the Shopkeeper gap by comparing UTC vs timezone-aware counting.
 *
 * Usage:
 *   node scripts/diagnose-tz-gap.js [dateFrom] [dateTo]
 *   node scripts/diagnose-tz-gap.js 2026-02-01 2026-03-02
 *
 * dateTo is INCLUSIVE (like Shopkeeper).
 */
require('dotenv').config();

const db = require('../src/database/pool');
const dayjs = require('dayjs');

const ACCOUNT_ID = 1;

const MARKETPLACE_TIMEZONES = {
  DE: 'Europe/Berlin',
  FR: 'Europe/Paris',
  IT: 'Europe/Rome',
  ES: 'Europe/Madrid',
  GB: 'Europe/London',
  NL: 'Europe/Amsterdam',
  SE: 'Europe/Stockholm',
  PL: 'Europe/Warsaw',
  TR: 'Europe/Istanbul',
  BE: 'Europe/Brussels',
  US: 'America/Los_Angeles',
  CA: 'America/Toronto',
};

async function main() {
  const dateFrom = process.argv[2] || '2026-02-01';
  const dateToInclusive = process.argv[3] || '2026-03-02';
  const dateToExclusive = dayjs(dateToInclusive).add(1, 'day').format('YYYY-MM-DD');

  console.log(`\n=== Timezone Gap Diagnosis ===`);
  console.log(`  Range: ${dateFrom} → ${dateToInclusive} (inclusive)`);
  console.log(`  Pipeline: >= ${dateFrom} AND < ${dateToExclusive}\n`);

  // Get all marketplaces
  const mps = await db.query(`
    SELECT DISTINCT mk.id, mk.country_code
    FROM marketplaces mk
    JOIN orders_raw o ON o.marketplace_id = mk.id AND o.account_id = $1
    ORDER BY mk.id
  `, [ACCOUNT_ID]);

  console.log('  country | UTC_units | TZ_units | delta | timezone');
  console.log('  --------|-----------|----------|-------|------------------');

  for (const mp of mps.rows) {
    const tz = MARKETPLACE_TIMEZONES[mp.country_code] || 'UTC';

    // Count using raw UTC timestamps (what the verification query does)
    const utcResult = await db.query(`
      SELECT COALESCE(SUM(quantity), 0) AS units
      FROM orders_raw
      WHERE account_id = $1 AND marketplace_id = $2
        AND UPPER(order_status) NOT IN ('CANCELLED','CANCELED','PENDING')
        AND purchase_date >= $3 AND purchase_date < $4
    `, [ACCOUNT_ID, mp.id, dateFrom, dateToExclusive]);

    // Count using timezone-aware dates (what the profit engine does)
    const tzResult = await db.query(`
      SELECT COALESCE(SUM(quantity), 0) AS units
      FROM orders_raw
      WHERE account_id = $1 AND marketplace_id = $2
        AND UPPER(order_status) NOT IN ('CANCELLED','CANCELED','PENDING')
        AND (purchase_date AT TIME ZONE $5)::date >= $3::date
        AND (purchase_date AT TIME ZONE $5)::date < $4::date
    `, [ACCOUNT_ID, mp.id, dateFrom, dateToExclusive, tz]);

    const utcUnits = parseInt(utcResult.rows[0].units, 10);
    const tzUnits = parseInt(tzResult.rows[0].units, 10);
    const delta = tzUnits - utcUnits;
    const deltaStr = delta === 0 ? '  0' : (delta > 0 ? ` +${delta}` : ` ${delta}`);

    console.log(`  ${mp.country_code.padEnd(7)} | ${String(utcUnits).padStart(9)} | ${String(tzUnits).padStart(8)} | ${deltaStr.padStart(5)} | ${tz}`);
  }

  // Show the boundary orders that shift between UTC and local timezone
  console.log(`\n=== Boundary orders (date changes between UTC and local TZ) ===\n`);

  for (const mp of mps.rows) {
    const tz = MARKETPLACE_TIMEZONES[mp.country_code] || 'UTC';
    if (tz === 'UTC') continue;

    const boundary = await db.query(`
      SELECT
        amazon_order_id, asin, quantity, order_status,
        purchase_date,
        purchase_date::date AS utc_date,
        (purchase_date AT TIME ZONE $5)::date AS local_date
      FROM orders_raw
      WHERE account_id = $1 AND marketplace_id = $2
        AND UPPER(order_status) NOT IN ('CANCELLED','CANCELED','PENDING')
        AND purchase_date::date != (purchase_date AT TIME ZONE $5)::date
        AND (
          -- Orders near the start boundary
          (purchase_date >= ($3::date - INTERVAL '1 day') AND purchase_date < ($3::date + INTERVAL '1 day'))
          OR
          -- Orders near the end boundary
          (purchase_date >= ($4::date - INTERVAL '1 day') AND purchase_date < ($4::date + INTERVAL '1 day'))
        )
      ORDER BY purchase_date
    `, [ACCOUNT_ID, mp.id, dateFrom, dateToExclusive, tz]);

    if (boundary.rows.length > 0) {
      console.log(`  ${mp.country_code} (${tz}): ${boundary.rows.length} boundary orders`);
      for (const row of boundary.rows) {
        const inUtc = row.utc_date >= dateFrom && row.utc_date < dateToExclusive;
        const inTz = row.local_date >= dateFrom && row.local_date < dateToExclusive;
        const status = inUtc && !inTz ? 'UTC-only (excluded by TZ)' :
                       !inUtc && inTz ? 'TZ-only (included by TZ)' : 'both';
        console.log(`    ${row.amazon_order_id} | ${row.asin} | qty=${row.quantity} | UTC=${row.utc_date} | local=${row.local_date} | ${status}`);
      }
      console.log();
    }
  }

  console.log('Done.');
  await db.shutdown();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
