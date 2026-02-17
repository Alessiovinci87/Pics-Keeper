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

      // Validate profile ID before making API calls
      const profileId = this.getProfileId(target, target.country_code);
      if (!profileId) {
        logger.warn('No Ads profile ID configured for this marketplace, skipping ads sync', {
          accountId: target.account_id,
          countryCode: target.country_code,
          hint: 'Set ads_profile_ids in the account record: [{countryCode: "XX", profileId: "123"}]',
        });
        await SyncLogger.complete(syncLog.id, { processed: 0, inserted: 0, updated: 0 });
        return { processed: 0, inserted: 0 };
      }

      const adsClient = new AdsApiClient(target);

      // Fetch reports for each campaign type: SP, SB, SD
      const campaignTypes = ['SP', 'SB', 'SD'];

      for (const campaignType of campaignTypes) {
        try {
          const report = await adsClient.getAsinDailyReport({
            profileId,
            campaignType,
            startDate: toDateStr(from),
            endDate: toDateStr(to),
          });

          for (const row of report) {
            processed++;
            const result = await this.upsertAdsDailySpend(target, row, campaignType);
            if (result === 'inserted') inserted++;
          }
        } catch (err) {
          // Log per-campaign-type failure but continue with other types
          logger.error('Ads report failed for campaign type', {
            accountId: target.account_id,
            countryCode: target.country_code,
            campaignType,
            error: err.message,
          });
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
   * Handles both v3 API field names (spend, sales14d, purchases14d)
   * and legacy field names (cost, sales, purchases) as fallback.
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
        parseFloat(row.spend || row.cost || 0),
        parseFloat(row.sales14d || row.sales || 0),
        row.purchases14d || row.purchases || row.orders || 0,
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
