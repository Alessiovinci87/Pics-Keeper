const db = require('../../database/pool');
const logger = require('../../utils/logger');
const { round, pct, roi, toDateStr } = require('../../utils/helpers');
const SyncLogger = require('../../services/sync-logger');

/**
 * Aggregation Engine - builds ASIN daily metrics and account daily KPIs
 * from order_profit and ads_daily_spend data.
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
      await this.aggregateAccountDaily(accountId, marketplaceId, dateFrom, dateTo);

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
   * Upserts into asin_daily_metrics.
   */
  async aggregateAsinDaily(accountId, marketplaceId, dateFrom, dateTo) {
    // This single query aggregates all order profit data and ads spend,
    // then upserts into asin_daily_metrics.
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
        SUM(op.quantity) AS units_sold,
        COUNT(DISTINCT op.amazon_order_id) AS orders_count,
        SUM(op.revenue) AS revenue,
        SUM(op.referral_fee + op.fba_fee + op.other_amazon_fees) AS total_amazon_fees,
        SUM(op.refund_amount) AS refunds,
        COALESCE(ads.total_spend, 0) AS ads_spend,
        SUM(op.product_cost + op.inbound_cost + op.customs_cost + op.prep_cost + op.packaging_cost + op.storage_allocated) AS total_product_costs,
        SUM(op.net_profit) AS net_profit,
        CASE WHEN SUM(op.revenue) > 0
          THEN ROUND((SUM(op.net_profit) / SUM(op.revenue)) * 100, 4)
          ELSE 0 END AS margin_pct,
        CASE WHEN SUM(op.product_cost + op.inbound_cost + op.customs_cost + op.prep_cost + op.packaging_cost + op.storage_allocated + op.ads_allocated) > 0
          THEN ROUND((SUM(op.net_profit) / SUM(op.product_cost + op.inbound_cost + op.customs_cost + op.prep_cost + op.packaging_cost + op.storage_allocated + op.ads_allocated)) * 100, 4)
          ELSE 0 END AS roi_pct,
        CASE WHEN COALESCE(ads.total_sales, 0) > 0
          THEN ROUND((COALESCE(ads.total_spend, 0) / ads.total_sales) * 100, 4)
          ELSE 0 END AS acos_pct,
        CASE WHEN SUM(op.revenue) > 0
          THEN ROUND((COALESCE(ads.total_spend, 0) / SUM(op.revenue)) * 100, 4)
          ELSE 0 END AS tacos_pct,
        op.currency,
        NOW() AS computed_at
      FROM order_profit op
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
   * Aggregate account-level daily KPIs per marketplace.
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
          THEN ROUND((SUM(net_profit) / SUM(revenue)) * 100, 4) ELSE 0 END,
        CASE WHEN SUM(total_product_costs + ads_spend) > 0
          THEN ROUND((SUM(net_profit) / SUM(total_product_costs + ads_spend)) * 100, 4) ELSE 0 END,
        CASE WHEN SUM(ads_spend) > 0 AND SUM(revenue) > 0
          THEN ROUND((SUM(ads_spend) / SUM(revenue)) * 100, 4) ELSE 0 END,
        CASE WHEN SUM(revenue) > 0
          THEN ROUND((SUM(ads_spend) / SUM(revenue)) * 100, 4) ELSE 0 END,
        currency,
        NOW()
      FROM asin_daily_metrics
      WHERE account_id = $1 AND marketplace_id = $2
        AND metric_date >= $3 AND metric_date < $4
      GROUP BY account_id, marketplace_id, metric_date, currency
      ON CONFLICT (account_id, marketplace_id, kpi_date) DO UPDATE SET
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
   * When marketplaceId is provided, queries per-marketplace rows directly.
   * When marketplaceId is omitted, dynamically aggregates across all marketplaces.
   */
  async getAccountDashboard({ accountId, marketplaceId, dateFrom, dateTo }) {
    const conditions = ['adk.account_id = $1', 'adk.marketplace_id IS NOT NULL'];
    const params = [accountId];
    let idx = 2;

    if (marketplaceId) {
      conditions.push(`adk.marketplace_id = $${idx}`);
      params.push(marketplaceId);
      idx++;
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

    const whereClause = conditions.join(' AND ');

    let result;
    if (marketplaceId) {
      result = await db.query(
        `SELECT adk.*, m.country_code, m.name AS marketplace_name
         FROM account_daily_kpi adk
         LEFT JOIN marketplaces m ON m.id = adk.marketplace_id
         WHERE ${whereClause}
         ORDER BY adk.kpi_date DESC`,
        params
      );
    } else {
      // Dynamically aggregate across all marketplaces per date
      result = await db.query(
        `SELECT
          adk.account_id,
          NULL::INTEGER AS marketplace_id,
          adk.kpi_date,
          SUM(adk.units_sold)::INTEGER AS units_sold,
          SUM(adk.orders_count)::INTEGER AS orders_count,
          SUM(adk.revenue) AS revenue,
          SUM(adk.total_amazon_fees) AS total_amazon_fees,
          SUM(adk.refunds) AS refunds,
          SUM(adk.ads_spend) AS ads_spend,
          SUM(adk.total_product_costs) AS total_product_costs,
          SUM(adk.net_profit) AS net_profit,
          CASE WHEN SUM(adk.revenue) > 0
            THEN ROUND((SUM(adk.net_profit) / SUM(adk.revenue)) * 100, 4) ELSE 0 END AS margin_pct,
          CASE WHEN SUM(adk.total_product_costs + adk.ads_spend) > 0
            THEN ROUND((SUM(adk.net_profit) / SUM(adk.total_product_costs + adk.ads_spend)) * 100, 4) ELSE 0 END AS roi_pct,
          CASE WHEN SUM(adk.revenue) > 0
            THEN ROUND((SUM(adk.ads_spend) / SUM(adk.revenue)) * 100, 4) ELSE 0 END AS acos_pct,
          CASE WHEN SUM(adk.revenue) > 0
            THEN ROUND((SUM(adk.ads_spend) / SUM(adk.revenue)) * 100, 4) ELSE 0 END AS tacos_pct,
          NULL AS currency,
          MAX(adk.computed_at) AS computed_at,
          NULL AS country_code,
          NULL AS marketplace_name
         FROM account_daily_kpi adk
         WHERE ${whereClause}
         GROUP BY adk.account_id, adk.kpi_date
         ORDER BY adk.kpi_date DESC`,
        params
      );
    }

    // Summary totals (works for both cases using the same WHERE)
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
       WHERE ${whereClause}`,
      params
    );

    return {
      daily: result.rows,
      summary: summary.rows[0],
    };
  },
};

module.exports = AggregationService;
