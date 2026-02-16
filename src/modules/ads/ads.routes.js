const { Router } = require('express');
const AdsService = require('./ads.service');

const router = Router();

// POST /api/ads/connect
router.post('/connect', async (req, res, next) => {
  try {
    const { accountId, refreshToken } = req.body;
    const result = await AdsService.connectAccount(accountId, refreshToken);
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
