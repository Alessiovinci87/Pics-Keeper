#!/usr/bin/env node
/**
 * Analisi COMPLETA di un singolo ASIN attraverso tutta la pipeline,
 * su TUTTI i marketplace, a finestre temporali progressive.
 *
 * Confronta 4 livelli:
 *   1) orders_raw       (dati grezzi SP-API)
 *   2) financial_events  (fee/commissioni)
 *   3) order_profit      (profit engine)
 *   4) asin_daily_metrics (aggregazioni dashboard)
 *
 * Finestre: oggi, 7gg, 30gg, 90gg, 180gg, 365gg
 *
 * Usage:
 *   node scripts/analyze-asin-full.js B0BY9Q4KTT
 *   node scripts/analyze-asin-full.js B0BY9Q4KTT IT        # solo un marketplace
 *   node scripts/analyze-asin-full.js B0BY9Q4KTT ALL 2026-03-03  # data di riferimento custom
 */
require('dotenv').config();
const db = require('../src/database/pool');

const ASIN = process.argv[2] || 'B0BY9Q4KTT';
const countryFilter = (process.argv[3] && process.argv[3] !== 'ALL') ? process.argv[3].toUpperCase() : null;
const referenceDate = process.argv[4] || new Date().toISOString().slice(0, 10);

const MARKETPLACE_TIMEZONES = {
  DE: 'Europe/Berlin', FR: 'Europe/Paris', IT: 'Europe/Rome',
  ES: 'Europe/Madrid', GB: 'Europe/London', NL: 'Europe/Amsterdam',
  SE: 'Europe/Stockholm', PL: 'Europe/Warsaw', TR: 'Europe/Istanbul',
  BE: 'Europe/Brussels', US: 'America/Los_Angeles', CA: 'America/Toronto',
};

/**
 * Calculate date N days before reference.
 */
