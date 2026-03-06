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
  // SP-API requires CreatedBefore to be at least 2 minutes before current time
  const now = dayjs.utc().subtract(3, 'minute');
  let from;
  if (lastSyncAt) {
    from = dayjs.utc(lastSyncAt);
  } else {
    from = now.subtract(maxDaysBack, 'day');
  }

  // Guard: if from >= to (can happen when last_sync_at was set to NOW()
  // and we re-trigger within the 3-minute safety buffer), push from back
  // by 5 minutes so the API gets a valid (small) date range.
  if (from.isSame(now) || from.isAfter(now)) {
    from = now.subtract(5, 'minute');
  }

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
      const status = err.response?.status;
      // Don't retry client errors (except 429 rate limiting)
      if (status && status >= 400 && status < 500 && status !== 429) throw err;
      if (attempt === maxRetries) throw err;
      let delay;
      if (status === 429) {
        const retryAfter = parseInt(err.response?.headers?.['retry-after'] || '0', 10);
        delay = retryAfter > 0 ? retryAfter * 1000 : baseDelay * Math.pow(2, attempt) * 2;
      } else {
        delay = baseDelay * Math.pow(2, attempt - 1);
      }

      logger.warn(`${label} attempt ${attempt} failed, retrying in ${delay}ms`, {
        error: err.message,
        status,
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
