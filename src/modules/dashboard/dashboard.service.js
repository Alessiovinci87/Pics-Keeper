const db = require('../../database/pool');
const logger = require('../../utils/logger');

const VALID_ASIN_SORT = ['units', 'revenue', 'profit', 'roi', 'acos'];
const SORT_COLUMN_MAP = {
  units: 'total_units',
  revenue: 'total_revenue',
  profit: 'total_profit',
  roi: 'avg_roi',
  acos: 'avg_acos',
};

/**
 * Dashboard Service - read-only aggregated queries for dashboard APIs.
 * Separated from AggregationService to keep query layer independent.
 */
const DashboardService = {
  /**
   * GET /api/dashboard/asin
   *
   * Aggregates asin_daily_metrics grouped by ASIN over a date range.
   * Returns SUM(units_sold), SUM(revenue), SUM(net_profit),
   * AVG(margin_pct), AVG(roi_pct), AVG(acos_pct) per ASIN.
   *
   * Uses index: idx_asin_metrics_lookup (account_id, marketplace_id, asin, metric_date)
   * The WHERE filters on account_id + optional marketplace_id + metric_date range
   * are fully covered by this composite index.
   */
  async getAsinAggregated({
    accountId,
    marketplaceId = null,
    dateFrom = null,
    dateTo = null,
    sortBy = 'revenue',
    sortDir = 'desc',
    limit = 50,
    offset = 0,
  }) {
    const conditions = ['adm.account_id = $1'];
    const params = [accountId];
    let idx = 2;

    if (marketplaceId) {
      conditions.push(`adm.marketplace_id = $${idx}`);
      params.push(marketplaceId);
      idx++;
    }

    // Default: last 30 days
    const effectiveDateFrom = dateFrom || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const effectiveDateTo = dateTo || new Date().toISOString().slice(0, 10);

    conditions.push(`adm.metric_date >= $${idx}`);
    params.push(effectiveDateFrom);
    idx++;

    conditions.push(`adm.metric_date <= $${idx}`);
    params.push(effectiveDateTo);
    idx++;

    // Validate and resolve sort column
    const sortCol = SORT_COLUMN_MAP[VALID_ASIN_SORT.includes(sortBy) ? sortBy : 'revenue'];
    const direction = sortDir === 'asc' ? 'ASC' : 'DESC';

    // Sanitize pagination
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
    const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);

    const whereClause = conditions.join(' AND ');

    const [dataResult, countResult] = await Promise.all([
      db.query(
        `SELECT
          adm.asin,
          SUM(adm.units_sold)   AS total_units,
          SUM(adm.revenue)      AS total_revenue,
          SUM(adm.net_profit)   AS total_profit,
          AVG(adm.margin_pct)   AS avg_margin,
          AVG(adm.roi_pct)      AS avg_roi,
          AVG(adm.acos_pct)     AS avg_acos
        FROM asin_daily_metrics adm
        WHERE ${whereClause}
        GROUP BY adm.asin
        ORDER BY ${sortCol} ${direction}
        LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, safeLimit, safeOffset]
      ),
      db.query(
        `SELECT COUNT(DISTINCT adm.asin) AS total
         FROM asin_daily_metrics adm
         WHERE ${whereClause}`,
        params
      ),
    ]);

    logger.debug('ASIN aggregated dashboard query', {
      accountId, rows: dataResult.rowCount,
    });

    return {
      data: dataResult.rows,
      pagination: {
        limit: safeLimit,
        offset: safeOffset,
        total: parseInt(countResult.rows[0].total, 10),
      },
      filters: {
        accountId,
        marketplaceId,
        dateFrom: effectiveDateFrom,
        dateTo: effectiveDateTo,
        sortBy,
        sortDir: direction.toLowerCase(),
      },
    };
  },

  /**
   * GET /api/dashboard/account
   *
   * Aggregates account_daily_kpi over a date range with profit-weighted percentages.
   *
   * Weighted margin = SUM(net_profit) / SUM(revenue) * 100
   * Weighted ROI    = SUM(net_profit) / SUM(total_product_costs + ads_spend) * 100
   * Weighted ACOS   = SUM(ads_spend) / SUM(revenue) * 100
   *
   * Uses index: idx_account_kpi_mp (account_id, marketplace_id, kpi_date)
   * or idx_account_kpi_lookup (account_id, kpi_date) when no marketplace filter.
   */
  async getAccountAggregated({
    accountId,
    marketplaceId = null,
    dateFrom = null,
    dateTo = null,
    sortBy = 'revenue',
    sortDir = 'desc',
    limit = 50,
    offset = 0,
  }) {
    const conditions = ['adk.account_id = $1'];
    const params = [accountId];
    let idx = 2;

    if (marketplaceId) {
      conditions.push(`adk.marketplace_id = $${idx}`);
      params.push(marketplaceId);
      idx++;
    } else {
      conditions.push('adk.marketplace_id IS NULL');
    }

    const effectiveDateFrom = dateFrom || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const effectiveDateTo = dateTo || new Date().toISOString().slice(0, 10);

    conditions.push(`adk.kpi_date >= $${idx}`);
    params.push(effectiveDateFrom);
    idx++;

    conditions.push(`adk.kpi_date <= $${idx}`);
    params.push(effectiveDateTo);
    idx++;

    const whereClause = conditions.join(' AND ');

    // Sanitize pagination
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
    const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);

    const [summaryResult, dailyResult, countResult] = await Promise.all([
      // Weighted aggregation in a single pass
      db.query(
        `SELECT
          SUM(adk.units_sold)       AS total_units,
          SUM(adk.revenue)          AS total_revenue,
          SUM(adk.net_profit)       AS total_net_profit,
          SUM(adk.ads_spend)        AS total_ads_spend,
          SUM(adk.total_product_costs) AS total_product_costs,
          SUM(adk.orders_count)     AS total_orders,
          CASE WHEN SUM(adk.revenue) > 0
            THEN ROUND((SUM(adk.net_profit) / SUM(adk.revenue)) * 100, 2)
            ELSE 0 END              AS weighted_margin_pct,
          CASE WHEN SUM(adk.total_product_costs + adk.ads_spend) > 0
            THEN ROUND((SUM(adk.net_profit) / SUM(adk.total_product_costs + adk.ads_spend)) * 100, 2)
            ELSE 0 END              AS weighted_roi_pct,
          CASE WHEN SUM(adk.revenue) > 0
            THEN ROUND((SUM(adk.ads_spend) / SUM(adk.revenue)) * 100, 2)
            ELSE 0 END              AS weighted_acos_pct
        FROM account_daily_kpi adk
        WHERE ${whereClause}`,
        params
      ),
      // Daily breakdown with pagination
      db.query(
        `SELECT
          adk.kpi_date,
          adk.units_sold,
          adk.orders_count,
          adk.revenue,
          adk.net_profit,
          adk.ads_spend,
          adk.margin_pct,
          adk.roi_pct,
          adk.acos_pct,
          adk.tacos_pct,
          adk.total_amazon_fees,
          adk.refunds,
          adk.total_product_costs,
          adk.currency
        FROM account_daily_kpi adk
        WHERE ${whereClause}
        ORDER BY adk.kpi_date DESC
        LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, safeLimit, safeOffset]
      ),
      db.query(
        `SELECT COUNT(*) AS total
         FROM account_daily_kpi adk
         WHERE ${whereClause}`,
        params
      ),
    ]);

    logger.debug('Account aggregated dashboard query', {
      accountId, days: dailyResult.rowCount,
    });

    return {
      summary: summaryResult.rows[0],
      daily: dailyResult.rows,
      pagination: {
        limit: safeLimit,
        offset: safeOffset,
        total: parseInt(countResult.rows[0].total, 10),
      },
      filters: {
        accountId,
        marketplaceId,
        dateFrom: effectiveDateFrom,
        dateTo: effectiveDateTo,
      },
    };
  },

  /**
   * GET /api/order/:orderId
   *
   * Returns full profit breakdown from order_profit for a single order.
   *
   * Uses index: idx_order_profit_order (amazon_order_id) for the lookup,
   * combined with account_id filter using idx_order_profit_lookup.
   */
  async getOrderBreakdown(accountId, orderId) {
    const result = await db.query(
      `SELECT
        op.amazon_order_id,
        op.asin,
        op.order_date,
        op.quantity,
        op.revenue,
        op.referral_fee,
        op.fba_fee,
        op.other_amazon_fees,
        op.refund_amount,
        op.ads_allocated,
        op.product_cost,
        op.inbound_cost,
        op.customs_cost,
        op.prep_cost,
        op.packaging_cost,
        op.storage_allocated,
        op.total_costs,
        op.net_profit,
        op.margin_pct,
        op.roi_pct,
        op.currency,
        op.computed_at,
        m.country_code,
        m.name AS marketplace_name
      FROM order_profit op
      LEFT JOIN marketplaces m ON m.id = op.marketplace_id
      WHERE op.account_id = $1 AND op.amazon_order_id = $2
      ORDER BY op.asin`,
      [accountId, orderId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    // Build order-level totals from all line items
    const items = result.rows;
    const totals = items.reduce((acc, item) => {
      acc.revenue += parseFloat(item.revenue || 0);
      acc.referralFee += parseFloat(item.referral_fee || 0);
      acc.fbaFee += parseFloat(item.fba_fee || 0);
      acc.otherAmazonFees += parseFloat(item.other_amazon_fees || 0);
      acc.refundAmount += parseFloat(item.refund_amount || 0);
      acc.adsAllocated += parseFloat(item.ads_allocated || 0);
      acc.productCost += parseFloat(item.product_cost || 0);
      acc.inboundCost += parseFloat(item.inbound_cost || 0);
      acc.customsCost += parseFloat(item.customs_cost || 0);
      acc.prepCost += parseFloat(item.prep_cost || 0);
      acc.packagingCost += parseFloat(item.packaging_cost || 0);
      acc.storageAllocated += parseFloat(item.storage_allocated || 0);
      acc.totalCosts += parseFloat(item.total_costs || 0);
      acc.netProfit += parseFloat(item.net_profit || 0);
      acc.quantity += parseInt(item.quantity || 0, 10);
      return acc;
    }, {
      revenue: 0, referralFee: 0, fbaFee: 0, otherAmazonFees: 0,
      refundAmount: 0, adsAllocated: 0, productCost: 0, inboundCost: 0,
      customsCost: 0, prepCost: 0, packagingCost: 0, storageAllocated: 0,
      totalCosts: 0, netProfit: 0, quantity: 0,
    });

    // Weighted margin/ROI at order level
    totals.marginPct = totals.revenue > 0
      ? Math.round((totals.netProfit / totals.revenue) * 10000) / 100
      : 0;
    totals.roiPct = totals.totalCosts > 0
      ? Math.round((totals.netProfit / totals.totalCosts) * 10000) / 100
      : 0;

    return {
      orderId: items[0].amazon_order_id,
      orderDate: items[0].order_date,
      marketplace: items[0].marketplace_name,
      countryCode: items[0].country_code,
      currency: items[0].currency,
      items,
      totals,
    };
  },
};

module.exports = DashboardService;
