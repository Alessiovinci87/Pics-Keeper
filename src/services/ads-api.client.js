const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');
const { ExternalApiError } = require('../utils/errors');
const { retry, sleep } = require('../utils/helpers');

/**
 * Amazon Advertising API v3 Reporting Client.
 * Handles report creation, polling, and download for ASIN-level daily spend data.
 *
 * v3 API reference:
 *   POST /reporting/reports
 *   adProduct: SPONSORED_PRODUCTS | SPONSORED_BRANDS | SPONSORED_DISPLAY
 *   Columns vary per adProduct; see column maps below.
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

    if (!config.adsApi.clientId || !config.adsApi.clientSecret) {
      throw new ExternalApiError('AmazonAds', 'Missing Ads API credentials (clientId or clientSecret)');
    }

    if (!this.target.ads_api_refresh_token) {
      throw new ExternalApiError('AmazonAds', 'Missing ads_api_refresh_token for account', {
        accountId: this.target.account_id,
      });
    }

    try {
      const response = await retry(
        () =>
          axios.post('https://api.amazon.com/auth/o2/token', {
            grant_type: 'refresh_token',
            refresh_token: this.target.ads_api_refresh_token,
            client_id: config.adsApi.clientId,
            client_secret: config.adsApi.clientSecret,
          }),
        { maxRetries: 3, baseDelay: 2000, label: 'Ads API token' }
      );

      this.accessToken = response.data.access_token;
      this.tokenExpiresAt = Date.now() + response.data.expires_in * 1000;
      return this.accessToken;
    } catch (err) {
      const responseBody = err.response?.data;
      const status = err.response?.status;

      logger.error('Ads API token exchange failed', {
        status,
        responseBody: typeof responseBody === 'object' ? JSON.stringify(responseBody) : responseBody,
        accountId: this.target.account_id,
      });

      if (responseBody?.error === 'invalid_grant') {
        throw new ExternalApiError(
          'AmazonAds',
          `Token exchange failed: invalid_grant. The refresh token may be expired or revoked.`,
          { accountId: this.target.account_id, status }
        );
      }

      throw new ExternalApiError(
        'AmazonAds',
        `Token exchange failed with status ${status}: ${responseBody?.error_description || responseBody?.error || err.message}`,
        { accountId: this.target.account_id, status, responseBody }
      );
    }
  }

  /**
   * Make an authenticated Ads API request.
   * Logs full Amazon error body on failure for debugging.
   */
  async request(method, path, data = {}, profileId = null) {
    const token = await this.getAccessToken();
    const headers = {
      Authorization: `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': config.adsApi.clientId,
      'Content-Type': 'application/json',
    };
    if (profileId) {
      headers['Amazon-Advertising-API-Scope'] = String(profileId);
    }

    try {
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
    } catch (err) {
      const responseBody = err.response?.data;
      const status = err.response?.status;

      logger.error('Ads API request failed', {
        method,
        path,
        status,
        responseBody: typeof responseBody === 'object' ? JSON.stringify(responseBody) : responseBody,
        profileId,
        accountId: this.target.account_id,
      });

      throw new ExternalApiError(
        'AmazonAds',
        `${method} ${path} failed with status ${status}`,
        { status, responseBody, profileId }
      );
    }
  }

  /**
   * v3 Reporting API: valid adProduct values.
   */
  static get AD_PRODUCTS() {
    return {
      SP: 'SPONSORED_PRODUCTS',
      SB: 'SPONSORED_BRANDS',
      SD: 'SPONSORED_DISPLAY',
    };
  }

  /**
   * v3 Reporting API: report type IDs per campaign type.
   */
  static get REPORT_TYPE_IDS() {
    return {
      SP: 'spAdvertisedProduct',
      SB: 'sbPurchasedProduct',
      SD: 'sdAdvertisedProduct',
    };
  }

  /**
   * v3 Reporting API: valid columns per campaign type.
   * Column names differ between campaign types in v3.
   */
  static get COLUMN_SETS() {
    return {
      SP: ['advertisedAsin', 'date', 'impressions', 'clicks', 'cost', 'sales14d', 'unitsSold14d'],
      SB: ['purchasedAsin', 'date', 'impressions', 'clicks', 'cost', 'sales14d', 'unitsSold14d'],
      SD: ['advertisedAsin', 'date', 'impressions', 'clicks', 'cost', 'sales14d', 'unitsSold14d'],
    };
  }

  /**
   * Map v3 response row fields back to a normalized structure for our DB.
   * v3 uses different field names per campaign type.
   */
  static normalizeRow(row, campaignType) {
    return {
      asin: row.advertisedAsin || row.purchasedAsin || row.asin || null,
      date: row.date || null,
      impressions: parseInt(row.impressions, 10) || 0,
      clicks: parseInt(row.clicks, 10) || 0,
      cost: parseFloat(row.cost) || 0,
      sales: parseFloat(row.sales14d || row.sales) || 0,
      orders: parseInt(row.unitsSold14d || row.unitsSold || row.purchases || row.orders) || 0,
    };
  }

  /**
   * Get ASIN-level daily report via v3 reporting API.
   * Creates a report, polls for completion, then downloads.
   *
   * Returns normalized array: [{ asin, date, impressions, clicks, cost, sales, orders }]
   */
  async getAsinDailyReport({ profileId, campaignType, startDate, endDate }) {
    if (!profileId) {
      logger.warn('No Ads profile ID, skipping report', {
        accountId: this.target.account_id,
        campaignType,
      });
      return [];
    }

    const adProduct = AdsApiClient.AD_PRODUCTS[campaignType];
    const reportTypeId = AdsApiClient.REPORT_TYPE_IDS[campaignType];
    const columns = AdsApiClient.COLUMN_SETS[campaignType];

    if (!adProduct || !reportTypeId || !columns) {
      logger.warn('Unknown campaign type, skipping', { campaignType });
      return [];
    }

    logger.debug('Creating Ads v3 report', {
      campaignType,
      adProduct,
      reportTypeId,
      columns,
      startDate,
      endDate,
      profileId,
    });

    // Step 1: Create report via v3 API
    const createResponse = await this.request(
      'POST',
      '/reporting/reports',
      {
        startDate,
        endDate,
        configuration: {
          adProduct,
          groupBy: ['asin'],
          columns,
          reportTypeId,
          timeUnit: 'DAILY',
          format: 'GZIP_JSON',
        },
      },
      profileId
    );

    const reportId = createResponse.reportId;
    logger.debug('Ads report created', { reportId, campaignType, adProduct });

    // Step 2: Poll for completion (max 60 attempts, 5s each = 5 min max)
    let status = 'PROCESSING';
    let downloadUrl = null;

    for (let i = 0; i < 60 && status === 'PROCESSING'; i++) {
      await sleep(5000);
      const statusResponse = await this.request('GET', `/reporting/reports/${reportId}`, {}, profileId);
      status = statusResponse.status;

      if (status === 'COMPLETED') {
        downloadUrl = statusResponse.url;
      } else if (status === 'FAILED') {
        logger.error('Ads report generation failed on Amazon side', {
          reportId,
          campaignType,
          statusResponse,
        });
        return [];
      }
    }

    if (!downloadUrl) {
      logger.warn('Ads report not completed in time', { reportId, campaignType, lastStatus: status });
      return [];
    }

    // Step 3: Download and decompress
    try {
      const reportData = await axios.get(downloadUrl, { responseType: 'arraybuffer' });
      const zlib = require('zlib');
      const decompressed = zlib.gunzipSync(reportData.data);
      const rawRows = JSON.parse(decompressed.toString());

      // Normalize column names to our internal schema
      const rows = rawRows.map((row) => AdsApiClient.normalizeRow(row, campaignType));

      logger.debug('Ads report downloaded and parsed', {
        reportId,
        campaignType,
        rowCount: rows.length,
      });

      return rows;
    } catch (downloadErr) {
      logger.error('Failed to download/parse Ads report', {
        reportId,
        campaignType,
        error: downloadErr.message,
      });
      return [];
    }
  }
}

module.exports = AdsApiClient;
