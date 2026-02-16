const { Router } = require('express');
const AdsController = require('./ads.controller');

const router = Router();

// POST /api/ads/connect
router.post('/connect', AdsController.connect);

module.exports = router;
