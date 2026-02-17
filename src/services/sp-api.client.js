const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');
const { retry, sleep } = require('../utils/helpers');
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
   * Validates credentials before calling, logs full error body on failure.
   */
  async getAccessToken() {
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60000) {
      return this.accessToken;
    }

    if (!config.spApi.clientId || !config.spApi.clientSecret) {
      throw new ExternalApiError('SP-API', 'Missing SP-API credentials (clientId or clientSecret)');
    }

    if (!this.target.sp_api_refresh_token) {
      throw new ExternalApiError('SP-API', 'Missing sp_api_refresh_token for account', {
        accountId: this.target.account_id,
      });
    }

    try {
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
    } catch (err) {
      const responseBody = err.response?.data;
      const status = err.response?.status;

      logger.error('SP-API token exchange failed', {
        status,
        responseBody: typeof responseBody === 'object' ? JSON.stringify(responseBody) : responseBody,
        accountId: this.target.account_id,
        region: this.target.region,
      });

      if (responseBody?.error === 'invalid_grant') {
        throw new ExternalApiError(
          'SP-API',
          'Token exchange failed: invalid_grant. The refresh token may be expired or revoked.',
          { accountId: this.target.account_id, status }
        );
      }

      throw new ExternalApiError(
        'SP-API',
        `Token exchange failed with status ${status}: ${responseBody?.error_description || responseBody?.error || err.message}`,
        { accountId: this.target.account_id, status, responseBody }
      );
    }
  }

  /**
   * Make an authenticated SP-API request.
   * Handles rate limiting (429) via retry with Retry-After header.
   */
  async request(method, path, params = {}) {
    const token = await this.getAccessToken();

    try {
      const response = await retry(
        () =>
          axios({
            method,
            url: `${this.baseUrl}${path}`,
            headers: {
              'x-amz-access-token': token,
              'Content-Type': 'application/json',
            },
            params: method === 'GET' ? params : undefined,
            data: method !== 'GET' ? params : undefined,
          }),
        { maxRetries: 3, baseDelay: 2000, label: `SP-API ${method} ${path}` }
      );

      return response.data.payload || response.data;
    } catch (err) {
      const status = err.response?.status;
      const responseBody = err.response?.data;

      // Handle rate limiting: back off and retry once
      if (status === 429) {
        const retryAfter = parseInt(err.response?.headers?.['retry-after'] || '2', 10);
        logger.warn('SP-API rate limited, backing off', { retryAfter, path });
        await sleep(retryAfter * 1000);
        return this.request(method, path, params);
      }

      logger.error('SP-API request failed', {
        method,
        path,
        status,
        responseBody: typeof responseBody === 'object' ? JSON.stringify(responseBody) : responseBody,
        accountId: this.target.account_id,
      });

      throw new ExternalApiError(
        'SP-API',
        `${method} ${path} failed with status ${status}`,
        { status, responseBody }
      );
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
