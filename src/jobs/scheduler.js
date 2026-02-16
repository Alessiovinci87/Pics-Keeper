const cron = require('node-cron');
const config = require('../config');
const logger = require('../utils/logger');
const AccountService = require('../modules/accounts/account.service');
const OrdersService = require('../modules/orders/orders.service');
const FinancialService = require('../modules/financial/financial.service');
const AdsService = require('../modules/ads/ads.service');
const ProfitService = require('../modules/profit-engine/profit.service');
const AggregationService = require('../modules/aggregation/aggregation.service');
const AlertsService = require('../modules/alerts/alerts.service');
const { toDateStr } = require('../utils/helpers');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
dayjs.extend(utc);

// Track running jobs to prevent overlap
const runningJobs = new Set();

/**
 * Guard against overlapping execution of the same job type.
 */
async function withLock(jobName, fn) {
  if (runningJobs.has(jobName)) {
    logger.warn(`Job ${jobName} already running, skipping this cycle`);
    return;
  }

  runningJobs.add(jobName);
  const startTime = Date.now();
  logger.info(`Job started: ${jobName}`);

  try {
    await fn();
    const duration = Date.now() - startTime;
    logger.info(`Job completed: ${jobName}`, { duration });
  } catch (err) {
    logger.error(`Job failed: ${jobName}`, { error: err.message, stack: err.stack });
  } finally {
    runningJobs.delete(jobName);
  }
}

/**
 * Sync orders for all active account+marketplace combos.
 */
async function syncOrdersJob() {
  await withLock('sync-orders', async () => {
    const targets = await AccountService.getActiveSyncTargets();
    for (const target of targets) {
      try {
        await AccountService.setSyncStatus(target.account_id, target.account_marketplace_id, 'running');
        await OrdersService.syncOrders(target);
        await AccountService.updateSyncTimestamp(
          target.account_id, target.account_marketplace_id, 'orders', new Date().toISOString()
        );
      } catch (err) {
        await AccountService.setSyncStatus(target.account_id, target.account_marketplace_id, 'failed');
        logger.error('Orders sync failed for target', {
          accountId: target.account_id,
          marketplace: target.country_code,
          error: err.message,
        });
      }
    }
  });
}

/**
 * Sync financial events for all active account+marketplace combos.
 */
async function syncFinancialJob() {
  await withLock('sync-financial', async () => {
    const targets = await AccountService.getActiveSyncTargets();
    for (const target of targets) {
      try {
        await FinancialService.syncFinancialEvents(target);
        await AccountService.updateSyncTimestamp(
          target.account_id, target.account_marketplace_id, 'financial', new Date().toISOString()
        );
      } catch (err) {
        logger.error('Financial sync failed for target', {
          accountId: target.account_id,
          marketplace: target.country_code,
          error: err.message,
        });
      }
    }
  });
}

/**
 * Sync ads spend for all active account+marketplace combos.
 */
async function syncAdsJob() {
  await withLock('sync-ads', async () => {
    const targets = await AccountService.getAdsSyncTargets();
    for (const target of targets) {
      try {
        await AdsService.syncAds(target);
        await AccountService.updateSyncTimestamp(
          target.account_id, target.account_marketplace_id, 'ads', new Date().toISOString()
        );
      } catch (err) {
        logger.error('Ads sync failed for target', {
          accountId: target.account_id,
          marketplace: target.country_code,
          error: err.message,
        });
      }
    }
  });
}

/**
 * Run profit computation and aggregation for all accounts.
 * Processes the last 7 days to ensure data freshness.
 */
async function computeAndAggregateJob() {
  await withLock('compute-aggregate', async () => {
    const targets = await AccountService.getActiveSyncTargets();
    const dateFrom = dayjs.utc().subtract(7, 'day').format('YYYY-MM-DD');
    const dateTo = dayjs.utc().add(1, 'day').format('YYYY-MM-DD');

    // Group by account+marketplace to avoid duplicates
    const seen = new Set();
    for (const target of targets) {
      const key = `${target.account_id}:${target.account_marketplace_id}`;
      if (seen.has(key)) continue;
      seen.add(key);

      try {
        await ProfitService.computeForRange(
          target.account_id, target.account_marketplace_id, dateFrom, dateTo
        );
        await AggregationService.aggregate(
          target.account_id, target.account_marketplace_id, dateFrom, dateTo
        );
      } catch (err) {
        logger.error('Compute/aggregate failed for target', {
          accountId: target.account_id,
          marketplace: target.country_code,
          error: err.message,
        });
      }
    }
  });
}

/**
 * Run alert evaluation for all active accounts.
 */
async function alertsJob() {
  await withLock('alerts', async () => {
    const targets = await AccountService.getActiveSyncTargets();
    const seenAccounts = new Set();

    for (const target of targets) {
      if (seenAccounts.has(target.account_id)) continue;
      seenAccounts.add(target.account_id);

      try {
        await AlertsService.evaluate(target.account_id);
      } catch (err) {
        logger.error('Alert evaluation failed', {
          accountId: target.account_id,
          error: err.message,
        });
      }
    }
  });
}

/**
 * Initialize all scheduled jobs.
 */
function startScheduler() {
  logger.info('Starting job scheduler', {
    orders: config.cron.syncOrders,
    financial: config.cron.syncFinancial,
    ads: config.cron.syncAds,
    aggregation: config.cron.aggregation,
    alerts: config.cron.alerts,
  });

  cron.schedule(config.cron.syncOrders, syncOrdersJob, { timezone: 'UTC' });
  cron.schedule(config.cron.syncFinancial, syncFinancialJob, { timezone: 'UTC' });
  cron.schedule(config.cron.syncAds, syncAdsJob, { timezone: 'UTC' });
  cron.schedule(config.cron.aggregation, computeAndAggregateJob, { timezone: 'UTC' });
  cron.schedule(config.cron.alerts, alertsJob, { timezone: 'UTC' });

  logger.info('Job scheduler started successfully');
}

/**
 * Stop all scheduled jobs.
 */
function stopScheduler() {
  const tasks = cron.getTasks();
  tasks.forEach((task) => task.stop());
  logger.info('Job scheduler stopped');
}

module.exports = {
  startScheduler,
  stopScheduler,
  // Export individual jobs for manual triggering via API
  syncOrdersJob,
  syncFinancialJob,
  syncAdsJob,
  computeAndAggregateJob,
  alertsJob,
};
