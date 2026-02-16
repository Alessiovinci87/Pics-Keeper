const axios = require('axios');
const zlib = require('zlib');
const config = require('../config');
const logger = require('../utils/logger');
const { retry, sleep } = require('../utils/helpers');

/**
 * Region-specific Amazon Advertising API base URLs.
 * See: https://advertising.amazon.com/API/docs/en-us/info/api-overview#api-endpoints
 */
const REGION_ENDPOINTS = {
  NA: 'https://advertising-api.amazon.com',
  EU: 'https://advertising-api-eu.amazon.com',
  FE: 'https://advertising-api-fe.amazon.com',
};

/**
 * Campaign type → Ads API report type mapping.
 */
const REPORT_TYPE_MAP = {
  SP: 'spAdvertisedProduct',
  SB: 'sbPurchasedProduct',
  SD: 'sdAdvertisedProduct',
};

const REPORT_POLL_INTERVAL_MS = 5000;
const REPORT_POLL_MAX_ATTEMPTS = 60;
const TOKEN_REFRESH_BUFFER_MS = 60000;

/**
 * Amazon Advertising API Client.
 *
 * One instance per account+marketplace target. Handles LWA token refresh,
 * authenticated requests, and async report creation/download.
 *
 * Requires:
 *   - target.ads_api_refresh_token  (per-account, stored in DB)
 *   - config.amazonAds.clientId     (app-level, from env)
 *   - config.amazonAds.clientSecret (app-level, from env)
 */
class AdsApiClient {
  /**
   * @param {Object} target - Account+marketplace sync target from getActiveSyncTargets()
   * @param {string} target.ads_api_refresh_token - LWA refresh token for this account
   * @param {string} target.region - 'EU', 'NA', or 'FE'
   * @param {number} target.account_id - Account ID for logging context
   */
  constructor(target) {
    if (!target.ads_api_refresh_token) {
      throw new Error(
        `Account ${target.account_id}: ads_api_refresh_token is missing. ` +
        'Set it via PATCH /api/accounts/:id before running ads sync.'
      );
    }

    if (!config.amazonAds.clientId || !config.amazonAds.clientSecret) {
      throw new Error(
        'AMAZON_ADS_CLIENT_ID and AMAZON_ADS_CLIENT_SECRET must be set in environment.'
      );
    }

    const baseUrl = REGION_ENDPOINTS[target.region];
    if (!baseUrl) {
      throw new Error(
        `Account ${target.account_id}: unsupported region "${target.region}". ` +
        `Supported: ${Object.keys(REGION_ENDPOINTS).join(', ')}`
      );
    }

    this.target = target;
    this.baseUrl = baseUrl;
    this.accessToken = null;
    this.tokenExpiresAt = 0;
  }

  /**
   * Get or refresh LWA access token.
   * Caches token in memory; refreshes when within 60s of expiry.
   *
   * @returns {Promise<string>} Valid access token
   */
  async getAccessToken() {
    if (this.accessToken && Date.now() < this.tokenExpiresAt - TOKEN_REFRESH_BUFFER_MS) {
      return this.accessToken;
    }

    const response = await retry(
      () =>
        axios.post(config.amazonAds.tokenEndpoint, {
          grant_type: 'refresh_token',
          refresh_token: this.target.ads_api_refresh_token,
          client_id: config.amazonAds.clientId,
          client_secret: config.amazonAds.clientSecret,
        }),
      { maxRetries: 3, baseDelay: 2000, label: `LWA token (account ${this.target.account_id})` }
    );

    this.accessToken = response.data.access_token;
    this.tokenExpiresAt = Date.now() + response.data.expires_in * 1000;

    logger.debug('LWA token refreshed', {
      accountId: this.target.account_id,
      expiresIn: response.data.expires_in,
    });

    return this.accessToken;
  }

  /**
   * Make an authenticated Ads API request.
   *
   * @param {string} method - HTTP method
   * @param {string} path - API path (appended to region base URL)
   * @param {Object} data - Request body (POST/PUT) or query params (GET)
   * @param {string|null} profileId - Advertising profile ID for scope header
   * @returns {Promise<Object>} Parsed response body
   */
  async request(method, path, data = {}, profileId = null) {
    const token = await this.getAccessToken();

    const headers = {
      Authorization: `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': config.amazonAds.clientId,
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
   * Fetch ASIN-level daily report via v3 async reporting API.
   *
   * Flow: create report → poll until COMPLETED → download GZIP JSON → parse.
   *
   * @param {Object} params
   * @param {string} params.profileId - Advertising profile ID
   * @param {string} params.campaignType - 'SP', 'SB', or 'SD'
   * @param {string} params.startDate - YYYY-MM-DD
   * @param {string} params.endDate - YYYY-MM-DD
   * @returns {Promise<Array>} Array of report rows, or empty array on skip/timeout
   */
  async getAsinDailyReport({ profileId, campaignType, startDate, endDate }) {
    if (!profileId) {
      logger.warn('No Ads profile ID for marketplace, skipping report', {
        accountId: this.target.account_id,
        countryCode: this.target.country_code,
        campaignType,
      });
      return [];
    }

    const reportTypeId = REPORT_TYPE_MAP[campaignType];
    if (!reportTypeId) {
      logger.warn('Unknown campaign type, skipping', { campaignType });
      return [];
    }

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
          reportTypeId,
          timeUnit: 'DAILY',
          format: 'GZIP_JSON',
        },
        startDate,
        endDate,
      },
      profileId
    );

    const reportId = createResponse.reportId;
    logger.debug('Ads report created', {
      reportId,
      campaignType,
      accountId: this.target.account_id,
      startDate,
      endDate,
    });

    // Step 2: Poll for completion
    const downloadUrl = await this._pollReportStatus(reportId, profileId, campaignType);
    if (!downloadUrl) {
      return [];
    }

    // Step 3: Download, decompress, parse
    return this._downloadReport(downloadUrl, reportId);
  }

  /**
   * Poll report status until COMPLETED or timeout.
   * @private
   */
  async _pollReportStatus(reportId, profileId, campaignType) {
    for (let attempt = 0; attempt < REPORT_POLL_MAX_ATTEMPTS; attempt++) {
      await sleep(REPORT_POLL_INTERVAL_MS);

      const statusResponse = await this.request(
        'GET',
        `/reporting/reports/${reportId}`,
        {},
        profileId
      );

      if (statusResponse.status === 'COMPLETED') {
        return statusResponse.url;
      }

      if (statusResponse.status === 'FAILED') {
        logger.error('Ads report generation failed', {
          reportId,
          campaignType,
          accountId: this.target.account_id,
          failureReason: statusResponse.failureReason,
        });
        return null;
      }
    }

    logger.warn('Ads report not completed within polling window', {
      reportId,
      campaignType,
      accountId: this.target.account_id,
      maxWaitMs: REPORT_POLL_INTERVAL_MS * REPORT_POLL_MAX_ATTEMPTS,
    });
    return null;
  }

  /**
   * Download and decompress a GZIP JSON report.
   * @private
   */
  async _downloadReport(downloadUrl, reportId) {
    const response = await axios.get(downloadUrl, { responseType: 'arraybuffer' });
    const decompressed = zlib.gunzipSync(response.data);
    const rows = JSON.parse(decompressed.toString());

    logger.debug('Ads report downloaded', { reportId, rowCount: rows.length });
    return rows;
  }
}

module.exports = AdsApiClient;
