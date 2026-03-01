#!/usr/bin/env node
/**
 * Diagnose order counts for a specific ASIN.
 * Compares orders_raw → order_profit → asin_daily_metrics pipeline.
 *
 * Usage:
 *   node scripts/diagnose-asin.js B0BY9Q4KTT 2026-02-01 2026-03-01
 */
require('dotenv').config();
const db = require('../src/database/pool');

const asin = process.argv[2] || 'B0BY9Q4KTT';
const dateFrom = process.argv[3] || '2026-02-01';
const dateTo = process.argv[4] || '2026-03-01';

(async () => {
  try {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`  DIAGNOSI ASIN: ${asin}`);
    console.log(`  Periodo: ${dateFrom} → ${dateTo}`);
    console.log(`${'='.repeat(70)}\n`);

    // 1. orders_raw breakdown by status
    const rawByStatus = await db.query(`
      SELECT
        o.order_status,
        COUNT(DISTINCT o.amazon_order_id) AS orders,
        COUNT(*) AS rows,
        SUM(o.quantity) AS units,
        ROUND(SUM(o.item_price)::numeric, 2) AS item_price,
        ROUND(SUM(o.item_tax)::numeric, 2) AS item_tax,
        ROUND(SUM(o.item_price + o.item_tax + o.shipping_price + o.shipping_tax - o.promotion_discount)::numeric, 2) AS gross_revenue
      FROM orders_raw o
      JOIN marketplaces m ON m.id = o.marketplace_id
      WHERE o.account_id = 1
        AND o.asin = $1
        AND m.country_code = 'IT'
        AND o.purchase_date >= $2
        AND o.purchase_date < $3
      GROUP BY o.order_status
      ORDER BY orders DESC
    `, [asin, dateFrom, dateTo]);

    console.log('--- 1. ORDERS_RAW per status ---');
    console.table(rawByStatus.rows);

    // 2. orders_raw totals
    const rawTotals = await db.query(`
      SELECT
        COUNT(DISTINCT o.amazon_order_id) AS distinct_orders,
        COUNT(*) AS total_rows,
        SUM(o.quantity) AS total_units,
        ROUND(SUM(o.item_price)::numeric, 2) AS total_item_price,
        ROUND(SUM(o.item_tax)::numeric, 2) AS total_item_tax,
        ROUND(SUM(o.item_price + o.item_tax + o.shipping_price + o.shipping_tax - o.promotion_discount)::numeric, 2) AS gross_revenue
      FROM orders_raw o
      JOIN marketplaces m ON m.id = o.marketplace_id
      WHERE o.account_id = 1
        AND o.asin = $1
        AND m.country_code = 'IT'
        AND o.purchase_date >= $2
        AND o.purchase_date < $3
    `, [asin, dateFrom, dateTo]);

    console.log('--- 2. ORDERS_RAW totali (tutti gli status) ---');
    console.table(rawTotals.rows);

    // 3. order_profit (handle missing marketplace_facilitator_tax column)
    const profitData = await db.query(`
      SELECT
        COUNT(DISTINCT op.amazon_order_id) AS distinct_orders,
        COUNT(*) AS total_rows,
        SUM(op.quantity) AS total_units,
        ROUND(SUM(op.revenue)::numeric, 2) AS revenue,
        ROUND(SUM(op.referral_fee)::numeric, 2) AS referral_fee,
        ROUND(SUM(op.fba_fee)::numeric, 2) AS fba_fee,
        ROUND(SUM(op.other_amazon_fees)::numeric, 2) AS other_fees,
        ROUND(SUM(op.referral_fee + op.fba_fee + op.other_amazon_fees)::numeric, 2) AS total_amazon_fees,
        ROUND(SUM(op.net_profit)::numeric, 2) AS net_profit
      FROM order_profit op
      JOIN marketplaces m ON m.id = op.marketplace_id
      WHERE op.account_id = 1
        AND op.asin = $1
        AND m.country_code = 'IT'
        AND op.order_date >= $2
        AND op.order_date < $3
    `, [asin, dateFrom, dateTo]);

    console.log('--- 3. ORDER_PROFIT ---');
    console.table(profitData.rows);

    // 4. asin_daily_metrics (what the frontend shows)
    const metricsData = await db.query(`
      SELECT
        SUM(adm.units_sold) AS units_sold,
        SUM(adm.orders_count) AS orders_count,
        ROUND(SUM(adm.revenue)::numeric, 2) AS revenue,
        ROUND(SUM(adm.total_amazon_fees)::numeric, 2) AS amazon_fees,
        ROUND(SUM(adm.net_profit)::numeric, 2) AS net_profit,
        ROUND(SUM(adm.ads_spend)::numeric, 2) AS ads_spend,
        ROUND(SUM(adm.total_product_costs)::numeric, 2) AS product_costs
      FROM asin_daily_metrics adm
      JOIN marketplaces m ON m.id = adm.marketplace_id
      WHERE adm.account_id = 1
        AND adm.asin = $1
        AND m.country_code = 'IT'
        AND adm.metric_date >= $2
        AND adm.metric_date < $3
    `, [asin, dateFrom, dateTo]);

    console.log('--- 4. ASIN_DAILY_METRICS (dati frontend) ---');
    console.table(metricsData.rows);

    // 5. Date coverage
    const coverage = await db.query(`
      SELECT
        MIN(o.purchase_date)::date AS first_order,
        MAX(o.purchase_date)::date AS last_order,
        COUNT(DISTINCT (o.purchase_date::date)) AS days_with_orders
      FROM orders_raw o
      JOIN marketplaces m ON m.id = o.marketplace_id
      WHERE o.account_id = 1
        AND o.asin = $1
        AND m.country_code = 'IT'
        AND o.purchase_date >= $2
        AND o.purchase_date < $3
    `, [asin, dateFrom, dateTo]);

    console.log('--- 5. Copertura date ---');
    console.table(coverage.rows);

    // 6. Check if order_profit has orders not in orders_raw or vice versa
    const missingFromProfit = await db.query(`
      SELECT COUNT(DISTINCT o.amazon_order_id) AS orders_without_profit
      FROM orders_raw o
      JOIN marketplaces m ON m.id = o.marketplace_id
      LEFT JOIN order_profit op ON op.account_id = o.account_id
        AND op.amazon_order_id = o.amazon_order_id AND op.asin = o.asin
      WHERE o.account_id = 1
        AND o.asin = $1
        AND m.country_code = 'IT'
        AND o.purchase_date >= $2
        AND o.purchase_date < $3
        AND op.id IS NULL
    `, [asin, dateFrom, dateTo]);

    console.log('--- 6. Ordini in orders_raw SENZA riga in order_profit ---');
    console.table(missingFromProfit.rows);

    // 7. Daily breakdown comparison
    const dailyComparison = await db.query(`
      SELECT
        d.day,
        COALESCE(raw.orders, 0) AS raw_orders,
        COALESCE(raw.units, 0) AS raw_units,
        COALESCE(profit.orders, 0) AS profit_orders,
        COALESCE(metrics.orders_count, 0) AS metrics_orders,
        COALESCE(metrics.units_sold, 0) AS metrics_units,
        ROUND(COALESCE(metrics.revenue, 0)::numeric, 2) AS metrics_revenue
      FROM generate_series($2::date, ($3::date - interval '1 day')::date, '1 day') d(day)
      LEFT JOIN LATERAL (
        SELECT COUNT(DISTINCT amazon_order_id) AS orders, SUM(quantity) AS units
        FROM orders_raw o
        JOIN marketplaces m ON m.id = o.marketplace_id
        WHERE o.account_id = 1 AND o.asin = $1 AND m.country_code = 'IT'
          AND o.purchase_date::date = d.day
      ) raw ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(DISTINCT amazon_order_id) AS orders
        FROM order_profit op
        JOIN marketplaces m ON m.id = op.marketplace_id
        WHERE op.account_id = 1 AND op.asin = $1 AND m.country_code = 'IT'
          AND op.order_date = d.day
      ) profit ON true
      LEFT JOIN LATERAL (
        SELECT orders_count, units_sold, revenue
        FROM asin_daily_metrics adm
        JOIN marketplaces m ON m.id = adm.marketplace_id
        WHERE adm.account_id = 1 AND adm.asin = $1 AND m.country_code = 'IT'
          AND adm.metric_date = d.day
      ) metrics ON true
      ORDER BY d.day
    `, [asin, dateFrom, dateTo]);

    console.log('--- 7. Confronto giornaliero (raw vs profit vs metrics) ---');
    console.table(dailyComparison.rows);

    console.log('\n  CONFRONTO RIEPILOGO:');
    const r = rawTotals.rows[0];
    const p = profitData.rows[0];
    const m = metricsData.rows[0];
    console.log(`  orders_raw:         ${r.distinct_orders} ordini, ${r.total_units} unità, €${r.gross_revenue} gross revenue`);
    console.log(`  order_profit:       ${p.distinct_orders} ordini, ${p.total_units} unità, €${p.revenue} revenue`);
    console.log(`  asin_daily_metrics: ${m.orders_count} ordini, ${m.units_sold} unità, €${m.revenue} revenue`);
    console.log(`  Shopkeeper:         695 ordini, €6,867 revenue`);
    console.log(`  Frontend:           448 ordini, 462 unità, €4,423.66 vendite\n`);

    await db.shutdown();
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
})();
