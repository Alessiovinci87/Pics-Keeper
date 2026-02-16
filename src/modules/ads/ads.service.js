const db = require('../../database/pool');
const logger = require('../../utils/logger');
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
   * Connect an Amazon Advertising account by saving the refresh token
   * and fetching advertising profiles.
   */
  async connectAccount(accountId, refreshToken) {
    // Verify account exists
    const accountResult = await db.query(
      'SELECT id FROM accounts WHERE id = $1',
      [accountId]
    );
    if (accountResult.rows.length === 0) {
      const { NotFoundError } = require('../../utils/errors');
      throw new NotFoundError('Account');
    }

    // Save refresh token
    await db.query(
      'UPDATE accounts SET ads_api_refresh_token = $1 WHERE id = $2',
      [refreshToken, accountId]
    );

    // Build a minimal target for AdsApiClient
    const target = { ads_api_refresh_token: refreshToken };

    const adsClient = new AdsApiClient(target);

    let rawProfiles;
    try {
      rawProfiles = await adsClient.request('GET', '/v2/profiles');
    } catch (err) {
      const { ExternalApiError } = require('../../utils/errors');
      const isAuthError =
        err.response?.status === 401 ||
        err.message?.includes('invalid_grant') ||
        err.message?.includes('authorization_code');

      if (isAuthError) {
        logger.error('Invalid refresh token for ads connect', {
          accountId,
          status: err.response?.status,
        });
        throw new ExternalApiError(
          'Amazon Advertising',
          'Invalid or expired refresh token'
        );
      }

      logger.error('Failed to fetch advertising profiles', {
        accountId,
        error: err.message,
      });
      throw new ExternalApiError(
        'Amazon Advertising',
        'Failed to fetch advertising profiles'
      );
    }

    // Normalize profiles
    const profiles = (Array.isArray(rawProfiles) ? rawProfiles : []).map((p) => ({
      countryCode: p.countryCode,
      profileId: String(p.profileId),
      accountName: p.accountInfo?.name || p.accountInfo?.id || '',
    }));

    // Save profiles
    await db.query(
      'UPDATE accounts SET ads_profile_ids = $1 WHERE id = $2',
      [JSON.stringify(profiles), accountId]
    );

    logger.info('Amazon Ads account connected', {
      accountId,
      profileCount: profiles.length,
    });

    return { profiles };
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
