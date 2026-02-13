const { Router } = require('express');
const AlertsService = require('../modules/alerts/alerts.service');
const validate = require('../middleware/validate');

const router = Router();

/**
 * GET /api/alerts
 * Get alerts with filters.
 * Query params: accountId, status?, alertType?, page?, limit?
 */
router.get('/', validate({ query: ['accountId'] }), async (req, res, next) => {
  try {
    const alerts = await AlertsService.getAlerts({
      accountId: parseInt(req.query.accountId, 10),
      status: req.query.status || null,
      alertType: req.query.alertType || null,
      page: parseInt(req.query.page, 10) || 1,
      limit: parseInt(req.query.limit, 10) || 50,
    });
    res.json({ data: alerts });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/alerts/:id/acknowledge
 */
router.patch('/:id/acknowledge', async (req, res, next) => {
  try {
    await AlertsService.acknowledge(parseInt(req.params.id, 10));
    res.json({ message: 'Alert acknowledged' });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/alerts/:id/resolve
 */
router.patch('/:id/resolve', async (req, res, next) => {
  try {
    await AlertsService.resolve(parseInt(req.params.id, 10));
    res.json({ message: 'Alert resolved' });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/alerts/thresholds
 * Set alert thresholds for an account.
 * Body: { accountId, alertType, thresholdValue }
 */
router.post('/thresholds', validate({ body: ['accountId', 'alertType', 'thresholdValue'] }), async (req, res, next) => {
  try {
    await AlertsService.setThreshold(
      req.body.accountId,
      req.body.alertType,
      req.body.thresholdValue
    );
    res.json({ message: 'Threshold updated' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
