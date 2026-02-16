require('dotenv').config();

const config = {
  port: parseInt(process.env.PORT, 10) || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',

  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 5432,
    database: process.env.DB_NAME || 'amazon_finance',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
    min: parseInt(process.env.DB_POOL_MIN, 10) || 2,
    max: parseInt(process.env.DB_POOL_MAX, 10) || 20,
  },

  spApi: {
    clientId: process.env.SP_API_APP_CLIENT_ID || '',
    clientSecret: process.env.SP_API_APP_CLIENT_SECRET || '',
  },

  amazonAds: {
    clientId: process.env.AMAZON_ADS_CLIENT_ID || '',
    clientSecret: process.env.AMAZON_ADS_CLIENT_SECRET || '',
    tokenEndpoint: 'https://api.amazon.com/auth/o2/token',
  },

  cron: {
    syncOrders: process.env.SYNC_ORDERS_CRON || '*/10 * * * *',
    syncFinancial: process.env.SYNC_FINANCIAL_CRON || '*/15 * * * *',
    syncAds: process.env.SYNC_ADS_CRON || '*/15 * * * *',
    aggregation: process.env.AGGREGATION_CRON || '*/20 * * * *',
    alerts: process.env.ALERTS_CRON || '0 * * * *',
  },

  logLevel: process.env.LOG_LEVEL || 'info',
};

/**
 * Validate that required configuration is present.
 * Called at startup to fail fast rather than at first API call.
 */
config.validate = function () {
  const errors = [];

  if (!this.amazonAds.clientId) {
    errors.push('AMAZON_ADS_CLIENT_ID is required');
  }
  if (!this.amazonAds.clientSecret) {
    errors.push('AMAZON_ADS_CLIENT_SECRET is required');
  }
  if (!this.spApi.clientId) {
    errors.push('SP_API_APP_CLIENT_ID is required');
  }
  if (!this.spApi.clientSecret) {
    errors.push('SP_API_APP_CLIENT_SECRET is required');
  }

  return errors;
};

module.exports = config;
