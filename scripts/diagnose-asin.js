#!/usr/bin/env node
/**
 * Diagnose order counts for a specific ASIN across ALL marketplaces.
 * Compares orders_raw → order_profit → asin_daily_metrics pipeline.
 * Helps identify which marketplace has missing data and at which pipeline stage.
 *
 * Usage:
 *   node scripts/diagnose-asin.js B0BY9Q4KTT 2026-02-01 2026-03-01
 *   node scripts/diagnose-asin.js B0BY9Q4KTT 2026-02-01 2026-03-01 FR    # single marketplace
 */
require('dotenv').config();
const db = require('../src/database/pool');

const asin = process.argv[2] || 'B0BY9Q4KTT';
const dateFrom = process.argv[3] || '2026-02-01';
const dateTo = process.argv[4] || '2026-03-01';
const countryFilter = process.argv[5] ? process.argv[5].toUpperCase() : null;

(async () => {
  try {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`  DIAGNOSI ASIN: ${asin}`);
    console.log(`  Periodo: ${dateFrom} → ${dateTo}`);
    if (countryFilter) console.log(`  Filtro paese: ${countryFilter}`);
    console.log(`${'='.repeat(70)}\n`);

    // ── 1. CROSS-MARKETPLACE SUMMARY ──────────────────────────────────
    // Compare orders_raw, order_profit, and asin_daily_metrics per country
    console.log('═══ 1. CONFRONTO PER MARKETPLACE (orders_raw → order_profit → metrics) ═══\n');

    const crossMp = await db.query(`
      SELECT
        m.country_code,
        COALESCE(raw.orders, 0)    AS raw_orders,
        COALESCE(raw.units, 0)     AS raw_units,
        ROUND(COALESCE(raw.gross_revenue, 0)::numeric, 2)  AS raw_revenue,
        COALESCE(profit.orders, 0) AS profit_orders,
        COALESCE(profit.units, 0)  AS profit_units,
        ROUND(COALESCE(profit.revenue, 0)::numeric, 2)     AS profit_revenue,
        COALESCE(metrics.orders, 0) AS metrics_orders,
        COALESCE(metrics.units, 0)  AS metrics_units,
        ROUND(COALESCE(metrics.revenue, 0)::numeric, 2)    AS metrics_revenue,
        COALESCE(raw.orders, 0) - COALESCE(profit.orders, 0) AS raw_vs_profit_gap,
        COALESCE(raw.units, 0) - COALESCE(metrics.units, 0)  AS raw_vs_metrics_gap
      FROM marketplaces m
      JOIN account_marketplaces am ON am.marketplace_id = m.id AND am.is_active = TRUE
      LEFT JOIN LATERAL (
        SELECT
          COUNT(DISTINCT o.amazon_order_id) AS orders,
          SUM(o.quantity) AS units,
          SUM(o.item_price + o.item_tax + o.shipping_price + o.shipping_tax - o.promotion_discount) AS gross_revenue
        FROM orders_raw o
        WHERE o.account_id = am.account_id
          AND o.marketplace_id = m.id
          AND o.asin = $1
          AND o.purchase_date >= $2
          AND o.purchase_date < $3
          AND UPPER(o.order_status) NOT IN ('CANCELLED', 'CANCELED', 'PENDING')
      ) raw ON TRUE
      LEFT JOIN LATERAL (
        SELECT
          COUNT(DISTINCT op.amazon_order_id) AS orders,
          SUM(op.quantity) AS units,
          SUM(op.revenue) AS revenue
        FROM order_profit op
        WHERE op.account_id = am.account_id
          AND op.marketplace_id = m.id
          AND op.asin = $1
          AND op.order_date >= $2::date
          AND op.order_date < $3::date
      ) profit ON TRUE
      LEFT JOIN LATERAL (
        SELECT
          SUM(adm.orders_count) AS orders,
          SUM(adm.units_sold) AS units,
          SUM(adm.revenue) AS revenue
        FROM asin_daily_metrics adm
        WHERE adm.account_id = am.account_id
          AND adm.marketplace_id = m.id
          AND adm.asin = $1
          AND adm.metric_date >= $2::date
          AND adm.metric_date < $3::date
      ) metrics ON TRUE
      WHERE am.account_id = 1
        AND (COALESCE(raw.orders, 0) > 0 OR COALESCE(profit.orders, 0) > 0 OR COALESCE(metrics.orders, 0) > 0)
      ORDER BY COALESCE(raw.units, 0) DESC
    `, [asin, dateFrom, dateTo]);

    console.table(crossMp.rows);

    // Totals row
    const totals = crossMp.rows.reduce((acc, r) => {
      acc.raw_orders += parseInt(r.raw_orders) || 0;
      acc.raw_units += parseInt(r.raw_units) || 0;
      acc.raw_revenue += parseFloat(r.raw_revenue) || 0;
      acc.profit_orders += parseInt(r.profit_orders) || 0;
      acc.profit_units += parseInt(r.profit_units) || 0;
      acc.profit_revenue += parseFloat(r.profit_revenue) || 0;
      acc.metrics_orders += parseInt(r.metrics_orders) || 0;
      acc.metrics_units += parseInt(r.metrics_units) || 0;
      acc.metrics_revenue += parseFloat(r.metrics_revenue) || 0;
      return acc;
    }, { raw_orders: 0, raw_units: 0, raw_revenue: 0, profit_orders: 0, profit_units: 0, profit_revenue: 0, metrics_orders: 0, metrics_units: 0, metrics_revenue: 0 });

    console.log('  TOTALI:');
    console.log(`    orders_raw:         ${totals.raw_orders} ordini, ${totals.raw_units} unità, €${totals.raw_revenue.toFixed(2)}`);
    console.log(`    order_profit:       ${totals.profit_orders} ordini, ${totals.profit_units} unità, €${totals.profit_revenue.toFixed(2)}`);
    console.log(`    asin_daily_metrics: ${totals.metrics_orders} ordini, ${totals.metrics_units} unità, €${totals.metrics_revenue.toFixed(2)}`);
    console.log('');

    // ── 2. PER-STATUS BREAKDOWN (per marketplace or filtered) ────────
    const targetCountry = countryFilter || null;

    if (targetCountry) {
      console.log(`═══ 2. DETTAGLIO ${targetCountry}: ORDERS_RAW per status ═══\n`);

      const rawByStatus = await db.query(`
        SELECT
          o.order_status,
          COUNT(DISTINCT o.amazon_order_id) AS orders,
          SUM(o.quantity) AS units,
          ROUND(SUM(o.item_price + o.item_tax + o.shipping_price + o.shipping_tax - o.promotion_discount)::numeric, 2) AS gross_revenue
        FROM orders_raw o
        JOIN marketplaces m ON m.id = o.marketplace_id
        WHERE o.account_id = 1
          AND o.asin = $1
          AND m.country_code = $4
          AND o.purchase_date >= $2
          AND o.purchase_date < $3
        GROUP BY o.order_status
        ORDER BY orders DESC
      `, [asin, dateFrom, dateTo, targetCountry]);

      console.table(rawByStatus.rows);
    }

    // ── 3. CANCELLED ORDERS CHECK ────────────────────────────────────
    console.log('═══ 3. ORDINI CANCELLATI per marketplace (esclusi dai conteggi) ═══\n');

    const cancelled = await db.query(`
      SELECT
        m.country_code,
        COUNT(DISTINCT o.amazon_order_id) AS cancelled_orders,
        SUM(o.quantity) AS cancelled_units
      FROM orders_raw o
      JOIN marketplaces m ON m.id = o.marketplace_id
      WHERE o.account_id = 1
        AND o.asin = $1
        AND o.purchase_date >= $2
        AND o.purchase_date < $3
        AND UPPER(o.order_status) IN ('CANCELLED', 'CANCELED')
      GROUP BY m.country_code
      ORDER BY cancelled_orders DESC
    `, [asin, dateFrom, dateTo]);

    if (cancelled.rows.length > 0) {
      console.table(cancelled.rows);
    } else {
      console.log('  Nessun ordine cancellato.\n');
    }

    // ── 4. DATE COVERAGE per marketplace ─────────────────────────────
    console.log('═══ 4. COPERTURA DATE per marketplace ═══\n');

    const coverage = await db.query(`
      SELECT
        m.country_code,
        MIN(o.purchase_date)::date AS first_order,
        MAX(o.purchase_date)::date AS last_order,
        COUNT(DISTINCT o.purchase_date::date) AS days_with_orders
      FROM orders_raw o
      JOIN marketplaces m ON m.id = o.marketplace_id
      WHERE o.account_id = 1
        AND o.asin = $1
        AND o.purchase_date >= $2
        AND o.purchase_date < $3
        AND UPPER(o.order_status) NOT IN ('CANCELLED', 'CANCELED', 'PENDING')
      GROUP BY m.country_code
      ORDER BY days_with_orders DESC
    `, [asin, dateFrom, dateTo]);

    console.table(coverage.rows);

    // ── 5. ORDERS WITHOUT PROFIT (per marketplace) ───────────────────
    console.log('═══ 5. ORDINI SENZA PROFIT per marketplace ═══\n');

    const missingProfit = await db.query(`
      SELECT
        m.country_code,
        COUNT(DISTINCT o.amazon_order_id) AS orders_without_profit
      FROM orders_raw o
      JOIN marketplaces m ON m.id = o.marketplace_id
      LEFT JOIN order_profit op ON op.account_id = o.account_id
        AND op.amazon_order_id = o.amazon_order_id AND op.asin = o.asin
      WHERE o.account_id = 1
        AND o.asin = $1
        AND o.purchase_date >= $2
        AND o.purchase_date < $3
        AND UPPER(o.order_status) NOT IN ('CANCELLED', 'CANCELED', 'PENDING')
        AND op.id IS NULL
      GROUP BY m.country_code
      HAVING COUNT(DISTINCT o.amazon_order_id) > 0
      ORDER BY orders_without_profit DESC
    `, [asin, dateFrom, dateTo]);

    if (missingProfit.rows.length > 0) {
      console.table(missingProfit.rows);
    } else {
      console.log('  Tutti gli ordini hanno una riga in order_profit.\n');
    }

    // ── 6. TIMEZONE BOUNDARY CHECK ───────────────────────────────────
    // Check if orders near UTC midnight might be attributed to wrong local date
    console.log('═══ 6. CONTROLLO CONFINE TIMEZONE (ordini vicino a mezzanotte UTC) ═══\n');

    const tzBoundary = await db.query(`
      SELECT
        m.country_code,
        COUNT(*) AS boundary_orders,
        SUM(o.quantity) AS boundary_units
      FROM orders_raw o
      JOIN marketplaces m ON m.id = o.marketplace_id
      WHERE o.account_id = 1
        AND o.asin = $1
        AND UPPER(o.order_status) NOT IN ('CANCELLED', 'CANCELED', 'PENDING')
        AND (
          -- Orders on Jan 31 UTC that might be Feb 1 local time
          (o.purchase_date >= ($2::date - interval '1 day') AND o.purchase_date < $2::timestamptz
           AND (o.purchase_date AT TIME ZONE
             CASE m.country_code
               WHEN 'IT' THEN 'Europe/Rome'
               WHEN 'FR' THEN 'Europe/Paris'
               WHEN 'ES' THEN 'Europe/Madrid'
               WHEN 'NL' THEN 'Europe/Amsterdam'
               WHEN 'GB' THEN 'Europe/London'
               WHEN 'PL' THEN 'Europe/Warsaw'
               WHEN 'DE' THEN 'Europe/Berlin'
               ELSE 'UTC'
             END)::date >= $2::date)
          OR
          -- Orders on last day UTC that might be next month local time
          (o.purchase_date >= ($3::date - interval '1 day')::timestamptz AND o.purchase_date < $3::timestamptz
           AND (o.purchase_date AT TIME ZONE
             CASE m.country_code
               WHEN 'IT' THEN 'Europe/Rome'
               WHEN 'FR' THEN 'Europe/Paris'
               WHEN 'ES' THEN 'Europe/Madrid'
               WHEN 'NL' THEN 'Europe/Amsterdam'
               WHEN 'GB' THEN 'Europe/London'
               WHEN 'PL' THEN 'Europe/Warsaw'
               WHEN 'DE' THEN 'Europe/Berlin'
               ELSE 'UTC'
             END)::date >= $3::date)
        )
      GROUP BY m.country_code
      HAVING COUNT(*) > 0
      ORDER BY boundary_orders DESC
    `, [asin, dateFrom, dateTo]);

    if (tzBoundary.rows.length > 0) {
      console.log('  ATTENZIONE: Ordini al confine timezone che potrebbero essere conteggiati nel mese sbagliato:');
      console.table(tzBoundary.rows);
    } else {
      console.log('  Nessun ordine problematico al confine timezone.\n');
    }

    // ── 7. SYNC LOG CHECK ────────────────────────────────────────────
    console.log('═══ 7. ULTIME SYNC per marketplace ═══\n');

    const syncStatus = await db.query(`
      SELECT
        m.country_code,
        am.last_orders_sync_at,
        am.sync_status,
        sl.last_sync_completed,
        sl.last_sync_records
      FROM account_marketplaces am
      JOIN marketplaces m ON m.id = am.marketplace_id
      LEFT JOIN LATERAL (
        SELECT completed_at AS last_sync_completed, records_processed AS last_sync_records
        FROM sync_log
        WHERE account_id = am.account_id
          AND marketplace_id = am.marketplace_id
          AND sync_type = 'orders'
          AND status = 'completed'
        ORDER BY completed_at DESC
        LIMIT 1
      ) sl ON TRUE
      WHERE am.account_id = 1 AND am.is_active = TRUE
      ORDER BY m.country_code
    `);

    console.table(syncStatus.rows);

    console.log(`\n${'='.repeat(70)}`);
    console.log('  DIAGNOSI COMPLETATA');
    console.log(`${'='.repeat(70)}\n`);

    await db.shutdown();
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
})();
