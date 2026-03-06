const { Router } = require('express');
const scheduler = require('../jobs/scheduler');
const SyncLogger = require('../services/sync-logger');
const AccountService = require('../modules/accounts/account.service');
const OrdersService = require('../modules/orders/orders.service');
const OrdersReconciliationService = require('../modules/orders/orders-reconciliation.service');
const BusinessReportsService = require('../modules/business-reports/business-reports.service');
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
    if (req.body && req.body.dateTo) {
      options.dateTo = req.body.dateTo;
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
 * POST /api/sync/reconcile/orders/:countryCode
 * Run orders reconciliation (Reports API) for a single marketplace.
 * Body: { dateFrom: "2026-02-01", dateTo: "2026-03-02" }
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

    // Run async
    OrdersReconciliationService.reconcile(target, { dateFrom, dateTo }).catch((err) => {
      logger.error('Manual orders reconciliation failed', {
        marketplace: countryCode,
        error: err.message,
      });
    });

    res.json({
      success: true,
      message: `Orders reconciliation started for ${countryCode} (${dateFrom} → ${dateTo})`,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/sync/reconcile/orders
 * Run orders reconciliation for ALL active marketplaces.
 * Body: { dateFrom: "2026-02-01", dateTo: "2026-03-02" }
 */
router.post('/reconcile/orders', async (req, res, next) => {
  try {
    const { dateFrom, dateTo } = req.body || {};

    if (!dateFrom || !dateTo) {
      return res.status(400).json({
        error: { message: 'dateFrom and dateTo are required (YYYY-MM-DD)' },
      });
    }

    // Run via the scheduled job which handles all targets
    scheduler.reconcileOrdersJob({ dateFrom, dateTo }).catch((err) => {
      logger.error('Manual orders reconciliation (all) failed', { error: err.message });
    });

    res.json({
      success: true,
      message: `Orders reconciliation started for all marketplaces (${dateFrom} → ${dateTo})`,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/sync/business-reports/:countryCode
 * Sync Business Reports for a single marketplace.
 * Body: { dateFrom: "2026-02-01", dateTo: "2026-03-02" }
 */
router.post('/business-reports/:countryCode', async (req, res, next) => {
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

    BusinessReportsService.sync(target, { dateFrom, dateTo }).catch((err) => {
      logger.error('Manual business reports sync failed', {
        marketplace: countryCode,
        error: err.message,
      });
    });

    res.json({
      success: true,
      message: `Business reports sync started for ${countryCode} (${dateFrom} → ${dateTo})`,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/sync/trigger/:jobType
 * Manually trigger a sync job.
 * jobType: orders | financial | ads | compute | alerts | business-reports
 */
router.post('/trigger/:jobType', async (req, res, next) => {
  try {
    const jobMap = {
      orders: scheduler.syncOrdersJob,
      financial: scheduler.syncFinancialJob,
      ads: scheduler.syncAdsJob,
      compute: scheduler.computeAndAggregateJob,
      alerts: scheduler.alertsJob,
      reconcile: scheduler.reconcileOrdersJob,
      'business-reports': scheduler.syncBusinessReportsJob,
    };

    const job = jobMap[req.params.jobType];
    if (!job) {
      return res.status(400).json({
        error: { message: `Unknown job type: ${req.params.jobType}. Valid: ${Object.keys(jobMap).join(', ')}` },
      });
    }

    // Pass body options (e.g. dateFrom/dateTo for historical sync) to the job
    const options = {};
    if (req.body && req.body.dateFrom) {
      options.dateFrom = req.body.dateFrom;
    }
    if (req.body && req.body.dateTo) {
      options.dateTo = req.body.dateTo;
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
