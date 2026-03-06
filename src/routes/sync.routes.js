const { Router } = require('express');
const scheduler = require('../jobs/scheduler');
const SyncLogger = require('../services/sync-logger');
const AccountService = require('../modules/accounts/account.service');
const OrdersService = require('../modules/orders/orders.service');
const OrdersReconciliationService = require('../modules/orders/orders-reconciliation.service');
const BusinessReportsService = require('../modules/business-reports/business-reports.service');
const logger = require('../utils/logger');
const validate = require('../middleware/validate');
const db = require('../database/pool');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);

const router = Router();

/**
 * POST /api/sync/trigger/compute-range
 * Trigger profit computation + aggregation for a custom date range.
 * Use this when the default 30-day window doesn't cover your test period.
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

    const ProfitService = require('../modules/profit-engine/profit.service');
    const AggregationService = require('../modules/aggregation/aggregation.service');

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
      // Total units from orders_raw (excluding cancelled — case-insensitive)
      db.query(
        `SELECT COUNT(*) AS order_lines, SUM(quantity) AS total_units
         FROM orders_raw
         WHERE ${dateConditionsOrders.join(' AND ')}
           AND LOWER(order_status) NOT LIKE '%cancel%'`,
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
      // Cancelled orders still in order_profit
      db.query(
        `SELECT COUNT(*) AS orphan_records, SUM(op.quantity) AS orphan_units
         FROM order_profit op
         JOIN orders_raw o ON o.account_id = op.account_id
           AND o.amazon_order_id = op.amazon_order_id AND o.asin = op.asin
         WHERE op.account_id = $1
           AND LOWER(o.order_status) LIKE '%cancel%'`,
        [accountId]
      ),
      // Date range of orders in DB
      db.query(
        `SELECT MIN(purchase_date) AS earliest_order, MAX(purchase_date) AS latest_order,
                COUNT(DISTINCT purchase_date::date) AS days_with_orders
         FROM orders_raw
         WHERE ${dateConditionsOrders.join(' AND ')}
           AND LOWER(order_status) NOT LIKE '%cancel%'`,
        paramsOrders
      ),
      // Per-day breakdown
      db.query(
        `SELECT purchase_date::date AS order_date,
                COUNT(*) AS order_lines, SUM(quantity) AS total_units
         FROM orders_raw
         WHERE ${dateConditionsOrders.join(' AND ')}
           AND LOWER(order_status) NOT LIKE '%cancel%'
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
        note: 'Excludes Canceled (case-insensitive)',
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
        note: 'order_profit records whose orders are now Cancelled',
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/sync/audit-units
 * Strict-mode unit audit: compare our system with Seller Central logic.
 * This is the primary diagnostic tool for unit count discrepancies.
 *
 * Query params:
 *   accountId (required)
 *   dateFrom (required, YYYY-MM-DD, marketplace local date)
 *   dateTo (required, YYYY-MM-DD, marketplace local date)
 *   marketplaceId (optional, internal ID)
 *   countryCode (optional, e.g. 'IT' — for timezone; defaults to 'IT')
 *   asin (optional, filter single ASIN)
 */
