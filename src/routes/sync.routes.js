const { Router } = require('express');
const scheduler = require('../jobs/scheduler');
const SyncLogger = require('../services/sync-logger');
const validate = require('../middleware/validate');

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

module.exports = router;
