const { Router } = require('express');
const validate = require('../../middleware/validate');
const { connectAds } = require('./ads.controller');

const router = Router();

// POST /api/ads/connect
router.post('/connect', validate({ body: ['accountId', 'refreshToken'] }), connectAds);

module.exports = router;
