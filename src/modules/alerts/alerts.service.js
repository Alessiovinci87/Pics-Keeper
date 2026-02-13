const db = require('../../database/pool');
const logger = require('../../utils/logger');
const { round, toDateStr } = require('../../utils/helpers');
const SyncLogger = require('../../services/sync-logger');

/**
 * Default thresholds (used when no account-specific thresholds exist).
 */
const DEFAULT_THRESHOLDS = {
  negative_profit: 0,       // trigger when profit < 0
  low_roi: 10,              // trigger when ROI < 10%
  high_acos: 40,            // trigger when ACOS > 40%
  ads_spike: 50,            // trigger when ads spend increases by > 50% day-over-day
  payout_drift: 10,         // trigger when payout vs accrued profit difference > 10%
};

/**
 * Alert Engine - evaluates configurable triggers and generates alerts.
 */
const AlertsService = {
  /**
   * Run all alert checks for an account.
   */
  async evaluate(accountId) {
    const syncLog = await SyncLogger.start(accountId, null, 'alerts');
    let alertsGenerated = 0;

    try {
      logger.info('Starting alert evaluation', { accountId });

      const thresholds = await this.getThresholds(accountId);
      const today = toDateStr(new Date());

      // Run each alert check
      alertsGenerated += await this.checkNegativeProfit(accountId, today, thresholds);
      alertsGenerated += await this.checkLowRoi(accountId, today, thresholds);
      alertsGenerated += await this.checkHighAcos(accountId, today, thresholds);
      alertsGenerated += await this.checkAdsSpike(accountId, today, thresholds);
      alertsGenerated += await this.checkPayoutDrift(accountId, thresholds);

      await SyncLogger.complete(syncLog.id, { processed: alertsGenerated, inserted: alertsGenerated });

      logger.info('Alert evaluation completed', { accountId, alertsGenerated });
      return { alertsGenerated };
    } catch (err) {
      await SyncLogger.fail(syncLog.id, err.message);
      logger.error('Alert evaluation failed', { accountId, error: err.message });
      throw err;
    }
  },

  /**
   * Get thresholds for an account (with defaults fallback).
   */
  async getThresholds(accountId) {
    const result = await db.query(
      `SELECT alert_type, threshold_value FROM alert_thresholds
       WHERE account_id = $1 AND is_active = TRUE`,
      [accountId]
    );

    const thresholds = { ...DEFAULT_THRESHOLDS };
    for (const row of result.rows) {
      thresholds[row.alert_type] = parseFloat(row.threshold_value);
    }
    return thresholds;
  },

  /**
   * Check for ASINs with negative daily profit.
   */
  async checkNegativeProfit(accountId, date, thresholds) {
    const result = await db.query(
      `SELECT asin, marketplace_id, metric_date, net_profit, revenue,
              m.country_code
       FROM asin_daily_metrics adm
       LEFT JOIN marketplaces m ON m.id = adm.marketplace_id
       WHERE adm.account_id = $1
         AND adm.metric_date = $2
         AND adm.net_profit < $3`,
      [accountId, date, thresholds.negative_profit]
    );

    let count = 0;
    for (const row of result.rows) {
      await this.createAlert({
        accountId,
        marketplaceId: row.marketplace_id,
        asin: row.asin,
        alertType: 'negative_profit',
        severity: row.net_profit < -50 ? 'critical' : 'warning',
        title: `Negative profit on ${row.asin} (${row.country_code}): ${round(row.net_profit, 2)}`,
        message: `ASIN ${row.asin} had negative profit of ${round(row.net_profit, 2)} on ${row.metric_date}. Revenue: ${round(row.revenue, 2)}.`,
        metricValue: row.net_profit,
        thresholdValue: thresholds.negative_profit,
      });
      count++;
    }
    return count;
  },

  /**
   * Check for ASINs with ROI below threshold.
   */
  async checkLowRoi(accountId, date, thresholds) {
    const result = await db.query(
      `SELECT asin, marketplace_id, metric_date, roi_pct, net_profit,
              m.country_code
       FROM asin_daily_metrics adm
       LEFT JOIN marketplaces m ON m.id = adm.marketplace_id
       WHERE adm.account_id = $1
         AND adm.metric_date = $2
         AND adm.roi_pct < $3
         AND adm.revenue > 0`,
      [accountId, date, thresholds.low_roi]
    );

    let count = 0;
    for (const row of result.rows) {
      await this.createAlert({
        accountId,
        marketplaceId: row.marketplace_id,
        asin: row.asin,
        alertType: 'low_roi',
        severity: row.roi_pct < 0 ? 'critical' : 'warning',
        title: `Low ROI on ${row.asin} (${row.country_code}): ${round(row.roi_pct, 2)}%`,
        message: `ASIN ${row.asin} ROI is ${round(row.roi_pct, 2)}% (threshold: ${thresholds.low_roi}%).`,
        metricValue: row.roi_pct,
        thresholdValue: thresholds.low_roi,
      });
      count++;
    }
    return count;
  },

  /**
   * Check for ASINs with ACOS above threshold.
   */
  async checkHighAcos(accountId, date, thresholds) {
    const result = await db.query(
      `SELECT asin, marketplace_id, metric_date, acos_pct, ads_spend,
              m.country_code
       FROM asin_daily_metrics adm
       LEFT JOIN marketplaces m ON m.id = adm.marketplace_id
       WHERE adm.account_id = $1
         AND adm.metric_date = $2
         AND adm.acos_pct > $3
         AND adm.ads_spend > 0`,
      [accountId, date, thresholds.high_acos]
    );

    let count = 0;
    for (const row of result.rows) {
      await this.createAlert({
        accountId,
        marketplaceId: row.marketplace_id,
        asin: row.asin,
        alertType: 'high_acos',
        severity: row.acos_pct > 80 ? 'critical' : 'warning',
        title: `High ACOS on ${row.asin} (${row.country_code}): ${round(row.acos_pct, 2)}%`,
        message: `ASIN ${row.asin} ACOS is ${round(row.acos_pct, 2)}% (threshold: ${thresholds.high_acos}%). Ads spend: ${round(row.ads_spend, 2)}.`,
        metricValue: row.acos_pct,
        thresholdValue: thresholds.high_acos,
      });
      count++;
    }
    return count;
  },

  /**
   * Check for ads spend spikes (day-over-day increase exceeding threshold %).
   */
  async checkAdsSpike(accountId, date, thresholds) {
    const result = await db.query(
      `WITH daily AS (
        SELECT asin, marketplace_id, spend_date, SUM(spend) AS daily_spend
        FROM ads_daily_spend
        WHERE account_id = $1 AND spend_date >= ($2::date - INTERVAL '1 day') AND spend_date <= $2
        GROUP BY asin, marketplace_id, spend_date
      )
      SELECT
        t.asin, t.marketplace_id, t.daily_spend AS today_spend,
        y.daily_spend AS yesterday_spend,
        m.country_code,
        CASE WHEN y.daily_spend > 0
          THEN ROUND(((t.daily_spend - y.daily_spend) / y.daily_spend) * 100, 2)
          ELSE 0 END AS spike_pct
      FROM daily t
      JOIN daily y ON y.asin = t.asin AND y.marketplace_id = t.marketplace_id
        AND y.spend_date = t.spend_date - INTERVAL '1 day'
      LEFT JOIN marketplaces m ON m.id = t.marketplace_id
      WHERE t.spend_date = $2
        AND y.daily_spend > 0
        AND ((t.daily_spend - y.daily_spend) / y.daily_spend) * 100 > $3`,
      [accountId, date, thresholds.ads_spike]
    );

    let count = 0;
    for (const row of result.rows) {
      await this.createAlert({
        accountId,
        marketplaceId: row.marketplace_id,
        asin: row.asin,
        alertType: 'ads_spike',
        severity: parseFloat(row.spike_pct) > 100 ? 'critical' : 'warning',
        title: `Ads spike on ${row.asin} (${row.country_code}): +${row.spike_pct}%`,
        message: `ASIN ${row.asin} ads spend spiked ${row.spike_pct}%. Today: ${round(row.today_spend, 2)}, Yesterday: ${round(row.yesterday_spend, 2)}.`,
        metricValue: parseFloat(row.spike_pct),
        thresholdValue: thresholds.ads_spike,
      });
      count++;
    }
    return count;
  },

  /**
   * Check payout vs accrued profit drift.
   */
  async checkPayoutDrift(accountId, thresholds) {
    const result = await db.query(
      `SELECT * FROM payout_reconciliation
       WHERE account_id = $1
         AND ABS(difference_pct) > $2
         AND created_at > NOW() - INTERVAL '24 hours'`,
      [accountId, thresholds.payout_drift]
    );

    let count = 0;
    for (const row of result.rows) {
      await this.createAlert({
        accountId,
        marketplaceId: row.marketplace_id,
        asin: null,
        alertType: 'payout_drift',
        severity: Math.abs(parseFloat(row.difference_pct)) > 20 ? 'critical' : 'warning',
        title: `Payout drift: ${round(row.difference_pct, 2)}% difference`,
        message: `Payout of ${round(row.payout_amount, 2)} differs from accrued profit of ${round(row.accrued_profit, 2)} by ${round(row.difference_pct, 2)}%.`,
        metricValue: parseFloat(row.difference_pct),
        thresholdValue: thresholds.payout_drift,
      });
      count++;
    }
    return count;
  },

  /**
   * Create an alert (avoid duplicates: same type+asin+date).
   */
  async createAlert({ accountId, marketplaceId, asin, alertType, severity, title, message, metricValue, thresholdValue, context }) {
    // Check for existing active alert with same parameters in last 24h
    const existing = await db.query(
      `SELECT id FROM alerts
       WHERE account_id = $1 AND alert_type = $2
         AND COALESCE(asin, '') = COALESCE($3, '')
         AND status = 'active'
         AND triggered_at > NOW() - INTERVAL '24 hours'
       LIMIT 1`,
      [accountId, alertType, asin]
    );

    if (existing.rows.length > 0) {
      return; // Duplicate suppression
    }

    await db.query(
      `INSERT INTO alerts (
        account_id, marketplace_id, asin, alert_type, severity, status,
        title, message, metric_value, threshold_value, context
      ) VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $8, $9, $10)`,
      [accountId, marketplaceId, asin, alertType, severity, title, message, metricValue, thresholdValue, context ? JSON.stringify(context) : null]
    );
  },

  // ---- Query methods for API ----

  /**
   * Get alerts with filters.
   */
  async getAlerts({ accountId, status, alertType, limit = 50, page = 1 }) {
    const conditions = ['a.account_id = $1'];
    const params = [accountId];
    let idx = 2;

    if (status) {
      conditions.push(`a.status = $${idx}`);
      params.push(status);
      idx++;
    }
    if (alertType) {
      conditions.push(`a.alert_type = $${idx}`);
      params.push(alertType);
      idx++;
    }

    const offset = (page - 1) * limit;

    const result = await db.query(
      `SELECT a.*, m.country_code, m.name AS marketplace_name
       FROM alerts a
       LEFT JOIN marketplaces m ON m.id = a.marketplace_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY a.triggered_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset]
    );

    return result.rows;
  },

  /**
   * Acknowledge an alert.
   */
  async acknowledge(alertId) {
    await db.query(
      `UPDATE alerts SET status = 'acknowledged', acknowledged_at = NOW()
       WHERE id = $1`,
      [alertId]
    );
  },

  /**
   * Resolve an alert.
   */
  async resolve(alertId) {
    await db.query(
      `UPDATE alerts SET status = 'resolved', resolved_at = NOW()
       WHERE id = $1`,
      [alertId]
    );
  },

  /**
   * Update thresholds for an account.
   */
  async setThreshold(accountId, alertType, thresholdValue) {
    await db.query(
      `INSERT INTO alert_thresholds (account_id, alert_type, threshold_value)
       VALUES ($1, $2, $3)
       ON CONFLICT (account_id, alert_type) DO UPDATE SET
         threshold_value = EXCLUDED.threshold_value,
         updated_at = NOW()`,
      [accountId, alertType, thresholdValue]
    );
  },
};

module.exports = AlertsService;
