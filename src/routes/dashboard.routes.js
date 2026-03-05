const { Router } = require('express');
const AggregationService = require('../modules/aggregation/aggregation.service');
const validate = require('../middleware/validate');
const db = require('../database/pool');

const router = Router();

/**
 * Resolve a country_code (e.g. 'IT') to the internal marketplace id.
 * Returns null if not found or not provided.
 */
async function resolveMarketplaceId(countryCode) {
  if (!countryCode) return null;
  const result = await db.query(
    'SELECT id FROM marketplaces WHERE country_code = $1 LIMIT 1',
    [countryCode.toUpperCase()]
  );
  return result.rows.length > 0 ? result.rows[0].id : null;
}

/**
 * GET /api/dashboard/products
 * Products dashboard: aggregated metrics per ASIN with marketplace breakdown.
 * Query params: accountId, countryCode?, marketplaceId?, dateFrom?, dateTo?, page?, limit?
 */
router.get('/products', validate({ query: ['accountId'] }), async (req, res, next) => {
  try {
    let marketplaceId = req.query.marketplaceId ? parseInt(req.query.marketplaceId, 10) : null;
    if (!marketplaceId && req.query.countryCode) {
      marketplaceId = await resolveMarketplaceId(req.query.countryCode);
    }
    const result = await AggregationService.getProductsDashboard({
      accountId: parseInt(req.query.accountId, 10),
      marketplaceId,
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
