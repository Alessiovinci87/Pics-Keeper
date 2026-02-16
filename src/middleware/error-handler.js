const logger = require('../utils/logger');
const config = require('../config');
const { AppError } = require('../utils/errors');

/**
 * Global error handling middleware.
 * Catches all errors and returns a structured JSON response.
 */
function errorHandler(err, req, res, _next) {
  // Log the error
  if (err instanceof AppError && err.statusCode < 500) {
    logger.warn('Client error', {
      statusCode: err.statusCode,
      message: err.message,
      path: req.path,
    });
  } else {
    logger.error('Server error', {
      message: err.message,
      stack: err.stack,
      path: req.path,
      method: req.method,
    });
  }

  const statusCode = err.statusCode || 500;
  const response = {
    error: {
      message: err.message || 'Internal Server Error',
      code: err.name || 'INTERNAL_ERROR',
    },
  };

  if (err.details) {
    response.error.details = err.details;
  }

  // Don't leak stack traces in production
  if (config.nodeEnv === 'development' && statusCode >= 500) {
    response.error.stack = err.stack;
  }

  res.status(statusCode).json(response);
}

module.exports = errorHandler;
