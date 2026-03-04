const db = require('../../database/pool');
const logger = require('../../utils/logger');
const SpApiClient = require('../../services/sp-api.client');
const AccountService = require('../accounts/account.service');

/**
 * Units Audit Service - diagnostic queries for comparing unit counts
 * across different data sources and counting methods.
 *
 * Compares:
 * - Strict mode (Seller Central): excludes only Cancelled, SUM(QuantityOrdered), timezone-aware
 * - Current system (profit engine): purchase_date < end exclusive
 * - order_profit table and asin_daily_metrics table
 * - Orphan detection and boundary analysis
 */
const UnitsAuditService = {
  /**
   * Run full audit for a given account, marketplace, and date range.
   * Returns results from 9 diagnostic queries.
   */
  async runAudit({ accountId, marketplaceId, dateFrom, dateTo, asin, timezone }) {
    const tz = timezone || 'UTC';
    const results = {};

    // 1. Strict mode count (like Seller Central)
    results.strictMode = await this.strictModeCount(accountId, marketplaceId, dateFrom, dateTo, asin, tz);

    // 2. Current system count (profit engine mode)
    results.systemMode = await this.systemModeCount(accountId, marketplaceId, dateFrom, dateTo, asin);

    // 3. order_profit table count
    results.orderProfitCount = await this.orderProfitCount(accountId, marketplaceId, dateFrom, dateTo, asin);

    // 4. asin_daily_metrics count
    results.asinMetricsCount = await this.asinMetricsCount(accountId, marketplaceId, dateFrom, dateTo, asin);

    // 5. Cancelled orders count (should be excluded)
    results.cancelledCount = await this.cancelledOrdersCount(accountId, marketplaceId, dateFrom, dateTo, asin);

    // 6. Pending orders count (should be excluded)
    results.pendingCount = await this.pendingOrdersCount(accountId, marketplaceId, dateFrom, dateTo, asin);

    // 7. Orphan order_profit records (no matching orders_raw)
    results.orphanProfitRecords = await this.orphanProfitRecords(accountId, marketplaceId, dateFrom, dateTo);

    // 8. Orders not yet computed (in orders_raw but not in order_profit)
    results.uncomputedOrders = await this.uncomputedOrders(accountId, marketplaceId, dateFrom, dateTo, asin);

    // 9. Timezone boundary analysis (orders that shift day when converting to local TZ)
    results.timezoneBoundaryOrders = await this.timezoneBoundaryOrders(accountId, marketplaceId, dateFrom, dateTo, tz);

    // Summary
    results.summary = {
      strictModeUnits: results.strictMode.total_units,
      systemModeUnits: results.systemMode.total_units,
      orderProfitUnits: results.orderProfitCount.total_units,
      asinMetricsUnits: results.asinMetricsCount.total_units,
      gap_strict_vs_system: results.strictMode.total_units - results.systemMode.total_units,
      gap_system_vs_profit: results.systemMode.total_units - results.orderProfitCount.total_units,
      cancelled: results.cancelledCount.count,
      pending: results.pendingCount.count,
      orphans: results.orphanProfitRecords.count,
      uncomputed: results.uncomputedOrders.count,
      timezoneBoundary: results.timezoneBoundaryOrders.count,
    };

    return results;
  },

  /**
   * 1. Strict mode: Seller Central-like count.
   * Excludes only Cancelled, uses timezone-aware date boundaries.
   */
  async strictModeCount(accountId, marketplaceId, dateFrom, dateTo, asin, tz) {
    const params = [accountId, marketplaceId, dateFrom, dateTo, tz];
    let asinFilter = '';
    if (asin) {
      asinFilter = 'AND asin = $6';
      params.push(asin);
    }

    const result = await db.query(
      `SELECT
        COUNT(*) AS total_orders,
        COALESCE(SUM(quantity), 0) AS total_units
       FROM orders_raw
       WHERE account_id = $1 AND marketplace_id = $2
         AND (purchase_date AT TIME ZONE $5)::date >= $3::date
         AND (purchase_date AT TIME ZONE $5)::date < $4::date
         AND UPPER(order_status) NOT IN ('CANCELLED', 'CANCELED', 'PENDING')
         ${asinFilter}`,
      params
    );
    return {
      total_orders: parseInt(result.rows[0].total_orders, 10),
      total_units: parseInt(result.rows[0].total_units, 10),
    };
  },

  /**
   * 2. System mode: current profit engine counting method.
   * Uses UTC purchase_date boundaries, excludes Cancelled + Pending.
   */
  async systemModeCount(accountId, marketplaceId, dateFrom, dateTo, asin) {
    const params = [accountId, marketplaceId, dateFrom, dateTo];
    let asinFilter = '';
    if (asin) {
      asinFilter = 'AND asin = $5';
      params.push(asin);
    }

    const result = await db.query(
      `SELECT
        COUNT(*) AS total_orders,
        COALESCE(SUM(quantity), 0) AS total_units
       FROM orders_raw
       WHERE account_id = $1 AND marketplace_id = $2
         AND purchase_date >= $3 AND purchase_date < $4
         AND UPPER(order_status) NOT IN ('CANCELLED', 'CANCELED', 'PENDING')
         ${asinFilter}`,
      params
    );
    return {
      total_orders: parseInt(result.rows[0].total_orders, 10),
      total_units: parseInt(result.rows[0].total_units, 10),
    };
  },

  /**
   * 3. order_profit table count.
   */
  async orderProfitCount(accountId, marketplaceId, dateFrom, dateTo, asin) {
    const params = [accountId, marketplaceId, dateFrom, dateTo];
    let asinFilter = '';
    if (asin) {
      asinFilter = 'AND asin = $5';
      params.push(asin);
    }

    const result = await db.query(
      `SELECT
        COUNT(*) AS total_orders,
        COALESCE(SUM(quantity), 0) AS total_units
       FROM order_profit
       WHERE account_id = $1 AND marketplace_id = $2
         AND order_date >= $3 AND order_date < $4
         ${asinFilter}`,
      params
    );
    return {
      total_orders: parseInt(result.rows[0].total_orders, 10),
      total_units: parseInt(result.rows[0].total_units, 10),
    };
  },

  /**
   * 4. asin_daily_metrics count.
   */
  async asinMetricsCount(accountId, marketplaceId, dateFrom, dateTo, asin) {
    const params = [accountId, marketplaceId, dateFrom, dateTo];
    let asinFilter = '';
    if (asin) {
      asinFilter = 'AND asin = $5';
      params.push(asin);
    }

    const result = await db.query(
      `SELECT
        COALESCE(SUM(units_sold), 0) AS total_units,
        COALESCE(SUM(orders_count), 0) AS total_orders
       FROM asin_daily_metrics
       WHERE account_id = $1 AND marketplace_id = $2
         AND metric_date >= $3 AND metric_date < $4
         ${asinFilter}`,
      params
    );
    return {
      total_orders: parseInt(result.rows[0].total_orders, 10),
      total_units: parseInt(result.rows[0].total_units, 10),
    };
  },

  /**
   * 5. Cancelled orders count.
   */
  async cancelledOrdersCount(accountId, marketplaceId, dateFrom, dateTo, asin) {
    const params = [accountId, marketplaceId, dateFrom, dateTo];
    let asinFilter = '';
    if (asin) {
      asinFilter = 'AND asin = $5';
      params.push(asin);
    }

    const result = await db.query(
      `SELECT COUNT(*) AS count, COALESCE(SUM(quantity), 0) AS units
       FROM orders_raw
       WHERE account_id = $1 AND marketplace_id = $2
         AND purchase_date >= $3 AND purchase_date < $4
         AND UPPER(order_status) IN ('CANCELLED', 'CANCELED')
         ${asinFilter}`,
      params
    );
    return {
      count: parseInt(result.rows[0].count, 10),
      units: parseInt(result.rows[0].units, 10),
    };
  },

  /**
   * 6. Pending orders count.
   */
  async pendingOrdersCount(accountId, marketplaceId, dateFrom, dateTo, asin) {
    const params = [accountId, marketplaceId, dateFrom, dateTo];
    let asinFilter = '';
    if (asin) {
      asinFilter = 'AND asin = $5';
      params.push(asin);
    }

    const result = await db.query(
      `SELECT COUNT(*) AS count, COALESCE(SUM(quantity), 0) AS units
       FROM orders_raw
       WHERE account_id = $1 AND marketplace_id = $2
         AND purchase_date >= $3 AND purchase_date < $4
         AND UPPER(order_status) = 'PENDING'
         ${asinFilter}`,
      params
    );
    return {
      count: parseInt(result.rows[0].count, 10),
      units: parseInt(result.rows[0].units, 10),
    };
  },

  /**
   * 7. Orphan order_profit records (no matching orders_raw entry).
   */
  async orphanProfitRecords(accountId, marketplaceId, dateFrom, dateTo) {
    const result = await db.query(
      `SELECT COUNT(*) AS count
       FROM order_profit op
       WHERE op.account_id = $1 AND op.marketplace_id = $2
         AND op.order_date >= $3 AND op.order_date < $4
         AND NOT EXISTS (
           SELECT 1 FROM orders_raw o
           WHERE o.account_id = op.account_id
             AND o.amazon_order_id = op.amazon_order_id
             AND o.asin = op.asin
         )`,
      [accountId, marketplaceId, dateFrom, dateTo]
    );
    return { count: parseInt(result.rows[0].count, 10) };
  },

  /**
   * 8. Orders in orders_raw but not yet in order_profit (uncomputed).
   */
  async uncomputedOrders(accountId, marketplaceId, dateFrom, dateTo, asin) {
    const params = [accountId, marketplaceId, dateFrom, dateTo];
    let asinFilter = '';
    if (asin) {
      asinFilter = 'AND o.asin = $5';
      params.push(asin);
    }

    const result = await db.query(
      `SELECT COUNT(*) AS count
       FROM orders_raw o
       WHERE o.account_id = $1 AND o.marketplace_id = $2
         AND o.purchase_date >= $3 AND o.purchase_date < $4
         AND UPPER(o.order_status) NOT IN ('CANCELLED', 'CANCELED', 'PENDING')
         ${asinFilter}
         AND NOT EXISTS (
           SELECT 1 FROM order_profit op
           WHERE op.account_id = o.account_id
             AND op.amazon_order_id = o.amazon_order_id
             AND op.asin = o.asin
         )`,
      params
    );
    return { count: parseInt(result.rows[0].count, 10) };
  },

  /**
   * 9. Orders at timezone boundary: orders whose date changes
   * when converting from UTC to local timezone.
   */
  async timezoneBoundaryOrders(accountId, marketplaceId, dateFrom, dateTo, tz) {
    const result = await db.query(
      `SELECT COUNT(*) AS count
       FROM orders_raw
       WHERE account_id = $1 AND marketplace_id = $2
         AND purchase_date >= $3 AND purchase_date < $4
         AND UPPER(order_status) NOT IN ('CANCELLED', 'CANCELED', 'PENDING')
         AND purchase_date::date != (purchase_date AT TIME ZONE $5)::date`,
      [accountId, marketplaceId, dateFrom, dateTo, tz]
    );
    return { count: parseInt(result.rows[0].count, 10) };
  },

  /**
   * Precision test: compare order-by-order for a single day.
   * Returns orders that are in one source but not the other.
   */
  async precisionTest(accountId, marketplaceId, date, timezone) {
    const tz = timezone || 'UTC';
    const nextDate = new Date(date);
    nextDate.setDate(nextDate.getDate() + 1);
    const nextDateStr = nextDate.toISOString().substring(0, 10);

    // Orders in DB for this day (system mode, UTC)
    const dbOrders = await db.query(
      `SELECT amazon_order_id, asin, quantity, order_status,
              purchase_date,
              purchase_date::date AS utc_date,
              (purchase_date AT TIME ZONE $5)::date AS local_date
       FROM orders_raw
       WHERE account_id = $1 AND marketplace_id = $2
         AND purchase_date >= $3 AND purchase_date < $4
         AND UPPER(order_status) NOT IN ('CANCELLED', 'CANCELED', 'PENDING')
       ORDER BY purchase_date`,
      [accountId, marketplaceId, date, nextDateStr, tz]
    );

    // Orders in order_profit for this day
    const profitOrders = await db.query(
      `SELECT amazon_order_id, asin, quantity, revenue, net_profit
       FROM order_profit
       WHERE account_id = $1 AND marketplace_id = $2
         AND order_date = $3
       ORDER BY amazon_order_id`,
      [accountId, marketplaceId, date]
    );

    // Find differences
    const dbSet = new Set(dbOrders.rows.map(r => `${r.amazon_order_id}:${r.asin}`));
    const profitSet = new Set(profitOrders.rows.map(r => `${r.amazon_order_id}:${r.asin}`));

    const inDbNotProfit = dbOrders.rows.filter(r => !profitSet.has(`${r.amazon_order_id}:${r.asin}`));
    const inProfitNotDb = profitOrders.rows.filter(r => !dbSet.has(`${r.amazon_order_id}:${r.asin}`));

    return {
      date,
      timezone: tz,
      dbOrdersCount: dbOrders.rows.length,
      profitOrdersCount: profitOrders.rows.length,
      inDbNotProfit: inDbNotProfit.length,
      inProfitNotDb: inProfitNotDb.length,
      missingFromProfit: inDbNotProfit,
      extraInProfit: inProfitNotDb,
      dbUnits: dbOrders.rows.reduce((s, r) => s + r.quantity, 0),
      profitUnits: profitOrders.rows.reduce((s, r) => s + r.quantity, 0),
    };
  },

  /**
   * Diagnose a specific ASIN: show all financial events, orders, and profit data.
   */
  async diagnoseAsin(accountId, marketplaceId, asin, dateFrom, dateTo) {
    const [orders, financials, profit, metrics] = await Promise.all([
      db.query(
        `SELECT amazon_order_id, quantity, item_price, item_tax,
                shipping_price, shipping_tax, promotion_discount,
                order_status, purchase_date
         FROM orders_raw
         WHERE account_id = $1 AND marketplace_id = $2 AND asin = $3
           AND purchase_date >= $4 AND purchase_date < $5
         ORDER BY purchase_date`,
        [accountId, marketplaceId, asin, dateFrom, dateTo]
      ),
      db.query(
        `SELECT amazon_order_id, event_type, fee_type, amount, event_date
         FROM financial_events_raw
         WHERE account_id = $1 AND marketplace_id = $2 AND asin = $3
           AND event_date >= $4 AND event_date < $5
         ORDER BY event_date, fee_type`,
        [accountId, marketplaceId, asin, dateFrom, dateTo]
      ),
      db.query(
        `SELECT amazon_order_id, order_date, quantity, revenue,
                referral_fee, fba_fee, other_amazon_fees, marketplace_facilitator_tax,
                refund_amount, ads_allocated, product_cost, total_costs, net_profit
         FROM order_profit
         WHERE account_id = $1 AND marketplace_id = $2 AND asin = $3
           AND order_date >= $4 AND order_date < $5
         ORDER BY order_date`,
        [accountId, marketplaceId, asin, dateFrom, dateTo]
      ),
      db.query(
        `SELECT metric_date, units_sold, revenue, total_amazon_fees, refunds,
                ads_spend, total_product_costs, net_profit, margin_pct
         FROM asin_daily_metrics
         WHERE account_id = $1 AND marketplace_id = $2 AND asin = $3
           AND metric_date >= $4 AND metric_date < $5
         ORDER BY metric_date`,
        [accountId, marketplaceId, asin, dateFrom, dateTo]
      ),
    ]);

    return {
      asin,
      orders: orders.rows,
      financialEvents: financials.rows,
      orderProfit: profit.rows,
      dailyMetrics: metrics.rows,
      summary: {
        totalOrders: orders.rows.filter(o => !['CANCELLED', 'CANCELED'].includes((o.order_status || '').toUpperCase())).length,
        totalUnits: orders.rows.filter(o => !['CANCELLED', 'CANCELED'].includes((o.order_status || '').toUpperCase())).reduce((s, r) => s + r.quantity, 0),
        totalRevenue: profit.rows.reduce((s, r) => s + parseFloat(r.revenue), 0),
        totalProfit: profit.rows.reduce((s, r) => s + parseFloat(r.net_profit), 0),
        totalFees: profit.rows.reduce((s, r) => s + parseFloat(r.referral_fee) + parseFloat(r.fba_fee) + parseFloat(r.other_amazon_fees), 0),
        financialEventsCount: financials.rows.length,
      },
    };
  },
};

module.exports = UnitsAuditService;
