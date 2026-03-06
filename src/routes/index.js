const { Router } = require('express');
const accountRoutes = require('../modules/accounts/account.routes');
const dashboardRoutes = require('./dashboard.routes');
const orderRoutes = require('./order.routes');
const alertRoutes = require('./alert.routes');
const cashRoutes = require('./cash.routes');
const asinCostRoutes = require('./asin-cost.routes');
const syncRoutes = require('./sync.routes');
const diagnosticsRoutes = require('./diagnostics.routes');
const reconciliationRoutes = require('./reconciliation.routes');

const router = Router();

// Health check
router.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Module routes
router.use('/accounts', accountRoutes);
router.use('/dashboard', dashboardRoutes);
router.use('/order', orderRoutes);
router.use('/alerts', alertRoutes);
router.use('/cash', cashRoutes);
router.use('/asin-costs', asinCostRoutes);
router.use('/sync', syncRoutes);
router.use('/diagnostics', diagnosticsRoutes);
router.use('/reconciliation', reconciliationRoutes);

module.exports = router;
