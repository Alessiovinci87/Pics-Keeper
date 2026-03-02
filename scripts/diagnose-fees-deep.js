#!/usr/bin/env node
/**
 * Deep diagnosis: why are fees=0 for many orders?
 * Checks:
 *  1. Financial events distribution by event_date
 *  2. Sample order from early Feb (should have events but doesn't)
 *  3. ASIN mismatch between financial_events_raw and orders_raw
 *  4. Marketplace_id mismatch
 */
require('dotenv').config();
const { pool, shutdown } = require('../src/database/pool');

async function run() {
  const client = await pool.connect();
  try {
    const mpId = 2; // FR

    // 1. Financial events date distribution (all marketplaces)
    console.log('\n=== 1. FINANCIAL EVENTS - DATE DISTRIBUTION (all marketplaces) ===');
    const dist = await client.query(`
      SELECT DATE_TRUNC('week', event_date)::date AS week,
        COUNT(*) AS rows,
        COUNT(DISTINCT amazon_order_id) AS orders
      FROM financial_events_raw
      WHERE account_id = 1 AND event_date >= '2026-01-01' AND event_date < '2026-03-03'
      GROUP BY DATE_TRUNC('week', event_date)::date
      ORDER BY week
    `);
    for (const r of dist.rows) {
      console.log(`  ${r.week.toISOString().slice(0,10)}: ${r.rows} rows, ${r.orders} orders`);
    }

    // 2. Financial events for FR vs other marketplaces
    console.log('\n=== 2. FINANCIAL EVENTS BY MARKETPLACE (Jan-Mar) ===');
    const byMp = await client.query(`
      SELECT fe.marketplace_id, m.country_code,
        COUNT(*) AS rows,
        COUNT(DISTINCT fe.amazon_order_id) AS orders
      FROM financial_events_raw fe
      LEFT JOIN marketplaces m ON m.id = fe.marketplace_id
      WHERE fe.account_id = 1
        AND fe.event_date >= '2026-01-01' AND fe.event_date < '2026-03-03'
      GROUP BY fe.marketplace_id, m.country_code
      ORDER BY rows DESC
    `);
    for (const r of byMp.rows) {
      console.log(`  mp=${r.marketplace_id} (${r.country_code}): ${r.rows} rows, ${r.orders} orders`);
    }

    // 3. Sample order from early Feb (should have fees but doesn't)
    console.log('\n=== 3. SAMPLE ORDERS FROM EARLY FEB WITH fees=0 ===');
    const earlyOrders = await client.query(`
      SELECT op.amazon_order_id, op.asin, op.order_date, op.revenue, op.referral_fee
      FROM order_profit op
      WHERE op.marketplace_id = $1
        AND op.order_date >= '2026-02-01' AND op.order_date <= '2026-02-05'
        AND op.referral_fee = 0 AND op.revenue > 0
      LIMIT 3
    `, [mpId]);

    for (const o of earlyOrders.rows) {
      console.log(`\n  Order: ${o.amazon_order_id} (ASIN: ${o.asin}, date: ${o.order_date}, rev: ${o.revenue})`);

      // Check financial events WITHOUT marketplace filter
      const feAll = await client.query(`
        SELECT marketplace_id, asin, event_type, fee_type, amount, event_date
        FROM financial_events_raw
        WHERE amazon_order_id = $1
        ORDER BY event_date
      `, [o.amazon_order_id]);

      if (feAll.rows.length === 0) {
        console.log('    -> NO financial events at all (any marketplace)');
      } else {
        console.log(`    -> ${feAll.rows.length} financial events found:`);
        const mpIds = [...new Set(feAll.rows.map(r => r.marketplace_id))];
        const asins = [...new Set(feAll.rows.map(r => r.asin))];
        console.log(`       marketplace_ids: ${mpIds.join(', ')}`);
        console.log(`       ASINs in events: ${asins.join(', ')}`);
        console.log(`       ASIN in orders_raw: ${o.asin}`);
        const fees = feAll.rows.filter(r => r.amount < 0 && r.event_type === 'ShipmentEvent');
        console.log(`       Fee rows (amount<0, ShipmentEvent): ${fees.length}`);
        if (fees.length > 0) {
          console.log(`       Sample fee: ${fees[0].fee_type} = ${fees[0].amount} (mp=${fees[0].marketplace_id}, asin=${fees[0].asin})`);
        }
      }
    }

    // 4. ASIN mismatch analysis: financial events where ASIN != orders_raw ASIN
    console.log('\n=== 4. ASIN MISMATCH: financial_events_raw vs orders_raw ===');
    const mismatch = await client.query(`
      SELECT COUNT(*) AS total_events,
        COUNT(CASE WHEN fe.asin != o.asin THEN 1 END) AS asin_mismatch,
        COUNT(CASE WHEN fe.asin = o.asin THEN 1 END) AS asin_match,
        COUNT(CASE WHEN fe.asin IS NULL THEN 1 END) AS asin_null_in_fe,
        COUNT(CASE WHEN o.asin IS NULL THEN 1 END) AS order_not_found
      FROM financial_events_raw fe
      LEFT JOIN orders_raw o ON o.amazon_order_id = fe.amazon_order_id
        AND o.account_id = fe.account_id
        AND o.asin = fe.asin
      WHERE fe.account_id = 1 AND fe.marketplace_id = $1
        AND fe.event_type = 'ShipmentEvent' AND fe.amount < 0
        AND fe.event_date >= '2026-01-01' AND fe.event_date < '2026-03-03'
    `, [mpId]);
    console.log(' ', JSON.stringify(mismatch.rows[0], null, 2));

    // 4b. Check how many FR fee events have ASIN that looks like SKU vs ASIN
    const asinFormat = await client.query(`
      SELECT
        COUNT(*) AS total,
        COUNT(CASE WHEN fe.asin ~ '^B[A-Z0-9]{9}$' THEN 1 END) AS looks_like_asin,
        COUNT(CASE WHEN fe.asin !~ '^B[A-Z0-9]{9}$' THEN 1 END) AS looks_like_sku,
        COUNT(CASE WHEN fe.asin IS NULL THEN 1 END) AS asin_null
      FROM financial_events_raw fe
      WHERE fe.account_id = 1 AND fe.marketplace_id = $1
        AND fe.event_type = 'ShipmentEvent' AND fe.amount < 0
        AND fe.event_date >= '2026-01-01' AND fe.event_date < '2026-03-03'
    `, [mpId]);
    console.log('\n=== 4b. ASIN FORMAT in financial events (FR, fees) ===');
    console.log(' ', JSON.stringify(asinFormat.rows[0], null, 2));

    // 4c. Show some sample SKU-format ASINs
    const skuSamples = await client.query(`
      SELECT DISTINCT fe.asin, fe.amazon_order_id
      FROM financial_events_raw fe
      WHERE fe.account_id = 1 AND fe.marketplace_id = $1
        AND fe.event_type = 'ShipmentEvent' AND fe.amount < 0
        AND fe.asin !~ '^B[A-Z0-9]{9}$'
        AND fe.asin IS NOT NULL
      LIMIT 5
    `, [mpId]);
    if (skuSamples.rows.length > 0) {
      console.log('\n=== 4c. SAMPLE SKU-format ASINs in financial events ===');
      for (const r of skuSamples.rows) {
        console.log(`  order=${r.amazon_order_id}, stored_asin=${r.asin}`);
      }
    }

    // 5. Check: orders from early Feb - do they have events under a DIFFERENT marketplace?
    console.log('\n=== 5. EARLY FEB FR ORDERS - EVENTS UNDER ANY MARKETPLACE ===');
    const earlyFebCheck = await client.query(`
      SELECT
        COUNT(DISTINCT op.amazon_order_id) AS total_orders,
        COUNT(DISTINCT CASE WHEN fe.id IS NOT NULL THEN op.amazon_order_id END) AS orders_with_events,
        COUNT(DISTINCT CASE WHEN fe.id IS NOT NULL AND fe.marketplace_id = $1 THEN op.amazon_order_id END) AS events_correct_mp,
        COUNT(DISTINCT CASE WHEN fe.id IS NOT NULL AND fe.marketplace_id != $1 THEN op.amazon_order_id END) AS events_wrong_mp
      FROM order_profit op
      LEFT JOIN financial_events_raw fe ON fe.amazon_order_id = op.amazon_order_id
        AND fe.account_id = op.account_id
        AND fe.event_type = 'ShipmentEvent' AND fe.amount < 0
      WHERE op.marketplace_id = $1
        AND op.order_date >= '2026-02-01' AND op.order_date <= '2026-02-09'
    `, [mpId]);
    console.log(' ', JSON.stringify(earlyFebCheck.rows[0], null, 2));

    // 6. Same check for late Feb
    console.log('\n=== 6. LATE FEB FR ORDERS (19-28) - EVENTS UNDER ANY MARKETPLACE ===');
    const lateFebCheck = await client.query(`
      SELECT
        COUNT(DISTINCT op.amazon_order_id) AS total_orders,
        COUNT(DISTINCT CASE WHEN fe.id IS NOT NULL THEN op.amazon_order_id END) AS orders_with_events,
        COUNT(DISTINCT CASE WHEN fe.id IS NOT NULL AND fe.marketplace_id = $1 THEN op.amazon_order_id END) AS events_correct_mp,
        COUNT(DISTINCT CASE WHEN fe.id IS NOT NULL AND fe.marketplace_id != $1 THEN op.amazon_order_id END) AS events_wrong_mp
      FROM order_profit op
      LEFT JOIN financial_events_raw fe ON fe.amazon_order_id = op.amazon_order_id
        AND fe.account_id = op.account_id
        AND fe.event_type = 'ShipmentEvent' AND fe.amount < 0
      WHERE op.marketplace_id = $1
        AND op.order_date >= '2026-02-19' AND op.order_date <= '2026-02-28'
    `, [mpId]);
    console.log(' ', JSON.stringify(lateFebCheck.rows[0], null, 2));

    // 7. How the buildFeeMap would see things
    console.log('\n=== 7. buildFeeMap SIMULATION (FR, feeFrom=Jan 2, feeTo=Mar 31) ===');
    const feeMapSim = await client.query(`
      SELECT COUNT(DISTINCT amazon_order_id) AS orders_in_feemap,
        COUNT(*) AS total_fee_rows
      FROM financial_events_raw
      WHERE account_id = 1 AND marketplace_id = $1
        AND event_date >= '2026-01-02' AND event_date < '2026-03-31'
        AND event_type = 'ShipmentEvent'
        AND amount < 0
    `, [mpId]);
    console.log(' ', JSON.stringify(feeMapSim.rows[0], null, 2));

    // 7b. How many of those orders match orders in order_profit for Feb?
    const matchSim = await client.query(`
      SELECT COUNT(DISTINCT op.amazon_order_id) AS feb_orders_with_fees_in_map
      FROM order_profit op
      INNER JOIN financial_events_raw fe ON fe.amazon_order_id = op.amazon_order_id
        AND fe.account_id = op.account_id AND fe.marketplace_id = op.marketplace_id
      WHERE op.marketplace_id = $1 AND op.order_date >= '2026-02-01' AND op.order_date < '2026-03-01'
        AND fe.event_type = 'ShipmentEvent' AND fe.amount < 0
        AND fe.event_date >= '2026-01-02' AND fe.event_date < '2026-03-31'
    `, [mpId]);
    console.log('  Feb orders that WOULD match feeMap (by order_id + same mp):', matchSim.rows[0]);

    // 7c. Same but matching also by ASIN
    const matchAsin = await client.query(`
      SELECT COUNT(DISTINCT op.amazon_order_id || ':' || op.asin) AS feb_order_asin_match
      FROM order_profit op
      INNER JOIN financial_events_raw fe ON fe.amazon_order_id = op.amazon_order_id
        AND fe.asin = op.asin
        AND fe.account_id = op.account_id AND fe.marketplace_id = op.marketplace_id
      WHERE op.marketplace_id = $1 AND op.order_date >= '2026-02-01' AND op.order_date < '2026-03-01'
        AND fe.event_type = 'ShipmentEvent' AND fe.amount < 0
        AND fe.event_date >= '2026-01-02' AND fe.event_date < '2026-03-31'
    `, [mpId]);
    console.log('  Feb orders that match by order_id + ASIN + mp:', matchAsin.rows[0]);

    console.log('');
  } finally {
    client.release();
    await shutdown();
  }
}

run().catch(err => { console.error('ERRORE:', err.message); process.exit(1); });
