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

    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.target.ads_api_refresh_token,
      client_id: config.adsApi.clientId,
      client_secret: config.adsApi.clientSecret,
    });

    const response = await retry(
      () =>
        axios.post(
          'https://api.amazon.com/auth/o2/token',
          params.toString(),
          {
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
            },
          }
        ),
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
    logger.debug('Ads report created', { reportId, campaignType });

    // Step 2: Poll for completion (max 60 attempts, 5s each = 5 min max)
    let status = 'PROCESSING';
    let downloadUrl = null;

    for (let i = 0; i < 60 && status === 'PROCESSING'; i++) {
      await sleep(5000);
      const statusResponse = await this.request('GET', `/reporting/reports/${reportId}`, {}, profileId);
      status = statusResponse.status;
      if (status === 'COMPLETED') {
        downloadUrl = statusResponse.url;
      }
    }

    if (!downloadUrl) {
      logger.warn('Ads report not completed in time', { reportId, campaignType });
      return [];
    }

    // Step 3: Download and parse
    const reportData = await axios.get(downloadUrl, { responseType: 'arraybuffer' });
    const zlib = require('zlib');
    const decompressed = zlib.gunzipSync(reportData.data);
    const rows = JSON.parse(decompressed.toString());

    return rows;
  }
}

module.exports = AdsApiClient;
