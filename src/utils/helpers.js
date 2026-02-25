const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
dayjs.extend(utc);

/**
 * Round a number to N decimal places using banker's rounding.
 */
function round(value, decimals = 2) {
  if (value === null || value === undefined) return 0;
  const factor = Math.pow(10, decimals);
  return Math.round((parseFloat(value) + Number.EPSILON) * factor) / factor;
}

/**
 * Calculate percentage safely (returns 0 if divisor is 0).
 */
function pct(numerator, denominator, decimals = 2) {
  if (!denominator || denominator === 0) return 0;
  const result = round((numerator / denominator) * 100, decimals);
  return Math.max(-9999, Math.min(9999, result));
}

/**
 * Calculate ROI: (profit / cost) * 100.
 */
function roi(profit, cost, decimals = 2) {
  if (!cost || cost === 0) return 0;
  const result = round((profit / cost) * 100, decimals);
  return Math.max(-9999, Math.min(9999, result));
}

/**
 * Get current UTC timestamp as ISO string.
 */
function nowUtc() {
  return dayjs.utc().toISOString();
}

/**
 * Parse date string to YYYY-MM-DD format.
 */
function toDateStr(dateInput) {
  return dayjs.utc(dateInput).format('YYYY-MM-DD');
}

/**
 * Build a date range for incremental sync: from lastSync to now, capped at maxDays.
 * Always goes back at least maxDaysBack to catch orders missed by earlier narrow windows.
 */
function syncDateRange(lastSyncAt, maxDaysBack = 30) {
  const now = dayjs.utc();
  const from = now.subtract(maxDaysBack, 'day').startOf('day');
  return {
    from: from.toISOString(),
    to: now.toISOString(),
  };
}

/**
 * Sleep for ms milliseconds (for retry backoff).
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry an async function with exponential backoff.
 */
async function retry(fn, { maxRetries = 3, baseDelay = 1000, label = 'operation' } = {}) {
  const logger = require('./logger');
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      // Don't retry client errors (4xx except 429 rate limit) - they won't succeed on retry
      const status = err.response?.status;
      if (status && status >= 400 && status < 500 && status !== 429) {
        logger.error(`${label} failed with HTTP ${status}, not retrying`, {
          error: err.message,
        });
        throw err;
      }
      if (attempt === maxRetries) throw err;
      const delay = baseDelay * Math.pow(2, attempt - 1);
      logger.warn(`${label} attempt ${attempt} failed, retrying in ${delay}ms`, {
        error: err.message,
      });
      await sleep(delay);
    }
  }
}

/**
 * Chunk an array into batches of given size.
 */
function chunk(arr, size) {
  const result = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}

module.exports = {
  round,
  pct,
  roi,
  nowUtc,
  toDateStr,
  syncDateRange,
  sleep,
  retry,
  chunk,
};
