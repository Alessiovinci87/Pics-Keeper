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
  return round((numerator / denominator) * 100, decimals);
}

/**
 * Calculate ROI: (profit / cost) * 100.
 */
function roi(profit, cost, decimals = 2) {
  if (!cost || cost === 0) return 0;
  return round((profit / cost) * 100, decimals);
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
 */
function syncDateRange(lastSyncAt, maxDaysBack = 30) {
  const now = dayjs.utc();
  let from;
  if (lastSyncAt) {
    from = dayjs.utc(lastSyncAt);
  } else {
    from = now.subtract(maxDaysBack, 'day');
  }
  // SP-API rejects ISO dates with milliseconds - use format without ms
  return {
    from: from.format('YYYY-MM-DDTHH:mm:ss[Z]'),
    to: now.format('YYYY-MM-DDTHH:mm:ss[Z]'),
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