function daysAgo(n) {
  const d = new Date(referenceDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

const WINDOWS = [
  { label: 'OGGI',       from: referenceDate,  to: referenceDate,   days: 1 },
  { label: '7 GIORNI',   from: daysAgo(6),     to: referenceDate,   days: 7 },
  { label: '30 GIORNI',  from: daysAgo(29),    to: referenceDate,   days: 30 },
  { label: '90 GIORNI',  from: daysAgo(89),    to: referenceDate,   days: 90 },
  { label: '180 GIORNI', from: daysAgo(179),   to: referenceDate,   days: 180 },
  { label: '365 GIORNI', from: daysAgo(364),   to: referenceDate,   days: 365 },
];

function sep(char = '═', len = 90) { return char.repeat(len); }
function pad(v, w) { return String(v).padStart(w); }

(async () => {
  try {
    // ── HEADER ──────────────────────────────────────────────────────
    console.log(`\n${sep()}`);
    console.log(`  ANALISI COMPLETA ASIN: ${ASIN}`);
    console.log(`  Data riferimento: ${referenceDate}`);
    if (countryFilter) console.log(`  Filtro paese: ${countryFilter}`);
    console.log(`  Finestre: ${WINDOWS.map(w => w.label).join(', ')}`);
    console.log(sep());

    // ── 0. ASIN INFO & COSTS ──────────────────────────────────────
    console.log(`\n${sep('─', 90)}`);
    console.log('  0. INFO PRODOTTO & COSTI CONFIGURATI');
    console.log(sep('─', 90));

    const asinInfo = await db.query(
      `SELECT a.asin, a.sku, a.title FROM asins a WHERE a.account_id = 1 AND a.asin = $1`, [ASIN]
    );
    if (asinInfo.rows.length > 0) {
      const a = asinInfo.rows[0];
      console.log(`  Titolo: ${a.title || '—'}`);
      console.log(`  SKU:    ${a.sku || '—'}`);
    } else {
      console.log(`  ASIN non trovato nella tabella asins!`);
    }

    const costInfo = await db.query(`
      SELECT ac.*, m.country_code, m.currency
      FROM asin_costs ac
      JOIN marketplaces m ON m.id = ac.marketplace_id
      WHERE ac.account_id = 1 AND ac.asin = $1
      ORDER BY m.country_code, ac.effective_from DESC
    `, [ASIN]);

    if (costInfo.rows.length > 0) {
      console.log(`\n  Costi configurati per marketplace:`);
      console.log(`  ${'Paese'.padEnd(5)} | ${'Da'.padEnd(10)} | Product | Inbound | Customs | Prep    | Packag. | Storage | Valuta`);
      console.log(`  ${'-'.repeat(85)}`);
      const seen = new Set();
      for (const c of costInfo.rows) {
        // Show only latest per marketplace
        if (seen.has(c.country_code)) continue;
        seen.add(c.country_code);
        console.log(`  ${c.country_code.padEnd(5)} | ${(c.effective_from || '—').toString().slice(0,10).padEnd(10)} | ${pad(c.product_cost,7)} | ${pad(c.inbound_cost,7)} | ${pad(c.customs_cost,7)} | ${pad(c.prep_cost,7)} | ${pad(c.packaging_cost,7)} | ${pad(c.storage_monthly_cost,7)} | ${c.currency}`);
      }
    } else {
      console.log(`\n  ⚠ NESSUN COSTO CONFIGURATO per questo ASIN!`);
    }

    // ── PER OGNI FINESTRA TEMPORALE ──────────────────────────────
    for (const window of WINDOWS) {
      // For "today", use exclusive upper bound = tomorrow
      const queryFrom = window.from;
      const tomorrow = new Date(window.to + 'T00:00:00Z');
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      const queryTo = tomorrow.toISOString().slice(0, 10);

      console.log(`\n\n${sep('═', 90)}`);
      console.log(`  FINESTRA: ${window.label}  (${queryFrom} → ${window.to})`);
      console.log(sep('═', 90));

      // ── 1. CONFRONTO 4 LIVELLI PER MARKETPLACE ────────────────
      console.log(`\n  1. PIPELINE: orders_raw → order_profit → asin_daily_metrics`);
      console.log(`  ${'-'.repeat(85)}`);

      const countryClause = countryFilter ? `AND m.country_code = '${countryFilter}'` : '';

      const pipeline = await db.query(`
        SELECT
          m.country_code,
          m.currency,
          -- orders_raw
          COALESCE(raw_data.orders, 0)    AS raw_orders,
          COALESCE(raw_data.units, 0)     AS raw_units,
          ROUND(COALESCE(raw_data.revenue, 0)::numeric, 2)  AS raw_revenue,
          -- order_profit
          COALESCE(profit_data.orders, 0) AS profit_orders,
          COALESCE(profit_data.units, 0)  AS profit_units,
          ROUND(COALESCE(profit_data.revenue, 0)::numeric, 2)  AS profit_revenue,
          ROUND(COALESCE(profit_data.net_profit, 0)::numeric, 2)  AS profit_net,
          ROUND(COALESCE(profit_data.total_fees, 0)::numeric, 2)  AS profit_fees,
          ROUND(COALESCE(profit_data.total_product_costs, 0)::numeric, 2)  AS profit_prod_costs,
          ROUND(COALESCE(profit_data.ads, 0)::numeric, 2) AS profit_ads,
          -- asin_daily_metrics
          COALESCE(metrics_data.orders, 0) AS metrics_orders,
          COALESCE(metrics_data.units, 0)  AS metrics_units,
          ROUND(COALESCE(metrics_data.revenue, 0)::numeric, 2)  AS metrics_revenue,
          ROUND(COALESCE(metrics_data.net_profit, 0)::numeric, 2) AS metrics_net,
          ROUND(COALESCE(metrics_data.ads_spend, 0)::numeric, 2) AS metrics_ads,
          -- financial_events_raw (fee totals)
          COALESCE(fee_data.fee_events, 0) AS fee_events,
          ROUND(COALESCE(fee_data.total_fees, 0)::numeric, 2) AS raw_fees_total,
          -- gaps
          COALESCE(raw_data.units, 0) - COALESCE(profit_data.units, 0) AS gap_raw_profit,
          COALESCE(raw_data.units, 0) - COALESCE(metrics_data.units, 0) AS gap_raw_metrics,
          COALESCE(profit_data.units, 0) - COALESCE(metrics_data.units, 0) AS gap_profit_metrics
        FROM marketplaces m
        JOIN account_marketplaces am ON am.marketplace_id = m.id AND am.is_active = TRUE AND am.account_id = 1
        LEFT JOIN LATERAL (
          SELECT
            COUNT(DISTINCT o.amazon_order_id) AS orders,
            SUM(o.quantity) AS units,
            SUM(o.item_price + o.item_tax + o.shipping_price + o.shipping_tax - o.promotion_discount) AS revenue
          FROM orders_raw o
          WHERE o.account_id = 1 AND o.marketplace_id = m.id AND o.asin = $1
            AND o.purchase_date >= $2::timestamptz AND o.purchase_date < $3::timestamptz
            AND UPPER(o.order_status) NOT IN ('CANCELLED', 'CANCELED')
        ) raw_data ON TRUE
        LEFT JOIN LATERAL (
          SELECT
            COUNT(DISTINCT op.amazon_order_id) AS orders,
            SUM(op.quantity) AS units,
            SUM(op.revenue) AS revenue,
            SUM(op.net_profit) AS net_profit,
            SUM(op.referral_fee + op.fba_fee + op.other_amazon_fees + op.marketplace_facilitator_tax) AS total_fees,
            SUM(op.product_cost + op.inbound_cost + op.customs_cost + op.prep_cost + op.packaging_cost + op.storage_allocated) AS total_product_costs,
            SUM(op.ads_allocated) AS ads
          FROM order_profit op
          WHERE op.account_id = 1 AND op.marketplace_id = m.id AND op.asin = $1
            AND op.order_date >= $2::date AND op.order_date < $3::date
        ) profit_data ON TRUE
        LEFT JOIN LATERAL (
          SELECT
            SUM(adm.orders_count) AS orders,
            SUM(adm.units_sold) AS units,
            SUM(adm.revenue) AS revenue,
            SUM(adm.net_profit) AS net_profit,
            SUM(adm.ads_spend) AS ads_spend
          FROM asin_daily_metrics adm
          WHERE adm.account_id = 1 AND adm.marketplace_id = m.id AND adm.asin = $1
            AND adm.metric_date >= $2::date AND adm.metric_date < $3::date
        ) metrics_data ON TRUE
        LEFT JOIN LATERAL (
          SELECT
            COUNT(*) AS fee_events,
            SUM(ABS(fe.amount)) AS total_fees
          FROM financial_events_raw fe
          WHERE fe.account_id = 1 AND fe.marketplace_id = m.id
            AND fe.amazon_order_id IN (
              SELECT DISTINCT o2.amazon_order_id FROM orders_raw o2
              WHERE o2.account_id = 1 AND o2.marketplace_id = m.id AND o2.asin = $1
                AND o2.purchase_date >= $2::timestamptz AND o2.purchase_date < $3::timestamptz
            )
            AND fe.event_type = 'ShipmentEvent'
            AND fe.amount < 0
        ) fee_data ON TRUE
        WHERE (COALESCE(raw_data.orders, 0) > 0 OR COALESCE(profit_data.orders, 0) > 0
               OR COALESCE(metrics_data.orders, 0) > 0)
          ${countryClause}
        ORDER BY COALESCE(raw_data.units, 0) DESC
      `, [ASIN, queryFrom, queryTo]);

      if (pipeline.rows.length === 0) {
        console.log(`  Nessun dato trovato per questa finestra.\n`);
        continue;
      }

      // Print header
      console.log(`  ${'Paese'.padEnd(5)} | ${'RAW ord/uni/rev'.padEnd(22)} | ${'PROFIT ord/uni/rev/net'.padEnd(32)} | ${'METRICS ord/uni/rev/net'.padEnd(32)} | Gaps`);
      console.log(`  ${'-'.repeat(100)}`);

      let totals = { raw_orders: 0, raw_units: 0, raw_revenue: 0, profit_orders: 0, profit_units: 0,
        profit_revenue: 0, profit_net: 0, profit_fees: 0, profit_prod_costs: 0, profit_ads: 0,
        metrics_orders: 0, metrics_units: 0, metrics_revenue: 0, metrics_net: 0, metrics_ads: 0,
        fee_events: 0, raw_fees_total: 0 };

      for (const r of pipeline.rows) {
        const gapStr = [];
        if (parseInt(r.gap_raw_profit) !== 0) gapStr.push(`R-P:${r.gap_raw_profit}`);
        if (parseInt(r.gap_raw_metrics) !== 0) gapStr.push(`R-M:${r.gap_raw_metrics}`);
        if (parseInt(r.gap_profit_metrics) !== 0) gapStr.push(`P-M:${r.gap_profit_metrics}`);
        const gapLabel = gapStr.length > 0 ? gapStr.join(' ') : 'OK';

        console.log(`  ${r.country_code.padEnd(5)} | ${pad(r.raw_orders,3)}/${pad(r.raw_units,3)}/${pad(r.raw_revenue,8)} ${r.currency || ''} | ${pad(r.profit_orders,3)}/${pad(r.profit_units,3)}/${pad(r.profit_revenue,8)}/${pad(r.profit_net,8)} | ${pad(r.metrics_orders,3)}/${pad(r.metrics_units,3)}/${pad(r.metrics_revenue,8)}/${pad(r.metrics_net,8)} | ${gapLabel}`);

        // Accumulate totals
        for (const key of Object.keys(totals)) {
          totals[key] += parseFloat(r[key]) || 0;
        }
      }

      console.log(`  ${'-'.repeat(100)}`);
      console.log(`  ${'TOT'.padEnd(5)} | ${pad(totals.raw_orders,3)}/${pad(totals.raw_units,3)}/${pad(totals.raw_revenue.toFixed(2),8)}     | ${pad(totals.profit_orders,3)}/${pad(totals.profit_units,3)}/${pad(totals.profit_revenue.toFixed(2),8)}/${pad(totals.profit_net.toFixed(2),8)} | ${pad(totals.metrics_orders,3)}/${pad(totals.metrics_units,3)}/${pad(totals.metrics_revenue.toFixed(2),8)}/${pad(totals.metrics_net.toFixed(2),8)} |`);

      // ── 2. DETTAGLIO FEES (solo per finestre corte) ─────────────
      if (window.days <= 30) {
        console.log(`\n  2. DETTAGLIO FEE per marketplace (financial_events → order_profit)`);
        console.log(`  ${'-'.repeat(85)}`);

        const feeDetail = await db.query(`
          SELECT
            m.country_code,
            -- Fee from financial_events_raw
            ROUND(COALESCE(fe_agg.referral, 0)::numeric, 2) AS fe_referral,
            ROUND(COALESCE(fe_agg.fba, 0)::numeric, 2) AS fe_fba,
            ROUND(COALESCE(fe_agg.mf_tax, 0)::numeric, 2) AS fe_mf_tax,
            ROUND(COALESCE(fe_agg.other, 0)::numeric, 2) AS fe_other,
            -- Fee from order_profit
            ROUND(COALESCE(op_agg.referral, 0)::numeric, 2) AS op_referral,
            ROUND(COALESCE(op_agg.fba, 0)::numeric, 2) AS op_fba,
            ROUND(COALESCE(op_agg.mf_tax, 0)::numeric, 2) AS op_mf_tax,
            ROUND(COALESCE(op_agg.other, 0)::numeric, 2) AS op_other
          FROM marketplaces m
          JOIN account_marketplaces am ON am.marketplace_id = m.id AND am.is_active = TRUE AND am.account_id = 1
          LEFT JOIN LATERAL (
            SELECT
              SUM(CASE WHEN fe.fee_type IN ('Commission', 'ReferralFee') THEN ABS(fe.amount) ELSE 0 END) AS referral,
              SUM(CASE WHEN fe.fee_type IN ('FBAPerUnitFulfillmentFee','FBAPerOrderFulfillmentFee','FBAWeightBasedFee') THEN ABS(fe.amount) ELSE 0 END) AS fba,
              SUM(CASE WHEN fe.fee_type LIKE 'MarketplaceFacilitatorTax%' THEN ABS(fe.amount) ELSE 0 END) AS mf_tax,
              SUM(CASE WHEN fe.fee_type NOT IN ('Commission','ReferralFee','FBAPerUnitFulfillmentFee','FBAPerOrderFulfillmentFee','FBAWeightBasedFee')
                AND fe.fee_type NOT LIKE 'MarketplaceFacilitatorTax%'
                AND fe.fee_type NOT IN ('Principal','Tax','ShippingCharge','ShippingTax','GiftWrap','GiftWrapTax','RestockingFee','Goodwill','ExportCharge','CODItemCharge','CODOrderCharge')
                THEN ABS(fe.amount) ELSE 0 END) AS other
            FROM financial_events_raw fe
            WHERE fe.account_id = 1 AND fe.marketplace_id = m.id
              AND fe.event_type = 'ShipmentEvent' AND fe.amount < 0
              AND fe.amazon_order_id IN (
                SELECT DISTINCT o2.amazon_order_id FROM orders_raw o2
                WHERE o2.account_id = 1 AND o2.marketplace_id = m.id AND o2.asin = $1
                  AND o2.purchase_date >= $2::timestamptz AND o2.purchase_date < $3::timestamptz
              )
          ) fe_agg ON TRUE
          LEFT JOIN LATERAL (
            SELECT
              SUM(op.referral_fee) AS referral,
              SUM(op.fba_fee) AS fba,
              SUM(op.marketplace_facilitator_tax) AS mf_tax,
              SUM(op.other_amazon_fees) AS other
            FROM order_profit op
            WHERE op.account_id = 1 AND op.marketplace_id = m.id AND op.asin = $1
              AND op.order_date >= $2::date AND op.order_date < $3::date
          ) op_agg ON TRUE
          WHERE COALESCE(fe_agg.referral, 0) > 0 OR COALESCE(op_agg.referral, 0) > 0
          ${countryClause}
          ORDER BY m.country_code
        `, [ASIN, queryFrom, queryTo]);

        if (feeDetail.rows.length > 0) {
          console.log(`  ${'Paese'.padEnd(5)} | ${'FIN.EVT: Ref/FBA/MFTax/Other'.padEnd(40)} | ${'ORD.PROF: Ref/FBA/MFTax/Other'.padEnd(40)}`);
          console.log(`  ${'-'.repeat(90)}`);
          for (const r of feeDetail.rows) {
            console.log(`  ${r.country_code.padEnd(5)} | ${pad(r.fe_referral,8)}/${pad(r.fe_fba,8)}/${pad(r.fe_mf_tax,8)}/${pad(r.fe_other,8)} | ${pad(r.op_referral,8)}/${pad(r.op_fba,8)}/${pad(r.op_mf_tax,8)}/${pad(r.op_other,8)}`);
          }
        } else {
          console.log(`  Nessuna fee trovata.`);
        }
      }

      // ── 3. DETTAGLIO ORDINI (solo per finestre corte, max 7gg) ──
      if (window.days <= 7) {
        console.log(`\n  3. ORDINI SINGOLI (orders_raw)`);
        console.log(`  ${'-'.repeat(100)}`);

        const orders = await db.query(`
          SELECT
            m.country_code,
            o.amazon_order_id,
            o.purchase_date,
            o.order_status,
            o.quantity,
            o.item_price,
            o.item_tax,
            o.shipping_price,
            o.shipping_tax,
            o.promotion_discount,
            o.item_price + o.item_tax + o.shipping_price + o.shipping_tax - o.promotion_discount AS gross_revenue,
            o.currency
          FROM orders_raw o
          JOIN marketplaces m ON m.id = o.marketplace_id
          ${countryFilter ? 'JOIN marketplaces m2 ON m2.id = o.marketplace_id' : ''}
          WHERE o.account_id = 1 AND o.asin = $1
            AND o.purchase_date >= $2::timestamptz AND o.purchase_date < $3::timestamptz
            ${countryFilter ? `AND m.country_code = '${countryFilter}'` : ''}
          ORDER BY m.country_code, o.purchase_date
        `, [ASIN, queryFrom, queryTo]);

        if (orders.rows.length > 0) {
          console.log(`  ${'Paese'.padEnd(5)} | ${'Order ID'.padEnd(22)} | ${'Data'.padEnd(19)} | ${'Status'.padEnd(10)} | Qty | ${'Price'.padEnd(8)} | ${'Tax'.padEnd(8)} | ${'Promo'.padEnd(8)} | ${'Gross'.padEnd(8)} | Valuta`);
          console.log(`  ${'-'.repeat(115)}`);
          for (const r of orders.rows) {
            console.log(`  ${r.country_code.padEnd(5)} | ${r.amazon_order_id.padEnd(22)} | ${r.purchase_date.toISOString().slice(0,19)} | ${r.order_status.padEnd(10)} | ${pad(r.quantity,3)} | ${pad(parseFloat(r.item_price||0).toFixed(2),8)} | ${pad(parseFloat(r.item_tax||0).toFixed(2),8)} | ${pad(parseFloat(r.promotion_discount||0).toFixed(2),8)} | ${pad(parseFloat(r.gross_revenue||0).toFixed(2),8)} | ${r.currency}`);
          }
          console.log(`  Totale righe: ${orders.rows.length}`);
        } else {
          console.log(`  Nessun ordine raw trovato.`);
        }

        // ── 3b. ORDINI CON PROFIT ──
        console.log(`\n  3b. ORDINI CON PROFIT CALCOLATO (order_profit)`);
        console.log(`  ${'-'.repeat(110)}`);

        const profitOrders = await db.query(`
          SELECT
            m.country_code,
            op.amazon_order_id,
            op.order_date,
            op.quantity,
            ROUND(op.revenue::numeric, 2) AS revenue,
            ROUND(op.referral_fee::numeric, 2) AS referral,
            ROUND(op.fba_fee::numeric, 2) AS fba,
            ROUND(op.other_amazon_fees::numeric, 2) AS other_fees,
            ROUND(op.marketplace_facilitator_tax::numeric, 2) AS mf_tax,
            ROUND(op.ads_allocated::numeric, 2) AS ads,
            ROUND(op.product_cost::numeric, 2) AS prod_cost,
            ROUND(op.refund_amount::numeric, 2) AS refund,
            ROUND(op.net_profit::numeric, 2) AS net_profit,
            ROUND(op.margin_pct::numeric, 1) AS margin,
            op.currency
          FROM order_profit op
          JOIN marketplaces m ON m.id = op.marketplace_id
          WHERE op.account_id = 1 AND op.asin = $1
            AND op.order_date >= $2::date AND op.order_date < $3::date
            ${countryFilter ? `AND m.country_code = '${countryFilter}'` : ''}
          ORDER BY m.country_code, op.order_date
        `, [ASIN, queryFrom, queryTo]);

        if (profitOrders.rows.length > 0) {
          console.log(`  ${'Paese'.padEnd(5)} | ${'Order ID'.padEnd(22)} | ${'Data'.padEnd(10)} | Qty | ${'Revenue'.padEnd(8)} | ${'Referr'.padEnd(7)} | ${'FBA'.padEnd(7)} | ${'MFTax'.padEnd(7)} | ${'Ads'.padEnd(7)} | ${'ProdC'.padEnd(7)} | ${'Refund'.padEnd(7)} | ${'NetProf'.padEnd(8)} | Margin`);
          console.log(`  ${'-'.repeat(125)}`);
          for (const r of profitOrders.rows) {
            console.log(`  ${r.country_code.padEnd(5)} | ${r.amazon_order_id.padEnd(22)} | ${r.order_date.toISOString().slice(0,10)} | ${pad(r.quantity,3)} | ${pad(r.revenue,8)} | ${pad(r.referral,7)} | ${pad(r.fba,7)} | ${pad(r.mf_tax,7)} | ${pad(r.ads,7)} | ${pad(r.prod_cost,7)} | ${pad(r.refund,7)} | ${pad(r.net_profit,8)} | ${r.margin}%`);
          }
        } else {
          console.log(`  Nessun record order_profit trovato.`);
        }

        // ── 3c. FINANCIAL EVENTS RAW ──
        console.log(`\n  3c. FINANCIAL EVENTS RAW per ordini di questa finestra`);
        console.log(`  ${'-'.repeat(100)}`);

        const finEvents = await db.query(`
          SELECT
            m.country_code,
            fe.amazon_order_id,
            fe.asin AS fe_asin,
            fe.event_type,
            fe.fee_type,
            fe.amount,
            fe.event_date
          FROM financial_events_raw fe
          JOIN marketplaces m ON m.id = fe.marketplace_id
          WHERE fe.account_id = 1
            AND fe.amazon_order_id IN (
              SELECT DISTINCT o2.amazon_order_id FROM orders_raw o2
              JOIN marketplaces m2 ON m2.id = o2.marketplace_id
              WHERE o2.account_id = 1 AND o2.asin = $1
                AND o2.purchase_date >= $2::timestamptz AND o2.purchase_date < $3::timestamptz
                ${countryFilter ? `AND m2.country_code = '${countryFilter}'` : ''}
            )
          ORDER BY m.country_code, fe.amazon_order_id, fe.fee_type
        `, [ASIN, queryFrom, queryTo]);

        if (finEvents.rows.length > 0) {
          console.log(`  ${'Paese'.padEnd(5)} | ${'Order ID'.padEnd(22)} | ${'ASIN(fin)'.padEnd(14)} | ${'Tipo'.padEnd(14)} | ${'Fee Type'.padEnd(35)} | Amount`);
          console.log(`  ${'-'.repeat(105)}`);
          for (const r of finEvents.rows) {
            console.log(`  ${r.country_code.padEnd(5)} | ${(r.amazon_order_id || '—').padEnd(22)} | ${(r.fe_asin || '—').padEnd(14)} | ${r.event_type.padEnd(14)} | ${r.fee_type.padEnd(35)} | ${parseFloat(r.amount).toFixed(4)}`);
          }
        } else {
          console.log(`  Nessun evento finanziario trovato.`);
        }
      }

      // ── 4. ADS DATA ───────────────────────────────────────────────
      if (window.days <= 30) {
        console.log(`\n  4. ADS SPEND per marketplace`);
        console.log(`  ${'-'.repeat(60)}`);

        const adsData = await db.query(`
          SELECT
            m.country_code,
            ads.campaign_type,
            SUM(ads.spend) AS total_spend,
            SUM(ads.impressions) AS impressions,
            SUM(ads.clicks) AS clicks,
            SUM(ads.orders_count) AS ad_orders
          FROM ads_daily_spend ads
          JOIN marketplaces m ON m.id = ads.marketplace_id
          WHERE ads.account_id = 1 AND ads.asin = $1
            AND ads.spend_date >= $2::date AND ads.spend_date < $3::date
            ${countryFilter ? `AND m.country_code = '${countryFilter}'` : ''}
          GROUP BY m.country_code, ads.campaign_type
          ORDER BY m.country_code, ads.campaign_type
        `, [ASIN, queryFrom, queryTo]);

        if (adsData.rows.length > 0) {
          console.log(`  ${'Paese'.padEnd(5)} | ${'Camp'.padEnd(4)} | ${'Spend'.padEnd(10)} | ${'Impress.'.padEnd(10)} | ${'Clicks'.padEnd(8)} | Ad Orders`);
          console.log(`  ${'-'.repeat(60)}`);
          for (const r of adsData.rows) {
            console.log(`  ${r.country_code.padEnd(5)} | ${r.campaign_type.padEnd(4)} | ${pad(parseFloat(r.total_spend).toFixed(2),10)} | ${pad(r.impressions,10)} | ${pad(r.clicks,8)} | ${r.ad_orders}`);
          }
        } else {
          console.log(`  Nessun dato ads trovato.`);
        }
      }

      // ── 5. ORDINI PENDING/SENZA PROFIT ────────────────────────────
      console.log(`\n  5. ORDINI PENDING e SENZA PROFIT`);
      console.log(`  ${'-'.repeat(60)}`);

      const pendingOrders = await db.query(`
        SELECT
          m.country_code,
          o.order_status,
          COUNT(DISTINCT o.amazon_order_id) AS orders,
          SUM(o.quantity) AS units
        FROM orders_raw o
        JOIN marketplaces m ON m.id = o.marketplace_id
        WHERE o.account_id = 1 AND o.asin = $1
          AND o.purchase_date >= $2::timestamptz AND o.purchase_date < $3::timestamptz
          ${countryFilter ? `AND m.country_code = '${countryFilter}'` : ''}
        GROUP BY m.country_code, o.order_status
        ORDER BY m.country_code, o.order_status
      `, [ASIN, queryFrom, queryTo]);

      if (pendingOrders.rows.length > 0) {
        console.log(`  ${'Paese'.padEnd(5)} | ${'Status'.padEnd(12)} | Orders | Units`);
        console.log(`  ${'-'.repeat(45)}`);
        for (const r of pendingOrders.rows) {
          console.log(`  ${r.country_code.padEnd(5)} | ${r.order_status.padEnd(12)} | ${pad(r.orders, 6)} | ${r.units}`);
        }
      }

      const missingProfit = await db.query(`
        SELECT
          m.country_code,
          COUNT(DISTINCT o.amazon_order_id) AS missing_orders,
          SUM(o.quantity) AS missing_units
        FROM orders_raw o
        JOIN marketplaces m ON m.id = o.marketplace_id
        LEFT JOIN order_profit op ON op.account_id = o.account_id AND op.amazon_order_id = o.amazon_order_id AND op.asin = o.asin
        WHERE o.account_id = 1 AND o.asin = $1
          AND o.purchase_date >= $2::timestamptz AND o.purchase_date < $3::timestamptz
          AND UPPER(o.order_status) NOT IN ('CANCELLED', 'CANCELED')
          AND op.id IS NULL
          ${countryFilter ? `AND m.country_code = '${countryFilter}'` : ''}
        GROUP BY m.country_code
        HAVING COUNT(DISTINCT o.amazon_order_id) > 0
      `, [ASIN, queryFrom, queryTo]);

      if (missingProfit.rows.length > 0) {
        console.log(`\n  ORDINI RAW SENZA order_profit:`);
        for (const r of missingProfit.rows) {
          console.log(`    ${r.country_code}: ${r.missing_orders} ordini, ${r.missing_units} unita`);
        }
      } else {
        console.log(`  Tutti gli ordini non-cancelled hanno un record order_profit.`);
      }

      // ── 6. REFUNDS ────────────────────────────────────────────────
      const refunds = await db.query(`
        SELECT
          m.country_code,
          COUNT(*) AS refund_events,
          ROUND(SUM(ABS(fe.amount))::numeric, 2) AS refund_total
        FROM financial_events_raw fe
        JOIN marketplaces m ON m.id = fe.marketplace_id
        WHERE fe.account_id = 1
          AND fe.event_type = 'RefundEvent'
          AND fe.event_date >= $2::timestamptz AND fe.event_date < $3::timestamptz
          AND fe.amazon_order_id IN (
            SELECT DISTINCT o2.amazon_order_id FROM orders_raw o2
            WHERE o2.account_id = 1 AND o2.asin = $1
              ${countryFilter ? `AND o2.marketplace_id IN (SELECT id FROM marketplaces WHERE country_code = '${countryFilter}')` : ''}
          )
          ${countryFilter ? `AND m.country_code = '${countryFilter}'` : ''}
        GROUP BY m.country_code
      `, [ASIN, queryFrom, queryTo]);

      if (refunds.rows.length > 0) {
        console.log(`\n  6. RIMBORSI:`);
        for (const r of refunds.rows) {
          console.log(`    ${r.country_code}: ${r.refund_events} eventi, totale ${r.refund_total}`);
        }
      }
    }

    // ── RIEPILOGO FINALE: SYNC STATUS ───────────────────────────────
    console.log(`\n\n${sep('═', 90)}`);
    console.log(`  STATO SYNC PER MARKETPLACE`);
    console.log(sep('═', 90));

    const syncStatus = await db.query(`
      SELECT
        m.country_code,
        am.is_active,
        am.last_orders_sync_at,
        am.last_financial_sync_at,
        am.last_ads_sync_at,
        am.sync_status
      FROM account_marketplaces am
      JOIN marketplaces m ON m.id = am.marketplace_id
      WHERE am.account_id = 1
      ORDER BY m.country_code
    `);

    console.log(`  ${'Paese'.padEnd(5)} | Active | ${'Last Orders Sync'.padEnd(24)} | ${'Last Financial'.padEnd(24)} | ${'Last Ads'.padEnd(24)} | Status`);
    console.log(`  ${'-'.repeat(110)}`);
    for (const r of syncStatus.rows) {
      const ordSync = r.last_orders_sync_at ? r.last_orders_sync_at.toISOString().slice(0, 19) : '—';
      const finSync = r.last_financial_sync_at ? r.last_financial_sync_at.toISOString().slice(0, 19) : '—';
      const adsSync = r.last_ads_sync_at ? r.last_ads_sync_at.toISOString().slice(0, 19) : '—';
      console.log(`  ${r.country_code.padEnd(5)} | ${r.is_active ? 'YES' : 'NO '} .. | ${ordSync.padEnd(24)} | ${finSync.padEnd(24)} | ${adsSync.padEnd(24)} | ${r.sync_status || '—'}`);
    }

    console.log(`\n${sep()}`);
    console.log(`  ANALISI COMPLETATA — ${new Date().toISOString()}`);
    console.log(sep());
    console.log('');

    await db.shutdown();
  } catch (err) {
    console.error('Error:', err.message);
    console.error(err.stack);
    await db.shutdown();
    process.exit(1);
  }
})();
