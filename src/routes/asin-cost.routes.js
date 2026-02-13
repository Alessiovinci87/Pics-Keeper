const { Router } = require('express');
const AsinCostsService = require('../modules/asin-costs/asin-costs.service');
const validate = require('../middleware/validate');

const router = Router();

/**
 * GET /api/asin-costs
 * List all ASIN costs for an account.
 * Query params: accountId, marketplaceId?, page?, limit?
 */
router.get('/', validate({ query: ['accountId'] }), async (req, res, next) => {
  try {
    const result = await AsinCostsService.listAll(
      parseInt(req.query.accountId, 10),
      {
        marketplaceId: req.query.marketplaceId ? parseInt(req.query.marketplaceId, 10) : null,
        page: parseInt(req.query.page, 10) || 1,
        limit: parseInt(req.query.limit, 10) || 100,
      }
    );
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/asin-costs/:asin
 * Get cost history for a specific ASIN.
 * Query params: accountId, marketplaceId?
 */
router.get('/:asin', validate({ query: ['accountId'], params: ['asin'] }), async (req, res, next) => {
  try {
    const result = await AsinCostsService.getHistory(
      parseInt(req.query.accountId, 10),
      req.params.asin,
      req.query.marketplaceId ? parseInt(req.query.marketplaceId, 10) : null
    );
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/asin-costs
 * Set costs for an ASIN.
 * Body: { accountId, asin, marketplaceId, costs: { productCost, inboundCost, ... }, effectiveFrom?, currency? }
 */
router.post('/', validate({ body: ['accountId', 'asin', 'marketplaceId', 'costs'] }), async (req, res, next) => {
  try {
    const result = await AsinCostsService.setCosts({
      accountId: req.body.accountId,
      asin: req.body.asin,
      marketplaceId: req.body.marketplaceId,
      costs: req.body.costs,
      effectiveFrom: req.body.effectiveFrom,
      currency: req.body.currency,
    });
    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/asin-costs/bulk
 * Bulk import ASIN costs.
 * Body: { accountId, rows: [{ asin, marketplaceId, productCost, ... }] }
 */
router.post('/bulk', validate({ body: ['accountId', 'rows'] }), async (req, res, next) => {
  try {
    const result = await AsinCostsService.bulkImport(req.body.accountId, req.body.rows);
    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
