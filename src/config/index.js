/**
 * Centralized configuration.
 * All process.env access is confined to this module.
 * dotenv must be loaded BEFORE this module is imported (see server.js).
 */

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

  adsApi: {
    clientId: process.env.ADS_API_CLIENT_ID || '',
    clientSecret: process.env.ADS_API_CLIENT_SECRET || '',
  },

  cron: {
    syncOrders: process.env.SYNC_ORDERS_CRON || '*/10 * * * *',
    syncFinancial: process.env.SYNC_FINANCIAL_CRON || '*/15 * * * *',
    syncAds: process.env.SYNC_ADS_CRON || '*/15 * * * *',
    aggregation: process.env.AGGREGATION_CRON || '*/20 * * * *',
    alerts: process.env.ALERTS_CRON || '0 * * * *',
  },

  corsOrigin: process.env.CORS_ORIGIN || '*',
  logLevel: process.env.LOG_LEVEL || 'info',
};

/**
 * Validate configuration at boot time.
 * Warns for missing optional credentials, throws for missing required config.
 */
function validateConfig() {
  const warnings = [];
  const errors = [];

  // Database is required in production
  if (!config.db.password && config.nodeEnv === 'production') {
    errors.push('DB_PASSWORD is required in production');
  }

  // SP-API credentials
  if (!config.spApi.clientId) {
    warnings.push('SP_API_APP_CLIENT_ID is not set. SP-API sync will fail.');
  }
  if (!config.spApi.clientSecret) {
    warnings.push('SP_API_APP_CLIENT_SECRET is not set. SP-API sync will fail.');
  }

  // Ads API credentials
  if (!config.adsApi.clientId) {
    warnings.push('ADS_API_CLIENT_ID is not set. Ads sync will fail.');
  }
  if (!config.adsApi.clientSecret) {
    warnings.push('ADS_API_CLIENT_SECRET is not set. Ads sync will fail.');
  }

  return { warnings, errors };
}

config.validate = validateConfig;

module.exports = config;
