const db = require('../../database/pool');
const logger = require('../../utils/logger');
const config = require('../../config');
const { syncDateRange, toDateStr } = require('../../utils/helpers');
const AdsApiClient = require('../../services/ads-api.client');
const SyncLogger = require('../../services/sync-logger');

/**
 * Ads Sync Service - fetches daily spend from Amazon Advertising API.
 * Aggregates by ASIN per day per campaign type.
 * Idempotent via ON CONFLICT.
 */
const AdsService = {
  /**
   * Connect an Amazon Advertising account by storing the refresh token
   * and fetching advertising profiles.
   */
  async connectAccount(accountId, refreshToken) {
    const axios = require('axios');
    const { retry } = require('../../utils/helpers');
    const { ExternalApiError, NotFoundError, ValidationError } = require('../../utils/errors');

    if (!accountId) throw new ValidationError('accountId is required');
    if (!refreshToken) throw new ValidationError('refreshToken is required');

    // Verify account exists
    const accountResult = await db.query('SELECT * FROM accounts WHERE id = $1', [accountId]);
    if (accountResult.rows.length === 0) throw new NotFoundError('Account');

    // Step 1: Exchange refresh token for access token
    let accessToken;
    try {
      const tokenResponse = await retry(
        () =>
          axios.post('https://api.amazon.com/auth/o2/token', {
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: config.adsApi.clientId,
            client_secret: config.adsApi.clientSecret,
          }),
        { maxRetries: 3, baseDelay: 2000, label: 'Ads token exchange' }
      );
      accessToken = tokenResponse.data.access_token;
    } catch (err) {
      throw new ExternalApiError(
        'Amazon Advertising',
        'Failed to exchange refresh token: ' + (err.response?.data?.error_description || err.message)
      );
    }

    // Step 2: Fetch advertising profiles
    let profiles;
    try {
      const profilesResponse = await retry(
        () =>
          axios.get('https://advertising-api.amazon.com/v2/profiles', {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Amazon-Advertising-API-ClientId': config.adsApi.clientId,
            },
          }),
        { maxRetries: 3, baseDelay: 2000, label: 'Ads fetch profiles' }
      );
      profiles = profilesResponse.data;
    } catch (err) {
      throw new ExternalApiError(
        'Amazon Advertising',
        'Failed to fetch advertising profiles: ' + (err.response?.data?.message || err.message)
      );
    }

    // Step 3: Map profiles to storage format
    const profileIds = profiles.map((p) => ({
      profileId: String(p.profileId),
      countryCode: p.countryCode,
      currencyCode: p.currencyCode,
      accountId: p.accountInfo?.id,
      type: p.accountInfo?.type,
    }));

    // Step 4: Store refresh token and profiles on the account
    const updateResult = await db.query(
      `UPDATE accounts
       SET ads_api_refresh_token = $1, ads_profile_ids = $2, updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [refreshToken, JSON.stringify(profileIds), accountId]
    );

    logger.info('Ads account connected', {
      accountId,
      profileCount: profileIds.length,
    });

    return {
      account: updateResult.rows[0],
      profiles: profileIds,
    };
  },

  /**
   * Sync ads data for a single account+marketplace.
   */
  async syncAds(target) {
    const syncLog = await SyncLogger.start(target.account_id, target.account_marketplace_id, 'ads');
    let processed = 0;
    let inserted = 0;

    try {
      const { from, to } = syncDateRange(target.last_ads_sync_at, 14);

      logger.info('Starting ads sync', {
        accountId: target.account_id,
        marketplace: target.country_code,
        from: toDateStr(from),
        to: toDateStr(to),
      });

      const adsClient = new AdsApiClient(target);

      // Fetch reports for each campaign type: SP, SB, SD
      const campaignTypes = ['SP', 'SB', 'SD'];

      for (const campaignType of campaignTypes) {
        const report = await adsClient.getAsinDailyReport({
          profileId: this.getProfileId(target, target.country_code),
          campaignType,
          startDate: toDateStr(from),
          endDate: toDateStr(to),
        });

        for (const row of report) {
          processed++;
          const result = await this.upsertAdsDailySpend(target, row, campaignType);
          if (result === 'inserted') inserted++;
        }
      }

      await SyncLogger.complete(syncLog.id, { processed, inserted, updated: 0 });

      logger.info('Ads sync completed', {
        accountId: target.account_id,
        marketplace: target.country_code,
        processed,
        inserted,
      });

      return { processed, inserted };
    } catch (err) {
      await SyncLogger.fail(syncLog.id, err.message);
      logger.error('Ads sync failed', {
        accountId: target.account_id,
        marketplace: target.country_code,
        error: err.message,
      });
      throw err;
    }
  },

  /**
   * Get the advertising profile ID for a given country.
   */
  getProfileId(target, countryCode) {
    const profiles = target.ads_profile_ids || [];
    const profile = profiles.find((p) => p.countryCode === countryCode);
    return profile?.profileId || null;
  },

  /**
   * Upsert a single daily ads spend row.
   */
  async upsertAdsDailySpend(target, row, campaignType) {
    const result = await db.query(
      `INSERT INTO ads_daily_spend (
        account_id, marketplace_id, asin, spend_date,
        impressions, clicks, spend, sales, orders_count,
        currency, campaign_type, raw_data
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (account_id, marketplace_id, asin, spend_date, campaign_type)
      DO UPDATE SET
        impressions = EXCLUDED.impressions,
        clicks = EXCLUDED.clicks,
        spend = EXCLUDED.spend,
        sales = EXCLUDED.sales,
        orders_count = EXCLUDED.orders_count,
        raw_data = EXCLUDED.raw_data,
        synced_at = NOW()
      RETURNING (xmax = 0) AS is_insert`,
      [
        target.account_id,
        target.account_marketplace_id,
        row.asin,
        row.date,
        row.impressions || 0,
        row.clicks || 0,
        parseFloat(row.cost || row.spend || 0),
        parseFloat(row.sales || row.attributedSales || 0),
        row.orders || row.attributedOrders || 0,
        target.currency,
        campaignType,
        JSON.stringify(row),
      ]
    );
    return result.rows[0]?.is_insert ? 'inserted' : 'updated';
  },

  /**
   * Get total ads spend for an ASIN on a specific day (all campaign types combined).
   * Used by profit engine for ads allocation.
   */
  async getDailySpendByAsin(accountId, marketplaceId, asin, date) {
    const result = await db.query(
      `SELECT
        COALESCE(SUM(spend), 0) AS total_spend,
        COALESCE(SUM(impressions), 0) AS total_impressions,
        COALESCE(SUM(clicks), 0) AS total_clicks,
        COALESCE(SUM(sales), 0) AS total_sales
      FROM ads_daily_spend
      WHERE account_id = $1 AND marketplace_id = $2 AND asin = $3 AND spend_date = $4`,
      [accountId, marketplaceId, asin, date]
    );
    return result.rows[0];
  },

  /**
   * Get aggregated spend for a marketplace on a date (for ACOS/TACOS at account level).
   */
  async getDailySpendByMarketplace(accountId, marketplaceId, date) {
    const result = await db.query(
      `SELECT
        asin,
        COALESCE(SUM(spend), 0) AS total_spend,
        COALESCE(SUM(sales), 0) AS total_sales
      FROM ads_daily_spend
      WHERE account_id = $1 AND marketplace_id = $2 AND spend_date = $3
      GROUP BY asin`,
      [accountId, marketplaceId, date]
    );
    return result.rows;
  },
};

module.exports = AdsService;
