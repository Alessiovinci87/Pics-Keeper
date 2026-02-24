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
const { toDateStr, sleep } = require('../utils/helpers');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
dayjs.extend(utc);

// Delay between marketplace syncs to respect API rate limits (ms)
const MARKETPLACE_SYNC_DELAY = 4000;

// Max time for a single marketplace sync before aborting (5 minutes)
const PER_MARKETPLACE_TIMEOUT = 5 * 60 * 1000;

// Track running jobs to prevent overlap
const runningJobs = new Set();

/**
 * Run an async function with a timeout. Rejects if timeout exceeded.
 */
function withTimeout(fn, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout after ${timeoutMs / 1000}s: ${label}`));
    }, timeoutMs);

    fn()
      .then((result) => { clearTimeout(timer); resolve(result); })
      .catch((err) => { clearTimeout(timer); reject(err); });
  });
}

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
    logger.info(`Orders sync: ${targets.length} marketplace(s) to process`, {
      marketplaces: targets.map(t => t.country_code).join(', '),
    });

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      const mpLabel = `orders ${target.country_code}`;
      try {
        await AccountService.setSyncStatus(target.account_id, target.account_marketplace_id, 'running');
        logger.info(`[${i + 1}/${targets.length}] Starting ${mpLabel}`);

        // No timeout for orders - large marketplaces (FR, IT) can take 30+ minutes
        await OrdersService.syncOrders(target);

        await AccountService.updateSyncTimestamp(
          target.account_id, target.account_marketplace_id, 'orders', new Date().toISOString()
        );
      } catch (err) {
        await AccountService.setSyncStatus(target.account_id, target.account_marketplace_id, 'failed');
        logger.error(`[${i + 1}/${targets.length}] ${mpLabel} failed`, {
          accountId: target.account_id,
          marketplace: target.country_code,
          error: err.message,
        });
      }
      // Pause between marketplace syncs to avoid rate limiting
      if (i < targets.length - 1) {
        await sleep(MARKETPLACE_SYNC_DELAY);
      }
    }
  });
}

/**
 * Sync financial events for all active accounts.
 *
 * The Financial Events API returns events for ALL marketplaces of an account,
 * so we group targets by account and call the API only ONCE per account.
 * No per-marketplace timeout since the API returns all data in one stream.
 */
async function syncFinancialJob() {
  await withLock('sync-financial', async () => {
    const targets = await AccountService.getActiveSyncTargets();

    // Group targets by account_id (Financial API returns all marketplaces per account)
    const accountGroups = new Map();
    for (const target of targets) {
      if (!accountGroups.has(target.account_id)) {
        accountGroups.set(target.account_id, []);
      }
      accountGroups.get(target.account_id).push(target);
    }

    logger.info(`Financial sync: ${accountGroups.size} account(s), ${targets.length} total marketplace(s)`);

    let accountIdx = 0;
    for (const [accountId, accountTargets] of accountGroups) {
      accountIdx++;
      try {
        logger.info(`[${accountIdx}/${accountGroups.size}] Starting financial sync for account ${accountId} (${accountTargets.map(t => t.country_code).join(', ')})`);

        // No timeout: financial sync processes all marketplaces in one API stream
        // and can take a long time for high-volume accounts
        await FinancialService.syncFinancialEventsForAccount(accountTargets);

        // Update sync timestamp for ALL marketplaces of this account
        const now = new Date().toISOString();
        for (const target of accountTargets) {
          await AccountService.updateSyncTimestamp(
            target.account_id, target.account_marketplace_id, 'financial', now
          );
        }

        logger.info(`[${accountIdx}/${accountGroups.size}] Financial sync completed for account ${accountId}`);
      } catch (err) {
        logger.error(`[${accountIdx}/${accountGroups.size}] Financial sync failed for account ${accountId}`, {
          error: err.message,
        });
      }

      // Pause between accounts
      if (accountIdx < accountGroups.size) {
        await sleep(MARKETPLACE_SYNC_DELAY);
      }
    }
  });
}

/**
 * Sync ads spend for all active account+marketplace combos.
 */
async function syncAdsJob() {
  await withLock('sync-ads', async () => {
    const targets = await AccountService.getActiveSyncTargets();
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
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
      if (i < targets.length - 1) {
        await sleep(MARKETPLACE_SYNC_DELAY);
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
    const dateFrom = dayjs.utc().subtract(config.sync.profitDaysBack, 'day').format('YYYY-MM-DD');
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
