const { Router } = require('express');
const scheduler = require('../jobs/scheduler');
const SyncLogger = require('../services/sync-logger');
const validate = require('../middleware/validate');
const db = require('../database/pool');

const router = Router();

/**
 * POST /api/sync/trigger/:jobType
 * Manually trigger a sync job.
 * jobType: orders | financial | ads | compute | alerts
 */
router.post('/trigger/:jobType', async (req, res, next) => {
  try {
    const jobMap = {
      orders: scheduler.syncOrdersJob,
      financial: scheduler.syncFinancialJob,
      ads: scheduler.syncAdsJob,
      compute: scheduler.computeAndAggregateJob,
      alerts: scheduler.alertsJob,
    };

    const job = jobMap[req.params.jobType];
    if (!job) {
      return res.status(400).json({
        error: { message: `Unknown job type: ${req.params.jobType}. Valid: ${Object.keys(jobMap).join(', ')}` },
      });
    }

    // Run async, don't wait
    job().catch((err) => {
      require('../utils/logger').error('Manual job trigger failed', {
        jobType: req.params.jobType,
        error: err.message,
      });
    });

    res.json({ message: `Job ${req.params.jobType} triggered` });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/sync/reset
 * Reset sync timestamps to force a full re-sync from scratch.
 * Body: { accountId, marketplaceId? (null = all), syncTypes? (default: ['orders','financial','ads']) }
 * Optionally triggers an immediate sync after reset.
 */
router.post('/reset', async (req, res, next) => {
  try {
    const { accountId, marketplaceId, syncTypes } = req.body;
    if (!accountId) {
      return res.status(400).json({ error: { message: 'accountId is required' } });
    }

    const AccountService = require('../modules/accounts/account.service');
    const affected = await AccountService.resetSyncTimestamps(
      accountId,
      marketplaceId || null,
      syncTypes || ['orders', 'financial', 'ads']
    );

    // Auto-trigger orders sync after reset
    scheduler.syncOrdersJob().catch((err) => {
      require('../utils/logger').error('Post-reset sync failed', { error: err.message });
    });

    res.json({
      message: `Sync timestamps reset for ${affected} marketplace(s). Orders sync triggered.`,
      affected,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/sync/log
 * Get recent sync logs for an account.
 * Query params: accountId, limit?
 */
router.get('/log', validate({ query: ['accountId'] }), async (req, res, next) => {
  try {
    const logs = await SyncLogger.getRecent(
      parseInt(req.query.accountId, 10),
      parseInt(req.query.limit, 10) || 50
    );
    res.json({ data: logs });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/sync/diagnose
 * Compare order counts between orders_raw, order_profit, and asin_daily_metrics.
 * Useful for verifying data consistency.
 * Query params: accountId, asin?, dateFrom?, dateTo?
 */
router.get('/diagnose', validate({ query: ['accountId'] }), async (req, res, next) => {
  try {
    const accountId = parseInt(req.query.accountId, 10);
    const asin = req.query.asin || null;
    const dateFrom = req.query.dateFrom || null;
    const dateTo = req.query.dateTo || null;

    const conditions = ['account_id = $1'];
    const params = [accountId];
    let idx = 2;

    if (asin) {
      conditions.push(`asin = $${idx}`);
      params.push(asin);
      idx++;
    }

    const dateConditionsOrders = [...conditions];
    const dateConditionsProfit = [...conditions];
    const dateConditionsMetrics = [...conditions];
    const paramsOrders = [...params];
    const paramsProfit = [...params];
    const paramsMetrics = [...params];
    let idxO = idx, idxP = idx, idxM = idx;

    if (dateFrom) {
      dateConditionsOrders.push(`purchase_date >= $${idxO}`);
      paramsOrders.push(dateFrom);
      idxO++;
      dateConditionsProfit.push(`order_date >= $${idxP}`);
      paramsProfit.push(dateFrom);
      idxP++;
      dateConditionsMetrics.push(`metric_date >= $${idxM}`);
      paramsMetrics.push(dateFrom);
      idxM++;
    }
    if (dateTo) {
      dateConditionsOrders.push(`purchase_date <= $${idxO}`);
      paramsOrders.push(dateTo);
      dateConditionsProfit.push(`order_date <= $${idxP}`);
      paramsProfit.push(dateTo);
      dateConditionsMetrics.push(`metric_date <= $${idxM}`);
      paramsMetrics.push(dateTo);
    }

    const [rawResult, rawByMp, profitResult, metricsResult, cancelledResult, dateRangeResult, dailyBreakdownResult] = await Promise.all([
      // Total units from orders_raw (excluding cancelled/pending)
      db.query(
        `SELECT COUNT(*) AS order_lines, SUM(quantity) AS total_units
         FROM orders_raw
         WHERE ${dateConditionsOrders.join(' AND ')}
           AND order_status NOT IN ('Cancelled', 'Pending')`,
        paramsOrders
      ),
      // Per-marketplace breakdown from orders_raw
      db.query(
        `SELECT m.country_code, o.order_status,
           COUNT(*) AS order_lines, SUM(o.quantity) AS total_units
         FROM orders_raw o
         JOIN marketplaces m ON m.id = o.marketplace_id
         WHERE ${dateConditionsOrders.map(c => c.replace('account_id', 'o.account_id').replace('asin', 'o.asin').replace('purchase_date', 'o.purchase_date')).join(' AND ')}
         GROUP BY m.country_code, o.order_status
         ORDER BY m.country_code, o.order_status`,
        paramsOrders
      ),
      // Total from order_profit
      db.query(
        `SELECT COUNT(*) AS order_lines, SUM(quantity) AS total_units
         FROM order_profit
         WHERE ${dateConditionsProfit.join(' AND ')}`,
        paramsProfit
      ),
      // Total from asin_daily_metrics (per marketplace)
      db.query(
        `SELECT m.country_code, SUM(adm.units_sold) AS total_units, SUM(adm.orders_count) AS total_orders
         FROM asin_daily_metrics adm
         JOIN marketplaces m ON m.id = adm.marketplace_id
         WHERE ${dateConditionsMetrics.map(c => c.replace('account_id', 'adm.account_id').replace('asin', 'adm.asin').replace('metric_date', 'adm.metric_date')).join(' AND ')}
         GROUP BY m.country_code
         ORDER BY SUM(adm.units_sold) DESC`,
        paramsMetrics
      ),
      // Cancelled/Pending orders still in order_profit
      db.query(
        `SELECT COUNT(*) AS orphan_records, SUM(op.quantity) AS orphan_units
         FROM order_profit op
         JOIN orders_raw o ON o.account_id = op.account_id
           AND o.amazon_order_id = op.amazon_order_id AND o.asin = op.asin
         WHERE op.account_id = $1
           AND o.order_status IN ('Cancelled', 'Pending')`,
        [accountId]
      ),
      // Date range of orders in DB
      db.query(
        `SELECT MIN(purchase_date) AS earliest_order, MAX(purchase_date) AS latest_order,
                COUNT(DISTINCT purchase_date::date) AS days_with_orders
         FROM orders_raw
         WHERE ${dateConditionsOrders.join(' AND ')}
           AND order_status NOT IN ('Cancelled', 'Pending')`,
        paramsOrders
      ),
      // Per-day breakdown (top marketplace by units)
      db.query(
        `SELECT purchase_date::date AS order_date,
                COUNT(*) AS order_lines, SUM(quantity) AS total_units
         FROM orders_raw
         WHERE ${dateConditionsOrders.join(' AND ')}
           AND order_status NOT IN ('Cancelled', 'Pending')
         GROUP BY purchase_date::date
         ORDER BY purchase_date::date`,
        paramsOrders
      ),
    ]);

    // Sum asin_daily_metrics totals from per-marketplace breakdown
    const metricsTotals = metricsResult.rows.reduce(
      (acc, r) => ({
        total_units: acc.total_units + parseInt(r.total_units || 0, 10),
        total_orders: acc.total_orders + parseInt(r.total_orders || 0, 10),
      }),
      { total_units: 0, total_orders: 0 }
    );

    res.json({
      orders_raw: {
        order_lines: parseInt(rawResult.rows[0].order_lines, 10),
        total_units: parseInt(rawResult.rows[0].total_units || 0, 10),
        note: 'Excludes Cancelled/Pending',
      },
      orders_raw_by_marketplace: rawByMp.rows,
      order_profit: {
        order_lines: parseInt(profitResult.rows[0].order_lines, 10),
        total_units: parseInt(profitResult.rows[0].total_units || 0, 10),
        note: 'Includes ALL records (may have orphan cancelled orders)',
      },
      asin_daily_metrics: {
        ...metricsTotals,
        by_marketplace: metricsResult.rows,
      },
      orders_date_range: {
        earliest: dateRangeResult.rows[0].earliest_order,
        latest: dateRangeResult.rows[0].latest_order,
        days_with_orders: parseInt(dateRangeResult.rows[0].days_with_orders || 0, 10),
      },
      daily_breakdown: dailyBreakdownResult.rows,
      orphan_cancelled_in_profit: {
        records: parseInt(cancelledResult.rows[0].orphan_records, 10),
        units: parseInt(cancelledResult.rows[0].orphan_units || 0, 10),
        note: 'order_profit records whose orders are now Cancelled/Pending',
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/sync/count-orders
 * Dry-run: call SP-API getOrders and count results WITHOUT syncing.
 * Compares SP-API order count with what's in our DB.
 * Query params: accountId, marketplaceId (internal ID, e.g. 3 for IT), dateFrom, dateTo
 */
router.get('/count-orders', validate({ query: ['accountId', 'marketplaceId'] }), async (req, res, next) => {
  try {
    const accountId = parseInt(req.query.accountId, 10);
    const marketplaceId = parseInt(req.query.marketplaceId, 10);
    const asin = req.query.asin || null;
    const dateFrom = req.query.dateFrom || null;
    const dateTo = req.query.dateTo || null;

    const AccountService = require('../modules/accounts/account.service');
    const SpApiClient = require('../services/sp-api.client');

    // Get the target info for this marketplace
    const targets = await AccountService.getActiveSyncTargets();
    const target = targets.find(t => t.account_id === accountId && t.account_marketplace_id === marketplaceId);
    if (!target) {
      return res.status(404).json({ error: { message: 'Account+marketplace combination not found' } });
    }

    const spApi = new SpApiClient(target);

    // Build date range
    const dayjs = require('dayjs');
    const utc = require('dayjs/plugin/utc');
    dayjs.extend(utc);
    const from = dateFrom
      ? dayjs.utc(dateFrom).format('YYYY-MM-DDTHH:mm:ss[Z]')
      : dayjs.utc().subtract(30, 'day').format('YYYY-MM-DDTHH:mm:ss[Z]');
    const to = dateTo
      ? dayjs.utc(dateTo).endOf('day').format('YYYY-MM-DDTHH:mm:ss[Z]')
      : dayjs.utc().subtract(2, 'minute').format('YYYY-MM-DDTHH:mm:ss[Z]');

    // Paginate through ALL orders and count them
    let nextToken = null;
    let totalOrders = 0;
    let pages = 0;

    do {
      const response = await spApi.getOrders({
        MarketplaceIds: [target.amazon_marketplace_id],
        CreatedAfter: from,
        CreatedBefore: to,
        NextToken: nextToken,
      });

      const orders = response.Orders || [];
      totalOrders += orders.length;
      pages++;
      nextToken = response.NextToken || null;
    } while (nextToken);

    // Compare with our DB
    const dbConditions = ['account_id = $1', 'marketplace_id = $2'];
    const dbParams = [accountId, marketplaceId];
    let idx = 3;

    if (asin) {
      dbConditions.push(`asin = $${idx}`);
      dbParams.push(asin);
      idx++;
    }
    if (dateFrom) {
      dbConditions.push(`purchase_date >= $${idx}`);
      dbParams.push(dateFrom);
      idx++;
    }
    if (dateTo) {
      dbConditions.push(`purchase_date <= $${idx}`);
      dbParams.push(dateTo);
      idx++;
    }

    const dbResult = await db.query(
      `SELECT COUNT(DISTINCT amazon_order_id) AS db_orders, COUNT(*) AS db_lines, SUM(quantity) AS db_units
       FROM orders_raw WHERE ${dbConditions.join(' AND ')}`,
      dbParams
    );

    res.json({
      sp_api: {
        total_orders: totalOrders,
        pages_fetched: pages,
        date_range: { from, to },
        marketplace: target.country_code,
        note: 'Total orders from SP-API (all ASINs, all statuses)',
      },
      db: {
        distinct_orders: parseInt(dbResult.rows[0].db_orders, 10),
        order_lines: parseInt(dbResult.rows[0].db_lines, 10),
        total_units: parseInt(dbResult.rows[0].db_units || 0, 10),
        note: asin ? `Filtered by ASIN ${asin}` : 'All ASINs (all statuses)',
      },
      gap: totalOrders - parseInt(dbResult.rows[0].db_orders, 10),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/sync/fix-titles
 * Force-refresh all ASIN titles from the Italian catalog.
 * Body: { accountId }
 */
router.post('/fix-titles', async (req, res, next) => {
  try {
    const { accountId } = req.body;
    if (!accountId) {
      return res.status(400).json({ error: { message: 'accountId is required' } });
    }

    const AccountService = require('../modules/accounts/account.service');
    const SpApiClient = require('../services/sp-api.client');
    const logger = require('../utils/logger');

    // Find the IT marketplace target
    const targets = await AccountService.getActiveSyncTargets();
    const itTarget = targets.find(t => t.account_id === accountId && t.country_code === 'IT');
    if (!itTarget) {
      return res.status(404).json({ error: { message: 'IT marketplace not found for this account' } });
    }

    const spApi = new SpApiClient(itTarget);

    // Get all ASINs for this account
    const asinsResult = await db.query(
      `SELECT asin FROM asins WHERE account_id = $1 AND is_active = TRUE`,
      [accountId]
    );

    let updated = 0;
    for (const row of asinsResult.rows) {
      try {
        const catalog = await spApi.getCatalogItem(row.asin, itTarget.amazon_marketplace_id);

        let imageUrl = null;
        const images = catalog?.images;
        if (images && images.length > 0) {
          const mainImage = images[0]?.images?.find((img) => img.variant === 'MAIN');
          imageUrl = mainImage?.link || images[0]?.images?.[0]?.link || null;
        }

        let title = null;
        const summaries = catalog?.summaries;
        if (summaries && summaries.length > 0) {
          title = summaries[0]?.itemName || null;
        }

        if (title || imageUrl) {
          await db.query(
            `UPDATE asins SET
              title = COALESCE($1, title),
              image_url = COALESCE($2, image_url),
              updated_at = NOW()
            WHERE account_id = $3 AND asin = $4`,
            [title, imageUrl, accountId, row.asin]
          );
          if (title) updated++;
        }
      } catch (err) {
        logger.warn('Failed to fetch IT catalog for ASIN', { asin: row.asin, error: err.message });
      }
    }

    res.json({
      message: `Titles updated from IT catalog`,
      total_asins: asinsResult.rows.length,
      updated,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
