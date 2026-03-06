const { Router } = require('express');
const ReconciliationService = require('../modules/reconciliation/reconciliation.service');
const validate = require('../middleware/validate');

const router = Router();

/**
 * POST /api/reconciliation/business-report
 * Import Business Report data from Seller Central.
 * Body: { accountId, rows: [{ marketplace_id, report_date, units_ordered, ordered_product_sales, ... }] }
 */
router.post('/business-report', validate({ body: ['accountId', 'rows'] }), async (req, res, next) => {
  try {
    const results = await ReconciliationService.importBusinessReport(
      parseInt(req.body.accountId, 10),
      req.body.rows
    );
    res.status(201).json({ data: results, count: results.length });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/reconciliation/compare
 * Compare Business Report vs orders_raw data.
 * Query params: accountId, marketplaceId?, dateFrom?, dateTo?
 */
router.get('/compare', validate({ query: ['accountId'] }), async (req, res, next) => {
  try {
    const result = await ReconciliationService.getReconciliation({
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

/**
 * GET /api/reconciliation/analyze/:date
 * Detailed discrepancy analysis for a specific date.
 * Query params: accountId, marketplaceId
 */
router.get('/analyze/:date', validate({ query: ['accountId', 'marketplaceId'] }), async (req, res, next) => {
  try {
    const result = await ReconciliationService.analyzeDiscrepancy(
      parseInt(req.query.accountId, 10),
      parseInt(req.query.marketplaceId, 10),
      req.params.date
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
