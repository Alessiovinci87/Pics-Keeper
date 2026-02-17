const axios = require('axios');
const zlib = require('zlib');
const config = require('../config');
const logger = require('../utils/logger');
const { retry, sleep } = require('../utils/helpers');

// Polling configuration
const POLL_MAX_ATTEMPTS = 20;
const POLL_INITIAL_DELAY_MS = 10000; // 10s
const POLL_MAX_DELAY_MS = 30000; // 30s

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
   * Extract reportId from a 425 Duplicate response.
   * Amazon returns: "The Request is a duplicate of: <reportId>"
   */
  extractDuplicateReportId(err) {
    const body = err.response?.data;
    if (!body) return null;

    // Try body.reportId directly
    if (body.reportId) return body.reportId;

    // Try parsing from message string
    const text = typeof body === 'string' ? body : (body.message || body.details || '');
    const match = text.toString().match(/duplicate of:\s*(\S+)/i);
    return match ? match[1] : null;
  }

  /**
   * Get ASIN-level daily report via v3 reporting API.
   * Creates a report, polls for completion, then downloads.
   * Handles 425 duplicate by reusing the existing report.
   */
  async getAsinDailyReport({ profileId, campaignType, startDate, endDate }) {
    if (!profileId) {
      logger.warn('[Ads] No profile ID, skipping report', {
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

    const reportBody = {
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
    };

    logger.info('[Ads] Requesting report', {
      campaignType,
      reportTypeId: reportTypeMap[campaignType],
      startDate,
      endDate,
      profileId,
    });

    // Step 1: Create report (handle 425 duplicate)
    let reportId;
    try {
      const createResponse = await this.request('POST', '/reporting/reports', reportBody, profileId);
      reportId = createResponse.reportId;
      logger.info('[Ads] Report created', { reportId, campaignType });
    } catch (err) {
      if (err.response && err.response.status === 425) {
        reportId = this.extractDuplicateReportId(err);
        if (reportId) {
          logger.info('[Ads] Report is duplicate, reusing existing', { reportId, campaignType });
        } else {
          logger.error('[Ads] 425 duplicate but could not extract reportId', {
            campaignType,
            responseBody: JSON.stringify(err.response.data).substring(0, 500),
          });
          throw err;
        }
      } else {
        throw err;
      }
    }

    // Step 2: Poll for completion (progressive delay, max ~5 min)
    let downloadUrl = null;
    let delay = POLL_INITIAL_DELAY_MS;

    for (let attempt = 1; attempt <= POLL_MAX_ATTEMPTS; attempt++) {
      await sleep(delay);

      const statusResponse = await this.request('GET', `/reporting/reports/${reportId}`, {}, profileId);
      const status = statusResponse.status;

      logger.info('[Ads] Report poll', {
        reportId,
        campaignType,
        attempt,
        maxAttempts: POLL_MAX_ATTEMPTS,
        status,
      });

      if (status === 'COMPLETED') {
        downloadUrl = statusResponse.url;
        logger.info('[Ads] Report completed', { reportId, campaignType });
        break;
      }

      if (status === 'FAILURE') {
        logger.error('[Ads] Report failed on Amazon side', { reportId, campaignType });
        return [];
      }

      // PENDING or PROCESSING → continue with progressive delay
      delay = Math.min(Math.round(delay * 1.5), POLL_MAX_DELAY_MS);
    }

    if (!downloadUrl) {
      logger.warn('[Ads] Report not completed after max poll attempts', {
        reportId,
        campaignType,
        maxAttempts: POLL_MAX_ATTEMPTS,
      });
      return [];
    }

    // Step 3: Download and parse
    const reportData = await axios.get(downloadUrl, { responseType: 'arraybuffer' });
    const decompressed = zlib.gunzipSync(reportData.data);
    const rows = JSON.parse(decompressed.toString());

    logger.info('[Ads] Report downloaded and parsed', {
      reportId,
      campaignType,
      rowCount: rows.length,
    });

    return rows;
  }
}

module.exports = AdsApiClient;
