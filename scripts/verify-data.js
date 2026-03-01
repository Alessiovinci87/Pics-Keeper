#!/usr/bin/env node
/**
 * Verify resync + recompute results.
 * Usage: node scripts/verify-data.js [dateFrom] [countries]
 * Example: node scripts/verify-data.js 2026-02-01 FR,NL,GB,PL
 */
require('dotenv').config();
const pool = require('../src/database/pool');

const dateFrom = process.argv[2] || '2026-02-01';
const countries = (process.argv[3] || 'FR,NL,GB,PL').split(',').map(c => c.trim());

// marketplace_id mapping
const MP = { DE:1, FR:2, IT:3, ES:4, GB:5, NL:6, SE:7, PL:8, TR:9, BE:10, US:11, CA:12 };
const mpIds = countries.map(c => MP[c]).filter(Boolean);

function fmt(n) { return n == null ? '-' : Number(n).toFixed(2); }
function fmtPct(n) { return n == null ? '-' : Number(n).toFixed(1) + '%'; }
function pad(s, len) { return String(s).padEnd(len); }
function padR(s, len) { return String(s).padStart(len); }

async function run() {
  const client = await pool.connect();
  try {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`  VERIFICA DATI — dal ${dateFrom} — Paesi: ${countries.join(', ')}`);
    console.log(`${'='.repeat(70)}`);

    // ─── 1. Order Profit summary per marketplace ───
    console.log(`\n  1) RIEPILOGO ORDER_PROFIT per marketplace\n`);
    const profitSummary = await client.query(`
      SELECT
        m.country_code,
        COUNT(*)                          AS righe,
        SUM(op.quantity)                  AS units,
        SUM(op.revenue)                   AS revenue,
        SUM(op.referral_fee + op.fba_fee + op.other_amazon_fees + op.marketplace_facilitator_tax)
                                          AS amazon_fees,
        SUM(op.product_cost + op.inbound_cost + op.customs_cost + op.prep_cost + op.packaging_cost + op.storage_allocated)
                                          AS product_costs,
        SUM(op.ads_allocated)             AS ads,
        SUM(op.refund_amount)             AS refunds,
        SUM(op.net_profit)                AS net_profit,
        AVG(op.margin_pct)                AS avg_margin
      FROM order_profit op
      JOIN marketplaces m ON m.id = op.marketplace_id
      WHERE op.order_date >= $1
        AND op.marketplace_id = ANY($2)
      GROUP BY m.country_code
      ORDER BY SUM(op.revenue) DESC
    `, [dateFrom, mpIds]);

    const hdr = `  ${pad('MP',4)} ${padR('Righe',7)} ${padR('Units',7)} ${padR('Revenue',12)} ${padR('Amz Fees',12)} ${padR('Prod Cost',12)} ${padR('Ads',10)} ${padR('Refunds',10)} ${padR('Net Profit',12)} ${padR('Margin',8)}`;
    console.log(hdr);
    console.log(`  ${'-'.repeat(hdr.length - 2)}`);
    let totRev = 0, totProfit = 0, totUnits = 0;
    for (const r of profitSummary.rows) {
      totRev += Number(r.revenue); totProfit += Number(r.net_profit); totUnits += Number(r.units);
      console.log(`  ${pad(r.country_code,4)} ${padR(r.righe,7)} ${padR(r.units,7)} ${padR(fmt(r.revenue),12)} ${padR(fmt(r.amazon_fees),12)} ${padR(fmt(r.product_costs),12)} ${padR(fmt(r.ads),10)} ${padR(fmt(r.refunds),10)} ${padR(fmt(r.net_profit),12)} ${padR(fmtPct(r.avg_margin),8)}`);
    }
    console.log(`  ${'-'.repeat(hdr.length - 2)}`);
    console.log(`  ${pad('TOT',4)} ${padR('',7)} ${padR(totUnits,7)} ${padR(fmt(totRev),12)} ${padR('',12)} ${padR('',12)} ${padR('',10)} ${padR('',10)} ${padR(fmt(totProfit),12)} ${padR(fmtPct(totRev ? (totProfit/totRev)*100 : 0),8)}`);

    // ─── 2. Account Daily KPI — ultimi giorni ───
    console.log(`\n  2) ACCOUNT_DAILY_KPI — andamento giornaliero (ultimi 10 giorni)\n`);
    const dailyKpi = await client.query(`
      SELECT
        kpi_date,
        SUM(units_sold)       AS units,
        SUM(orders_count)     AS orders,
        SUM(revenue)          AS revenue,
        SUM(total_amazon_fees) AS fees,
        SUM(ads_spend)        AS ads,
        SUM(net_profit)       AS profit
      FROM account_daily_kpi
      WHERE kpi_date >= $1
        AND marketplace_id = ANY($2)
      GROUP BY kpi_date
      ORDER BY kpi_date DESC
      LIMIT 10
    `, [dateFrom, mpIds]);

    console.log(`  ${pad('Data',12)} ${padR('Units',7)} ${padR('Orders',8)} ${padR('Revenue',12)} ${padR('Fees',12)} ${padR('Ads',10)} ${padR('Profit',12)} ${padR('Margin',8)}`);
    console.log(`  ${'-'.repeat(70)}`);
    for (const r of dailyKpi.rows) {
      const margin = Number(r.revenue) ? (Number(r.profit) / Number(r.revenue)) * 100 : 0;
      console.log(`  ${pad(r.kpi_date.toISOString().slice(0,10),12)} ${padR(r.units,7)} ${padR(r.orders,8)} ${padR(fmt(r.revenue),12)} ${padR(fmt(r.fees),12)} ${padR(fmt(r.ads),10)} ${padR(fmt(r.profit),12)} ${padR(fmtPct(margin),8)}`);
    }

    // ─── 3. Top 10 ASIN per profitto ───
    console.log(`\n  3) TOP 10 ASIN per net_profit (dal ${dateFrom})\n`);
    const topAsin = await client.query(`
      SELECT
        m.country_code,
        adm.asin,
        SUM(adm.units_sold)   AS units,
        SUM(adm.revenue)      AS revenue,
        SUM(adm.ads_spend)    AS ads,
        SUM(adm.net_profit)   AS profit,
        AVG(adm.margin_pct)   AS margin
      FROM asin_daily_metrics adm
      JOIN marketplaces m ON m.id = adm.marketplace_id
      WHERE adm.metric_date >= $1
        AND adm.marketplace_id = ANY($2)
      GROUP BY m.country_code, adm.asin
      ORDER BY SUM(adm.net_profit) DESC
      LIMIT 10
    `, [dateFrom, mpIds]);

    console.log(`  ${pad('MP',4)} ${pad('ASIN',14)} ${padR('Units',7)} ${padR('Revenue',12)} ${padR('Ads',10)} ${padR('Profit',12)} ${padR('Margin',8)}`);
    console.log(`  ${'-'.repeat(66)}`);
    for (const r of topAsin.rows) {
      console.log(`  ${pad(r.country_code,4)} ${pad(r.asin,14)} ${padR(r.units,7)} ${padR(fmt(r.revenue),12)} ${padR(fmt(r.ads),10)} ${padR(fmt(r.profit),12)} ${padR(fmtPct(r.margin),8)}`);
    }

    // ─── 4. Sanity checks ───
    console.log(`\n  4) SANITY CHECKS\n`);

    // Orders in orders_raw vs order_profit
    const rawCount = await client.query(`
      SELECT COUNT(DISTINCT amazon_order_id) AS cnt
      FROM orders_raw
      WHERE purchase_date >= $1
        AND marketplace_id = ANY($2)
        AND order_status != 'Cancelled'
    `, [dateFrom, mpIds]);

    const profitCount = await client.query(`
      SELECT COUNT(DISTINCT amazon_order_id) AS cnt
      FROM order_profit
      WHERE order_date >= $1
        AND marketplace_id = ANY($2)
    `, [dateFrom, mpIds]);

    const rawN = Number(rawCount.rows[0].cnt);
    const profN = Number(profitCount.rows[0].cnt);
    const match = rawN === profN;
    console.log(`  Ordini in orders_raw (non cancellati): ${rawN}`);
    console.log(`  Ordini in order_profit:                ${profN}`);
    console.log(`  Match: ${match ? 'SI' : `NO (differenza: ${rawN - profN})`}`);

    // Null net_profit check
    const nullProfit = await client.query(`
      SELECT COUNT(*) AS cnt FROM order_profit
      WHERE order_date >= $1 AND marketplace_id = ANY($2) AND net_profit IS NULL
    `, [dateFrom, mpIds]);
    console.log(`  Righe con net_profit NULL: ${nullProfit.rows[0].cnt}`);

    // Zero revenue check
    const zeroRev = await client.query(`
      SELECT COUNT(*) AS cnt FROM order_profit
      WHERE order_date >= $1 AND marketplace_id = ANY($2) AND revenue = 0
    `, [dateFrom, mpIds]);
    console.log(`  Righe con revenue = 0: ${zeroRev.rows[0].cnt}`);

    console.log(`\n${'='.repeat(70)}`);
    console.log(`  VERIFICA COMPLETATA`);
    console.log(`${'='.repeat(70)}\n`);

  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(err => { console.error('ERRORE:', err.message); process.exit(1); });
