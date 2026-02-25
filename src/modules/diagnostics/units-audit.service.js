const db = require('../../database/pool');
const logger = require('../../utils/logger');
const SpApiClient = require('../../services/sp-api.client');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * Marketplace timezone mapping.
 * Used to convert local dates to UTC for querying.
 */
const MARKETPLACE_TIMEZONES = {
  IT: 'Europe/Rome',
  DE: 'Europe/Berlin',
  FR: 'Europe/Paris',
  ES: 'Europe/Madrid',
  GB: 'Europe/London',
  NL: 'Europe/Amsterdam',
  SE: 'Europe/Stockholm',
  PL: 'Europe/Warsaw',
  TR: 'Europe/Istanbul',
  BE: 'Europe/Brussels',
  US: 'America/Los_Angeles',
  CA: 'America/Toronto',
};

/**
 * Units Audit Service — strict-mode unit counting that replicates
 * Seller Central "Sales Snapshot" logic for comparison.
 *
 * Seller Central counts:
 *  - Filter by PurchaseDate (order creation date)
 *  - Include ALL statuses EXCEPT Canceled
 *  - Sum QuantityOrdered (not count of orders)
 *  - Date boundaries in marketplace local timezone
 */
const UnitsAuditService = {
  /**
   * Full audit: compare strict-mode count vs current system at every stage.
   *
   * @param {Object} params
   * @param {number} params.accountId
   * @param {number|null} params.marketplaceId - internal marketplace ID (null = all)
   * @param {string|null} params.countryCode - for timezone conversion
   * @param {string} params.dateFrom - local date YYYY-MM-DD
   * @param {string} params.dateTo - local date YYYY-MM-DD
   * @param {string|null} params.asin - filter single ASIN (optional)
   */
  async auditUnitsFromDB({ accountId, marketplaceId, countryCode, dateFrom, dateTo, asin }) {
    const tz = (countryCode && MARKETPLACE_TIMEZONES[countryCode]) || 'Europe/Rome';

    // Convert local marketplace dates to UTC for querying purchase_date
    const utcFrom = dayjs.tz(dateFrom, tz).startOf('day').utc().toISOString();
    const utcTo = dayjs.tz(dateTo, tz).endOf('day').utc().toISOString();

    // Build common filter parts
    const mpFilter = marketplaceId ? 'AND marketplace_id = $2' : '';
    const asinFilter = asin ? `AND asin = $${marketplaceId ? 3 : 2}` : '';
    const baseParams = marketplaceId
      ? (asin ? [accountId, marketplaceId, asin] : [accountId, marketplaceId])
      : (asin ? [accountId, asin] : [accountId]);

    // Date param indices
    const dateIdx = baseParams.length + 1;

    // ──────────────────────────────────────────────────────────
    // 1. STRICT MODE: Seller Central style (exclude only canceled)
    // ──────────────────────────────────────────────────────────
    const strictResult = await db.query(
      `SELECT
        COUNT(*) AS order_lines,
        COUNT(DISTINCT amazon_order_id) AS distinct_orders,
        SUM(quantity) AS total_units,
        MIN(purchase_date) AS earliest,
        MAX(purchase_date) AS latest
       FROM orders_raw
       WHERE account_id = $1 ${mpFilter} ${asinFilter}
         AND purchase_date >= $${dateIdx} AND purchase_date <= $${dateIdx + 1}
         AND LOWER(order_status) NOT LIKE '%cancel%'`,
      [...baseParams, utcFrom, utcTo]
    );

    // ──────────────────────────────────────────────────────────
    // 2. CURRENT SYSTEM: what profit engine uses (old logic)
    // ──────────────────────────────────────────────────────────
    const currentResult = await db.query(
      `SELECT
        COUNT(*) AS order_lines,
        SUM(quantity) AS total_units
       FROM orders_raw
       WHERE account_id = $1 ${mpFilter} ${asinFilter}
         AND purchase_date >= $${dateIdx} AND purchase_date < $${dateIdx + 1}
         AND order_status NOT IN ('Cancelled', 'Pending')`,
      [...baseParams, utcFrom, utcTo]
    );

    // ──────────────────────────────────────────────────────────
    // 3. BREAKDOWN BY STATUS (all statuses, no filter)
    // ──────────────────────────────────────────────────────────
    const byStatus = await db.query(
      `SELECT
        order_status,
        COUNT(*) AS order_lines,
        COUNT(DISTINCT amazon_order_id) AS distinct_orders,
        SUM(quantity) AS total_units
       FROM orders_raw
       WHERE account_id = $1 ${mpFilter} ${asinFilter}
         AND purchase_date >= $${dateIdx} AND purchase_date <= $${dateIdx + 1}
       GROUP BY order_status
       ORDER BY SUM(quantity) DESC`,
      [...baseParams, utcFrom, utcTo]
    );

    // ──────────────────────────────────────────────────────────
    // 4. BREAKDOWN BY MARKETPLACE (strict mode)
    // ──────────────────────────────────────────────────────────
    const byMarketplace = await db.query(
      `SELECT
        m.country_code,
        COUNT(*) AS order_lines,
        COUNT(DISTINCT o.amazon_order_id) AS distinct_orders,
        SUM(o.quantity) AS total_units
       FROM orders_raw o
       JOIN marketplaces m ON m.id = o.marketplace_id
       WHERE o.account_id = $1 ${mpFilter ? 'AND o.marketplace_id = $2' : ''} ${asinFilter ? `AND o.asin = $${marketplaceId ? 3 : 2}` : ''}
         AND o.purchase_date >= $${dateIdx} AND o.purchase_date <= $${dateIdx + 1}
         AND LOWER(o.order_status) NOT LIKE '%cancel%'
       GROUP BY m.country_code
       ORDER BY SUM(o.quantity) DESC`,
      [...baseParams, utcFrom, utcTo]
    );

    // ──────────────────────────────────────────────────────────
    // 5. DAILY BREAKDOWN (in marketplace local time)
    // ──────────────────────────────────────────────────────────
    const daily = await db.query(
      `SELECT
        (purchase_date AT TIME ZONE 'UTC' AT TIME ZONE $${dateIdx + 2})::date AS local_date,
        COUNT(*) AS order_lines,
        COUNT(DISTINCT amazon_order_id) AS distinct_orders,
        SUM(quantity) AS total_units
       FROM orders_raw
       WHERE account_id = $1 ${mpFilter} ${asinFilter}
         AND purchase_date >= $${dateIdx} AND purchase_date <= $${dateIdx + 1}
         AND LOWER(order_status) NOT LIKE '%cancel%'
       GROUP BY (purchase_date AT TIME ZONE 'UTC' AT TIME ZONE $${dateIdx + 2})::date
       ORDER BY local_date`,
      [...baseParams, utcFrom, utcTo, tz]
    );

    // ──────────────────────────────────────────────────────────
    // 6. WHAT'S IN order_profit TABLE
    // ──────────────────────────────────────────────────────────
    const profitResult = await db.query(
      `SELECT
        COUNT(*) AS order_lines,
        SUM(quantity) AS total_units
       FROM order_profit
       WHERE account_id = $1 ${mpFilter} ${asinFilter}
         AND order_date >= $${dateIdx} AND order_date <= $${dateIdx + 1}`,
      [...baseParams, dateFrom, dateTo]
    );

    // ──────────────────────────────────────────────────────────
    // 7. WHAT'S IN asin_daily_metrics
    // ──────────────────────────────────────────────────────────
    const metricsResult = await db.query(
      `SELECT
        SUM(units_sold) AS total_units,
        SUM(orders_count) AS total_orders
       FROM asin_daily_metrics
       WHERE account_id = $1 ${mpFilter} ${asinFilter}
         AND metric_date >= $${dateIdx} AND metric_date <= $${dateIdx + 1}`,
      [...baseParams, dateFrom, dateTo]
    );

    // ──────────────────────────────────────────────────────────
    // 8. ORPHANED CANCELLED IN order_profit
    // ──────────────────────────────────────────────────────────
    const orphanResult = await db.query(
      `SELECT
        COUNT(*) AS orphan_records,
        SUM(op.quantity) AS orphan_units
       FROM order_profit op
       JOIN orders_raw o ON o.account_id = op.account_id
         AND o.amazon_order_id = op.amazon_order_id AND o.asin = op.asin
       WHERE op.account_id = $1 ${mpFilter ? 'AND op.marketplace_id = $2' : ''}
         AND LOWER(o.order_status) LIKE '%cancel%'`,
      marketplaceId ? [accountId, marketplaceId] : [accountId]
    );

    // ──────────────────────────────────────────────────────────
    // 9. ORDERS IN DB BUT OUTSIDE COMPUTE WINDOW
    // ──────────────────────────────────────────────────────────
    const outsideWindow = await db.query(
      `SELECT
        COUNT(*) AS order_lines,
        SUM(o.quantity) AS total_units,
        MIN(o.purchase_date) AS earliest,
        MAX(o.purchase_date) AS latest
       FROM orders_raw o
       LEFT JOIN order_profit op ON op.account_id = o.account_id
         AND op.amazon_order_id = o.amazon_order_id AND op.asin = o.asin
       WHERE o.account_id = $1 ${mpFilter ? 'AND o.marketplace_id = $2' : ''} ${asinFilter ? `AND o.asin = $${marketplaceId ? 3 : 2}` : ''}
         AND o.purchase_date >= $${dateIdx} AND o.purchase_date <= $${dateIdx + 1}
         AND LOWER(o.order_status) NOT LIKE '%cancel%'
         AND op.id IS NULL`,
      [...baseParams, utcFrom, utcTo]
    );

    // ──────────────────────────────────────────────────────────
    // BUILD RESPONSE
    // ──────────────────────────────────────────────────────────
    const strictTotal = parseInt(strictResult.rows[0].total_units || 0, 10);
    const currentTotal = parseInt(currentResult.rows[0].total_units || 0, 10);
    const profitTotal = parseInt(profitResult.rows[0].total_units || 0, 10);
    const metricsTotal = parseInt(metricsResult.rows[0].total_units || 0, 10);
    const outsideTotal = parseInt(outsideWindow.rows[0].total_units || 0, 10);

    return {
      strict_mode: {
        total_units: strictTotal,
        distinct_orders: parseInt(strictResult.rows[0].distinct_orders || 0, 10),
        order_lines: parseInt(strictResult.rows[0].order_lines, 10),
        earliest_order: strictResult.rows[0].earliest,
        latest_order: strictResult.rows[0].latest,
        query_range_utc: { from: utcFrom, to: utcTo },
        query_range_local: { from: dateFrom, to: dateTo },
        marketplace_timezone: tz,
        logic: 'PurchaseDate, exclude only Canceled, SUM(QuantityOrdered), TZ-aware boundaries',
      },
      current_profit_engine: {
        total_units: currentTotal,
        order_lines: parseInt(currentResult.rows[0].order_lines, 10),
        logic: "Current: excludes 'Cancelled' AND 'Pending' (case-sensitive), purchase_date < end (exclusive)",
      },
      order_profit_table: {
        total_units: profitTotal,
        order_lines: parseInt(profitResult.rows[0].order_lines, 10),
      },
      asin_daily_metrics: {
        total_units: metricsTotal,
        total_orders: parseInt(metricsResult.rows[0].total_orders || 0, 10),
      },
      gaps: {
        strict_vs_current_engine: strictTotal - currentTotal,
        strict_vs_order_profit: strictTotal - profitTotal,
        strict_vs_metrics: strictTotal - metricsTotal,
        orders_in_raw_but_not_profit: outsideTotal,
        orphan_cancelled_in_profit: parseInt(orphanResult.rows[0].orphan_units || 0, 10),
        explanation: [
          strictTotal - currentTotal > 0
            ? `+${strictTotal - currentTotal} units: Pending/status-case orders excluded by current engine`
            : null,
          outsideTotal > 0
            ? `+${outsideTotal} units: orders in orders_raw but MISSING from order_profit (not computed)`
            : null,
          parseInt(orphanResult.rows[0].orphan_units || 0, 10) > 0
            ? `-${orphanResult.rows[0].orphan_units} units: cancelled orders still in order_profit`
            : null,
        ].filter(Boolean),
      },
      breakdown_by_status: byStatus.rows.map(r => ({
        status: r.order_status,
        order_lines: parseInt(r.order_lines, 10),
        distinct_orders: parseInt(r.distinct_orders, 10),
        total_units: parseInt(r.total_units, 10),
      })),
      breakdown_by_marketplace: byMarketplace.rows.map(r => ({
        country: r.country_code,
        order_lines: parseInt(r.order_lines, 10),
        distinct_orders: parseInt(r.distinct_orders, 10),
        total_units: parseInt(r.total_units, 10),
      })),
      daily_breakdown: daily.rows.map(r => ({
        date: r.local_date,
        order_lines: parseInt(r.order_lines, 10),
        distinct_orders: parseInt(r.distinct_orders, 10),
        total_units: parseInt(r.total_units, 10),
      })),
    };
  },

  /**
   * Live count from SP-API for a single marketplace.
   * Calls searchOrders with full pagination and counts everything.
   *
   * WARNING: Slow due to API rate limits. Use for verification, not routine checks.
   */
  async auditUnitsFromAPI(target, dateFrom, dateTo) {
    const tz = MARKETPLACE_TIMEZONES[target.country_code] || 'Europe/Rome';
    const utcFrom = dayjs.tz(dateFrom, tz).startOf('day').utc().toISOString();
    const utcTo = dayjs.tz(dateTo, tz).endOf('day').utc().toISOString();

    const spApi = new SpApiClient(target);
    let paginationToken = null;
    let page = 0;

    const stats = {
      totalOrders: 0,
      totalItems: 0,
      totalQuantity: 0,
      byStatus: {},
      canceledQuantity: 0,
      sampleStatuses: new Set(),
    };

    do {
      page++;
      const response = await spApi.searchOrders({
        marketplaceIds: [target.amazon_marketplace_id],
        createdAfter: utcFrom,
        createdBefore: utcTo,
        paginationToken,
      });

      const orders = response.orders || [];
      stats.totalOrders += orders.length;

      for (const order of orders) {
        const status = order.fulfillment?.fulfillmentStatus || 'UNKNOWN';
        stats.sampleStatuses.add(status);

        if (!stats.byStatus[status]) {
          stats.byStatus[status] = { orders: 0, items: 0, quantity: 0 };
        }
        stats.byStatus[status].orders++;

        const items = order.orderItems || [];
        stats.totalItems += items.length;
        stats.byStatus[status].items += items.length;

        for (const item of items) {
          const qty = item.quantityOrdered || 1;
          stats.totalQuantity += qty;
          stats.byStatus[status].quantity += qty;
        }

        if (status.toLowerCase().includes('cancel')) {
          for (const item of items) {
            stats.canceledQuantity += item.quantityOrdered || 1;
          }
        }
      }

      paginationToken = response.pagination?.nextToken || null;
      logger.info(`Audit SP-API ${target.country_code} page ${page}: ${stats.totalOrders} orders, ${stats.totalQuantity} units so far`);
    } while (paginationToken);

    return {
      sp_api: {
        total_orders: stats.totalOrders,
        total_items: stats.totalItems,
        total_quantity_all: stats.totalQuantity,
        total_quantity_excl_canceled: stats.totalQuantity - stats.canceledQuantity,
        canceled_quantity: stats.canceledQuantity,
        pages_fetched: page,
        date_range_utc: { from: utcFrom, to: utcTo },
        date_range_local: { from: dateFrom, to: dateTo },
        marketplace: target.country_code,
        marketplace_timezone: tz,
      },
      by_status: stats.byStatus,
      status_values_seen: [...stats.sampleStatuses],
    };
  },

  /**
   * Single-day, single-marketplace, single-ASIN precision test.
   * Compares SP-API live data with DB data for exact matching.
   */
  async precisionTest(target, date, asin) {
    const tz = MARKETPLACE_TIMEZONES[target.country_code] || 'Europe/Rome';
    const utcFrom = dayjs.tz(date, tz).startOf('day').utc().toISOString();
    const utcTo = dayjs.tz(date, tz).endOf('day').utc().toISOString();

    // DB data
    const dbResult = await db.query(
      `SELECT
        amazon_order_id, asin, quantity, order_status,
        purchase_date, item_price, item_tax
       FROM orders_raw
       WHERE account_id = $1 AND marketplace_id = $2
         AND purchase_date >= $3 AND purchase_date <= $4
         ${asin ? 'AND asin = $5' : ''}
       ORDER BY purchase_date`,
      asin
        ? [target.account_id, target.account_marketplace_id, utcFrom, utcTo, asin]
        : [target.account_id, target.account_marketplace_id, utcFrom, utcTo]
    );

    const dbOrders = dbResult.rows;
    const dbUnitsAll = dbOrders.reduce((sum, r) => sum + parseInt(r.quantity, 10), 0);
    const dbUnitsSeller = dbOrders
      .filter(r => !r.order_status.toLowerCase().includes('cancel'))
      .reduce((sum, r) => sum + parseInt(r.quantity, 10), 0);

    // SP-API live
    const spApi = new SpApiClient(target);
    let paginationToken = null;
    const apiOrders = [];

    do {
      const response = await spApi.searchOrders({
        marketplaceIds: [target.amazon_marketplace_id],
        createdAfter: utcFrom,
        createdBefore: utcTo,
        paginationToken,
      });

      for (const order of (response.orders || [])) {
        const status = order.fulfillment?.fulfillmentStatus || 'UNKNOWN';
        for (const item of (order.orderItems || [])) {
          if (asin && item.product?.asin !== asin) continue;
          apiOrders.push({
            orderId: order.orderId,
            asin: item.product?.asin,
            quantity: item.quantityOrdered || 1,
            status,
            createdTime: order.createdTime,
          });
        }
      }

      paginationToken = response.pagination?.nextToken || null;
    } while (paginationToken);

    const apiUnitsAll = apiOrders.reduce((sum, r) => sum + r.quantity, 0);
    const apiUnitsSeller = apiOrders
      .filter(r => !r.status.toLowerCase().includes('cancel'))
      .reduce((sum, r) => sum + r.quantity, 0);

    // Find differences
    const dbOrderIds = new Set(dbOrders.map(r => `${r.amazon_order_id}:${r.asin}`));
    const apiOrderIds = new Set(apiOrders.map(r => `${r.orderId}:${r.asin}`));

    const inApiNotDb = apiOrders.filter(r => !dbOrderIds.has(`${r.orderId}:${r.asin}`));
    const inDbNotApi = dbOrders.filter(r => !apiOrderIds.has(`${r.amazon_order_id}:${r.asin}`));

    return {
      test_params: {
        marketplace: target.country_code,
        date,
        asin: asin || 'ALL',
        timezone: tz,
        utc_range: { from: utcFrom, to: utcTo },
      },
      db: {
        total_lines: dbOrders.length,
        total_units_all: dbUnitsAll,
        total_units_excl_canceled: dbUnitsSeller,
        statuses: [...new Set(dbOrders.map(r => r.order_status))],
      },
      sp_api: {
        total_lines: apiOrders.length,
        total_units_all: apiUnitsAll,
        total_units_excl_canceled: apiUnitsSeller,
        statuses: [...new Set(apiOrders.map(r => r.status))],
      },
      comparison: {
        units_match: dbUnitsSeller === apiUnitsSeller,
        units_gap: apiUnitsSeller - dbUnitsSeller,
        in_api_not_db: inApiNotDb.length,
        in_db_not_api: inDbNotApi.length,
      },
      missing_from_db: inApiNotDb.slice(0, 20),
      extra_in_db: inDbNotApi.slice(0, 20).map(r => ({
        orderId: r.amazon_order_id,
        asin: r.asin,
        quantity: r.quantity,
        status: r.order_status,
      })),
    };
  },
};

module.exports = UnitsAuditService;
