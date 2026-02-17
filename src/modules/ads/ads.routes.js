const { Router } = require('express');
const AdsController = require('./ads.controller');

const router = Router();

/**
 * POST /api/ads/sync
 * Historical ads sync (SP only, endDate = yesterday UTC).
 * Query: ?accountId=1
 */
router.post('/sync', AdsController.sync);

/**
 * GET /api/ads/live
 * Realtime intraday spend for today (no async reports, no DB).
 * Query: ?accountId=1
 */
router.get('/live', AdsController.live);

module.exports = router;
