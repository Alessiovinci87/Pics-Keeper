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
        const response = await axios.post('https://api.amazon.com/auth/o2/token', {
          grant_type: 'refresh_token',
          refresh_token: this.target.sp_api_refresh_token,
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
   * Retries up to 8 times with exponential backoff, respects Retry-After header.
   * Refreshes access token on 401/403 errors.
   */
  async request(method, path, params = {}) {
    const maxRetries = 8;
    const baseDelay = 3000;

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

        return response.data.payload || response.data;
      } catch (err) {
        const status = err.response?.status;
        const retryAfterHeader = err.response?.headers?.['x-amzn-ratelimit-limit']
          || err.response?.headers?.['retry-after'];

        // Rate limited (429) - wait and retry
        if (status === 429) {
          const retryDelay = retryAfterHeader
            ? Math.max(parseInt(retryAfterHeader, 10) * 1000, baseDelay)
            : baseDelay * Math.pow(2, attempt - 1);
          const cappedDelay = Math.min(retryDelay, 60000);

          logger.warn(`SP-API rate limited (429) on ${path}, attempt ${attempt}/${maxRetries}, waiting ${cappedDelay}ms`, {
            path,
            attempt,
          });

          if (attempt === maxRetries) {
            throw new ExternalApiError(`SP-API rate limited after ${maxRetries} attempts: ${path}`);
          }

          await sleep(cappedDelay);
          continue;
        }

        // Unauthorized (401/403) - refresh token and retry once
        if ((status === 401 || status === 403) && attempt <= 2) {
          logger.warn(`SP-API auth error (${status}) on ${path}, refreshing token`, { path });
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
   * List financial events (paginated).
   */
  async listFinancialEvents({ PostedAfter, PostedBefore, NextToken }) {
    const params = { PostedAfter, PostedBefore };
    if (NextToken) params.NextToken = NextToken;

    return this.request('GET', '/finances/v0/financialEvents', params);
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
