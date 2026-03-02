#!/usr/bin/env node
/**
 * Quick verification: fees per marketplace for Feb 1-20
 * (dates where financial events should exist)
 */
require('dotenv').config();
const { pool, shutdown } = require('../src/database/pool');

async function run() {
  const client = await pool.connect();
  try {
    // Check fees by marketplace for Feb 1-20 (where events exist)
    const result = await client.query(`
      SELECT
        mp.country_code,
        op.marketplace_id,
        COUNT(*) AS orders,
        SUM(op.revenue) AS revenue,
        SUM(op.referral_fee + op.fba_fee + op.other_amazon_fees + op.marketplace_facilitator_tax) AS total_fees,
        CASE WHEN SUM(op.revenue) > 0
          THEN ROUND(SUM(op.referral_fee + op.fba_fee + op.other_amazon_fees + op.marketplace_facilitator_tax) / SUM(op.revenue) * 100, 1)
          ELSE 0 END AS fee_pct
      FROM order_profit op
      JOIN marketplaces mp ON mp.id = op.marketplace_id
      WHERE op.order_date >= '2026-02-01' AND op.order_date <= '2026-02-20'
      GROUP BY mp.country_code, op.marketplace_id
      ORDER BY SUM(op.revenue) DESC
    `);

    console.log('\n  === FEES BY MARKETPLACE (Feb 1-20) ===');
    console.log('  Country | Orders | Revenue   | Fees      | Fee %');
    console.log('  --------|--------|-----------|-----------|------');
    for (const r of result.rows) {
      const country = r.country_code.padEnd(7);
      const orders = String(r.orders).padStart(6);
      const rev = Number(r.revenue).toFixed(2).padStart(9);
      const fees = Number(r.total_fees).toFixed(2).padStart(9);
      const pct = Number(r.fee_pct).toFixed(1).padStart(5);
      console.log(`  ${country} | ${orders} | ${rev} | ${fees} | ${pct}%`);
    }

    // Also check Feb 21-28 to confirm those are still 0 (expected)
    const late = await client.query(`
      SELECT
        mp.country_code,
        COUNT(*) AS orders,
        SUM(op.referral_fee + op.fba_fee + op.other_amazon_fees + op.marketplace_facilitator_tax) AS total_fees
      FROM order_profit op
      JOIN marketplaces mp ON mp.id = op.marketplace_id
      WHERE op.order_date >= '2026-02-21' AND op.order_date <= '2026-02-28'
      GROUP BY mp.country_code
      ORDER BY COUNT(*) DESC
    `);

    console.log('\n  === LATE FEB (Feb 21-28) - Expected: fees ~ 0 (no events yet) ===');
    for (const r of late.rows) {
      console.log(`  ${r.country_code}: ${r.orders} orders, fees=${Number(r.total_fees).toFixed(2)}`);
    }

    console.log('');
  } finally {
    client.release();
    await shutdown();
  }
}

run().catch(err => { console.error('ERRORE:', err.message); process.exit(1); });
