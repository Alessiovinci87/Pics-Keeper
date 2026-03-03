#!/usr/bin/env node
/**
 * Unità vendute per ASIN in un intervallo di date preciso.
 * Usa conversione timezone per marketplace (come Seller Central).
 *
 * Usage:
 *   node scripts/units-sold-range.js B0BY9Q4KTT 2026-02-24 2026-03-03
 *   node scripts/units-sold-range.js B0BY9Q4KTT 2026-02-24 2026-03-03 IT
 */
require('dotenv').config();
const db = require('../src/database/pool');

const ASIN = process.argv[2];
const dateFrom = process.argv[3];
const dateTo = process.argv[4];
const countryFilter = process.argv[5] ? process.argv[5].toUpperCase() : null;

if (!ASIN || !dateFrom || !dateTo) {
  console.log('Usage: node scripts/units-sold-range.js <ASIN> <YYYY-MM-DD from> <YYYY-MM-DD to> [COUNTRY]');
  process.exit(1);
}

const TZ_CASE = `
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
  END
`;

(async () => {
  try {
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`  UNITÀ VENDUTE — ASIN: ${ASIN}`);
    console.log(`  Periodo: ${dateFrom} → ${dateTo} (inclusi)`);
    if (countryFilter) console.log(`  Filtro paese: ${countryFilter}`);
    console.log(`${'═'.repeat(70)}`);

    const countryClause = countryFilter ? `AND m.country_code = $4` : '';
    const params = countryFilter ? [ASIN, dateFrom, dateTo, countryFilter] : [ASIN, dateFrom, dateTo];

    // ── 1. Riepilogo per marketplace (ESCLUSI CANCELLED) ──
    const summary = await db.query(`
      SELECT
        m.country_code,
        COUNT(DISTINCT o.amazon_order_id) AS orders,
        SUM(o.quantity) AS units,
        o.currency
      FROM orders_raw o
      JOIN marketplaces m ON m.id = o.marketplace_id
      WHERE o.account_id = 1
        AND o.asin = $1
        AND (o.purchase_date AT TIME ZONE ${TZ_CASE})::date >= $2::date
        AND (o.purchase_date AT TIME ZONE ${TZ_CASE})::date <= $3::date
        AND UPPER(o.order_status) NOT IN ('CANCELLED', 'CANCELED')
        ${countryClause}
      GROUP BY m.country_code, o.currency
      ORDER BY units DESC
    `, params);

    let totOrd = 0, totUni = 0;
    console.log(`\n  VENDITE (esclusi cancelled):`);
    console.log(`  ${'Paese'.padEnd(5)} | Ordini | Unità`);
    console.log(`  ${'-'.repeat(30)}`);
    for (const r of summary.rows) {
      totOrd += parseInt(r.orders);
      totUni += parseInt(r.units);
      console.log(`  ${r.country_code.padEnd(5)} | ${String(r.orders).padStart(6)} | ${String(r.units).padStart(5)}`);
    }
    console.log(`  ${'-'.repeat(30)}`);
    console.log(`  ${'TOT'.padEnd(5)} | ${String(totOrd).padStart(6)} | ${String(totUni).padStart(5)}`);

    // ── 2. Dettaglio per status ──
    const byStatus = await db.query(`
      SELECT
        m.country_code,
        UPPER(o.order_status) AS status,
        COUNT(DISTINCT o.amazon_order_id) AS orders,
        SUM(o.quantity) AS units
      FROM orders_raw o
      JOIN marketplaces m ON m.id = o.marketplace_id
      WHERE o.account_id = 1
        AND o.asin = $1
        AND (o.purchase_date AT TIME ZONE ${TZ_CASE})::date >= $2::date
        AND (o.purchase_date AT TIME ZONE ${TZ_CASE})::date <= $3::date
        ${countryClause}
      GROUP BY m.country_code, UPPER(o.order_status)
      ORDER BY m.country_code, status
    `, params);

    console.log(`\n  DETTAGLIO PER STATUS:`);
    console.log(`  ${'Paese'.padEnd(5)} | ${'Status'.padEnd(12)} | Ordini | Unità`);
    console.log(`  ${'-'.repeat(45)}`);
    for (const r of byStatus.rows) {
      console.log(`  ${r.country_code.padEnd(5)} | ${r.status.padEnd(12)} | ${String(r.orders).padStart(6)} | ${String(r.units).padStart(5)}`);
    }

    // ── 3. Dettaglio giornaliero ──
    const daily = await db.query(`
      SELECT
        (o.purchase_date AT TIME ZONE ${TZ_CASE})::date AS day,
        m.country_code,
        COUNT(DISTINCT o.amazon_order_id) AS orders,
        SUM(o.quantity) AS units
      FROM orders_raw o
      JOIN marketplaces m ON m.id = o.marketplace_id
      WHERE o.account_id = 1
        AND o.asin = $1
        AND (o.purchase_date AT TIME ZONE ${TZ_CASE})::date >= $2::date
        AND (o.purchase_date AT TIME ZONE ${TZ_CASE})::date <= $3::date
        AND UPPER(o.order_status) NOT IN ('CANCELLED', 'CANCELED')
        ${countryClause}
      GROUP BY day, m.country_code
      ORDER BY day, m.country_code
    `, params);

    console.log(`\n  DETTAGLIO GIORNALIERO (esclusi cancelled):`);
    console.log(`  ${'Data'.padEnd(10)} | ${'Paese'.padEnd(5)} | Ordini | Unità`);
    console.log(`  ${'-'.repeat(40)}`);

    let currentDay = null;
    let dayTotOrd = 0, dayTotUni = 0;
    for (const r of daily.rows) {
      const dayStr = r.day.toISOString().slice(0, 10);
      if (currentDay && currentDay !== dayStr) {
        console.log(`  ${' '.repeat(10)} | ${'SUB'.padEnd(5)} | ${String(dayTotOrd).padStart(6)} | ${String(dayTotUni).padStart(5)}`);
        console.log(`  ${'-'.repeat(40)}`);
        dayTotOrd = 0;
        dayTotUni = 0;
      }
      currentDay = dayStr;
      dayTotOrd += parseInt(r.orders);
      dayTotUni += parseInt(r.units);
      console.log(`  ${dayStr} | ${r.country_code.padEnd(5)} | ${String(r.orders).padStart(6)} | ${String(r.units).padStart(5)}`);
    }
    if (currentDay) {
      console.log(`  ${' '.repeat(10)} | ${'SUB'.padEnd(5)} | ${String(dayTotOrd).padStart(6)} | ${String(dayTotUni).padStart(5)}`);
    }

    // ── 4. Confronto con e senza timezone ──
    console.log(`\n  CONFRONTO: con timezone vs senza timezone (UTC):`);
    const noTz = await db.query(`
      SELECT
        m.country_code,
        COUNT(DISTINCT o.amazon_order_id) AS orders,
        SUM(o.quantity) AS units
      FROM orders_raw o
      JOIN marketplaces m ON m.id = o.marketplace_id
      WHERE o.account_id = 1
        AND o.asin = $1
        AND o.purchase_date >= $2::timestamptz
        AND o.purchase_date < ($3::date + 1)::timestamptz
        AND UPPER(o.order_status) NOT IN ('CANCELLED', 'CANCELED')
        ${countryClause}
      GROUP BY m.country_code
      ORDER BY units DESC
    `, params);

    let noTzTotOrd = 0, noTzTotUni = 0;
    console.log(`  ${'Paese'.padEnd(5)} | ${'Con TZ'.padEnd(14)} | Senza TZ (UTC)`);
    console.log(`  ${'-'.repeat(45)}`);

    // Build lookup for noTz
    const noTzMap = {};
    for (const r of noTz.rows) {
      noTzMap[r.country_code] = r;
      noTzTotOrd += parseInt(r.orders);
      noTzTotUni += parseInt(r.units);
    }

    // Build lookup for withTz (from summary)
    const withTzMap = {};
    for (const r of summary.rows) {
      withTzMap[r.country_code] = r;
    }

    const allCountries = [...new Set([...Object.keys(withTzMap), ...Object.keys(noTzMap)])].sort();
    for (const cc of allCountries) {
      const tz = withTzMap[cc] || { orders: 0, units: 0 };
      const notz = noTzMap[cc] || { orders: 0, units: 0 };
      const diff = parseInt(tz.units) - parseInt(notz.units);
      const diffStr = diff !== 0 ? ` (diff: ${diff > 0 ? '+' : ''}${diff})` : '';
      console.log(`  ${cc.padEnd(5)} | ${String(tz.orders).padStart(3)}/${String(tz.units).padStart(3)} unità   | ${String(notz.orders).padStart(3)}/${String(notz.units).padStart(3)} unità${diffStr}`);
    }
    console.log(`  ${'-'.repeat(45)}`);
    const totalDiff = totUni - noTzTotUni;
    const totalDiffStr = totalDiff !== 0 ? ` (diff: ${totalDiff > 0 ? '+' : ''}${totalDiff})` : '';
    console.log(`  ${'TOT'.padEnd(5)} | ${String(totOrd).padStart(3)}/${String(totUni).padStart(3)} unità   | ${String(noTzTotOrd).padStart(3)}/${String(noTzTotUni).padStart(3)} unità${totalDiffStr}`);

    console.log(`\n${'═'.repeat(70)}`);
    console.log(`  Nota: Seller Central usa il timezone del marketplace.`);
    console.log(`  Il dato "Con TZ" dovrebbe corrispondere a Seller Central.`);
    console.log(`${'═'.repeat(70)}\n`);

    await db.shutdown();
  } catch (err) {
    console.error('Error:', err.message);
    console.error(err.stack);
    await db.shutdown();
    process.exit(1);
  }
})();
