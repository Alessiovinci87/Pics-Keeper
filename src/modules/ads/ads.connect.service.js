const db = require('../../database/pool');
const config = require('../../config');
const logger = require('../../utils/logger');
const { NotFoundError, AppError, ExternalApiError } = require('../../utils/errors');
const AdsApiClient = require('../../services/ads-api.client');

/**
 * Service for connecting an Amazon Ads account.
 * Saves the refresh token, fetches available profiles, and persists them.
 */
const AdsConnectService = {
  /**
   * Connect an Amazon Ads account by saving the refresh token
   * and fetching all available advertising profiles.
   */
  async connect(accountId, refreshToken) {
    // 1. Validate env credentials
    if (!config.adsApi.clientId || !config.adsApi.clientSecret) {
      throw new AppError(
        'Amazon Ads API credentials (ADS_API_CLIENT_ID, ADS_API_CLIENT_SECRET) are not configured',
        500
      );
    }

    // 2. Verify account exists
    const accountResult = await db.query(
      'SELECT id FROM accounts WHERE id = $1',
      [accountId]
    );
    if (accountResult.rowCount === 0) {
      throw new NotFoundError('Account');
    }

    // 3. Save refresh token
    await db.query(
      'UPDATE accounts SET ads_api_refresh_token = $1, updated_at = NOW() WHERE id = $2',
      [refreshToken, accountId]
    );

    // 4. Fetch profiles from Amazon Ads API
    const client = new AdsApiClient({
      ads_api_refresh_token: refreshToken,
      region: 'EU',
    });

    let rawProfiles;
    try {
      rawProfiles = await client.request('GET', '/v2/profiles');
    } catch (err) {
      const status = err.response?.status;
      if (status === 401) {
        throw new ExternalApiError(
          'Amazon Ads',
          'Invalid or expired refresh token (401 Unauthorized)',
          { hint: 'Generate a new refresh token via Login with Amazon' }
        );
      }
      throw new ExternalApiError(
        'Amazon Ads',
        `Failed to fetch profiles: ${err.message}`
      );
    }

    // 5. Map to compact format
    const profiles = rawProfiles
      .filter((p) => p.accountInfo?.type === 'seller')
      .map((p) => ({
        countryCode: p.countryCode,
        profileId: String(p.profileId),
      }));

    // 6. Save profile IDs
    await db.query(
      'UPDATE accounts SET ads_profile_ids = $1, updated_at = NOW() WHERE id = $2',
      [JSON.stringify(profiles), accountId]
    );

    logger.info('Amazon Ads account connected', {
      accountId,
      profileCount: profiles.length,
    });

    return profiles;
  },
};

module.exports = AdsConnectService;
