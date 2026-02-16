require('dotenv').config();
const config = require('./config');
const logger = require('./utils/logger');
const app = require('./app');
const db = require('./database/pool');
const { startScheduler, stopScheduler } = require('./jobs/scheduler');

async function start() {
  try {
    // Verify database connection
    const dbResult = await db.query('SELECT NOW() AS now');
    logger.info('Database connected', { serverTime: dbResult.rows[0].now });

    // Start HTTP server
    const server = app.listen(config.port, () => {
      logger.info(`Server started on port ${config.port}`, {
        env: config.nodeEnv,
        port: config.port,
      });
    });

    // Start job scheduler
    startScheduler();

    // Graceful shutdown
    const shutdown = async (signal) => {
      logger.info(`${signal} received, shutting down gracefully`);
      stopScheduler();

      server.close(async () => {
        logger.info('HTTP server closed');
        await db.shutdown();
        logger.info('Database pool closed');
        process.exit(0);
      });

      // Force exit after 30s
      setTimeout(() => {
        logger.error('Forced shutdown after timeout');
        process.exit(1);
      }, 30000);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    process.on('unhandledRejection', (reason) => {
      logger.error('Unhandled rejection', { reason: reason?.message || reason });
    });

    process.on('uncaughtException', (err) => {
      logger.error('Uncaught exception', { error: err.message, stack: err.stack });
      process.exit(1);
    });
  } catch (err) {
    logger.error('Failed to start server', { error: err.message, stack: err.stack });
    process.exit(1);
  }
}

start();
