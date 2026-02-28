#!/usr/bin/env node
/**
 * Diagnostic script: why are today's orders showing 0?
 * Run: node scripts/debug-today.js
 */
require('dotenv').config();
const db = require('../src/database/pool');

(async () => {
  try {
    // 1) DB time
    const timeRes = await db.query(`SELECT NOW() AS db_now, CURRENT_DATE AS db_today, current_setting('TIMEZONE') AS db_tz`);
    const { db_now, db_today, db_tz } = timeRes.rows[0];
    console.log(`\n--- DB TIME ---`);
    console.log(`  NOW():        ${db_now}`);
    console.log(`  CURRENT_DATE: ${db_today}`);
    console.log(`  Timezone:     ${db_tz}`);

    // 2) Total rows in orders_raw
    const totalRes = await db.query(`SELECT COUNT(*) AS total FROM orders_raw`);
    console.log(`\n--- ORDERS_RAW ---`);
    console.log(`  Total rows: ${totalRes.rows[0].total}`);

    // 3) Latest orders
    const latestRes = await db.query(`
      SELECT purchase_date, amazon_order_id, asin, order_status, marketplace_id, quantity
      FROM orders_raw
      ORDER BY purchase_date DESC
      LIMIT 5
    `);
    console.log(`\n--- 5 MOST RECENT ORDERS ---`);
    for (const r of latestRes.rows) {
      console.log(`  ${r.purchase_date} | ${r.amazon_order_id} | ${r.asin} | status=${r.order_status} | mkt=${r.marketplace_id} | qty=${r.quantity}`);
    }

    // 4) Date range
    const rangeRes = await db.query(`SELECT MIN(purchase_date) AS oldest, MAX(purchase_date) AS newest FROM orders_raw`);
    console.log(`\n--- DATE RANGE ---`);
    console.log(`  Oldest: ${rangeRes.rows[0].oldest}`);
    console.log(`  Newest: ${rangeRes.rows[0].newest}`);

    // 5) Orders "today" with different methods
    console.log(`\n--- ORDERS MATCHING "TODAY" ---`);

    // Method A: raw UTC date comparison
    const utcToday = await db.query(`
      SELECT COUNT(*) AS cnt FROM orders_raw
      WHERE purchase_date::date = CURRENT_DATE
    `);
    console.log(`  A) purchase_date::date = CURRENT_DATE (UTC):  ${utcToday.rows[0].cnt}`);

    // Method B: timezone-aware (Europe/Rome)
    const romeToday = await db.query(`
      SELECT COUNT(*) AS cnt FROM orders_raw
      WHERE (purchase_date AT TIME ZONE 'Europe/Rome')::date = CURRENT_DATE
    `);
    console.log(`  B) AT TIME ZONE 'Europe/Rome' = CURRENT_DATE: ${romeToday.rows[0].cnt}`);

    // Method C: last 24 hours
    const last24 = await db.query(`
      SELECT COUNT(*) AS cnt FROM orders_raw
      WHERE purchase_date >= NOW() - INTERVAL '24 hours'
    `);
    console.log(`  C) Last 24 hours:                              ${last24.rows[0].cnt}`);

    // Method D: last 48 hours
    const last48 = await db.query(`
      SELECT COUNT(*) AS cnt FROM orders_raw
      WHERE purchase_date >= NOW() - INTERVAL '48 hours'
    `);
    console.log(`  D) Last 48 hours:                              ${last48.rows[0].cnt}`);

    // 6) Check for cancelled filter issue
    const statusBreakdown = await db.query(`
      SELECT UPPER(order_status) AS status, COUNT(*) AS cnt
      FROM orders_raw
      WHERE purchase_date >= NOW() - INTERVAL '48 hours'
      GROUP BY UPPER(order_status)
      ORDER BY cnt DESC
    `);
    console.log(`\n--- ORDER STATUS (last 48h) ---`);
    if (statusBreakdown.rows.length === 0) {
      console.log(`  No orders in the last 48 hours at all!`);
    }
    for (const r of statusBreakdown.rows) {
      console.log(`  ${r.status}: ${r.cnt}`);
    }

    // 7) Check sync targets
    const targetsRes = await db.query(`
      SELECT st.id, st.account_id, st.marketplace_id, m.country_code, st.sync_enabled
      FROM sync_targets st
      JOIN marketplaces m ON m.id = st.marketplace_id
      ORDER BY st.account_id, m.country_code
    `);
    console.log(`\n--- SYNC TARGETS ---`);
    for (const t of targetsRes.rows) {
      console.log(`  account=${t.account_id} | ${t.country_code} | enabled=${t.sync_enabled}`);
    }

    // 8) Check marketplaces
    const mktRes = await db.query(`SELECT id, country_code, name FROM marketplaces ORDER BY id`);
    console.log(`\n--- MARKETPLACES ---`);
    for (const m of mktRes.rows) {
      console.log(`  id=${m.id} | ${m.country_code} | ${m.name}`);
    }

    console.log(`\n--- DONE ---\n`);
    await db.shutdown();
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
})();
