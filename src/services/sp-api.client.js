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
    /**
   * Make an authenticated SP-API request.
   * Handles 429 (rate limit) with proper backoff, retries 5xx, no retry on other 4xx.
   */
  async request(method, path, params = {}) {
    const MAX_ATTEMPTS = 6;
    const label = `SP-API ${method} ${path}`;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
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
          data: method !== 'GET' ? params : undefined,
        });

        return response.data.payload || response.data;
      } catch (err) {
        const status = err.response?.status;

        // 429 - Rate limited: wait using x-amzn-ratelimit-limit header or fallback
        if (status === 429) {
          if (attempt === MAX_ATTEMPTS) {
            logger.error(`${label} rate limited after ${MAX_ATTEMPTS} attempts, giving up`, { path });
            throw new ExternalApiError(`SP-API rate limit exceeded after ${MAX_ATTEMPTS} attempts: ${path}`);
          }
          // x-amzn-ratelimit-limit is requests/sec; invert for wait time. Fallback 60s.
          const rateHeader = err.response?.headers?.['x-amzn-ratelimit-limit'];
          let waitSec;
          if (rateHeader && parseFloat(rateHeader) > 0) {
            waitSec = Math.ceil(1 / parseFloat(rateHeader)) + 1;
          } else {
            waitSec = 60;
          }
          logger.warn(`${label} 429 rate limited, waiting ${waitSec}s (attempt ${attempt}/${MAX_ATTEMPTS})`, { path });
          await new Promise((r) => setTimeout(r, waitSec * 1000));
          continue;
        }

        // Other 4xx - client error, do not retry
        if (status && status >= 400 && status < 500) {
          logger.error(`${label} client error ${status}, not retrying`, {
            path,
            status,
            message: err.response?.data?.errors?.[0]?.message || err.message,
          });
          throw new ExternalApiError(`SP-API ${status} error: ${path} - ${err.message}`);
        }

        // 5xx or network error - retry with exponential backoff
        if (attempt === MAX_ATTEMPTS) {
          logger.error(`${label} failed after ${MAX_ATTEMPTS} attempts`, { path, error: err.message });
          throw new ExternalApiError(`SP-API failed after ${MAX_ATTEMPTS} attempts: ${path} - ${err.message}`);
        }
        const backoff = 2000 * Math.pow(2, attempt - 1); // 2s, 4s, 8s, 16s, 32s
        logger.warn(`${label} error (${status || 'network'}), retrying in ${backoff}ms (attempt ${attempt}/${MAX_ATTEMPTS})`, {
          path,
          error: err.message,
        });
        await new Promise((r) => setTimeout(r, backoff));
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
