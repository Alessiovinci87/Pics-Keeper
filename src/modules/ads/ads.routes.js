const { Router } = require('express');
const validate = require('../../middleware/validate');
const AccountService = require('../accounts/account.service');
const AdsApiClient = require('../../services/ads-api.client');
const logger = require('../../utils/logger');

const router = Router();

/**
 * POST /api/ads/connect
 * Connect an account to Amazon Advertising API.
 * Saves the refresh token and fetches advertising profiles.
 * Body: { accountId, refreshToken }
 */
router.post('/connect', validate({ body: ['accountId', 'refreshToken'] }), async (req, res, next) => {
  try {
    const { accountId, refreshToken } = req.body;

    // Save the ads refresh token on the account
    const account = await AccountService.update(accountId, {
      adsApiRefreshToken: refreshToken,
    });

    // Fetch advertising profiles from Amazon to validate the token
    const adsClient = new AdsApiClient({ ads_api_refresh_token: refreshToken });
    const token = await adsClient.getAccessToken();

    // Retrieve profiles list via Ads API
    const axios = require('axios');
    const profilesResponse = await axios.get(`${adsClient.baseUrl}/v2/profiles`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Amazon-Advertising-API-ClientId': require('../../config').adsApi.clientId,
      },
    });

    const profiles = (profilesResponse.data || []).map((p) => ({
      profileId: String(p.profileId),
      countryCode: p.countryCode,
      currencyCode: p.currencyCode,
      accountName: p.accountInfo?.name || null,
    }));

    // Save profiles on the account
    if (profiles.length > 0) {
      await AccountService.update(accountId, { adsProfileIds: profiles });
    }

    logger.info('Ads account connected', { accountId, profileCount: profiles.length });

    res.json({
      data: {
        accountId: account.id,
        connected: true,
        profiles,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/ads/profiles/:accountId
 * Get stored advertising profiles for an account.
 */
router.get('/profiles/:accountId', async (req, res, next) => {
  try {
    const account = await AccountService.getById(parseInt(req.params.accountId, 10));
    res.json({
      data: {
        accountId: account.id,
        profiles: account.ads_profile_ids || [],
        connected: !!account.ads_api_refresh_token,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
