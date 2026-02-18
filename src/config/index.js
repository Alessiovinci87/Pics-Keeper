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

  adsApi: {
    clientId: process.env.ADS_API_CLIENT_ID || '',
    clientSecret: process.env.ADS_API_CLIENT_SECRET || '',
  },

  sync: {
    maxDaysBack: parseInt(process.env.SYNC_MAX_DAYS_BACK, 10) || 3,
    profitDaysBack: parseInt(process.env.PROFIT_DAYS_BACK, 10) || 30,
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

module.exports = config;
