const db = require('../../database/pool');
const logger = require('../../utils/logger');
const { round, pct, roi, toDateStr } = require('../../utils/helpers');
const SyncLogger = require('../../services/sync-logger');

/**
 * Aggregation Engine - builds ASIN daily metrics and account daily KPIs
 * from order_profit and ads_daily_spend data.
 *
 * Key fixes:
 * - Second pass for ads-only rows (ASINs with ad spend but zero sales)
 * - Proper ON CONFLICT for NULL marketplace_id (cross-marketplace aggregate)
 * - LATERAL JOIN for efficient ads lookup
 * - marketplace_facilitator_tax included in total_amazon_fees
 */
const AggregationService = {
  /**
   * Run full aggregation for an account+marketplace in a date range.
   */
  async aggregate(accountId, marketplaceId, dateFrom, dateTo) {
    const syncLog = await SyncLogger.start(accountId, marketplaceId, 'aggregation');

    try {
      logger.info('Starting aggregation', { accountId, marketplaceId, dateFrom, dateTo });

      await this.aggregateAsinDaily(accountId, marketplaceId, dateFrom, dateTo);
      await this.aggregateAdsOnlyAsins(accountId, marketplaceId, dateFrom, dateTo);
      await this.aggregateAccountDaily(accountId, marketplaceId, dateFrom, dateTo);
      await this.aggregateAccountDailyTotal(accountId, dateFrom, dateTo);

      await SyncLogger.complete(syncLog.id, {});
      logger.info('Aggregation completed', { accountId, marketplaceId });
    } catch (err) {
      await SyncLogger.fail(syncLog.id, err.message);
      logger.error('Aggregation failed', { accountId, error: err.message });
      throw err;
    }
  },

  /**
   * Aggregate per-ASIN per-day metrics from order_profit.
   * Includes marketplace_facilitator_tax in total_amazon_fees.
   * Uses LATERAL JOIN for efficient ads lookup.
   *
   * INNER JOIN with orders_raw ensures:
   * - Cancelled orders are always excluded (even if stale in order_profit)
   * - Quantity uses the authoritative value from orders_raw
   */
  async aggregateAsinDaily(accountId, marketplaceId, dateFrom, dateTo) {
    await db.query(
      `INSERT INTO asin_daily_metrics (
        account_id, marketplace_id, asin, metric_date,
        units_sold, orders_count, revenue, total_amazon_fees, refunds,
        ads_spend, total_product_costs, net_profit,
        margin_pct, roi_pct, acos_pct, tacos_pct, currency, computed_at
      )
      SELECT
        op.account_id,
        op.marketplace_id,
        op.asin,
        op.order_date AS metric_date,
        SUM(o.quantity) AS units_sold,
        COUNT(DISTINCT op.amazon_order_id) AS orders_count,
        SUM(op.revenue) AS revenue,
        SUM(op.referral_fee + op.fba_fee + op.other_amazon_fees + op.marketplace_facilitator_tax) AS total_amazon_fees,
        SUM(op.refund_amount) AS refunds,
        COALESCE(ads.total_spend, 0) AS ads_spend,
        SUM(op.product_cost + op.inbound_cost + op.customs_cost + op.prep_cost + op.packaging_cost + op.storage_allocated) AS total_product_costs,
        SUM(op.net_profit) AS net_profit,
        CASE WHEN SUM(op.revenue) > 0
          THEN LEAST(9999.9999, GREATEST(-9999.9999,
            ROUND((SUM(op.net_profit) / SUM(op.revenue)) * 100, 4)))
          ELSE 0 END AS margin_pct,
        CASE WHEN SUM(op.product_cost + op.inbound_cost + op.customs_cost + op.prep_cost + op.packaging_cost + op.storage_allocated + op.ads_allocated) > 0
          THEN LEAST(9999.9999, GREATEST(-9999.9999,
            ROUND((SUM(op.net_profit) / SUM(op.product_cost + op.inbound_cost + op.customs_cost + op.prep_cost + op.packaging_cost + op.storage_allocated + op.ads_allocated)) * 100, 4)))
          ELSE 0 END AS roi_pct,
        CASE WHEN COALESCE(ads.total_sales, 0) > 0
          THEN LEAST(9999.9999,
            ROUND((COALESCE(ads.total_spend, 0) / ads.total_sales) * 100, 4))
          ELSE 0 END AS acos_pct,
        CASE WHEN SUM(op.revenue) > 0
          THEN LEAST(9999.9999,
            ROUND((COALESCE(ads.total_spend, 0) / SUM(op.revenue)) * 100, 4))
          ELSE 0 END AS tacos_pct,
        op.currency,
        NOW() AS computed_at
      FROM order_profit op
      INNER JOIN orders_raw o
        ON o.account_id = op.account_id
        AND o.amazon_order_id = op.amazon_order_id
        AND o.asin = op.asin
      LEFT JOIN LATERAL (
        SELECT
          SUM(spend) AS total_spend,
          SUM(sales) AS total_sales
        FROM ads_daily_spend
        WHERE account_id = op.account_id
          AND marketplace_id = op.marketplace_id
          AND asin = op.asin
          AND spend_date = op.order_date
      ) ads ON TRUE
      WHERE op.account_id = $1
        AND op.marketplace_id = $2
        AND op.order_date >= $3
        AND op.order_date < $4
        AND UPPER(o.order_status) NOT IN ('CANCELLED', 'CANCELED')
      GROUP BY op.account_id, op.marketplace_id, op.asin, op.order_date,
               ads.total_spend, ads.total_sales, op.currency
      ON CONFLICT (account_id, marketplace_id, asin, metric_date) DO UPDATE SET
        units_sold = EXCLUDED.units_sold,
        orders_count = EXCLUDED.orders_count,
        revenue = EXCLUDED.revenue,
        total_amazon_fees = EXCLUDED.total_amazon_fees,
        refunds = EXCLUDED.refunds,
        ads_spend = EXCLUDED.ads_spend,
        total_product_costs = EXCLUDED.total_product_costs,
        net_profit = EXCLUDED.net_profit,
        margin_pct = EXCLUDED.margin_pct,
        roi_pct = EXCLUDED.roi_pct,
        acos_pct = EXCLUDED.acos_pct,
        tacos_pct = EXCLUDED.tacos_pct,
        computed_at = NOW()`,
      [accountId, marketplaceId, dateFrom, dateTo]
    );

    logger.debug('ASIN daily metrics aggregated', { accountId, marketplaceId });
  },

  /**
   * Second pass: Include ASINs that have ads spend but zero sales.
   * These are "ads-only" rows that won't appear in order_profit.
   */
  async aggregateAdsOnlyAsins(accountId, marketplaceId, dateFrom, dateTo) {
    await db.query(
      `INSERT INTO asin_daily_metrics (
        account_id, marketplace_id, asin, metric_date,
        units_sold, orders_count, revenue, total_amazon_fees, refunds,
        ads_spend, total_product_costs, net_profit,
        margin_pct, roi_pct, acos_pct, tacos_pct, currency, computed_at
      )
      SELECT
        ads.account_id,
        ads.marketplace_id,
        ads.asin,
        ads.spend_date AS metric_date,
        0 AS units_sold,
        0 AS orders_count,
        0 AS revenue,
        0 AS total_amazon_fees,
        0 AS refunds,
        SUM(ads.spend) AS ads_spend,
        0 AS total_product_costs,
        -SUM(ads.spend) AS net_profit,
        0 AS margin_pct,
        0 AS roi_pct,
        CASE WHEN SUM(ads.sales) > 0
          THEN LEAST(9999.9999, ROUND((SUM(ads.spend) / SUM(ads.sales)) * 100, 4))
          ELSE 0 END AS acos_pct,
        0 AS tacos_pct,
        ads.currency,
        NOW() AS computed_at
      FROM ads_daily_spend ads
      WHERE ads.account_id = $1
        AND ads.marketplace_id = $2
        AND ads.spend_date >= $3::date
        AND ads.spend_date < $4::date
        AND NOT EXISTS (
          SELECT 1 FROM asin_daily_metrics adm
          WHERE adm.account_id = ads.account_id
            AND adm.marketplace_id = ads.marketplace_id
            AND adm.asin = ads.asin
            AND adm.metric_date = ads.spend_date
        )
      GROUP BY ads.account_id, ads.marketplace_id, ads.asin, ads.spend_date, ads.currency
      ON CONFLICT (account_id, marketplace_id, asin, metric_date) DO NOTHING`,
      [accountId, marketplaceId, dateFrom, dateTo]
    );

    logger.debug('Ads-only ASIN daily metrics aggregated', { accountId, marketplaceId });
  },

  /**
   * Aggregate account-level daily KPIs per marketplace.
   * Uses the partial unique index (WHERE marketplace_id IS NOT NULL).
   */
  async aggregateAccountDaily(accountId, marketplaceId, dateFrom, dateTo) {
    await db.query(
      `INSERT INTO account_daily_kpi (
        account_id, marketplace_id, kpi_date,
        units_sold, orders_count, revenue, total_amazon_fees, refunds,
        ads_spend, total_product_costs, net_profit,
        margin_pct, roi_pct, acos_pct, tacos_pct, currency, computed_at
      )
      SELECT
        account_id,
        marketplace_id,
        metric_date AS kpi_date,
        SUM(units_sold),
        SUM(orders_count),
        SUM(revenue),
        SUM(total_amazon_fees),
        SUM(refunds),
        SUM(ads_spend),
        SUM(total_product_costs),
        SUM(net_profit),
        CASE WHEN SUM(revenue) > 0
          THEN LEAST(9999.9999, GREATEST(-9999.9999,
            ROUND((SUM(net_profit) / SUM(revenue)) * 100, 4))) ELSE 0 END,
        CASE WHEN SUM(total_product_costs + ads_spend) > 0
          THEN LEAST(9999.9999, GREATEST(-9999.9999,
            ROUND((SUM(net_profit) / SUM(total_product_costs + ads_spend)) * 100, 4))) ELSE 0 END,
        CASE WHEN SUM(ads_spend) > 0 AND SUM(revenue) > 0
          THEN LEAST(9999.9999,
            ROUND((SUM(ads_spend) / SUM(revenue)) * 100, 4)) ELSE 0 END,
        CASE WHEN SUM(revenue) > 0
          THEN LEAST(9999.9999,
            ROUND((SUM(ads_spend) / SUM(revenue)) * 100, 4)) ELSE 0 END,
        currency,
        NOW()
      FROM asin_daily_metrics
      WHERE account_id = $1 AND marketplace_id = $2
        AND metric_date >= $3 AND metric_date < $4
      GROUP BY account_id, marketplace_id, metric_date, currency
      ON CONFLICT (account_id, marketplace_id, kpi_date)
        WHERE marketplace_id IS NOT NULL
      DO UPDATE SET
        units_sold = EXCLUDED.units_sold,
        orders_count = EXCLUDED.orders_count,
        revenue = EXCLUDED.revenue,
        total_amazon_fees = EXCLUDED.total_amazon_fees,
        refunds = EXCLUDED.refunds,
        ads_spend = EXCLUDED.ads_spend,
        total_product_costs = EXCLUDED.total_product_costs,
        net_profit = EXCLUDED.net_profit,
        margin_pct = EXCLUDED.margin_pct,
        roi_pct = EXCLUDED.roi_pct,
        acos_pct = EXCLUDED.acos_pct,
        tacos_pct = EXCLUDED.tacos_pct,
        computed_at = NOW()`,
      [accountId, marketplaceId, dateFrom, dateTo]
    );

    logger.debug('Account daily KPI aggregated (per marketplace)', { accountId, marketplaceId });
  },

  /**
   * Aggregate account-level daily KPIs across ALL marketplaces (marketplace_id = NULL).
   * Uses the partial unique index (WHERE marketplace_id IS NULL).
   */
  async aggregateAccountDailyTotal(accountId, dateFrom, dateTo) {
    await db.query(
      `INSERT INTO account_daily_kpi (
        account_id, marketplace_id, kpi_date,
        units_sold, orders_count, revenue, total_amazon_fees, refunds,
        ads_spend, total_product_costs, net_profit,
        margin_pct, roi_pct, acos_pct, tacos_pct, currency, computed_at
      )
      SELECT
        account_id,
        NULL AS marketplace_id,
        kpi_date,
        SUM(units_sold),
        SUM(orders_count),
        SUM(revenue),
        SUM(total_amazon_fees),
        SUM(refunds),
        SUM(ads_spend),
        SUM(total_product_costs),
        SUM(net_profit),
        CASE WHEN SUM(revenue) > 0
          THEN LEAST(9999.9999, GREATEST(-9999.9999,
            ROUND((SUM(net_profit) / SUM(revenue)) * 100, 4))) ELSE 0 END,
        CASE WHEN SUM(total_product_costs + ads_spend) > 0
          THEN LEAST(9999.9999, GREATEST(-9999.9999,
            ROUND((SUM(net_profit) / SUM(total_product_costs + ads_spend)) * 100, 4))) ELSE 0 END,
        CASE WHEN SUM(ads_spend) > 0 AND SUM(revenue) > 0
          THEN LEAST(9999.9999,
            ROUND((SUM(ads_spend) / SUM(revenue)) * 100, 4)) ELSE 0 END,
        CASE WHEN SUM(revenue) > 0
          THEN LEAST(9999.9999,
            ROUND((SUM(ads_spend) / SUM(revenue)) * 100, 4)) ELSE 0 END,
        'EUR',
        NOW()
      FROM account_daily_kpi
      WHERE account_id = $1
        AND marketplace_id IS NOT NULL
        AND kpi_date >= $2 AND kpi_date < $3
      GROUP BY account_id, kpi_date
      ON CONFLICT (account_id, kpi_date)
        WHERE marketplace_id IS NULL
      DO UPDATE SET
        units_sold = EXCLUDED.units_sold,
        orders_count = EXCLUDED.orders_count,
        revenue = EXCLUDED.revenue,
        total_amazon_fees = EXCLUDED.total_amazon_fees,
        refunds = EXCLUDED.refunds,
        ads_spend = EXCLUDED.ads_spend,
        total_product_costs = EXCLUDED.total_product_costs,
        net_profit = EXCLUDED.net_profit,
        margin_pct = EXCLUDED.margin_pct,
        roi_pct = EXCLUDED.roi_pct,
        acos_pct = EXCLUDED.acos_pct,
        tacos_pct = EXCLUDED.tacos_pct,
        computed_at = NOW()`,
      [accountId, dateFrom, dateTo]
    );

    logger.debug('Account daily KPI aggregated (all marketplaces)', { accountId });
  },

  // ---- Query methods for API ----

  /**
   * Get ASIN dashboard data: daily metrics with filters.
   */
  async getAsinDashboard({ accountId, marketplaceId, asin, dateFrom, dateTo, page = 1, limit = 50 }) {
    const conditions = ['adm.account_id = $1'];
    const params = [accountId];
    let idx = 2;

    if (marketplaceId) {
      conditions.push(`adm.marketplace_id = $${idx}`);
      params.push(marketplaceId);
      idx++;
    }
    if (asin) {
      conditions.push(`adm.asin = $${idx}`);
      params.push(asin);
      idx++;
    }
    if (dateFrom) {
      conditions.push(`adm.metric_date >= $${idx}`);
      params.push(dateFrom);
      idx++;
    }
    if (dateTo) {
      conditions.push(`adm.metric_date <= $${idx}`);
      params.push(dateTo);
      idx++;
    }

    const offset = (page - 1) * limit;

    const [dataResult, countResult] = await Promise.all([
      db.query(
        `SELECT adm.*, m.country_code, m.name AS marketplace_name,
                a_info.title AS asin_title
         FROM asin_daily_metrics adm
         LEFT JOIN marketplaces m ON m.id = adm.marketplace_id
         LEFT JOIN asins a_info ON a_info.account_id = adm.account_id AND a_info.asin = adm.asin
         WHERE ${conditions.join(' AND ')}
         ORDER BY adm.metric_date DESC, adm.revenue DESC
         LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, limit, offset]
      ),
      db.query(
        `SELECT COUNT(*) FROM asin_daily_metrics adm WHERE ${conditions.join(' AND ')}`,
        params
      ),
    ]);

    return {
      data: dataResult.rows,
      pagination: {
        page,
        limit,
        total: parseInt(countResult.rows[0].count, 10),
      },
    };
  },

  /**
   * Get account dashboard data: daily KPIs.
   */
  async getAccountDashboard({ accountId, marketplaceId, dateFrom, dateTo }) {
    const conditions = ['adk.account_id = $1'];
    const params = [accountId];
    let idx = 2;

    if (marketplaceId) {
      conditions.push(`adk.marketplace_id = $${idx}`);
      params.push(marketplaceId);
      idx++;
    } else {
      conditions.push('adk.marketplace_id IS NULL'); // aggregated across all marketplaces
    }

    if (dateFrom) {
      conditions.push(`adk.kpi_date >= $${idx}`);
      params.push(dateFrom);
      idx++;
    }
    if (dateTo) {
      conditions.push(`adk.kpi_date <= $${idx}`);
      params.push(dateTo);
      idx++;
    }

    const result = await db.query(
      `SELECT adk.*, m.country_code, m.name AS marketplace_name
       FROM account_daily_kpi adk
       LEFT JOIN marketplaces m ON m.id = adk.marketplace_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY adk.kpi_date DESC`,
      params
    );

    // Also get summary totals
    const summary = await db.query(
      `SELECT
        SUM(units_sold) AS total_units,
        SUM(orders_count) AS total_orders,
        SUM(revenue) AS total_revenue,
        SUM(net_profit) AS total_profit,
        SUM(ads_spend) AS total_ads_spend,
        CASE WHEN SUM(revenue) > 0
          THEN ROUND((SUM(net_profit) / SUM(revenue)) * 100, 2)
          ELSE 0 END AS avg_margin,
        CASE WHEN SUM(ads_spend) > 0 AND SUM(revenue) > 0
          THEN ROUND((SUM(ads_spend) / SUM(revenue)) * 100, 2)
          ELSE 0 END AS avg_tacos
       FROM account_daily_kpi adk
       WHERE ${conditions.join(' AND ')}`,
      params
    );

    return {
      daily: result.rows,
      summary: summary.rows[0],
    };
  },
  /**
   * Get today's sales summary directly from orders_raw (real-time, no aggregation needed).
   * Uses marketplace timezone for accurate "today" boundary.
   */
  async getTodaySales(accountId) {
    // Per-marketplace breakdown
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
      WHERE o.account_id = $1
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
          END, 'UTC'))::date = CURRENT_DATE
        AND UPPER(o.order_status) NOT IN ('CANCELLED', 'CANCELED')
      GROUP BY m.country_code, m.name, o.currency
      ORDER BY gross_revenue DESC`,
      [accountId]
    );

    // Per-ASIN breakdown (top sellers today)
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
      WHERE o.account_id = $1
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
          END, 'UTC'))::date = CURRENT_DATE
        AND UPPER(o.order_status) NOT IN ('CANCELLED', 'CANCELED')
      GROUP BY o.asin, a.title, a.sku, m.country_code, o.currency
      ORDER BY units_sold DESC
      LIMIT 50`,
      [accountId]
    );

    // Totals
    const totals = byMarketplace.rows.reduce(
      (acc, row) => {
        acc.orders_count += parseInt(row.orders_count, 10);
        acc.units_sold += parseInt(row.units_sold, 10);
        acc.gross_revenue += parseFloat(row.gross_revenue || 0);
        return acc;
      },
      { orders_count: 0, units_sold: 0, gross_revenue: 0 }
    );
    totals.gross_revenue = round(totals.gross_revenue, 2);

    return {
      date: new Date().toISOString().slice(0, 10),
      totals,
      by_marketplace: byMarketplace.rows,
      by_asin: byAsin.rows,
    };
  },
};

module.exports = AggregationService;
