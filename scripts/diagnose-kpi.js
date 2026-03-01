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
      WHERE marketplace_id IS NULL AND kpi_date = $1
    `, [testDate]);
    console.log('\n  LAYER 3b - account_daily_kpi (ALL, mp=NULL):');
    console.log('  ', JSON.stringify(kpiAll.rows[0] || 'NESSUN RECORD', null, 2));

    // ─── DIAGNOSI FINANCIAL EVENTS ───
    console.log('\n  ─── FINANCIAL EVENTS RAW ───');

    // Total financial events for this marketplace in Feb
    const feTotal = await client.query(`
      SELECT
        COUNT(*) AS righe,
        COUNT(DISTINCT amazon_order_id) AS ordini_distinti,
        MIN(event_date) AS min_date,
        MAX(event_date) AS max_date
      FROM financial_events_raw
      WHERE marketplace_id = $1
        AND event_date >= '2026-02-01' AND event_date < '2026-03-02'
    `, [mpId]);
    console.log('  Totale eventi finanziari FR (feb):');
    console.log('  ', JSON.stringify(feTotal.rows[0], null, 2));

    // Fee events specifically (amount < 0, ShipmentEvent)
    const feFees = await client.query(`
      SELECT
        COUNT(*) AS righe_fee,
        COUNT(DISTINCT amazon_order_id) AS ordini_con_fee,
        SUM(amount) AS total_fee_amount
      FROM financial_events_raw
      WHERE marketplace_id = $1
        AND event_date >= '2026-02-01' AND event_date < '2026-03-02'
        AND event_type = 'ShipmentEvent'
        AND amount < 0
    `, [mpId]);
    console.log('  Eventi fee (ShipmentEvent, amount<0):');
    console.log('  ', JSON.stringify(feFees.rows[0], null, 2));

    // Check a specific order that has fees=0 in order_profit
    const sampleOrder = await client.query(`
      SELECT amazon_order_id, asin, revenue, referral_fee, fba_fee
      FROM order_profit
      WHERE marketplace_id = $1 AND order_date = $2
        AND referral_fee = 0 AND revenue > 0
      LIMIT 1
    `, [mpId, testDate]);
    if (sampleOrder.rows[0]) {
      const oid = sampleOrder.rows[0].amazon_order_id;
      const asin = sampleOrder.rows[0].asin;
      console.log(`\n  Ordine campione senza fees: ${oid} (ASIN: ${asin}, revenue: ${sampleOrder.rows[0].revenue})`);

      const feForOrder = await client.query(`
        SELECT event_type, fee_type, amount, event_date
        FROM financial_events_raw
        WHERE amazon_order_id = $1
        ORDER BY event_date
      `, [oid]);
      if (feForOrder.rows.length === 0) {
        console.log('    NESSUN evento finanziario trovato per questo ordine!');
      } else {
        console.log(`    ${feForOrder.rows.length} eventi finanziari trovati:`);
        for (const r of feForOrder.rows) {
          console.log(`      ${r.event_type} | ${r.fee_type} | ${r.amount} | ${r.event_date}`);
        }
      }
    }

    // Check: which dates have fees > 0 in order_profit?
    const datesWithFees = await client.query(`
      SELECT order_date,
        COUNT(*) AS righe,
        SUM(referral_fee + fba_fee + other_amazon_fees + marketplace_facilitator_tax) AS total_fees
      FROM order_profit
      WHERE marketplace_id = $1 AND order_date >= '2026-02-01'
      GROUP BY order_date
      ORDER BY order_date
    `, [mpId]);
    console.log('\n  Fees per giorno in order_profit (FR):');
    for (const r of datesWithFees.rows) {
      const marker = Number(r.total_fees) > 0 ? ' <<<' : '';
      console.log(`    ${r.order_date.toISOString().slice(0,10)}: ${r.righe} righe, fees=${Number(r.total_fees).toFixed(2)}${marker}`);
    }

    console.log('');
  } finally {
    client.release();
    await shutdown();
  }
}

run().catch(err => { console.error('ERRORE:', err.message); process.exit(1); });
