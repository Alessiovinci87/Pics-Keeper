const { Router } = require('express');
const scheduler = require('../jobs/scheduler');
const SyncLogger = require('../services/sync-logger');
const AccountService = require('../modules/accounts/account.service');
const OrdersService = require('../modules/orders/orders.service');
const logger = require('../utils/logger');
const validate = require('../middleware/validate');

const router = Router();

/**
 * POST /api/sync/trigger/orders/:countryCode
 * Sync orders for a single marketplace (e.g. IT, FR, DE).
 * Body: { dateFrom?: "2025-01-01" }
 */
router.post('/trigger/orders/:countryCode', async (req, res, next) => {
  try {
    const countryCode = req.params.countryCode.toUpperCase();
    const targets = await AccountService.getActiveSyncTargets();
    const target = targets.find((t) => t.country_code === countryCode);

    if (!target) {
      return res.status(404).json({
        error: { message: `No active marketplace found for country code: ${countryCode}` },
      });
    }

    const options = {};
    if (req.body && req.body.dateFrom) {
      options.dateFrom = req.body.dateFrom;
    }

    // Run async, same logic as syncOrdersJob but single target
    (async () => {
      try {
        await AccountService.setSyncStatus(target.account_id, target.account_marketplace_id, 'running');
        await OrdersService.syncOrders(target, options);
        await AccountService.updateSyncTimestamp(
          target.account_id, target.account_marketplace_id, 'orders', new Date().toISOString()
        );
      } catch (err) {
        await AccountService.setSyncStatus(target.account_id, target.account_marketplace_id, 'failed');
        logger.error('Single marketplace orders sync failed', {
          marketplace: countryCode,
          error: err.message,
        });
      }
    })();

    res.json({ success: true, marketplace: countryCode });
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

    // Pass body options (e.g. dateFrom for historical sync) to the job
    const options = {};
    if (req.body && req.body.dateFrom) {
      options.dateFrom = req.body.dateFrom;
    }

    // Run async, don't wait
    job(options).catch((err) => {
      require('../utils/logger').error('Manual job trigger failed', {
        jobType: req.params.jobType,
        error: err.message,
      });
    });

    res.json({ message: `Job ${req.params.jobType} triggered`, options });
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
