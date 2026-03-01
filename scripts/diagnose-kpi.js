#!/usr/bin/env node
/**
 * Diagnose KPI fees=0 bug by comparing data across all 3 layers:
 *   order_profit → asin_daily_metrics → account_daily_kpi
 */
require('dotenv').config();
const { pool, shutdown } = require('../src/database/pool');

async function run() {
  const client = await pool.connect();
  try {
    const testDate = '2026-02-28';
    const mpId = 2; // FR
    console.log(`\n  DIAGNOSI: data=${testDate}, marketplace=FR (id=${mpId})\n`);

    // Layer 1: order_profit
    const op = await client.query(`
      SELECT
        COUNT(*) AS righe,
        SUM(quantity) AS units,
        SUM(revenue) AS revenue,
        SUM(referral_fee) AS ref_fee,
        SUM(fba_fee) AS fba_fee,
        SUM(other_amazon_fees) AS other_fees,
        SUM(marketplace_facilitator_tax) AS mf_tax,
        SUM(referral_fee + fba_fee + other_amazon_fees + marketplace_facilitator_tax) AS total_fees,
        SUM(net_profit) AS net_profit
      FROM order_profit
      WHERE marketplace_id = $1 AND order_date = $2
    `, [mpId, testDate]);
    console.log('  LAYER 1 - order_profit:');
    console.log('  ', JSON.stringify(op.rows[0], null, 2));

    // Layer 2: asin_daily_metrics
    const adm = await client.query(`
      SELECT
        COUNT(*) AS righe_asin,
        SUM(units_sold) AS units,
        SUM(revenue) AS revenue,
        SUM(total_amazon_fees) AS total_fees,
        SUM(net_profit) AS net_profit
      FROM asin_daily_metrics
      WHERE marketplace_id = $1 AND metric_date = $2
    `, [mpId, testDate]);
    console.log('\n  LAYER 2 - asin_daily_metrics:');
    console.log('  ', JSON.stringify(adm.rows[0], null, 2));

    // Layer 3: account_daily_kpi (per marketplace)
    const kpi = await client.query(`
      SELECT
        units_sold, orders_count, revenue,
        total_amazon_fees, net_profit, margin_pct
      FROM account_daily_kpi
      WHERE marketplace_id = $1 AND kpi_date = $2
    `, [mpId, testDate]);
    console.log('\n  LAYER 3 - account_daily_kpi (FR):');
    console.log('  ', JSON.stringify(kpi.rows[0] || 'NESSUN RECORD', null, 2));

    // Layer 3b: account_daily_kpi (cross-marketplace, NULL)
    const kpiAll = await client.query(`
      SELECT
        units_sold, orders_count, revenue,
        total_amazon_fees, net_profit, margin_pct
      FROM account_daily_kpi
      WHERE marketplace_id IS NULL AND kpi_date = $2
    `, [mpId, testDate]);
    console.log('\n  LAYER 3b - account_daily_kpi (ALL, mp=NULL):');
    console.log('  ', JSON.stringify(kpiAll.rows[0] || 'NESSUN RECORD', null, 2));

    // Check: how many rows in account_daily_kpi for this date?
    const kpiCount = await client.query(`
      SELECT marketplace_id, units_sold, revenue, total_amazon_fees, net_profit
      FROM account_daily_kpi
      WHERE kpi_date = $1
      ORDER BY marketplace_id NULLS LAST
    `, [testDate]);
    console.log('\n  TUTTE le righe account_daily_kpi per', testDate, ':');
    for (const r of kpiCount.rows) {
      console.log(`    mp=${r.marketplace_id || 'NULL'} units=${r.units_sold} rev=${r.revenue} fees=${r.total_amazon_fees} profit=${r.net_profit}`);
    }

    // Sample: first 5 asin_daily_metrics rows for this date
    const sample = await client.query(`
      SELECT asin, units_sold, revenue, total_amazon_fees, net_profit
      FROM asin_daily_metrics
      WHERE marketplace_id = $1 AND metric_date = $2
      ORDER BY revenue DESC
      LIMIT 5
    `, [mpId, testDate]);
    console.log('\n  SAMPLE asin_daily_metrics (top 5 by revenue):');
    for (const r of sample.rows) {
      console.log(`    ${r.asin}: units=${r.units_sold} rev=${r.revenue} fees=${r.total_amazon_fees} profit=${r.net_profit}`);
    }

    console.log('');
  } finally {
    client.release();
    await shutdown();
  }
}

run().catch(err => { console.error('ERRORE:', err.message); process.exit(1); });
