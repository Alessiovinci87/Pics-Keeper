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

    const [rawResult, rawByMp, profitResult, metricsResult, cancelledResult] = await Promise.all([
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
      // Total from asin_daily_metrics
      db.query(
        `SELECT SUM(units_sold) AS total_units, SUM(orders_count) AS total_orders
         FROM asin_daily_metrics
         WHERE ${dateConditionsMetrics.join(' AND ')}`,
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
    ]);

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
        total_units: parseInt(metricsResult.rows[0].total_units || 0, 10),
        total_orders: parseInt(metricsResult.rows[0].total_orders || 0, 10),
      },
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

module.exports = router;
