const { Router } = require('express');
const DashboardService = require('../modules/dashboard/dashboard.service');
const validate = require('../middleware/validate');
const { NotFoundError } = require('../utils/errors');

const router = Router();

/**
 * GET /api/dashboard/asin
 *
 * ASIN aggregated metrics over a date range.
 * Groups by ASIN, returns SUM/AVG of key metrics.
 *
 * Query params:
 *   accountId      (required)
 *   marketplaceId  (optional)
 *   dateFrom       (optional, default now-30d)
 *   dateTo         (optional, default now)
 *   sortBy         (optional: units|revenue|profit|roi|acos, default revenue)
 *   sortDir        (optional: asc|desc, default desc)
 *   limit          (optional, default 50, max 500)
 *   offset         (optional, default 0)
 */
router.get('/asin', validate({ query: ['accountId'] }), async (req, res, next) => {
  try {
    const result = await DashboardService.getAsinAggregated({
      accountId: parseInt(req.query.accountId, 10),
      marketplaceId: req.query.marketplaceId ? parseInt(req.query.marketplaceId, 10) : null,
      dateFrom: req.query.dateFrom || null,
      dateTo: req.query.dateTo || null,
      sortBy: req.query.sortBy || 'revenue',
      sortDir: req.query.sortDir || 'desc',
      limit: req.query.limit ? parseInt(req.query.limit, 10) : 50,
      offset: req.query.offset ? parseInt(req.query.offset, 10) : 0,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/dashboard/account
 *
 * Account-level aggregated KPIs with profit-weighted percentages.
 *
 * Query params:
 *   accountId      (required)
 *   marketplaceId  (optional)
 *   dateFrom       (optional, default now-30d)
 *   dateTo         (optional, default now)
 *   limit          (optional, default 50, max 500)
 *   offset         (optional, default 0)
 */
router.get('/account', validate({ query: ['accountId'] }), async (req, res, next) => {
  try {
    const result = await DashboardService.getAccountAggregated({
      accountId: parseInt(req.query.accountId, 10),
      marketplaceId: req.query.marketplaceId ? parseInt(req.query.marketplaceId, 10) : null,
      dateFrom: req.query.dateFrom || null,
      dateTo: req.query.dateTo || null,
      limit: req.query.limit ? parseInt(req.query.limit, 10) : 50,
      offset: req.query.offset ? parseInt(req.query.offset, 10) : 0,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/dashboard/order/:orderId
 *
 * Full profit breakdown for a single order from order_profit.
 *
 * Query params:
 *   accountId      (required)
 */
router.get('/order/:orderId', validate({ query: ['accountId'], params: ['orderId'] }), async (req, res, next) => {
  try {
    const accountId = parseInt(req.query.accountId, 10);
    const { orderId } = req.params;

    const result = await DashboardService.getOrderBreakdown(accountId, orderId);

    if (!result) {
      throw new NotFoundError('Order');
    }

    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
