const { Router } = require('express');
const db = require('../database/pool');
const validate = require('../middleware/validate');

const router = Router();

/**
 * GET /api/dashboard/products
 * Product-level dashboard: aggregated metrics per ASIN with per-marketplace breakdown.
 * Query params: accountId, dateFrom?, dateTo?, page?, limit?
 *
 * Returns for each ASIN:
 *  - totals aggregated across all marketplaces
 *  - per-marketplace breakdown (for country dropdown)
 *  - product info (title, image, ASIN)
 */
router.get('/', validate({ query: ['accountId'] }), async (req, res, next) => {
  try {
    const accountId = parseInt(req.query.accountId, 10);
    const dateFrom = req.query.dateFrom || null;
    const dateTo = req.query.dateTo || null;
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 50;
    const offset = (page - 1) * limit;

    const conditions = ['adm.account_id = $1'];
    const params = [accountId];
    let idx = 2;

    if (dateFrom) {
      conditions.push(`adm.metric_date >= $${idx}`);
      params.push(dateFrom);
      idx++;
    }
    if (dateTo) {
      conditions.push(`adm.metric_date <= $${idx}`);
      params.push(dateTo);
      idx++;
    }

    const whereClause = conditions.join(' AND ');

    // Get aggregated totals per ASIN (across all marketplaces and dates in range)
    const [productsResult, countResult] = await Promise.all([
      db.query(
        `SELECT
          adm.asin,
          a_info.title AS product_title,
          a_info.image_url,
          a_info.sku,
          SUM(adm.units_sold) AS units_sold,
          SUM(adm.orders_count) AS orders_count,
          SUM(adm.revenue) AS revenue,
          SUM(adm.total_amazon_fees) AS total_amazon_fees,
          SUM(adm.refunds) AS refunds,
          SUM(adm.ads_spend) AS ads_spend,
          SUM(adm.total_product_costs) AS total_product_costs,
          SUM(adm.net_profit) AS net_profit,
          CASE WHEN SUM(adm.revenue) > 0
            THEN ROUND((SUM(adm.net_profit) / SUM(adm.revenue)) * 100, 2)
            ELSE 0 END AS margin_pct,
          CASE WHEN SUM(adm.total_product_costs + adm.ads_spend) > 0
            THEN ROUND((SUM(adm.net_profit) / SUM(adm.total_product_costs + adm.ads_spend)) * 100, 2)
            ELSE 0 END AS roi_pct,
          CASE WHEN SUM(adm.ads_spend) > 0 AND SUM(adm.revenue) > 0
            THEN ROUND((SUM(adm.ads_spend) / SUM(adm.revenue)) * 100, 2)
            ELSE 0 END AS tacos_pct
        FROM asin_daily_metrics adm
        LEFT JOIN asins a_info ON a_info.account_id = adm.account_id AND a_info.asin = adm.asin
        WHERE ${whereClause}
        GROUP BY adm.asin, a_info.title, a_info.image_url, a_info.sku
        ORDER BY SUM(adm.revenue) DESC
        LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, limit, offset]
      ),
      db.query(
        `SELECT COUNT(DISTINCT adm.asin) FROM asin_daily_metrics adm WHERE ${whereClause}`,
        params
      ),
    ]);

    // For each ASIN, get per-marketplace breakdown
    const asins = productsResult.rows.map(r => r.asin);

    let marketplaceBreakdown = {};
    if (asins.length > 0) {
      const breakdownResult = await db.query(
        `SELECT
          adm.asin,
          m.country_code,
          m.name AS marketplace_name,
          m.currency,
          SUM(adm.units_sold) AS units_sold,
          SUM(adm.orders_count) AS orders_count,
          SUM(adm.revenue) AS revenue,
          SUM(adm.total_amazon_fees) AS total_amazon_fees,
          SUM(adm.refunds) AS refunds,
          SUM(adm.ads_spend) AS ads_spend,
          SUM(adm.total_product_costs) AS total_product_costs,
          SUM(adm.net_profit) AS net_profit,
          CASE WHEN SUM(adm.revenue) > 0
            THEN ROUND((SUM(adm.net_profit) / SUM(adm.revenue)) * 100, 2)
            ELSE 0 END AS margin_pct,
          CASE WHEN SUM(adm.total_product_costs + adm.ads_spend) > 0
            THEN ROUND((SUM(adm.net_profit) / SUM(adm.total_product_costs + adm.ads_spend)) * 100, 2)
            ELSE 0 END AS roi_pct,
          CASE WHEN SUM(adm.ads_spend) > 0 AND SUM(adm.revenue) > 0
            THEN ROUND((SUM(adm.ads_spend) / SUM(adm.revenue)) * 100, 2)
            ELSE 0 END AS tacos_pct
        FROM asin_daily_metrics adm
        JOIN marketplaces m ON m.id = adm.marketplace_id
        WHERE adm.account_id = $1
          AND adm.asin = ANY($2)
          ${dateFrom ? `AND adm.metric_date >= $3` : ''}
          ${dateTo ? `AND adm.metric_date <= $${dateFrom ? 4 : 3}` : ''}
        GROUP BY adm.asin, m.country_code, m.name, m.currency
        ORDER BY adm.asin, SUM(adm.revenue) DESC`,
        [accountId, asins, ...(dateFrom ? [dateFrom] : []), ...(dateTo ? [dateTo] : [])]
      );

      // Group breakdown by ASIN
      for (const row of breakdownResult.rows) {
        if (!marketplaceBreakdown[row.asin]) {
          marketplaceBreakdown[row.asin] = [];
        }
        marketplaceBreakdown[row.asin].push(row);
      }
    }

    // Compose response
    const products = productsResult.rows.map(product => ({
      ...product,
      marketplaces: marketplaceBreakdown[product.asin] || [],
    }));

    res.json({
      data: products,
      pagination: {
        page,
        limit,
        total: parseInt(countResult.rows[0].count, 10),
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
