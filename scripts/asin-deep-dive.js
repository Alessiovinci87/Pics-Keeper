#!/usr/bin/env node
/**
 * Deep dive: analyze a single ASIN across all marketplaces for a specific date.
 *
 * Usage:
 *   node scripts/asin-deep-dive.js B0BY9Q4KTT 2026-02-27
 */
require('dotenv').config();
const db = require('../src/database/pool');

const asin = process.argv[2];
const targetDate = process.argv[3] || new Date(Date.now() - 86400000).toISOString().slice(0, 10);

if (!asin) {
  console.error('Usage: node scripts/asin-deep-dive.js <ASIN> [YYYY-MM-DD]');
  process.exit(1);
}

(async () => {
  try {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`  ASIN: ${asin} — Data: ${targetDate}`);
    console.log(`${'='.repeat(70)}`);

    // 1) Every single order row for this ASIN on this date
    const orders = await db.query(
      `SELECT
        o.amazon_order_id,
        o.purchase_date,
        (o.purchase_date AT TIME ZONE COALESCE(
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
            ELSE 'UTC'
          END, 'UTC'))::date AS local_date,
        o.order_status,
        o.quantity,
        o.item_price,
        o.item_tax,
        o.shipping_price,
        o.shipping_tax,
        o.promotion_discount,
        o.item_price + o.item_tax + o.shipping_price + o.shipping_tax - o.promotion_discount AS net_line,
        o.currency,
        m.country_code
      FROM orders_raw o
      JOIN marketplaces m ON m.id = o.marketplace_id
      WHERE o.account_id = 1
        AND o.asin = $1
        AND (o.purchase_date AT TIME ZONE COALESCE(
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
            ELSE 'UTC'
          END, 'UTC'))::date = $2::date
      ORDER BY m.country_code, o.purchase_date`,
      [asin, targetDate]
    );

    if (orders.rows.length === 0) {
      console.log(`\n  Nessun ordine trovato per ${asin} in data ${targetDate}\n`);
      await db.shutdown();
      return;
    }

    // 2) Print every single order line
    console.log(`\n  DETTAGLIO ORDINI (${orders.rows.length} righe):`);
    console.log(`  ${'—'.repeat(65)}`);
    console.log(`  ${'Paese'.padEnd(5)} | ${'Order ID'.padEnd(22)} | ${'Status'.padEnd(10)} | Qty | Price    | Tax      | Ship     | Promo    | Net`);
    console.log(`  ${'—'.repeat(65)}`);

    for (const r of orders.rows) {
      const price = parseFloat(r.item_price || 0).toFixed(2).padStart(8);
      const tax = parseFloat(r.item_tax || 0).toFixed(2).padStart(8);
      const ship = parseFloat(r.shipping_price || 0).toFixed(2).padStart(8);
      const promo = parseFloat(r.promotion_discount || 0).toFixed(2).padStart(8);
      const net = parseFloat(r.net_line || 0).toFixed(2).padStart(8);
      console.log(`  ${r.country_code.padEnd(5)} | ${r.amazon_order_id.padEnd(22)} | ${r.order_status.padEnd(10)} | ${String(r.quantity).padStart(3)} | ${price} | ${tax} | ${ship} | ${promo} | ${net}`);
    }

    // 3) Summary per country
    console.log(`\n  RIEPILOGO PER PAESE:`);
    console.log(`  ${'—'.repeat(65)}`);

    const summary = {};
    for (const r of orders.rows) {
      const cc = r.country_code;
      if (!summary[cc]) summary[cc] = { orders: new Set(), units: 0, revenue: 0, pending: 0, shipped: 0, cancelled: 0 };
      summary[cc].orders.add(r.amazon_order_id);
      summary[cc].units += parseInt(r.quantity, 10);
      summary[cc].revenue += parseFloat(r.net_line || 0);
      const status = r.order_status.toUpperCase();
      if (status === 'PENDING') summary[cc].pending += parseInt(r.quantity, 10);
      else if (status === 'SHIPPED' || status === 'UNSHIPPED') summary[cc].shipped += parseInt(r.quantity, 10);
      else if (status === 'CANCELLED' || status === 'CANCELED') summary[cc].cancelled += parseInt(r.quantity, 10);
    }

    let grandUnits = 0, grandRevenue = 0, grandOrders = 0;
    for (const [cc, s] of Object.entries(summary)) {
      const rev = s.revenue.toFixed(2);
      console.log(`  ${cc.padEnd(5)} | ${String(s.orders.size).padStart(3)} ordini | ${String(s.units).padStart(3)} unità (${s.shipped} shipped, ${s.pending} pending, ${s.cancelled} cancelled) | €${rev}`);
      grandUnits += s.units;
      grandRevenue += s.revenue;
      grandOrders += s.orders.size;
    }
    console.log(`  ${'—'.repeat(65)}`);
    console.log(`  TOTALE | ${String(grandOrders).padStart(3)} ordini | ${String(grandUnits).padStart(3)} unità | €${grandRevenue.toFixed(2)}`);

    // 4) Also check: are there CANCELLED orders excluded from main query?
    const cancelledCheck = await db.query(
      `SELECT COUNT(*) AS cnt, SUM(o.quantity) AS units
      FROM orders_raw o
      JOIN marketplaces m ON m.id = o.marketplace_id
      WHERE o.account_id = 1
        AND o.asin = $1
        AND (o.purchase_date AT TIME ZONE COALESCE(
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
            ELSE 'UTC'
          END, 'UTC'))::date = $2::date
        AND UPPER(o.order_status) IN ('CANCELLED', 'CANCELED')`,
      [asin, targetDate]
    );
    const canc = cancelledCheck.rows[0];
    if (parseInt(canc.cnt) > 0) {
      console.log(`\n  NOTA: ${canc.cnt} ordini cancellati (${canc.units} unità) — esclusi dal totale vendite`);
    }

    // 5) Check: same ASIN without timezone filter (raw UTC date)
    const utcCheck = await db.query(
      `SELECT
        m.country_code,
        COUNT(DISTINCT o.amazon_order_id) AS orders,
        SUM(o.quantity) AS units
      FROM orders_raw o
      JOIN marketplaces m ON m.id = o.marketplace_id
      WHERE o.account_id = 1
        AND o.asin = $1
        AND o.purchase_date::date = $2::date
      GROUP BY m.country_code
      ORDER BY m.country_code`,
      [asin, targetDate]
    );
    console.log(`\n  CONFRONTO UTC (senza conversione timezone):`);
    for (const r of utcCheck.rows) {
      console.log(`  ${r.country_code.padEnd(5)} | ${r.orders} ordini | ${r.units} unità`);
    }

    // 6) Check if ASIN info exists
    const asinInfo = await db.query(
      `SELECT asin, title, sku FROM asins WHERE account_id = 1 AND asin = $1`,
      [asin]
    );
    if (asinInfo.rows.length > 0) {
      const a = asinInfo.rows[0];
      console.log(`\n  INFO ASIN: ${a.title || '—'} (SKU: ${a.sku || '—'})`);
    }

    console.log(`\n`);
    await db.shutdown();
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
})();
