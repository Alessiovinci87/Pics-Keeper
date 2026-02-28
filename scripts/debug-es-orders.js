#!/usr/bin/env node
/**
 * Debug: analyze ES orders for a specific ASIN+date to understand
 * discrepancy with ShopKeeper. Shows purchase_date in both UTC and
 * Madrid time, plus order status details.
 *
 * Usage:
 *   node scripts/debug-es-orders.js B0BY9Q4KTT 2026-02-27
 */
require('dotenv').config();
const db = require('../src/database/pool');

const asin = process.argv[2];
const targetDate = process.argv[3] || new Date(Date.now() - 86400000).toISOString().slice(0, 10);

if (!asin) {
  console.error('Usage: node scripts/debug-es-orders.js <ASIN> [YYYY-MM-DD]');
  process.exit(1);
}

(async () => {
  try {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`  DEBUG ES ORDERS — ASIN: ${asin} — Data: ${targetDate}`);
    console.log(`${'='.repeat(80)}`);

    // All ES orders for this ASIN around the target date (wider window: ±1 day)
    const orders = await db.query(
      `SELECT
        o.amazon_order_id,
        o.purchase_date,
        o.purchase_date::text AS utc_timestamp,
        (o.purchase_date AT TIME ZONE 'Europe/Madrid')::text AS madrid_timestamp,
        (o.purchase_date)::date AS utc_date,
        (o.purchase_date AT TIME ZONE 'Europe/Madrid')::date AS madrid_date,
        o.order_status,
        o.quantity,
        o.item_price,
        o.item_tax,
        o.item_price + o.item_tax + o.shipping_price + o.shipping_tax - o.promotion_discount AS net_line,
        o.synced_at
      FROM orders_raw o
      JOIN marketplaces m ON m.id = o.marketplace_id
      WHERE o.account_id = 1
        AND o.asin = $1
        AND m.country_code = 'ES'
        AND o.purchase_date >= ($2::date - interval '1 day')
        AND o.purchase_date < ($2::date + interval '2 days')
      ORDER BY o.purchase_date`,
      [asin, targetDate]
    );

    console.log(`\n  Ordini ES trovati (finestra ±1 giorno): ${orders.rows.length}`);
    console.log(`  ${'—'.repeat(75)}`);
    console.log(`  # | Order ID               | UTC Timestamp           | Madrid Timestamp        | UTC Date   | Madrid Date | Status     | Qty | Net`);
    console.log(`  ${'—'.repeat(75)}`);

    let inTarget = 0;
    let inTargetMadrid = 0;
    for (let i = 0; i < orders.rows.length; i++) {
      const r = orders.rows[i];
      const utcDate = r.utc_date.toISOString().slice(0, 10);
      const madridDate = r.madrid_date.toISOString().slice(0, 10);
      const isTargetUTC = utcDate === targetDate;
      const isTargetMadrid = madridDate === targetDate;
      const marker = isTargetMadrid ? (isTargetUTC ? '  ' : '>>') : (isTargetUTC ? '<<' : '  ');

      if (isTargetUTC) inTarget++;
      if (isTargetMadrid) inTargetMadrid++;

      const net = parseFloat(r.net_line || 0).toFixed(2).padStart(8);
      console.log(`  ${marker} ${String(i + 1).padStart(2)} | ${r.amazon_order_id.padEnd(22)} | ${r.utc_timestamp.substring(0, 23).padEnd(23)} | ${r.madrid_timestamp.substring(0, 23).padEnd(23)} | ${utcDate} | ${madridDate}  | ${r.order_status.padEnd(10)} | ${String(r.quantity).padStart(3)} | €${net}`);
    }

    console.log(`  ${'—'.repeat(75)}`);
    console.log(`  >> = nel 27 Feb Madrid ma NON in UTC (ShopKeeper li conta, noi potremmo mancarli nel sync)`);
    console.log(`  << = nel 27 Feb UTC ma NON in Madrid (noi li contiamo, ShopKeeper no)`);
    console.log(`\n  CONTEGGIO:`);
    console.log(`    UTC ${targetDate}:    ${inTarget} ordini`);
    console.log(`    Madrid ${targetDate}: ${inTargetMadrid} ordini`);
    console.log(`    ShopKeeper:         9 ordini (riferimento)`);

    // Count by status for Madrid date
    const byStatus = {};
    let madridUnits = 0;
    for (const r of orders.rows) {
      const madridDate = r.madrid_date.toISOString().slice(0, 10);
      if (madridDate !== targetDate) continue;
      const status = r.order_status.toUpperCase();
      if (!byStatus[status]) byStatus[status] = { orders: 0, units: 0 };
      byStatus[status].orders++;
      byStatus[status].units += parseInt(r.quantity);
      madridUnits += parseInt(r.quantity);
    }

    console.log(`\n  MADRID ${targetDate} per status:`);
    for (const [status, s] of Object.entries(byStatus)) {
      console.log(`    ${status}: ${s.orders} ordini, ${s.units} unità`);
    }
    console.log(`    TOTALE: ${madridUnits} unità`);

    // Check: shipped-only count (ShopKeeper might only count shipped)
    let shippedUnits = 0;
    let shippedOrders = 0;
    for (const r of orders.rows) {
      const madridDate = r.madrid_date.toISOString().slice(0, 10);
      if (madridDate !== targetDate) continue;
      if (r.order_status.toUpperCase() === 'SHIPPED') {
        shippedOrders++;
        shippedUnits += parseInt(r.quantity);
      }
    }
    console.log(`\n  SHIPPED-ONLY (Madrid ${targetDate}): ${shippedOrders} ordini, ${shippedUnits} unità`);

    // Check: orders count (unique order IDs, not item lines)
    const uniqueOrders = new Set();
    for (const r of orders.rows) {
      const madridDate = r.madrid_date.toISOString().slice(0, 10);
      if (madridDate !== targetDate) continue;
      uniqueOrders.add(r.amazon_order_id);
    }
    console.log(`  ORDINI UNICI (Madrid ${targetDate}): ${uniqueOrders.size}`);
    console.log(`\n  IPOTESI: ShopKeeper conta ${9} → potrebbe contare ORDINI unici (non unità)?`);

    console.log('');
    await db.shutdown();
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
})();
