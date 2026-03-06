const db = require('../../database/pool');
const logger = require('../../utils/logger');

/**
 * Reconciliation Service - compares orders_raw data against
 * Seller Central Business Report data to identify discrepancies.
 *
 * The Business Report from Seller Central is the single source of truth
 * for units ordered and ordered product sales.
 */
const ReconciliationService = {
  /**
   * Import a Business Report row (single day, single marketplace).
   * Upserts to prevent duplicates.
   */
  async importBusinessReportDay(accountId, data) {
    const result = await db.query(
      `INSERT INTO business_report_daily (
        account_id, marketplace_id, report_date,
        ordered_product_sales, ordered_product_sales_b2b,
        units_ordered, units_ordered_b2b,
        total_order_items, total_order_items_b2b,
        page_views, page_views_b2b,
        sessions, sessions_b2b,
        buy_box_pct, buy_box_pct_b2b,
        unit_session_pct, unit_session_pct_b2b,
        currency, imported_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,NOW())
      ON CONFLICT (account_id, marketplace_id, report_date) DO UPDATE SET
        ordered_product_sales = EXCLUDED.ordered_product_sales,
        ordered_product_sales_b2b = EXCLUDED.ordered_product_sales_b2b,
        units_ordered = EXCLUDED.units_ordered,
        units_ordered_b2b = EXCLUDED.units_ordered_b2b,
        total_order_items = EXCLUDED.total_order_items,
        total_order_items_b2b = EXCLUDED.total_order_items_b2b,
        page_views = EXCLUDED.page_views,
        page_views_b2b = EXCLUDED.page_views_b2b,
        sessions = EXCLUDED.sessions,
        sessions_b2b = EXCLUDED.sessions_b2b,
        buy_box_pct = EXCLUDED.buy_box_pct,
        buy_box_pct_b2b = EXCLUDED.buy_box_pct_b2b,
        unit_session_pct = EXCLUDED.unit_session_pct,
        unit_session_pct_b2b = EXCLUDED.unit_session_pct_b2b,
        imported_at = NOW()
      RETURNING *`,
      [
        accountId,
        data.marketplace_id,
        data.report_date,
        data.ordered_product_sales || 0,
        data.ordered_product_sales_b2b || 0,
        data.units_ordered || 0,
        data.units_ordered_b2b || 0,
        data.total_order_items || 0,
        data.total_order_items_b2b || 0,
        data.page_views || 0,
        data.page_views_b2b || 0,
        data.sessions || 0,
        data.sessions_b2b || 0,
        data.buy_box_pct || 0,
        data.buy_box_pct_b2b || 0,
        data.unit_session_pct || 0,
        data.unit_session_pct_b2b || 0,
        data.currency || 'EUR',
      ]
    );

    return result.rows[0];
  },

  /**
   * Bulk import Business Report data (multiple days).
   */
  async importBusinessReport(accountId, rows) {
    const results = [];
    for (const row of rows) {
      const result = await this.importBusinessReportDay(accountId, row);
      results.push(result);
    }

    logger.info('Business Report imported', {
      accountId,
      rowsImported: results.length,
    });

    return results;
  },

  /**
   * Get reconciliation data for a date range.
   * Compares Business Report vs orders_raw using the v_sales_reconciliation view.
   */
  async getReconciliation({ accountId, marketplaceId, dateFrom, dateTo }) {
    const conditions = ['account_id = $1'];
    const params = [accountId];
    let idx = 2;

    if (marketplaceId) {
      conditions.push(`marketplace_id = $${idx}`);
      params.push(marketplaceId);
      idx++;
    }
    if (dateFrom) {
      conditions.push(`report_date >= $${idx}`);
      params.push(dateFrom);
      idx++;
    }
    if (dateTo) {
      conditions.push(`report_date <= $${idx}`);
      params.push(dateTo);
      idx++;
    }

    const daily = await db.query(
      `SELECT * FROM v_sales_reconciliation
       WHERE ${conditions.join(' AND ')}
       ORDER BY report_date, country_code`,
      params
    );

    // Summary totals
    const summary = await db.query(
      `SELECT
        marketplace_id,
        country_code,
        marketplace_name,
        SUM(br_units) AS total_br_units,
        SUM(br_sales) AS total_br_sales,
        SUM(db_units) AS total_db_units,
        SUM(db_sales) AS total_db_sales,
        SUM(db_units) - SUM(br_units) AS total_units_diff,
        CASE WHEN SUM(br_units) > 0
          THEN ROUND(((SUM(db_units) - SUM(br_units))::numeric / SUM(br_units)) * 100, 2)
          ELSE 0 END AS total_units_diff_pct,
        SUM(db_sales) - SUM(br_sales) AS total_sales_diff,
        CASE WHEN SUM(br_sales) > 0
          THEN ROUND(((SUM(db_sales) - SUM(br_sales)) / SUM(br_sales)) * 100, 2)
          ELSE 0 END AS total_sales_diff_pct
      FROM v_sales_reconciliation
      WHERE ${conditions.join(' AND ')}
      GROUP BY marketplace_id, country_code, marketplace_name
      ORDER BY country_code`,
      params
    );

    return {
      daily: daily.rows,
      summary: summary.rows,
    };
  },

  /**
   * Get discrepancy analysis for a specific date.
   * Breaks down the difference by order_status to help identify root causes.
   */
  async analyzeDiscrepancy(accountId, marketplaceId, reportDate) {
    // Get the timezone for this marketplace
    const mpResult = await db.query(
      'SELECT country_code FROM marketplaces WHERE id = $1',
      [marketplaceId]
    );
    const cc = mpResult.rows[0]?.country_code || 'IT';
    const tz = this.getTimezone(cc);

    // Business Report data
    const brResult = await db.query(
      `SELECT * FROM business_report_daily
       WHERE account_id = $1 AND marketplace_id = $2 AND report_date = $3`,
      [accountId, marketplaceId, reportDate]
    );

    // orders_raw breakdown by status
    const statusBreakdown = await db.query(
      `SELECT
        order_status,
        COUNT(*) AS order_lines,
        SUM(quantity) AS total_units,
        SUM(item_price + shipping_price - promotion_discount) AS total_sales
      FROM orders_raw
      WHERE account_id = $1
        AND marketplace_id = $2
        AND (purchase_date AT TIME ZONE $3)::date = $4
      GROUP BY order_status
      ORDER BY total_units DESC`,
      [accountId, marketplaceId, tz, reportDate]
    );

    // orders_raw filtered (matching profit engine logic)
    const filteredResult = await db.query(
      `SELECT
        COUNT(*) AS order_lines,
        SUM(quantity) AS total_units,
        SUM(item_price + shipping_price - promotion_discount) AS total_sales
      FROM orders_raw
      WHERE account_id = $1
        AND marketplace_id = $2
        AND (purchase_date AT TIME ZONE $3)::date = $4
        AND UPPER(order_status) != 'CANCELLED'`,
      [accountId, marketplaceId, tz, reportDate]
    );

    return {
      report_date: reportDate,
      business_report: brResult.rows[0] || null,
      orders_raw_by_status: statusBreakdown.rows,
      orders_raw_filtered: filteredResult.rows[0],
      discrepancy: {
        br_units: brResult.rows[0]?.units_ordered || 0,
        db_units: parseInt(filteredResult.rows[0]?.total_units || 0, 10),
        difference: parseInt(filteredResult.rows[0]?.total_units || 0, 10) -
                    (brResult.rows[0]?.units_ordered || 0),
      },
    };
  },

  /**
   * Get timezone for a country code.
   */
  getTimezone(countryCode) {
    const tzMap = {
      IT: 'Europe/Rome',
      DE: 'Europe/Berlin',
      FR: 'Europe/Paris',
      ES: 'Europe/Madrid',
      NL: 'Europe/Amsterdam',
      BE: 'Europe/Brussels',
      PL: 'Europe/Warsaw',
      SE: 'Europe/Stockholm',
      TR: 'Europe/Istanbul',
      GB: 'Europe/London',
      US: 'America/New_York',
      CA: 'America/Toronto',
    };
    return tzMap[countryCode] || 'Europe/Rome';
  },
};

module.exports = ReconciliationService;
