#!/usr/bin/env node
/**
 * Sales by date: query orders_raw for any specific date.
 *
 * Usage:
 *   node scripts/sales-by-date.js                    # defaults to yesterday
 *   node scripts/sales-by-date.js 2026-02-27         # specific date
 *   node scripts/sales-by-date.js 2026-02-27 --asin  # include ASIN breakdown
 */
require('dotenv').config();
const db = require('../src/database/pool');

const args = process.argv.slice(2);
const showAsin = args.includes('--asin');
const dateArg = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a));

// Default to yesterday if no date provided
const targetDate = dateArg || new Date(Date.now() - 86400000).toISOString().slice(0, 10);

(async () => {
  try {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`  VENDITE DEL ${targetDate}`);
    console.log(`${'='.repeat(60)}\n`);

    // Per-marketplace breakdown (timezone-aware)
    const byMarketplace = await db.query(
      `SELECT
        m.country_code,
        m.name AS marketplace_name,
        COUNT(DISTINCT o.amazon_order_id) AS orders_count,
        SUM(o.quantity) AS units_sold,
        SUM(o.item_price + o.item_tax + o.shipping_price + o.shipping_tax - o.promotion_discount) AS gross_revenue,
        o.currency
      FROM orders_raw o
      JOIN marketplaces m ON m.id = o.marketplace_id
      WHERE o.account_id = 1
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
            WHEN 'US' THEN 'America/Los_Angeles'
            WHEN 'CA' THEN 'America/Toronto'
            ELSE 'UTC'
          END, 'UTC'))::date = $1::date
        AND UPPER(o.order_status) NOT IN ('CANCELLED', 'CANCELED')
      GROUP BY m.country_code, m.name, o.currency
      ORDER BY gross_revenue DESC`,
      [targetDate]
    );

    // Totals
    let totalOrders = 0, totalUnits = 0, totalRevenue = 0;
    for (const row of byMarketplace.rows) {
      totalOrders += parseInt(row.orders_count, 10);
      totalUnits += parseInt(row.units_sold, 10);
      totalRevenue += parseFloat(row.gross_revenue || 0);
    }

    console.log(`  Ordini totali:  ${totalOrders}`);
    console.log(`  Unità vendute:  ${totalUnits}`);
    console.log(`  Ricavo lordo:   €${totalRevenue.toFixed(2)}`);

    if (byMarketplace.rows.length > 0) {
      console.log(`\n  Per marketplace:`);
      console.log(`  ${'—'.repeat(55)}`);
      for (const mp of byMarketplace.rows) {
        const rev = parseFloat(mp.gross_revenue || 0).toFixed(2);
        console.log(`  ${mp.country_code.padEnd(5)} | ${String(mp.units_sold).padStart(5)} unità | ${String(mp.orders_count).padStart(5)} ordini | ${mp.currency} ${rev}`);
      }
    } else {
      console.log(`\n  Nessun ordine trovato per questa data.`);
    }

    // ASIN breakdown
    if (showAsin) {
      const byAsin = await db.query(
        `SELECT
          o.asin,
          a.title AS asin_title,
          a.sku,
          m.country_code,
          COUNT(DISTINCT o.amazon_order_id) AS orders_count,
          SUM(o.quantity) AS units_sold,
          SUM(o.item_price + o.item_tax + o.shipping_price + o.shipping_tax - o.promotion_discount) AS gross_revenue,
          o.currency
        FROM orders_raw o
        JOIN marketplaces m ON m.id = o.marketplace_id
        LEFT JOIN asins a ON a.account_id = o.account_id AND a.asin = o.asin
        WHERE o.account_id = 1
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
              WHEN 'US' THEN 'America/Los_Angeles'
              WHEN 'CA' THEN 'America/Toronto'
              ELSE 'UTC'
            END, 'UTC'))::date = $1::date
          AND UPPER(o.order_status) NOT IN ('CANCELLED', 'CANCELED')
        GROUP BY o.asin, a.title, a.sku, m.country_code, o.currency
        ORDER BY units_sold DESC
        LIMIT 30`,
        [targetDate]
      );

      if (byAsin.rows.length > 0) {
        console.log(`\n  Top ASIN:`);
        console.log(`  ${'—'.repeat(55)}`);
        for (const item of byAsin.rows) {
          const title = (item.asin_title || '—').substring(0, 30);
          const rev = parseFloat(item.gross_revenue || 0).toFixed(2);
          console.log(`  ${item.asin} [${item.country_code}] | ${String(item.units_sold).padStart(3)} pz | ${item.currency} ${rev.padStart(8)} | ${title}`);
        }
      }
    } else {
      console.log(`\n  (aggiungi --asin per il dettaglio per prodotto)`);
    }

    console.log(`\n`);
    await db.shutdown();
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
})();
