const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');
const { sleep } = require('../utils/helpers');
const { ExternalApiError } = require('../utils/errors');

/**
 * Amazon SP-API Client.
 * Handles authentication (LWA token exchange) and API calls.
 * One instance per account+marketplace target.
 */
class SpApiClient {
  constructor(target) {
    this.target = target;
    this.accessToken = null;
    this.tokenExpiresAt = 0;

    // Region-based endpoints
    this.endpoints = {
      EU: 'https://sellingpartnerapi-eu.amazon.com',
      NA: 'https://sellingpartnerapi-na.amazon.com',
    };

    this.baseUrl = this.endpoints[target.region] || this.endpoints.EU;
  }

  /**
   * Get or refresh LWA access token.
   */
  async getAccessToken(forceRefresh = false) {
    if (!forceRefresh && this.accessToken && Date.now() < this.tokenExpiresAt - 60000) {
      return this.accessToken;
    }

    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        // Use region-specific refresh token: NA token for NA region, default for EU
        const refreshToken = this.target.region === 'NA' && this.target.sp_api_refresh_token_na
          ? this.target.sp_api_refresh_token_na
          : this.target.sp_api_refresh_token;

        logger.info('SP-API token exchange', {
          region: this.target.region,
          country: this.target.country_code,
          usingNaToken: !!(this.target.region === 'NA' && this.target.sp_api_refresh_token_na),
          tokenPrefix: refreshToken ? refreshToken.substring(0, 15) + '...' : 'MISSING',
          endpoint: this.baseUrl,
        });

        const response = await axios.post('https://api.amazon.com/auth/o2/token', {
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: config.spApi.clientId,
          client_secret: config.spApi.clientSecret,
        });

        this.accessToken = response.data.access_token;
        this.tokenExpiresAt = Date.now() + response.data.expires_in * 1000;
        return this.accessToken;
      } catch (err) {
        if (attempt === 4) throw err;
        const delay = 2000 * Math.pow(2, attempt - 1);
        logger.warn(`SP-API token refresh attempt ${attempt} failed, retrying in ${delay}ms`, {
          error: err.message,
        });
        await sleep(delay);
      }
    }
  }

  /**
   * Custom params serializer that does NOT encode commas.
   * Amazon SP-API expects MarketplaceIds=A1,A2 (raw commas).
   */
  serializeParams(params) {
    const parts = [];
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
    // Restore commas that were encoded (SP-API expects raw commas for list params)
    return parts.join('&').replace(/%2C/gi, ',');
  }

  /**
   * Make an authenticated SP-API request with built-in rate-limit handling.
   * Retries up to 8 times with exponential backoff, respects rate-limit header.
   * Refreshes access token on 401/403 errors.
   */
  async request(method, path, params = {}) {
    const maxRetries = 8;
    const baseDelay = 3000;
    let wasRateLimited = false;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const token = await this.getAccessToken();

      try {
        const response = await axios({
          method,
          url: `${this.baseUrl}${path}`,
          headers: {
            'x-amz-access-token': token,
            'Content-Type': 'application/json',
          },
          params: method === 'GET' ? params : undefined,
          paramsSerializer: method === 'GET' ? (p) => this.serializeParams(p) : undefined,
          data: method !== 'GET' ? params : undefined,
        });

        // After recovering from rate limit, add cooldown to let tokens rebuild
        if (wasRateLimited) {
          await sleep(3000);
        }

        return response.data.payload || response.data;
      } catch (err) {
        const status = err.response?.status;

        // Rate limited (429) - calculate proper wait from rate limit header
        if (status === 429) {
          const rateLimitHeader = err.response?.headers?.['x-amzn-ratelimit-limit'];
          let retryDelay;

          if (rateLimitHeader) {
            const ratePerSecond = parseFloat(rateLimitHeader);
            retryDelay = ratePerSecond > 0 ? Math.ceil(1 / ratePerSecond) * 1000 : 180000;
          } else {
            retryDelay = baseDelay * Math.pow(2, attempt - 1);
          }

          // Cap between 3s and 180s
          retryDelay = Math.max(baseDelay, Math.min(retryDelay, 180000));

          if (attempt === maxRetries) {
            throw new ExternalApiError(`SP-API rate limited after ${maxRetries} attempts: ${path}`);
          }

          logger.info(`SP-API rate limited (429) on ${path}, waiting ${Math.round(retryDelay / 1000)}s for token restore (attempt ${attempt}/${maxRetries})`, {
            path,
            attempt,
            waitSeconds: Math.round(retryDelay / 1000),
          });

          await sleep(retryDelay);
          wasRateLimited = true;
          continue;
        }

        // Unauthorized (401/403) - refresh token and retry once
        if ((status === 401 || status === 403) && attempt <= 2) {
          const authErrorBody = err.response?.data;
          logger.warn(`SP-API auth error (${status}) on ${path}, refreshing token`, {
            path,
            endpoint: this.baseUrl,
            region: this.target.region,
            responseBody: JSON.stringify(authErrorBody),
          });
          await this.getAccessToken(true);
          continue;
        }

        // Bad request (400) - log details and throw (no point retrying)
        if (status === 400) {
          const errorBody = err.response?.data;
          logger.error(`SP-API bad request (400) on ${path}`, {
            path,
            params: JSON.stringify(params),
            responseBody: JSON.stringify(errorBody),
          });
          throw new ExternalApiError(
            `SP-API 400 on ${path}: ${JSON.stringify(errorBody?.errors || errorBody || err.message)}`
          );
        }

        // Server errors (5xx) - retry with backoff
        if (status >= 500 && attempt < maxRetries) {
          const delay = baseDelay * Math.pow(2, attempt - 1);
          logger.warn(`SP-API server error (${status}) on ${path}, attempt ${attempt}, retrying in ${delay}ms`);
          await sleep(delay);
          continue;
        }

        // All other errors - throw immediately
        throw err;
      }
    }
  }

  /**
   * Search orders (paginated) — Orders API v2026-01-01.
   * Returns orders WITH embedded orderItems (no separate getOrderItems call needed).
   * includedData: PROCEEDS (prices/taxes), FULFILLMENT (order status).
   */
  async searchOrders({ marketplaceIds, createdAfter, createdBefore, paginationToken }) {
    const params = {
      marketplaceIds: marketplaceIds.join(','),
      createdAfter,
      createdBefore,
      includedData: 'PROCEEDS,FULFILLMENT',
    };
    if (paginationToken) params.paginationToken = paginationToken;

    return this.request('GET', '/orders/2026-01-01/orders', params);
  }

  /**
   * Get orders (paginated) — Orders API v0 (legacy).
   */
  async getOrders({ MarketplaceIds, CreatedAfter, CreatedBefore, NextToken }) {
    const params = {
      MarketplaceIds: MarketplaceIds.join(','),
      CreatedAfter,
      CreatedBefore,
    };
    if (NextToken) params.NextToken = NextToken;

    return this.request('GET', '/orders/v0/orders', params);
  }

  /**
   * Get order items for a specific order (legacy v0 API).
   */
  async getOrderItems(orderId) {
    const result = await this.request('GET', `/orders/v0/orders/${orderId}/orderItems`);
    return result.OrderItems || [];
  }

  /**
   * List financial events (paginated).
   */
  async listFinancialEvents({ PostedAfter, PostedBefore, NextToken }) {
    const params = { PostedAfter, PostedBefore };
    if (NextToken) params.NextToken = NextToken;

    return this.request('GET', '/finances/v0/financialEvents', params);
  }

  // -------------------------------------------------------
  // Reports API v2021-06-30
  // -------------------------------------------------------

  /**
   * Create a report request.
   * @param {string} reportType - e.g. GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL
   * @param {string[]} marketplaceIds
   * @param {string} dataStartTime - ISO date
   * @param {string} dataEndTime - ISO date
   * @returns {{ reportId: string }}
   */
  async createReport({ reportType, marketplaceIds, dataStartTime, dataEndTime }) {
    return this.request('POST', '/reports/2021-06-30/reports', {
      reportType,
      marketplaceIds,
      dataStartTime,
      dataEndTime,
    });
  }

  /**
   * Get report status by reportId.
   * @returns {{ processingStatus, reportDocumentId, ... }}
   */
  async getReport(reportId) {
    return this.request('GET', `/reports/2021-06-30/reports/${reportId}`);
  }

  /**
   * Get report document download URL.
   * @returns {{ url, compressionAlgorithm }}
   */
  async getReportDocument(reportDocumentId) {
    return this.request('GET', `/reports/2021-06-30/documents/${reportDocumentId}`);
  }

  /**
   * Get catalog item details (images, title) for an ASIN.
   * Uses Catalog Items API v2022-04-01.
   */
  async getCatalogItem(asin, marketplaceId) {
    await sleep(500);
    const result = await this.request('GET', `/catalog/2022-04-01/items/${asin}`, {
      marketplaceIds: marketplaceId,
      includedData: 'images,summaries',
    });
    return result;
  }
}

module.exports = SpApiClient;
