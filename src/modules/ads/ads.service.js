const db = require('../../database/pool');
const logger = require('../../utils/logger');
const { toDateStr } = require('../../utils/helpers');
const AdsApiClient = require('../../services/ads-api.client');
const SyncLogger = require('../../services/sync-logger');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
dayjs.extend(utc);

const MAX_DAYS_BACK = 14;

/**
 * Ads Sync Service - fetches daily spend from Amazon Advertising API.
 * Historical sync only (endDate = yesterday UTC, never today).
 * Sponsored Products (SP) only.
 * Idempotent via ON CONFLICT.
 */
const AdsService = {
  /**
   * Sync historical ads data for a single account+marketplace.
   * Only Sponsored Products. endDate is always yesterday (UTC).
   */
  async syncAds(target) {
    const syncLog = await SyncLogger.start(target.account_id, target.account_marketplace_id, 'ads');
    let processed = 0;
    let inserted = 0;

    try {
      // Determine startDate from MAX(spend_date) in DB — the true source of truth
      const lastSpendResult = await db.query(
        `SELECT MAX(spend_date) AS last_spend_date
         FROM ads_daily_spend
         WHERE account_id = $1 AND marketplace_id = $2`,
        [target.account_id, target.account_marketplace_id]
      );

      const lastSpendDate = lastSpendResult.rows[0]?.last_spend_date || null;
      const yesterday = dayjs.utc().subtract(1, 'day').format('YYYY-MM-DD');

      let startDate;
      if (lastSpendDate) {
        // Resume from the day after the last persisted spend_date
        startDate = dayjs.utc(lastSpendDate).add(1, 'day').format('YYYY-MM-DD');
      } else {
        // No data yet — backfill from maxDaysBack
        startDate = dayjs.utc().subtract(MAX_DAYS_BACK, 'day').format('YYYY-MM-DD');
      }
      const endDate = yesterday;

      logger.info('[Ads] Historical sync computed range', {
        accountId: target.account_id,
        marketplace: target.country_code,
        lastSpendDate: lastSpendDate || 'none',
        startDate,
        endDate,
        skip: startDate > endDate,
      });

      // If startDate > endDate, all days up to yesterday are already covered
      if (startDate > endDate) {
        logger.info('[Ads] Sync skipped — already up to date', {
          accountId: target.account_id,
          marketplace: target.country_code,
          lastSpendDate,
          startDate,
          endDate,
        });
        await SyncLogger.complete(syncLog.id, { processed: 0, inserted: 0, updated: 0, skipped: true });
        return { processed: 0, inserted: 0, skipped: true };
      }

      logger.info('[Ads] Starting historical sync', {
        accountId: target.account_id,
        marketplace: target.country_code,
        startDate,
        endDate,
      });

      const profileId = this.getProfileId(target, target.country_code);
      if (!profileId) {
        logger.warn('No ads profile ID found, skipping sync', {
          accountId: target.account_id,
          marketplace: target.country_code,
        });
        await SyncLogger.complete(syncLog.id, { processed: 0, inserted: 0, updated: 0, noProfile: true });
        return { processed: 0, inserted: 0, skipped: true };
      }

      const adsClient = new AdsApiClient(target);

      // Sponsored Products only
      const report = await adsClient.getAsinDailyReport({
        profileId,
        campaignType: 'SP',
        startDate,
        endDate,
      });

      for (const row of report) {
        processed++;
        const result = await this.upsertAdsDailySpend(target, row, 'SP');
        if (result === 'inserted') inserted++;
      }

      await SyncLogger.complete(syncLog.id, { processed, inserted, updated: processed - inserted });

      logger.info('[Ads] Historical sync completed', {
        accountId: target.account_id,
        marketplace: target.country_code,
        startDate,
        endDate,
        processed,
        inserted,
        updated: processed - inserted,
      });

      return { processed, inserted };
    } catch (err) {
      await SyncLogger.fail(syncLog.id, err.message);
      logger.error('[Ads] Historical sync failed', {
        accountId: target.account_id,
        marketplace: target.country_code,
        error: err.message,
      });
      throw err;
    }
  },

  /**
   * Fetch live intraday spend for today via SP campaigns stats endpoint.
   * No DB persistence — returns JSON for dashboard usage.
   */
  async getLiveSpend(target) {
    const profileId = this.getProfileId(target, target.country_code);
    if (!profileId) {
      logger.warn('No ads profile ID for live stats', {
        accountId: target.account_id,
        marketplace: target.country_code,
      });
      return { profileId: null, spend: 0, clicks: 0, sales: 0, impressions: 0, date: toDateStr(new Date()) };
    }

    const adsClient = new AdsApiClient(target);
    const today = toDateStr(new Date());

    logger.info('Fetching live ads spend', {
      accountId: target.account_id,
      marketplace: target.country_code,
      date: today,
      profileId,
    });

    const stats = await adsClient.getLiveStats({ profileId, date: today });

    logger.info('Live ads spend fetched', {
      accountId: target.account_id,
      marketplace: target.country_code,
      spend: stats.spend,
      clicks: stats.clicks,
    });

    return {
      profileId,
      date: today,
      marketplace: target.country_code,
      currency: target.currency,
      ...stats,
    };
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
