#!/usr/bin/env node
/**
 * Diagnostic script: analyze sales discrepancy between Amazon report and Pics-Keeper
 * for Italy (IT) marketplace, period 2026-02-03 to 2026-03-04.
 *
 * Usage: node scripts/diagnose-sales-gap.js
 * (Requires .env with DB credentials)
 */
require('dotenv').config();
const { Pool } = require('pg');
const config = require('../src/config');

const pool = new Pool(config.db);

const PERIOD_FROM = '2026-02-03';
const PERIOD_TO = '2026-03-05'; // exclusive upper bound (purchase_date < this)
const AMAZON_UNITS = 3701;

async function run() {
  const client = await pool.connect();
  try {
    console.log('='.repeat(70));
    console.log('DIAGNOSTICA DISCREPANZA VENDITE - Italia');
    console.log(`Periodo: ${PERIOD_FROM} - ${PERIOD_TO} (escluso)`);
    console.log(`Unità Amazon Seller Central: ${AMAZON_UNITS}`);
    console.log('='.repeat(70));

    // 0) Find Italy marketplace
    const mp = await client.query(
      `SELECT id, marketplace_id AS amazon_marketplace_id, country_code FROM marketplaces WHERE country_code = 'IT'`
    );
    if (mp.rows.length === 0) {
      console.log('ERROR: Marketplace IT not found!');
      return;
    }
    const marketplaceId = mp.rows[0].id;
    console.log(`\nMarketplace IT: internal id = ${marketplaceId}, amazon_id = ${mp.rows[0].amazon_marketplace_id}`);

    // 1) Total units in orders_raw (ALL statuses)
    const rawAll = await client.query(
      `SELECT
        COUNT(*) AS total_rows,
        SUM(quantity) AS total_units,
        COUNT(DISTINCT amazon_order_id) AS distinct_orders
       FROM orders_raw
       WHERE marketplace_id = $1
         AND purchase_date >= $2 AND purchase_date < $3`,
      [marketplaceId, PERIOD_FROM, PERIOD_TO]
    );
    console.log('\n--- 1) orders_raw: TUTTI gli ordini (qualsiasi status) ---');
    console.log(`  Righe: ${rawAll.rows[0].total_rows}`);
    console.log(`  Unità totali: ${rawAll.rows[0].total_units}`);
    console.log(`  Ordini distinti: ${rawAll.rows[0].distinct_orders}`);

    // 2) Units by order_status
    const byStatus = await client.query(
      `SELECT
        order_status,
        COUNT(*) AS rows,
        SUM(quantity) AS units,
        COUNT(DISTINCT amazon_order_id) AS orders
       FROM orders_raw
       WHERE marketplace_id = $1
         AND purchase_date >= $2 AND purchase_date < $3
       GROUP BY order_status
       ORDER BY units DESC`,
      [marketplaceId, PERIOD_FROM, PERIOD_TO]
    );
    console.log('\n--- 2) orders_raw: breakdown per order_status ---');
    for (const r of byStatus.rows) {
      console.log(`  ${r.order_status}: ${r.units} unità, ${r.orders} ordini, ${r.rows} righe`);
    }

    // 3) Units excluding Cancelled (what Pics-Keeper counts)
    const rawNoCancelled = await client.query(
      `SELECT
        SUM(quantity) AS units,
        COUNT(DISTINCT amazon_order_id) AS orders
       FROM orders_raw
       WHERE marketplace_id = $1
         AND purchase_date >= $2 AND purchase_date < $3
         AND UPPER(order_status) != 'CANCELLED'`,
      [marketplaceId, PERIOD_FROM, PERIOD_TO]
    );
    console.log('\n--- 3) orders_raw: esclusi Cancelled (= logica Pics-Keeper) ---');
    console.log(`  Unità (no cancelled): ${rawNoCancelled.rows[0].units}`);
    console.log(`  Ordini (no cancelled): ${rawNoCancelled.rows[0].orders}`);

    // 4) Units in order_profit (computed data)
    const profitUnits = await client.query(
      `SELECT
        SUM(quantity) AS units,
        COUNT(DISTINCT amazon_order_id) AS orders
       FROM order_profit
       WHERE marketplace_id = $1
         AND order_date >= $2 AND order_date < $3`,
      [marketplaceId, PERIOD_FROM, PERIOD_TO]
    );
    console.log('\n--- 4) order_profit: dati calcolati dal profit engine ---');
    console.log(`  Unità: ${profitUnits.rows[0].units}`);
    console.log(`  Ordini: ${profitUnits.rows[0].orders}`);

    // 5) Units in asin_daily_metrics (what the dashboard shows)
    const asinMetrics = await client.query(
      `SELECT
        SUM(units_sold) AS units,
        SUM(orders_count) AS orders
       FROM asin_daily_metrics
       WHERE marketplace_id = $1
         AND metric_date >= $2 AND metric_date < $3`,
      [marketplaceId, PERIOD_FROM, PERIOD_TO]
    );
    console.log('\n--- 5) asin_daily_metrics: dati mostrati in dashboard ---');
    console.log(`  Unità: ${asinMetrics.rows[0].units}`);
    console.log(`  Ordini: ${asinMetrics.rows[0].orders}`);

    // 6) Units in account_daily_kpi
    const kpi = await client.query(
      `SELECT
        SUM(units_sold) AS units
       FROM account_daily_kpi
       WHERE marketplace_id = $1
         AND kpi_date >= $2 AND kpi_date < $3`,
      [marketplaceId, PERIOD_FROM, PERIOD_TO]
    );
    console.log('\n--- 6) account_daily_kpi ---');
    console.log(`  Unità: ${kpi.rows[0].units}`);

    // 7) Daily breakdown from orders_raw (to spot missing days)
    const daily = await client.query(
      `SELECT
        purchase_date::date AS day,
        SUM(quantity) AS units,
        COUNT(DISTINCT amazon_order_id) AS orders
       FROM orders_raw
       WHERE marketplace_id = $1
         AND purchase_date >= $2 AND purchase_date < $3
         AND UPPER(order_status) != 'CANCELLED'
       GROUP BY purchase_date::date
       ORDER BY day`,
      [marketplaceId, PERIOD_FROM, PERIOD_TO]
    );
    console.log('\n--- 7) Breakdown giornaliero orders_raw (no cancelled) ---');
    let totalDailyUnits = 0;
    for (const r of daily.rows) {
      console.log(`  ${r.day.toISOString().substring(0, 10)}: ${r.units} unità, ${r.orders} ordini`);
      totalDailyUnits += parseInt(r.units, 10);
    }
    console.log(`  TOTALE: ${totalDailyUnits} unità in ${daily.rows.length} giorni`);

    // 8) Check for missing days in asin_daily_metrics vs orders_raw
    const missingDays = await client.query(
      `SELECT o.day, o.units AS raw_units, COALESCE(m.units, 0) AS metric_units,
              o.units - COALESCE(m.units, 0) AS gap
       FROM (
         SELECT purchase_date::date AS day, SUM(quantity) AS units
         FROM orders_raw
         WHERE marketplace_id = $1 AND purchase_date >= $2 AND purchase_date < $3
           AND UPPER(order_status) != 'CANCELLED'
         GROUP BY purchase_date::date
       ) o
       LEFT JOIN (
         SELECT metric_date AS day, SUM(units_sold) AS units
         FROM asin_daily_metrics
         WHERE marketplace_id = $1 AND metric_date >= $2 AND metric_date < $3
         GROUP BY metric_date
       ) m ON o.day = m.day
       WHERE o.units != COALESCE(m.units, 0)
       ORDER BY o.day`,
      [marketplaceId, PERIOD_FROM, PERIOD_TO]
    );
    console.log('\n--- 8) Giorni con discrepanza orders_raw vs asin_daily_metrics ---');
    if (missingDays.rows.length === 0) {
      console.log('  Nessuna discrepanza trovata!');
    } else {
      let totalGap = 0;
      for (const r of missingDays.rows) {
        console.log(`  ${r.day.toISOString().substring(0, 10)}: raw=${r.raw_units} vs metrics=${r.metric_units} (gap: ${r.gap})`);
        totalGap += parseInt(r.gap, 10);
      }
      console.log(`  GAP TOTALE: ${totalGap} unità in ${missingDays.rows.length} giorni`);
    }

    // 9) Check timezone effect: orders near midnight Italian time
    const tzEdge = await client.query(
      `SELECT
        purchase_date::date AS day_utc,
        (purchase_date AT TIME ZONE 'Europe/Rome')::date AS day_rome,
        COUNT(*) AS rows,
        SUM(quantity) AS units
       FROM orders_raw
       WHERE marketplace_id = $1
         AND purchase_date >= $2 AND purchase_date < $3
         AND UPPER(order_status) != 'CANCELLED'
         AND purchase_date::date != (purchase_date AT TIME ZONE 'Europe/Rome')::date
       GROUP BY day_utc, day_rome
       ORDER BY day_utc`,
      [marketplaceId, PERIOD_FROM, PERIOD_TO]
    );
    console.log('\n--- 9) Ordini con data diversa UTC vs Rome (effetto timezone) ---');
    if (tzEdge.rows.length === 0) {
      console.log('  Nessun ordine con data diversa UTC/Rome');
    } else {
      let tzUnits = 0;
      for (const r of tzEdge.rows) {
        console.log(`  UTC: ${r.day_utc.toISOString().substring(0, 10)} -> Rome: ${r.day_rome.toISOString().substring(0, 10)}: ${r.units} unità`);
        tzUnits += parseInt(r.units, 10);
      }
      console.log(`  Totale unità impattate dal timezone: ${tzUnits}`);
    }

    // 10) Check last sync timestamps
    const syncInfo = await client.query(
      `SELECT
        am.id, m.country_code, am.is_active,
        am.last_orders_sync_at, am.last_financial_sync_at,
        am.sync_status
       FROM account_marketplaces am
       JOIN marketplaces m ON m.id = am.marketplace_id
       WHERE m.country_code = 'IT'`
    );
    console.log('\n--- 10) Stato sync per Italia ---');
    for (const r of syncInfo.rows) {
      console.log(`  Active: ${r.is_active}, Status: ${r.sync_status}`);
      console.log(`  Last orders sync: ${r.last_orders_sync_at}`);
      console.log(`  Last financial sync: ${r.last_financial_sync_at}`);
    }

    // 11) Check sync_log for errors in the period
    const syncErrors = await client.query(
      `SELECT
        sl.sync_type, sl.status, sl.error_message,
        sl.started_at::date AS day, COUNT(*) AS occurrences
       FROM sync_log sl
       JOIN marketplaces m ON m.id = sl.marketplace_id
       WHERE m.country_code = 'IT'
         AND sl.started_at >= $1 AND sl.started_at < $2
         AND sl.status = 'failed'
       GROUP BY sl.sync_type, sl.status, sl.error_message, day
       ORDER BY day`,
      [PERIOD_FROM, PERIOD_TO]
    );
    console.log('\n--- 11) Errori di sync nel periodo ---');
    if (syncErrors.rows.length === 0) {
      console.log('  Nessun errore trovato');
    } else {
      for (const r of syncErrors.rows) {
        console.log(`  ${r.day.toISOString().substring(0, 10)} | ${r.sync_type} | ${r.occurrences}x | ${r.error_message}`);
      }
    }

    // Summary
    const rawUnits = parseInt(rawNoCancelled.rows[0].units || 0, 10);
    const metricUnits = parseInt(asinMetrics.rows[0].units || 0, 10);
    console.log('\n' + '='.repeat(70));
    console.log('RIEPILOGO');
    console.log('='.repeat(70));
    console.log(`  Amazon Seller Central:      ${AMAZON_UNITS} unità`);
    console.log(`  orders_raw (no cancelled):  ${rawUnits} unità`);
    console.log(`  asin_daily_metrics:         ${metricUnits} unità`);
    console.log(`  Pics-Keeper dashboard:      3549 unità`);
    console.log('');
    console.log(`  Gap Amazon vs orders_raw:   ${AMAZON_UNITS - rawUnits} unità (ordini mai scaricati?)`);
    console.log(`  Gap orders_raw vs metrics:  ${rawUnits - metricUnits} unità (non calcolati dal profit engine?)`);
    console.log(`  Gap metrics vs dashboard:   ${metricUnits - 3549} unità (filtro dashboard?)`);

  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
