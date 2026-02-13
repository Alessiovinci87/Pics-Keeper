const db = require('../../database/pool');
const logger = require('../../utils/logger');
const { round, pct } = require('../../utils/helpers');

/**
 * Cash Analysis Module.
 * Manages payout reconciliation: compares Amazon payouts against accrued profit.
 * Tracks historical discrepancies.
 */
const CashService = {
  /**
   * Register an Amazon payout and reconcile against accrued profit.
   */
  async registerPayout({ accountId, marketplaceId, payoutDate, payoutAmount, periodStart, periodEnd, currency, notes }) {
    logger.info('Registering payout', { accountId, payoutDate, payoutAmount });

    // Calculate accrued profit for the payout period
    const profitResult = await db.query(
      `SELECT COALESCE(SUM(net_profit), 0) AS accrued_profit
       FROM order_profit
       WHERE account_id = $1
         AND ($2::integer IS NULL OR marketplace_id = $2)
         AND order_date >= $3 AND order_date <= $4`,
      [accountId, marketplaceId || null, periodStart, periodEnd]
    );

    const accruedProfit = round(parseFloat(profitResult.rows[0].accrued_profit), 4);
    const difference = round(payoutAmount - accruedProfit, 4);
    const differencePct = pct(difference, accruedProfit, 4);

    const result = await db.query(
      `INSERT INTO payout_reconciliation (
        account_id, marketplace_id, payout_date, payout_amount,
        accrued_profit, difference, difference_pct,
        period_start, period_end, notes, currency
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *`,
      [
        accountId, marketplaceId || null, payoutDate, payoutAmount,
        accruedProfit, difference, differencePct,
        periodStart, periodEnd, notes || null, currency || 'EUR',
      ]
    );

    logger.info('Payout registered', {
      accountId,
      payoutDate,
      payoutAmount,
      accruedProfit,
      differencePct,
    });

    return result.rows[0];
  },

  /**
   * Get cash summary for an account: total payouts, accrued, drift.
   */
  async getSummary({ accountId, marketplaceId, dateFrom, dateTo }) {
    const conditions = ['pr.account_id = $1'];
    const params = [accountId];
    let idx = 2;

    if (marketplaceId) {
      conditions.push(`pr.marketplace_id = $${idx}`);
      params.push(marketplaceId);
      idx++;
    }
    if (dateFrom) {
      conditions.push(`pr.payout_date >= $${idx}`);
      params.push(dateFrom);
      idx++;
    }
    if (dateTo) {
      conditions.push(`pr.payout_date <= $${idx}`);
      params.push(dateTo);
      idx++;
    }

    // Summary totals
    const summaryResult = await db.query(
      `SELECT
        COUNT(*) AS payout_count,
        COALESCE(SUM(payout_amount), 0) AS total_payouts,
        COALESCE(SUM(accrued_profit), 0) AS total_accrued,
        COALESCE(SUM(difference), 0) AS total_difference,
        CASE WHEN SUM(accrued_profit) != 0
          THEN ROUND((SUM(difference) / ABS(SUM(accrued_profit))) * 100, 2)
          ELSE 0 END AS avg_drift_pct
       FROM payout_reconciliation pr
       WHERE ${conditions.join(' AND ')}`,
      params
    );

    // Individual payouts (history)
    const historyResult = await db.query(
      `SELECT pr.*, m.country_code, m.name AS marketplace_name
       FROM payout_reconciliation pr
       LEFT JOIN marketplaces m ON m.id = pr.marketplace_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY pr.payout_date DESC`,
      params
    );

    // Monthly trend of discrepancies
    const trendResult = await db.query(
      `SELECT
        DATE_TRUNC('month', payout_date) AS month,
        SUM(payout_amount) AS payouts,
        SUM(accrued_profit) AS accrued,
        SUM(difference) AS difference,
        CASE WHEN SUM(accrued_profit) != 0
          THEN ROUND((SUM(difference) / ABS(SUM(accrued_profit))) * 100, 2)
          ELSE 0 END AS drift_pct
       FROM payout_reconciliation pr
       WHERE ${conditions.join(' AND ')}
       GROUP BY DATE_TRUNC('month', payout_date)
       ORDER BY month DESC`,
      params
    );

    return {
      summary: summaryResult.rows[0],
      history: historyResult.rows,
      trend: trendResult.rows,
    };
  },

  /**
   * Update a payout record (e.g., add notes, correct amount).
   */
  async updatePayout(payoutId, updates) {
    const allowedFields = ['payout_amount', 'notes', 'period_start', 'period_end'];
    const fields = [];
    const values = [];
    let idx = 1;

    for (const [key, value] of Object.entries(updates)) {
      if (allowedFields.includes(key)) {
        fields.push(`${key} = $${idx}`);
        values.push(value);
        idx++;
      }
    }

    if (fields.length === 0) return null;

    fields.push(`updated_at = NOW()`);
    values.push(payoutId);

    const result = await db.query(
      `UPDATE payout_reconciliation SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );

    // Recalculate difference if amount changed
    if (updates.payout_amount) {
      const row = result.rows[0];
      const difference = round(row.payout_amount - row.accrued_profit, 4);
      const differencePct = pct(difference, row.accrued_profit, 4);
      await db.query(
        `UPDATE payout_reconciliation SET difference = $1, difference_pct = $2 WHERE id = $3`,
        [difference, differencePct, payoutId]
      );
    }

    return result.rows[0];
  },
};

module.exports = CashService;
