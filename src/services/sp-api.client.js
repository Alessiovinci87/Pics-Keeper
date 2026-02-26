const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');
const { retry } = require('../utils/helpers');
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
  async getAccessToken() {
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60000) {
      return this.accessToken;
    }

    const response = await retry(
      () =>
        axios.post('https://api.amazon.com/auth/o2/token', {
          grant_type: 'refresh_token',
          refresh_token: this.target.sp_api_refresh_token,
          client_id: config.spApi.clientId,
          client_secret: config.spApi.clientSecret,
        }),
      { maxRetries: 3, baseDelay: 2000, label: 'SP-API token' }
    );

    this.accessToken = response.data.access_token;
    this.tokenExpiresAt = Date.now() + response.data.expires_in * 1000;
    return this.accessToken;
  }

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
   * Get orders (paginated).
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
   * Get order items for a specific order.
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
}

module.exports = SpApiClient;
