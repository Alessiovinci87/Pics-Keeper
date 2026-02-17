const db = require('../../database/pool');
const logger = require('../../utils/logger');
const { syncDateRange, toDateStr } = require('../../utils/helpers');
const AdsApiClient = require('../../services/ads-api.client');
const SyncLogger = require('../../services/sync-logger');

/**
 * Ads Sync Service - fetches daily spend from Amazon Advertising API v3.
 * Aggregates by ASIN per day per campaign type.
 * Idempotent via ON CONFLICT.
 *
 * Strategy: SP (Sponsored Products) is the primary campaign type.
 * SB and SD are attempted but their failure does not block the overall sync.
 */
const AdsService = {
  /**
   * Sync ads data for a single account+marketplace.
   * Each campaign type is wrapped individually so one failure doesn't kill the others.
   */
  async syncAds(target) {
    const syncLog = await SyncLogger.start(target.account_id, target.account_marketplace_id, 'ads');
    let processed = 0;
    let inserted = 0;
    const errors = [];

    try {
      const { from, to } = syncDateRange(target.last_ads_sync_at, 14);

      logger.info('Starting ads sync', {
        accountId: target.account_id,
        marketplace: target.country_code,
        from: toDateStr(from),
        to: toDateStr(to),
      });

      const adsClient = new AdsApiClient(target);
      const profileId = this.getProfileId(target, target.country_code);

      if (!profileId) {
        logger.warn('No Ads profile ID found for marketplace, skipping ads sync', {
          accountId: target.account_id,
          marketplace: target.country_code,
        });
        await SyncLogger.complete(syncLog.id, { processed: 0, inserted: 0, updated: 0, skipped: 'no_profile_id' });
        return { processed: 0, inserted: 0 };
      }

      // SP is the primary campaign type. SB and SD are secondary.
      // Each is wrapped in try/catch so one failure doesn't block the others.
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
            if (!row.asin) {
              logger.debug('Skipping ads row with no ASIN', { campaignType, row });
              continue;
            }
            processed++;
            const result = await this.upsertAdsDailySpend(target, row, campaignType);
            if (result === 'inserted') inserted++;
          }

          logger.debug('Campaign type sync completed', {
            campaignType,
            accountId: target.account_id,
            marketplace: target.country_code,
            rowCount: report.length,
          });
        } catch (campaignErr) {
          errors.push({ campaignType, error: campaignErr.message });
          logger.error('Ads sync failed for campaign type', {
            campaignType,
            accountId: target.account_id,
            marketplace: target.country_code,
            error: campaignErr.message,
          });
          // Continue to next campaign type - don't break the loop
        }
      }

      await SyncLogger.complete(syncLog.id, { processed, inserted, updated: 0, errors });

      logger.info('Ads sync completed', {
        accountId: target.account_id,
        marketplace: target.country_code,
        processed,
        inserted,
        campaignErrors: errors.length,
      });

      return { processed, inserted, errors };
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
    if (!Array.isArray(profiles) || profiles.length === 0) return null;
    const profile = profiles.find((p) => p.countryCode === countryCode);
    return profile?.profileId || null;
  },

  /**
   * Upsert a single daily ads spend row.
   * Expects normalized row from AdsApiClient.normalizeRow():
   *   { asin, date, impressions, clicks, cost, sales, orders }
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
        parseFloat(row.cost || 0),
        parseFloat(row.sales || 0),
        row.orders || 0,
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
