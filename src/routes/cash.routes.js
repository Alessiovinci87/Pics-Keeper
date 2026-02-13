const { Router } = require('express');
const CashService = require('../modules/cash/cash.service');
const validate = require('../middleware/validate');

const router = Router();

/**
 * POST /api/cash/payout
 * Register an Amazon payout.
 * Body: { accountId, marketplaceId?, payoutDate, payoutAmount, periodStart, periodEnd, currency?, notes? }
 */
router.post('/payout', validate({ body: ['accountId', 'payoutDate', 'payoutAmount', 'periodStart', 'periodEnd'] }), async (req, res, next) => {
  try {
    const result = await CashService.registerPayout({
      accountId: req.body.accountId,
      marketplaceId: req.body.marketplaceId || null,
      payoutDate: req.body.payoutDate,
      payoutAmount: parseFloat(req.body.payoutAmount),
      periodStart: req.body.periodStart,
      periodEnd: req.body.periodEnd,
      currency: req.body.currency,
      notes: req.body.notes,
    });
    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/cash/summary
 * Get cash summary with payout history and trend.
 * Query params: accountId, marketplaceId?, dateFrom?, dateTo?
 */
router.get('/summary', validate({ query: ['accountId'] }), async (req, res, next) => {
  try {
    const result = await CashService.getSummary({
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
 * PATCH /api/cash/payout/:id
 * Update a payout record.
 */
router.patch('/payout/:id', async (req, res, next) => {
  try {
    const result = await CashService.updatePayout(parseInt(req.params.id, 10), req.body);
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
