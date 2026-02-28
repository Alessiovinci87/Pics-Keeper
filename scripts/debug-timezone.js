#!/usr/bin/env node
/**
 * Debug timezone handling — all counting done in PostgreSQL (no JS Date issues).
 * Compares 3 counting methods for ES orders:
 *   1. Raw UTC date
 *   2. Current AT TIME ZONE (single conversion)
 *   3. Correct AT TIME ZONE 'UTC' AT TIME ZONE tz (double conversion)
 *
 * Usage:
 *   node scripts/debug-timezone.js B0BY9Q4KTT 2026-02-27
 */
require('dotenv').config();
const db = require('../src/database/pool');

const asin = process.argv[2];
const targetDate = process.argv[3] || new Date(Date.now() - 86400000).toISOString().slice(0, 10);

if (!asin) {
  console.error('Usage: node scripts/debug-timezone.js <ASIN> [YYYY-MM-DD]');
  process.exit(1);
}

(async () => {
  try {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`  DEBUG TIMEZONE — ASIN: ${asin} — Data: ${targetDate}`);
    console.log(`${'='.repeat(80)}`);

    // 1. Check column type and server timezone
    const tzInfo = await db.query(`
      SELECT
        current_setting('TIMEZONE') AS server_tz,
        pg_typeof(purchase_date)::text AS col_type
      FROM orders_raw LIMIT 1
    `);
    console.log(`\n  Server timezone: ${tzInfo.rows[0]?.server_tz}`);
    console.log(`  Column type: ${tzInfo.rows[0]?.col_type}`);

    // 2. Show a sample ES order with all timezone conversions (all in SQL, returned as text)
    const sample = await db.query(`
      SELECT
        o.amazon_order_id,
        o.purchase_date::text AS raw_value,
        (o.purchase_date AT TIME ZONE 'UTC')::text AS at_tz_utc,
        (o.purchase_date AT TIME ZONE 'Europe/Madrid')::text AS single_conv,
        (o.purchase_date AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Madrid')::text AS double_conv,
        o.purchase_date::date::text AS raw_date,
        (o.purchase_date AT TIME ZONE 'Europe/Madrid')::date::text AS single_date,
        (o.purchase_date AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Madrid')::date::text AS double_date
      FROM orders_raw o
      JOIN marketplaces m ON m.id = o.marketplace_id
      WHERE o.account_id = 1 AND o.asin = $1 AND m.country_code = 'ES'
      ORDER BY o.purchase_date
      LIMIT 5
    `, [asin]);

    console.log(`\n  SAMPLE ES ORDERS (valori come text in PostgreSQL):`);
    console.log(`  ${'—'.repeat(75)}`);
    for (const r of sample.rows) {
      console.log(`  Order: ${r.amazon_order_id}`);
      console.log(`    raw_value:    ${r.raw_value}`);
      console.log(`    AT TZ UTC:    ${r.at_tz_utc}`);
      console.log(`    single conv:  ${r.single_conv}  → date: ${r.single_date}`);
      console.log(`    double conv:  ${r.double_conv}  → date: ${r.double_date}`);
      console.log(`    raw ::date:   ${r.raw_date}`);
      console.log('');
    }

    // 3. Count ES orders for target date with ALL methods (entirely in SQL)
    const counts = await db.query(`
      SELECT
        'UTC_raw' AS method,
        COUNT(DISTINCT o.amazon_order_id) AS orders,
        SUM(o.quantity) AS units
      FROM orders_raw o
      JOIN marketplaces m ON m.id = o.marketplace_id
      WHERE o.account_id = 1 AND o.asin = $1 AND m.country_code = 'ES'
        AND o.purchase_date::date = $2::date

      UNION ALL

      SELECT
        'single_AT_TZ' AS method,
        COUNT(DISTINCT o.amazon_order_id),
        SUM(o.quantity)
      FROM orders_raw o
      JOIN marketplaces m ON m.id = o.marketplace_id
      WHERE o.account_id = 1 AND o.asin = $1 AND m.country_code = 'ES'
        AND (o.purchase_date AT TIME ZONE 'Europe/Madrid')::date = $2::date

      UNION ALL

      SELECT
        'double_AT_TZ' AS method,
        COUNT(DISTINCT o.amazon_order_id),
        SUM(o.quantity)
      FROM orders_raw o
      JOIN marketplaces m ON m.id = o.marketplace_id
      WHERE o.account_id = 1 AND o.asin = $1 AND m.country_code = 'ES'
        AND (o.purchase_date AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Madrid')::date = $2::date

      UNION ALL

      SELECT
        'shipped_only_double' AS method,
        COUNT(DISTINCT o.amazon_order_id),
        SUM(o.quantity)
      FROM orders_raw o
      JOIN marketplaces m ON m.id = o.marketplace_id
      WHERE o.account_id = 1 AND o.asin = $1 AND m.country_code = 'ES'
        AND (o.purchase_date AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Madrid')::date = $2::date
        AND UPPER(o.order_status) NOT IN ('CANCELLED', 'CANCELED', 'PENDING')
    `, [asin, targetDate]);

    console.log(`  CONTEGGIO ES ${targetDate} — tutti i metodi (SQL puro):`);
    console.log(`  ${'—'.repeat(50)}`);
    for (const r of counts.rows) {
      console.log(`  ${r.method.padEnd(25)} | ${String(r.orders).padStart(3)} ordini | ${String(r.units).padStart(3)} unità`);
    }
    console.log(`  ${'—'.repeat(50)}`);
    console.log(`  ShopKeeper              |   9 (riferimento)`);

    // 4. Same for ALL countries (double conv, all statuses, vs ShopKeeper)
    const allCountries = await db.query(`
      SELECT
        m.country_code,
        COUNT(DISTINCT o.amazon_order_id) AS orders,
        SUM(o.quantity) AS units
      FROM orders_raw o
      JOIN marketplaces m ON m.id = o.marketplace_id
      WHERE o.account_id = 1 AND o.asin = $1
        AND (o.purchase_date AT TIME ZONE 'UTC' AT TIME ZONE COALESCE(
          CASE m.country_code
            WHEN 'IT' THEN 'Europe/Rome'
            WHEN 'DE' THEN 'Europe/Berlin'
            WHEN 'FR' THEN 'Europe/Paris'
            WHEN 'ES' THEN 'Europe/Madrid'
            WHEN 'GB' THEN 'Europe/London'
            WHEN 'NL' THEN 'Europe/Amsterdam'
            WHEN 'SE' THEN 'Europe/Stockholm'
            WHEN 'PL' THEN 'Europe/Warsaw'
            WHEN 'BE' THEN 'Europe/Brussels'
            WHEN 'US' THEN 'America/Los_Angeles'
            WHEN 'CA' THEN 'America/Toronto'
            ELSE 'UTC'
          END, 'UTC'))::date = $2::date
      GROUP BY m.country_code
      ORDER BY m.country_code
    `, [asin, targetDate]);

    console.log(`\n  TUTTI I PAESI con double AT TIME ZONE (corretto):`);
    console.log(`  ${'—'.repeat(50)}`);
    console.log(`  Paese | Ordini | Unità | ShopKeeper`);
    const shopkeeper = { IT: 17, ES: 9, FR: 3, NL: 4 };
    for (const r of allCountries.rows) {
      const sk = shopkeeper[r.country_code] ?? '?';
      const match = parseInt(r.units) === sk ? 'MATCH' : `DIFF (${parseInt(r.units) - sk > 0 ? '+' : ''}${parseInt(r.units) - sk})`;
      console.log(`  ${r.country_code.padEnd(5)} | ${String(r.orders).padStart(6)} | ${String(r.units).padStart(5)} | ${String(sk).padStart(5)}  ${match}`);
    }

    console.log('');
    await db.shutdown();
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
})();
