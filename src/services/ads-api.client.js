const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');
const { retry, sleep } = require('../utils/helpers');

/**
 * Amazon Advertising API Client.
 * Handles report creation, polling, and download for ASIN-level daily spend data.
 */
class AdsApiClient {
  constructor(target) {
    this.target = target;
    this.accessToken = null;
    this.tokenExpiresAt = 0;
    this.baseUrl = 'https://advertising-api-eu.amazon.com';

    // NA region uses different base URL
    if (target.region === 'NA') {
      this.baseUrl = 'https://advertising-api.amazon.com';
    }
  }

  /**
   * Get or refresh LWA access token for Ads API.
   */
  async getAccessToken() {
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60000) {
      return this.accessToken;
    }

    const response = await retry(
      () =>
        axios.post('https://api.amazon.com/auth/o2/token', {
          grant_type: 'refresh_token',
          refresh_token: this.target.ads_api_refresh_token,
          client_id: config.adsApi.clientId,
          client_secret: config.adsApi.clientSecret,
        }).catch((err) => {
          // Surface Amazon's error response for diagnostics (invalid_grant, invalid_client, etc.)
          if (err.response) {
            logger.error('[Ads] LWA token exchange failed', {
              status: err.response.status,
              data: err.response.data,
              accountId: this.target.account_id,
            });
          }
          throw err;
        }),
      { maxRetries: 3, baseDelay: 2000, label: 'Ads API token' }
    );

    this.accessToken = response.data.access_token;
    this.tokenExpiresAt = Date.now() + response.data.expires_in * 1000;
    return this.accessToken;
  }

  /**
   * Make an authenticated Ads API request.
   */
  async request(method, path, data = {}, profileId = null) {
    const token = await this.getAccessToken();
    const headers = {
      Authorization: `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': config.adsApi.clientId,
      'Content-Type': 'application/json',
    };
    if (profileId) {
      headers['Amazon-Advertising-API-Scope'] = profileId;
    }

    const response = await retry(
      () =>
        axios({
          method,
          url: `${this.baseUrl}${path}`,
          headers,
          data: method !== 'GET' ? data : undefined,
          params: method === 'GET' ? data : undefined,
        }),
      { maxRetries: 3, baseDelay: 2000, label: `Ads API ${method} ${path}` }
    );

    return response.data;
  }

  /**
   * Get ASIN-level daily report via v3 reporting API.
   * Creates a report, polls for completion, then downloads.
   * endDate must be <= yesterday — never request today's data via async reporting.
   */
  async getAsinDailyReport({ profileId, campaignType, startDate, endDate }) {
    if (!profileId) {
      logger.warn('No Ads profile ID, skipping report', {
        accountId: this.target.account_id,
        campaignType,
      });
      return [];
    }

    // Map campaign type to report type
    const reportTypeMap = {
      SP: 'spAdvertisedProduct',
      SB: 'sbPurchasedProduct',
      SD: 'sdAdvertisedProduct',
    };

    // Step 1: Create report
    const createResponse = await this.request(
      'POST',
      '/reporting/reports',
      {
        reportDate: startDate,
        configuration: {
          adProduct: campaignType,
          groupBy: ['asin'],
          columns: ['asin', 'date', 'impressions', 'clicks', 'cost', 'sales', 'purchases'],
          reportTypeId: reportTypeMap[campaignType],
          timeUnit: 'DAILY',
          format: 'GZIP_JSON',
        },
        startDate,
        endDate,
      },
      profileId
    );

    const reportId = createResponse.reportId;
    logger.info('Ads report created', { reportId, campaignType, startDate, endDate });

    // Step 2: Poll for completion (max 60 attempts, 5s each = 5 min max)
    // Handle both PENDING and PROCESSING states from Amazon
    let status = 'PENDING';
    let downloadUrl = null;

    for (let attempt = 1; attempt <= 60; attempt++) {
      await sleep(5000);
      const statusResponse = await this.request('GET', `/reporting/reports/${reportId}`, {}, profileId);
      status = statusResponse.status;

      logger.debug('Ads report poll', {
        reportId,
        campaignType,
        attempt,
        status,
      });

      if (status === 'COMPLETED') {
        downloadUrl = statusResponse.url;
        break;
      }

      if (status === 'FAILURE') {
        logger.error('Ads report failed on Amazon side', { reportId, campaignType, response: statusResponse });
        return [];
      }

      // Continue polling for PENDING or PROCESSING
    }

    if (!downloadUrl) {
      logger.warn('Ads report not completed in time', {
        reportId,
        campaignType,
        lastStatus: status,
        attempts: 60,
      });
      return [];
    }

    logger.info('Ads report completed, downloading', { reportId, campaignType });

    // Step 3: Download and parse
    const reportData = await axios.get(downloadUrl, { responseType: 'arraybuffer' });
    const zlib = require('zlib');
    const decompressed = zlib.gunzipSync(reportData.data);
    const rows = JSON.parse(decompressed.toString());

    logger.info('Ads report downloaded', { reportId, campaignType, rowCount: rows.length });

    return rows;
  }

  /**
   * Fetch live intraday stats for Sponsored Products campaigns.
   * Uses the SP campaigns endpoint for synchronous (non-async) data.
   * No report creation, no polling — direct API response.
   */
  async getLiveStats({ profileId, date }) {
    if (!profileId) {
      return { spend: 0, clicks: 0, sales: 0, impressions: 0 };
    }

    try {
      // Use SP campaigns list endpoint to get today's aggregated stats
      const campaigns = await this.request(
        'POST',
        '/sp/campaigns/list',
        {
          stateFilter: { include: ['ENABLED'] },
        },
        profileId
      );

      const campaignList = campaigns.campaigns || campaigns || [];

      if (!Array.isArray(campaignList) || campaignList.length === 0) {
        logger.info('No active SP campaigns found for live stats', { profileId });
        return { spend: 0, clicks: 0, sales: 0, impressions: 0 };
      }

      // Fetch today's stats using the campaigns report endpoint (synchronous snapshot)
      const campaignIds = campaignList
        .map((c) => c.campaignId)
        .filter(Boolean);

      const statsResponse = await this.request(
        'POST',
        '/sp/campaigns/report',
        {
          campaigns: campaignIds.slice(0, 100), // Limit to avoid payload issues
          startDate: date,
          endDate: date,
          metrics: ['impressions', 'clicks', 'cost', 'sales'],
        },
        profileId
      );

      // Aggregate all campaign stats
      let totalSpend = 0;
      let totalClicks = 0;
      let totalSales = 0;
      let totalImpressions = 0;

      const rows = statsResponse.campaigns || statsResponse || [];
      if (Array.isArray(rows)) {
        for (const row of rows) {
          totalSpend += parseFloat(row.cost || row.spend || 0);
          totalClicks += parseInt(row.clicks || 0, 10);
          totalSales += parseFloat(row.sales || 0);
          totalImpressions += parseInt(row.impressions || 0, 10);
        }
      }

      return {
        spend: Math.round(totalSpend * 10000) / 10000,
        clicks: totalClicks,
        sales: Math.round(totalSales * 10000) / 10000,
        impressions: totalImpressions,
        campaignCount: campaignIds.length,
      };
    } catch (err) {
      logger.error('Live stats fetch failed', {
        profileId,
        date,
        error: err.message,
      });
      throw err;
    }
  }
}

module.exports = AdsApiClient;
