const { Router } = require('express');
const scheduler = require('../jobs/scheduler');
const SyncLogger = require('../services/sync-logger');
const AccountService = require('../modules/accounts/account.service');
const OrdersReconciliationService = require('../modules/orders/orders-reconciliation.service');
const validate = require('../middleware/validate');
const db = require('../database/pool');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
dayjs.extend(utc);

const router = Router();
const logger = require('../utils/logger');

/**
 * POST /api/sync/trigger/compute-range
 * Trigger profit computation + aggregation for a custom date range.
 * Body: { accountId, dateFrom, dateTo }
 *
 * MUST be defined before /trigger/:jobType so Express doesn't
 * match "compute-range" as a jobType parameter.
 */
router.post('/trigger/compute-range', async (req, res, next) => {
  try {
    const { accountId, dateFrom, dateTo } = req.body;
    if (!accountId || !dateFrom || !dateTo) {
      return res.status(400).json({
        error: { message: 'accountId, dateFrom, dateTo are required (YYYY-MM-DD)' },
      });
    }

    const AccountService = require('../modules/accounts/account.service');
    const ProfitService = require('../modules/profit-engine/profit.service');
    const AggregationService = require('../modules/aggregation/aggregation.service');
    const logger = require('../utils/logger');

    const targets = await AccountService.getActiveSyncTargets();
    const accountTargets = targets.filter(t => t.account_id === parseInt(accountId, 10));

    if (accountTargets.length === 0) {
      return res.status(404).json({ error: { message: 'No active marketplaces for this account' } });
    }

    const computeDateTo = dayjs.utc(dateTo).add(1, 'day').format('YYYY-MM-DD');

    const seen = new Set();
    const runCompute = async () => {
      // Clean orphaned cancelled records
      const orphanCleanup = await db.query(
        `DELETE FROM order_profit op
         USING orders_raw o
         WHERE op.account_id = o.account_id
           AND op.amazon_order_id = o.amazon_order_id
           AND op.asin = o.asin
           AND o.account_id = $1
           AND LOWER(o.order_status) LIKE '%cancel%'`,
        [parseInt(accountId, 10)]
      );
      if (orphanCleanup.rowCount > 0) {
        logger.info(`compute-range: cleaned ${orphanCleanup.rowCount} orphaned cancelled records`);
      }

      for (const target of accountTargets) {
        const key = `${target.account_id}:${target.account_marketplace_id}`;
        if (seen.has(key)) continue;
        seen.add(key);

        try {
          logger.info(`compute-range: processing ${target.country_code}`, {
            accountId: target.account_id,
            dateFrom,
            dateTo: computeDateTo,
          });
          await ProfitService.computeForRange(
            target.account_id, target.account_marketplace_id, dateFrom, computeDateTo
          );
          await AggregationService.aggregate(
            target.account_id, target.account_marketplace_id, dateFrom, computeDateTo
          );
          logger.info(`compute-range: ${target.country_code} completed`);
        } catch (err) {
          logger.error(`compute-range: ${target.country_code} failed`, { error: err.message });
        }
      }
      logger.info('compute-range: all marketplaces done');
    };

    runCompute().catch((err) => {
      logger.error('compute-range job failed', { error: err.message });
    });

    res.json({
      message: `Compute+aggregate triggered for ${accountTargets.length} marketplace(s)`,
      dateRange: { from: dateFrom, to: dateTo },
      marketplaces: accountTargets.map(t => t.country_code),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/sync/reconcile/orders/:countryCode
 * Run orders reconciliation (Reports API) for a single marketplace.
 * Body: { dateFrom: "2026-02-01", dateTo: "2026-03-06" }
 */
router.post('/reconcile/orders/:countryCode', async (req, res, next) => {
  try {
    const countryCode = req.params.countryCode.toUpperCase();
    const { dateFrom, dateTo } = req.body || {};

    if (!dateFrom || !dateTo) {
      return res.status(400).json({
        error: { message: 'dateFrom and dateTo are required (YYYY-MM-DD)' },
      });
    }

    const targets = await AccountService.getActiveSyncTargets();
    const target = targets.find((t) => t.country_code === countryCode);

    if (!target) {
      return res.status(404).json({
        error: { message: `No active marketplace found for country code: ${countryCode}` },
      });
    }

    OrdersReconciliationService.reconcile(target, { dateFrom, dateTo }).catch((err) => {
      logger.error('Manual orders reconciliation failed', {
        marketplace: countryCode,
        error: err.message,
      });
    });

    res.json({
      success: true,
      message: `Orders reconciliation started for ${countryCode} (${dateFrom} -> ${dateTo})`,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/sync/backfill/orders/:countryCode
 * Backfill historical orders using Reports API, split into monthly chunks.
 * Designed for large date ranges (up to 2+ years).
 * Body: { dateFrom: "2024-03-01", dateTo: "2026-03-06" }
 */
router.post('/backfill/orders/:countryCode', async (req, res, next) => {
  try {
    const countryCode = req.params.countryCode.toUpperCase();
    const { dateFrom, dateTo } = req.body || {};

    if (!dateFrom || !dateTo) {
      return res.status(400).json({
        error: { message: 'dateFrom and dateTo are required (YYYY-MM-DD)' },
      });
    }

    const targets = await AccountService.getActiveSyncTargets();
    const target = targets.find((t) => t.country_code === countryCode);

    if (!target) {
      return res.status(404).json({
        error: { message: `No active marketplace found for country code: ${countryCode}` },
      });
    }

    const months = dayjs.utc(dateTo).diff(dayjs.utc(dateFrom), 'month') + 1;

    OrdersReconciliationService.backfill(target, { dateFrom, dateTo }).then((result) => {
      logger.info('Backfill completed via API', { marketplace: countryCode, ...result });
    }).catch((err) => {
      logger.error('Backfill failed via API', {
        marketplace: countryCode,
        error: err.message,
      });
    });

    res.json({
      success: true,
      message: `Orders backfill started for ${countryCode} (${dateFrom} -> ${dateTo}, ~${months} monthly chunks). Check logs for progress.`,
    });
  } catch (err) {
    next(err);
  }
});

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

module.exports = router;
