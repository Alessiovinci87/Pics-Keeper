#!/usr/bin/env node
/**
 * Extract Business Report data for Italy only, for a given date range.
 * Compares BR data with Orders API data.
 *
 * Usage:
 *   node scripts/br-italy-week.js 2026-02-22 2026-02-28
 */
require('dotenv').config();
const db = require('../src/database/pool');
const dayjs = require('dayjs');

const ACCOUNT_ID = 1;

async function main() {
  const startDate = process.argv[2] || '2026-02-22';
  const endDate = process.argv[3] || '2026-02-28';

  console.log(`\n${'='.repeat(70)}`);
  console.log(`  BUSINESS REPORT ITALIA: ${startDate} → ${endDate}`);
  console.log(`${'='.repeat(70)}\n`);

  // Get Italy marketplace ID
  const mkRes = await db.query(
    `SELECT id, country_code, name FROM marketplaces WHERE country_code = 'IT'`
  );
  if (mkRes.rows.length === 0) {
    console.log('  Marketplace IT non trovato!');
    await db.shutdown();
    return;
  }
  const mkId = mkRes.rows[0].id;
  console.log(`  Marketplace: ${mkRes.rows[0].name} (id=${mkId})\n`);

  // --- 1. Daily totals from Business Report ---
  console.log('--- 1. BR Totali giornalieri (riga _TOTAL) ---\n');

  const dailyTotals = await db.query(`
    SELECT
      report_date,
      units_ordered,
      ordered_product_sales,
      sessions,
      page_views,
      buy_box_percentage,
      unit_session_percentage
    FROM business_report_daily
    WHERE account_id = $1
      AND marketplace_id = $2
      AND asin = '_TOTAL'
      AND report_date >= $3::date
      AND report_date <= $4::date
    ORDER BY report_date
  `, [ACCOUNT_ID, mkId, startDate, endDate]);

  let totUnits = 0, totSales = 0, totSessions = 0, totPageViews = 0;

  console.log('  data       | unità | vendite (€) | sessioni | page_views | buy_box% | conv%');
  console.log('  -----------|-------|-------------|----------|------------|----------|------');

  for (const row of dailyTotals.rows) {
    const dt = dayjs(row.report_date).format('YYYY-MM-DD');
    const units = parseInt(row.units_ordered, 10);
    const sales = parseFloat(row.ordered_product_sales);
    const sess = parseInt(row.sessions, 10);
    const pv = parseInt(row.page_views, 10);
    const bb = parseFloat(row.buy_box_percentage).toFixed(2);
    const conv = parseFloat(row.unit_session_percentage).toFixed(2);

    console.log(`  ${dt} | ${String(units).padStart(5)} | ${sales.toFixed(2).padStart(11)} | ${String(sess).padStart(8)} | ${String(pv).padStart(10)} | ${String(bb).padStart(8)} | ${String(conv).padStart(5)}`);
    totUnits += units;
    totSales += sales;
    totSessions += sess;
    totPageViews += pv;
  }

  console.log('  -----------|-------|-------------|----------|------------|----------|------');
  console.log(`  TOTALE     | ${String(totUnits).padStart(5)} | ${totSales.toFixed(2).padStart(11)} | ${String(totSessions).padStart(8)} | ${String(totPageViews).padStart(10)} |          |`);

  // --- 2. Per-ASIN breakdown for the period ---
  console.log(`\n--- 2. BR Per-ASIN (periodo intero, top 20) ---\n`);

  const asinRows = await db.query(`
    SELECT
      brd.asin,
      SUM(brd.units_ordered) AS units,
      SUM(brd.ordered_product_sales) AS sales,
      SUM(brd.sessions) AS sessions,
      SUM(brd.page_views) AS page_views,
      ROUND(AVG(brd.buy_box_percentage), 2) AS avg_bb,
      ROUND(AVG(brd.unit_session_percentage), 2) AS avg_conv
    FROM business_report_daily brd
    WHERE brd.account_id = $1
      AND brd.marketplace_id = $2
      AND brd.asin != '_TOTAL'
      AND brd.report_date >= $3::date
      AND brd.report_date <= $4::date
    GROUP BY brd.asin
    ORDER BY units DESC
    LIMIT 20
  `, [ACCOUNT_ID, mkId, startDate, endDate]);

  console.log('  ASIN       | unità | vendite (€) | sessioni | page_views | buy_box% | conv%');
  console.log('  -----------|-------|-------------|----------|------------|----------|------');

  for (const row of asinRows.rows) {
    const units = parseInt(row.units, 10);
    const sales = parseFloat(row.sales);
    const sess = parseInt(row.sessions, 10);
    const pv = parseInt(row.page_views, 10);
    const bb = parseFloat(row.avg_bb).toFixed(2);
    const conv = parseFloat(row.avg_conv).toFixed(2);

    console.log(`  ${row.asin.padEnd(10)} | ${String(units).padStart(5)} | ${sales.toFixed(2).padStart(11)} | ${String(sess).padStart(8)} | ${String(pv).padStart(10)} | ${String(bb).padStart(8)} | ${String(conv).padStart(5)}`);
  }

  // --- 3. Orders API comparison for Italy ---
  console.log(`\n--- 3. Confronto con Orders API (solo IT) ---\n`);

  const ordersRes = await db.query(`
    SELECT
      (o.purchase_date AT TIME ZONE 'Europe/Rome')::date AS local_date,
      COUNT(DISTINCT o.amazon_order_id) AS num_orders,
      SUM(o.quantity) AS units,
      SUM(o.item_price) AS item_revenue,
      SUM(o.item_price + o.item_tax + o.shipping_price + o.shipping_tax - o.promotion_discount) AS gross_revenue
    FROM orders_raw o
    WHERE o.account_id = $1
      AND o.marketplace_id = $2
      AND UPPER(o.order_status) NOT IN ('CANCELLED','CANCELED')
      AND (o.purchase_date AT TIME ZONE 'Europe/Rome')::date >= $3::date
      AND (o.purchase_date AT TIME ZONE 'Europe/Rome')::date <= $4::date
    GROUP BY local_date
    ORDER BY local_date
  `, [ACCOUNT_ID, mkId, startDate, endDate]);

  let ordTotUnits = 0, ordTotOrders = 0, ordTotRevenue = 0;

  console.log('  data       | ordini | unità | item_price (€) | gross_revenue (€)');
  console.log('  -----------|--------|-------|----------------|------------------');

  for (const row of ordersRes.rows) {
    const dt = dayjs(row.local_date).format('YYYY-MM-DD');
    const orders = parseInt(row.num_orders, 10);
    const units = parseInt(row.units, 10);
    const itemRev = parseFloat(row.item_revenue);
    const grossRev = parseFloat(row.gross_revenue);

    console.log(`  ${dt} | ${String(orders).padStart(6)} | ${String(units).padStart(5)} | ${itemRev.toFixed(2).padStart(14)} | ${grossRev.toFixed(2).padStart(16)}`);
    ordTotUnits += units;
    ordTotOrders += orders;
    ordTotRevenue += itemRev;
  }

  console.log('  -----------|--------|-------|----------------|------------------');
  console.log(`  TOTALE     | ${String(ordTotOrders).padStart(6)} | ${String(ordTotUnits).padStart(5)} | ${ordTotRevenue.toFixed(2).padStart(14)} |`);

  // --- 4. Summary comparison ---
  console.log(`\n--- 4. RIEPILOGO CONFRONTO ---\n`);
  console.log(`  BR units_ordered:       ${totUnits}`);
  console.log(`  BR ordered_product_sales: €${totSales.toFixed(2)}`);
  console.log(`  BR sessions:            ${totSessions}`);
  console.log(`  BR page_views:          ${totPageViews}`);
  console.log(`  ---`);
  console.log(`  Orders API units:       ${ordTotUnits}`);
  console.log(`  Orders API item_price:  €${ordTotRevenue.toFixed(2)}`);
  console.log(`  Delta unità (BR - API): ${totUnits - ordTotUnits}`);
  console.log(`  Delta vendite (BR - API): €${(totSales - ordTotRevenue).toFixed(2)}`);
  console.log();

  await db.shutdown();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
