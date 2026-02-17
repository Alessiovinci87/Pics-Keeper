const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
dayjs.extend(utc);

const db = require('../../database/pool');
const logger = require('../../utils/logger');
const { syncDateRange, toDateStr } = require('../../utils/helpers');
const AdsApiClient = require('../../services/ads-api.client');
const SyncLogger = require('../../services/sync-logger');

// Only SP is stable for now; SB and SD are temporarily disabled
const ENABLED_CAMPAIGN_TYPES = ['SP'];

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
    let updated = 0;

    try {
      const { from, to } = syncDateRange(target.last_ads_sync_at, 14);

      // Cap endDate to yesterday — Amazon does not consolidate the current day
      const yesterday = dayjs.utc().subtract(1, 'day').format('YYYY-MM-DD');
      const startDate = toDateStr(from);
      let endDate = toDateStr(to);
      if (endDate > yesterday) {
        endDate = yesterday;
      }

      // Skip if date range is invalid (e.g., last sync was today)
      if (startDate > endDate) {
        logger.info('[Ads] No valid date range to sync (startDate > endDate)', {
          accountId: target.account_id,
          marketplace: target.country_code,
          startDate,
          endDate,
        });
        await SyncLogger.complete(syncLog.id, { processed: 0, inserted: 0, updated: 0 });
        return { processed: 0, inserted: 0, updated: 0 };
      }

      logger.info('[Ads] Starting sync', {
        accountId: target.account_id,
        marketplace: target.country_code,
        startDate,
        endDate,
        campaignTypes: ENABLED_CAMPAIGN_TYPES,
      });

      const adsClient = new AdsApiClient(target);

      for (const campaignType of ENABLED_CAMPAIGN_TYPES) {
        logger.info('[Ads] Fetching report', {
          accountId: target.account_id,
          marketplace: target.country_code,
          campaignType,
        });

        const report = await adsClient.getAsinDailyReport({
          profileId: this.getProfileId(target, target.country_code),
          campaignType,
          startDate,
          endDate,
        });

        logger.info('[Ads] Report rows received', {
          accountId: target.account_id,
          campaignType,
          rowCount: report.length,
        });

        for (const row of report) {
          processed++;
          const result = await this.upsertAdsDailySpend(target, row, campaignType);
          if (result === 'inserted') inserted++;
          else updated++;
        }
      }

      await SyncLogger.complete(syncLog.id, { processed, inserted, updated });

      logger.info('[Ads] Sync completed', {
        accountId: target.account_id,
        marketplace: target.country_code,
        processed,
        inserted,
        updated,
      });

      return { processed, inserted, updated };
    } catch (err) {
      await SyncLogger.fail(syncLog.id, err.message);
      logger.error('[Ads] Sync failed', {
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
