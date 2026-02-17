const AdsService = require('./ads.service');
const AccountService = require('../accounts/account.service');
const logger = require('../../utils/logger');
const { ValidationError } = require('../../utils/errors');

/**
 * Ads Controller - handles HTTP requests for ads sync and live stats.
 */
const AdsController = {
  /**
   * POST /api/ads/sync
   * Trigger historical ads sync (SP only, endDate = yesterday).
   * Query: ?accountId=1
   */
  async sync(req, res, next) {
    try {
      const accountId = parseInt(req.query.accountId, 10);
      if (!accountId) {
        throw new ValidationError('accountId query parameter is required');
      }

      const targets = await AccountService.getActiveSyncTargets();
      const accountTargets = targets.filter((t) => t.account_id === accountId);

      if (accountTargets.length === 0) {
        return res.status(404).json({
          error: { message: `No active sync targets found for account ${accountId}` },
        });
      }

      const results = [];
      for (const target of accountTargets) {
        try {
          const result = await AdsService.syncAds(target);
          results.push({
            marketplace: target.country_code,
            ...result,
          });
        } catch (err) {
          logger.error('Ads sync failed for marketplace', {
            accountId,
            marketplace: target.country_code,
            error: err.message,
          });
          results.push({
            marketplace: target.country_code,
            error: err.message,
          });
        }
      }

      res.json({
        accountId,
        syncType: 'historical',
        campaignType: 'SP',
        results,
      });
    } catch (err) {
      next(err);
    }
  },

  /**
   * GET /api/ads/live
   * Fetch realtime intraday spend for today (no DB, no async reports).
   * Query: ?accountId=1
   */
  async live(req, res, next) {
    try {
      const accountId = parseInt(req.query.accountId, 10);
      if (!accountId) {
        throw new ValidationError('accountId query parameter is required');
      }

      const targets = await AccountService.getActiveSyncTargets();
      const accountTargets = targets.filter((t) => t.account_id === accountId);

      if (accountTargets.length === 0) {
        return res.status(404).json({
          error: { message: `No active sync targets found for account ${accountId}` },
        });
      }

      const results = [];
      for (const target of accountTargets) {
        try {
          const stats = await AdsService.getLiveSpend(target);
          results.push(stats);
        } catch (err) {
          logger.error('Live stats failed for marketplace', {
            accountId,
            marketplace: target.country_code,
            error: err.message,
          });
          results.push({
            marketplace: target.country_code,
            error: err.message,
          });
        }
      }

      res.json({
        accountId,
        type: 'live',
        results,
      });
    } catch (err) {
      next(err);
    }
  },
};

module.exports = AdsController;