router.get('/audit-units', validate({ query: ['accountId', 'dateFrom', 'dateTo'] }), async (req, res, next) => {
  try {
    const UnitsAuditService = require('../modules/diagnostics/units-audit.service');

    const result = await UnitsAuditService.auditUnitsFromDB({
      accountId: parseInt(req.query.accountId, 10),
      marketplaceId: req.query.marketplaceId ? parseInt(req.query.marketplaceId, 10) : null,
      countryCode: req.query.countryCode || null,
      dateFrom: req.query.dateFrom,
      dateTo: req.query.dateTo,
      asin: req.query.asin || null,
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/sync/audit-units-live
 * Live SP-API unit count for a single marketplace.
 * WARNING: Slow! Calls SP-API directly with full pagination.
 *
 * Query params:
 *   accountId (required)
 *   marketplaceId (required, internal ID)
 *   dateFrom (required, YYYY-MM-DD)
 *   dateTo (required, YYYY-MM-DD)
 */
router.get('/audit-units-live', validate({ query: ['accountId', 'marketplaceId', 'dateFrom', 'dateTo'] }), async (req, res, next) => {
  try {
    const AccountService = require('../modules/accounts/account.service');
    const UnitsAuditService = require('../modules/diagnostics/units-audit.service');

    const accountId = parseInt(req.query.accountId, 10);
    const marketplaceId = parseInt(req.query.marketplaceId, 10);

    const targets = await AccountService.getActiveSyncTargets();
    const target = targets.find(t => t.account_id === accountId && t.account_marketplace_id === marketplaceId);
    if (!target) {
      return res.status(404).json({ error: { message: 'Account+marketplace combination not found' } });
    }

    const result = await UnitsAuditService.auditUnitsFromAPI(
      target,
      req.query.dateFrom,
      req.query.dateTo
    );

    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/sync/precision-test
 * Single-day, single-marketplace precision test.
 * Compares SP-API live data with DB for exact order-by-order matching.
 *
 * Query params:
 *   accountId (required)
 *   marketplaceId (required, internal ID)
 *   date (required, YYYY-MM-DD)
 *   asin (optional)
 */
router.get('/precision-test', validate({ query: ['accountId', 'marketplaceId', 'date'] }), async (req, res, next) => {
  try {
    const AccountService = require('../modules/accounts/account.service');
    const UnitsAuditService = require('../modules/diagnostics/units-audit.service');

    const accountId = parseInt(req.query.accountId, 10);
    const marketplaceId = parseInt(req.query.marketplaceId, 10);

    const targets = await AccountService.getActiveSyncTargets();
    const target = targets.find(t => t.account_id === accountId && t.account_marketplace_id === marketplaceId);
    if (!target) {
      return res.status(404).json({ error: { message: 'Account+marketplace combination not found' } });
    }

    const result = await UnitsAuditService.precisionTest(
      target,
      req.query.date,
      req.query.asin || null
    );

    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/sync/count-orders
 * Dry-run: call SP-API searchOrders and count results WITHOUT syncing.
 * Compares SP-API order count with what's in our DB.
 * Query params: accountId, marketplaceId (internal ID), dateFrom?, dateTo?
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
    const from = dateFrom
      ? dayjs.utc(dateFrom).format('YYYY-MM-DDTHH:mm:ss[Z]')
      : dayjs.utc().subtract(30, 'day').format('YYYY-MM-DDTHH:mm:ss[Z]');
    const to = dateTo
      ? dayjs.utc(dateTo).endOf('day').format('YYYY-MM-DDTHH:mm:ss[Z]')
      : dayjs.utc().subtract(2, 'minute').format('YYYY-MM-DDTHH:mm:ss[Z]');

    // Paginate through ALL orders using searchOrders (v2026-01-01)
    let paginationToken = null;
    let totalOrders = 0;
    let totalItems = 0;
    let totalQuantity = 0;
    let pages = 0;

    do {
      const response = await spApi.searchOrders({
        marketplaceIds: [target.amazon_marketplace_id],
        createdAfter: from,
        createdBefore: to,
        paginationToken,
      });

      const orders = response.orders || [];
      totalOrders += orders.length;
      pages++;

      for (const order of orders) {
        const items = order.orderItems || [];
        totalItems += items.length;
        for (const item of items) {
          totalQuantity += item.quantityOrdered || 1;
        }
      }

      paginationToken = response.pagination?.nextToken || null;
    } while (paginationToken);

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
        total_items: totalItems,
        total_quantity: totalQuantity,
        pages_fetched: pages,
        date_range: { from, to },
        marketplace: target.country_code,
        note: 'Total from SP-API searchOrders v2026 (all statuses, SUM quantityOrdered)',
      },
      db: {
        distinct_orders: parseInt(dbResult.rows[0].db_orders, 10),
        order_lines: parseInt(dbResult.rows[0].db_lines, 10),
        total_units: parseInt(dbResult.rows[0].db_units || 0, 10),
        note: asin ? `Filtered by ASIN ${asin}` : 'All ASINs (all statuses)',
      },
      gap_orders: totalOrders - parseInt(dbResult.rows[0].db_orders, 10),
      gap_units: totalQuantity - parseInt(dbResult.rows[0].db_units || 0, 10),
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
