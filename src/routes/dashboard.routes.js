const { Router } = require('express');
const AggregationService = require('../modules/aggregation/aggregation.service');
const validate = require('../middleware/validate');

const router = Router();

/**
 * GET /api/dashboard/products
 * Products dashboard: aggregated metrics per ASIN with marketplace breakdown.
 * Query params: accountId, dateFrom?, dateTo?, page?, limit?
 */
router.get('/products', validate({ query: ['accountId'] }), async (req, res, next) => {
  try {
    const result = await AggregationService.getProductsDashboard({
      accountId: parseInt(req.query.accountId, 10),
      dateFrom: req.query.dateFrom || null,
      dateTo: req.query.dateTo || null,
      page: parseInt(req.query.page, 10) || 1,
      limit: parseInt(req.query.limit, 10) || 50,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/dashboard/asin
 * ASIN-level daily metrics with filters.
 * Query params: accountId, marketplaceId?, asin?, dateFrom?, dateTo?, page?, limit?
 */
router.get('/asin', validate({ query: ['accountId'] }), async (req, res, next) => {
  try {
    const result = await AggregationService.getAsinDashboard({
      accountId: parseInt(req.query.accountId, 10),
      marketplaceId: req.query.marketplaceId ? parseInt(req.query.marketplaceId, 10) : null,
      asin: req.query.asin || null,
      dateFrom: req.query.dateFrom || null,
      dateTo: req.query.dateTo || null,
      page: parseInt(req.query.page, 10) || 1,
      limit: parseInt(req.query.limit, 10) || 50,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/dashboard/account
 * Account-level daily KPIs.
 * Query params: accountId, marketplaceId?, dateFrom?, dateTo?
 */
router.get('/account', validate({ query: ['accountId'] }), async (req, res, next) => {
  try {
    const result = await AggregationService.getAccountDashboard({
      accountId: parseInt(req.query.accountId, 10),
      marketplaceId: req.query.marketplaceId ? parseInt(req.query.marketplaceId, 10) : null,
      dateFrom: req.query.dateFrom || null,
      dateTo: req.query.dateTo || null,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
