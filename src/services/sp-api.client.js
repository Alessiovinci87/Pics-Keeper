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
   */
  async request(method, path, params = {}) {
    const token = await this.getAccessToken();

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
        }).catch((err) => {
          // Enrich error with response details for better debugging
          if (err.response?.data) {
            const detail = JSON.stringify(err.response.data).substring(0, 500);
            err.message = `${err.message} - ${detail}`;
          }
          throw err;
        }),
      { maxRetries: 5, baseDelay: 2000, label: `SP-API ${method} ${path}` }
    );

    return response.data.payload || response.data;
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
