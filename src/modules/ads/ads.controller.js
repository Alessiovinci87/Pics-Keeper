const AdsConnectService = require('./ads.connect.service');

/**
 * POST /api/ads/connect
 * Connect an Amazon Ads account by saving the refresh token
 * and auto-discovering advertising profiles.
 */
async function connectAds(req, res, next) {
  try {
    const { accountId, refreshToken } = req.body;
    const profiles = await AdsConnectService.connect(accountId, refreshToken);

    res.json({
      connected: true,
      profiles,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { connectAds };
