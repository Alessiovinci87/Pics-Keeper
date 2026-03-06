const { Router } = require('express');
const UnitsAuditService = require('../modules/diagnostics/units-audit.service');
const AccountService = require('../modules/accounts/account.service');
const SpApiClient = require('../services/sp-api.client');
const validate = require('../middleware/validate');
const logger = require('../utils/logger');

const router = Router();

/**
 * Marketplace timezone map (same as profit.service.js).
 */
const MARKETPLACE_TIMEZONES = {
  DE: 'Europe/Berlin',
  FR: 'Europe/Paris',
  IT: 'Europe/Rome',
  ES: 'Europe/Madrid',
  GB: 'Europe/London',
  NL: 'Europe/Amsterdam',
  SE: 'Europe/Stockholm',
  PL: 'Europe/Warsaw',
  TR: 'Europe/Istanbul',
  BE: 'Europe/Brussels',
  US: 'America/Los_Angeles',
  CA: 'America/Toronto',
};

/**
 * GET /api/diagnostics/units-audit
 * Full 9-query diagnostic audit comparing unit counts across data sources.
 *
 * Query params:
 *   accountId (required), marketplaceId (required),
 *   dateFrom (required), dateTo (required),
 *   asin (optional), timezone (optional, auto-resolved from marketplace)
 *
 * Example:
 *   /api/diagnostics/units-audit?accountId=1&marketplaceId=2&dateFrom=2026-02-15&dateTo=2026-02-16&asin=B0BY9Q4KTT
 */
router.get(
  '/units-audit',
  validate({ query: ['accountId', 'marketplaceId', 'dateFrom', 'dateTo'] }),
  async (req, res, next) => {
    try {
      const accountId = parseInt(req.query.accountId, 10);
      const marketplaceId = parseInt(req.query.marketplaceId, 10);
      const { dateFrom, dateTo, asin } = req.query;

      // Auto-resolve timezone from marketplace if not provided
      let timezone = req.query.timezone;
      if (!timezone) {
        const db = require('../database/pool');
        const mpResult = await db.query(
          'SELECT country_code FROM marketplaces WHERE id = $1',
          [marketplaceId]
        );
        const cc = mpResult.rows[0]?.country_code;
        timezone = MARKETPLACE_TIMEZONES[cc] || 'UTC';
      }

      const results = await UnitsAuditService.runAudit({
        accountId,
        marketplaceId,
        dateFrom,
        dateTo,
        asin: asin || null,
        timezone,
      });

      res.json({
        params: { accountId, marketplaceId, dateFrom, dateTo, asin: asin || null, timezone },
        ...results,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/diagnostics/precision-test
 * Order-by-order comparison for a single day: orders_raw vs order_profit.
 *
 * Query params:
 *   accountId (required), marketplaceId (required), date (required, YYYY-MM-DD),
 *   timezone (optional)
 *
 * Example:
 *   /api/diagnostics/precision-test?accountId=1&marketplaceId=2&date=2026-02-15
 */
router.get(
  '/precision-test',
  validate({ query: ['accountId', 'marketplaceId', 'date'] }),
  async (req, res, next) => {
    try {
      const accountId = parseInt(req.query.accountId, 10);
      const marketplaceId = parseInt(req.query.marketplaceId, 10);
      const { date } = req.query;

      let timezone = req.query.timezone;
      if (!timezone) {
        const db = require('../database/pool');
        const mpResult = await db.query(
          'SELECT country_code FROM marketplaces WHERE id = $1',
          [marketplaceId]
        );
        const cc = mpResult.rows[0]?.country_code;
        timezone = MARKETPLACE_TIMEZONES[cc] || 'UTC';
      }

      const results = await UnitsAuditService.precisionTest(accountId, marketplaceId, date, timezone);

      res.json({
        params: { accountId, marketplaceId, date, timezone },
        ...results,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/diagnostics/asin-diagnosis
 * Full diagnosis for a specific ASIN: orders, financial events, profit, metrics.
 *
 * Query params:
 *   accountId (required), marketplaceId (required), asin (required),
 *   dateFrom (required), dateTo (required)
 *
 * Example:
 *   /api/diagnostics/asin-diagnosis?accountId=1&marketplaceId=2&asin=B0BY9Q4KTT&dateFrom=2026-02-15&dateTo=2026-02-16
 */
router.get(
  '/asin-diagnosis',
  validate({ query: ['accountId', 'marketplaceId', 'asin', 'dateFrom', 'dateTo'] }),
  async (req, res, next) => {
    try {
      const accountId = parseInt(req.query.accountId, 10);
      const marketplaceId = parseInt(req.query.marketplaceId, 10);
      const { asin, dateFrom, dateTo } = req.query;

      const results = await UnitsAuditService.diagnoseAsin(
        accountId,
        marketplaceId,
        asin,
        dateFrom,
        dateTo
      );

      res.json({
        params: { accountId, marketplaceId, asin, dateFrom, dateTo },
        ...results,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/diagnostics/live-compare
 * Fetch orders LIVE from SP-API for a single day + optional ASIN,
 * then compare with what's in the DB.
 *
 * This is the key diagnostic: if SP-API returns 24 orders but our DB has 20,
 * we know 4 orders were lost during sync.
 *
 * Query params:
 *   countryCode (required, e.g. IT), date (required, YYYY-MM-DD),
 *   asin (optional, filter results to a specific ASIN)
 *
 * Example:
 *   /api/diagnostics/live-compare?countryCode=IT&date=2026-02-15&asin=B0BY9Q4KTT
 */
router.get(
  '/live-compare',
  validate({ query: ['countryCode', 'date'] }),
  async (req, res, next) => {
    try {
      const db = require('../database/pool');
      const countryCode = req.query.countryCode.toUpperCase();
      const { date, asin } = req.query;

      // Resolve target
      const targets = await AccountService.getActiveSyncTargets();
      const target = targets.find((t) => t.country_code === countryCode);
      if (!target) {
        return res.status(404).json({
          error: { message: `No active marketplace for country code: ${countryCode}` },
        });
      }

      const tz = MARKETPLACE_TIMEZONES[countryCode] || 'UTC';

      // Widen SP-API query window by 3 hours each side to capture
      // timezone boundary orders (max EU offset is +2 CEST).
      // The DB query with AT TIME ZONE does the precise local-date filtering.
      const dayjs = require('dayjs');
      const utc = require('dayjs/plugin/utc');
      dayjs.extend(utc);

      const dayStart = dayjs.utc(date).subtract(3, 'hour').toISOString();
      const dayEnd = dayjs.utc(date).add(1, 'day').add(3, 'hour').toISOString();

      logger.info('Live compare: fetching from SP-API', {
        countryCode, date, asin, dayStart, dayEnd,
      });

      // --- Part 1: Fetch from SP-API ---
      const spApi = new SpApiClient(target);
      const spApiOrders = [];
      let nextToken = null;

      do {
        const response = await spApi.getOrders({
          MarketplaceIds: [target.amazon_marketplace_id],
          CreatedAfter: dayStart,
          CreatedBefore: dayEnd,
          NextToken: nextToken,
        });

        const orders = response.Orders || [];
        for (const order of orders) {
          // Skip cancelled
          if (['Canceled', 'Cancelled'].includes(order.OrderStatus)) continue;

          const items = await spApi.getOrderItems(order.AmazonOrderId);
          for (const item of items) {
            if (asin && item.ASIN !== asin) continue;
            spApiOrders.push({
              amazonOrderId: order.AmazonOrderId,
              asin: item.ASIN,
              sku: item.SellerSKU,
              quantity: item.QuantityOrdered || 1,
              orderStatus: order.OrderStatus,
              purchaseDate: order.PurchaseDate,
            });
          }
          // Rate limiting
          await new Promise((r) => setTimeout(r, 500));
        }
        nextToken = response.NextToken || null;
      } while (nextToken);

      // --- Part 2: Fetch from DB (strict mode, timezone-aware) ---
      const dbParams = [
        target.account_id,
        target.account_marketplace_id,
        date,
        dayjs(date).add(1, 'day').format('YYYY-MM-DD'),
        tz,
      ];
      let asinFilter = '';
      if (asin) {
        asinFilter = 'AND asin = $6';
        dbParams.push(asin);
      }

      const dbResult = await db.query(
        `SELECT amazon_order_id, asin, sku, quantity, order_status,
                purchase_date,
                purchase_date::date AS utc_date,
                (purchase_date AT TIME ZONE $5)::date AS local_date
         FROM orders_raw
         WHERE account_id = $1 AND marketplace_id = $2
           AND (purchase_date AT TIME ZONE $5)::date >= $3::date
           AND (purchase_date AT TIME ZONE $5)::date < $4::date
           AND UPPER(order_status) NOT IN ('CANCELLED', 'CANCELED')
           ${asinFilter}
         ORDER BY purchase_date`,
        dbParams
      );

      // --- Part 3: Compare ---
      const spApiSet = new Map();
      for (const o of spApiOrders) {
        const key = `${o.amazonOrderId}:${o.asin}`;
        spApiSet.set(key, o);
      }

      const dbSet = new Map();
      for (const o of dbResult.rows) {
        const key = `${o.amazon_order_id}:${o.asin}`;
        dbSet.set(key, o);
      }

      const inApiNotDb = [];
      for (const [key, order] of spApiSet) {
        if (!dbSet.has(key)) inApiNotDb.push(order);
      }

      const inDbNotApi = [];
      for (const [key, order] of dbSet) {
        if (!spApiSet.has(key)) inDbNotApi.push(order);
      }

      // Quantity mismatches (same order+ASIN but different quantity)
      const quantityMismatches = [];
      for (const [key, apiOrder] of spApiSet) {
        const dbOrder = dbSet.get(key);
        if (dbOrder && apiOrder.quantity !== dbOrder.quantity) {
          quantityMismatches.push({
            amazonOrderId: apiOrder.amazonOrderId,
            asin: apiOrder.asin,
            spApiQuantity: apiOrder.quantity,
            dbQuantity: dbOrder.quantity,
          });
        }
      }

      const spApiUnits = spApiOrders.reduce((s, o) => s + o.quantity, 0);
      const dbUnits = dbResult.rows.reduce((s, o) => s + o.quantity, 0);

      res.json({
        params: { countryCode, date, asin: asin || null, timezone: tz },
        comparison: {
          spApiOrderLines: spApiOrders.length,
          spApiUnits,
          dbOrderLines: dbResult.rows.length,
          dbUnits,
          unitsDifference: spApiUnits - dbUnits,
          inApiNotDb: inApiNotDb.length,
          inDbNotApi: inDbNotApi.length,
          quantityMismatches: quantityMismatches.length,
        },
        missingFromDb: inApiNotDb,
        extraInDb: inDbNotApi,
        quantityMismatches,
        spApiDateRange: { from: dayStart, to: dayEnd },
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/diagnostics/db-orders
 * List all orders in DB for a given day + ASIN, showing status, quantity, and dates.
 * Quick view without calling SP-API.
 *
 * Query params:
 *   accountId (required), marketplaceId (required), date (required),
 *   asin (optional), timezone (optional)
 *
 * Example:
 *   /api/diagnostics/db-orders?accountId=1&marketplaceId=2&date=2026-02-15&asin=B0BY9Q4KTT
 */
router.get(
  '/db-orders',
  validate({ query: ['accountId', 'marketplaceId', 'date'] }),
  async (req, res, next) => {
    try {
      const db = require('../database/pool');
      const accountId = parseInt(req.query.accountId, 10);
      const marketplaceId = parseInt(req.query.marketplaceId, 10);
      const { date, asin } = req.query;

      let timezone = req.query.timezone;
      if (!timezone) {
        const mpResult = await db.query(
          'SELECT country_code FROM marketplaces WHERE id = $1',
          [marketplaceId]
        );
        const cc = mpResult.rows[0]?.country_code;
        timezone = MARKETPLACE_TIMEZONES[cc] || 'UTC';
      }

      const dayjs = require('dayjs');
      const nextDate = dayjs(date).add(1, 'day').format('YYYY-MM-DD');

      const params = [accountId, marketplaceId, date, nextDate, timezone];
      let asinFilter = '';
      if (asin) {
        asinFilter = 'AND asin = $6';
        params.push(asin);
      }

      // All orders (including cancelled) for full picture
      const allOrders = await db.query(
        `SELECT amazon_order_id, asin, sku, quantity, order_status,
                purchase_date,
                purchase_date::date AS utc_date,
                (purchase_date AT TIME ZONE $5)::date AS local_date,
                item_price, item_tax, shipping_price, shipping_tax, promotion_discount,
                synced_at
         FROM orders_raw
         WHERE account_id = $1 AND marketplace_id = $2
           AND (purchase_date AT TIME ZONE $5)::date >= $3::date
           AND (purchase_date AT TIME ZONE $5)::date < $4::date
           ${asinFilter}
         ORDER BY purchase_date`,
        params
      );

      // Separate by status
      const active = allOrders.rows.filter(
        (o) => !['CANCELLED', 'CANCELED'].includes((o.order_status || '').toUpperCase())
      );
      const cancelled = allOrders.rows.filter(
        (o) => ['CANCELLED', 'CANCELED'].includes((o.order_status || '').toUpperCase())
      );
      const pending = allOrders.rows.filter(
        (o) => (o.order_status || '').toUpperCase() === 'PENDING'
      );

      const activeUnits = active.reduce((s, o) => s + o.quantity, 0);
      const cancelledUnits = cancelled.reduce((s, o) => s + o.quantity, 0);
      const pendingUnits = pending.reduce((s, o) => s + o.quantity, 0);

      res.json({
        params: { accountId, marketplaceId, date, asin: asin || null, timezone },
        summary: {
          totalOrderLines: allOrders.rows.length,
          activeOrderLines: active.length,
          activeUnits,
          cancelledOrderLines: cancelled.length,
          cancelledUnits,
          pendingOrderLines: pending.length,
          pendingUnits,
        },
        orders: allOrders.rows,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/diagnostics/revenue-breakdown
 * Per-marketplace revenue breakdown from all 3 data layers:
 * orders_raw, order_profit, asin_daily_metrics.
 * Detects cross-marketplace duplication.
 *
 * Query params:
 *   accountId (required), date (required, YYYY-MM-DD)
 *
 * Example:
 *   /api/diagnostics/revenue-breakdown?accountId=1&date=2026-03-03
 */
router.get(
  '/revenue-breakdown',
  validate({ query: ['accountId', 'date'] }),
  async (req, res, next) => {
    try {
      const db = require('../database/pool');
      const accountId = parseInt(req.query.accountId, 10);
      const { date } = req.query;

      const dayjs = require('dayjs');
      const nextDate = dayjs(date).add(1, 'day').format('YYYY-MM-DD');

      // Layer 1: orders_raw per marketplace (timezone-aware)
      const ordersRaw = await db.query(
        `SELECT m.country_code,
                COUNT(*) AS order_lines,
                SUM(o.quantity) AS units,
                SUM(o.item_price) AS item_price_total,
                SUM(o.item_tax) AS item_tax_total,
                SUM(o.shipping_price) AS shipping_total,
                SUM(o.shipping_tax) AS shipping_tax_total,
                SUM(o.promotion_discount) AS promo_discount_total,
                SUM(o.item_price + o.item_tax + o.shipping_price + o.shipping_tax - o.promotion_discount) AS gross_revenue
         FROM orders_raw o
         JOIN marketplaces m ON m.id = o.marketplace_id
         WHERE o.account_id = $1
           AND (o.purchase_date AT TIME ZONE COALESCE($3, 'UTC'))::date = $2::date
           AND UPPER(o.order_status) NOT IN ('CANCELLED', 'CANCELED')
         GROUP BY m.country_code
         ORDER BY gross_revenue DESC`,
        [accountId, date, 'Europe/Rome']
      );

      // Layer 2: order_profit per marketplace
      const orderProfit = await db.query(
        `SELECT m.country_code,
                COUNT(*) AS order_lines,
                SUM(op.quantity) AS units,
                SUM(op.revenue) AS revenue,
                SUM(op.referral_fee) AS referral_fee,
                SUM(op.fba_fee) AS fba_fee,
                SUM(op.other_amazon_fees) AS other_fees,
                SUM(op.net_profit) AS net_profit
         FROM order_profit op
         JOIN marketplaces m ON m.id = op.marketplace_id
         WHERE op.account_id = $1
           AND op.order_date = $2
         GROUP BY m.country_code
         ORDER BY revenue DESC`,
        [accountId, date]
      );

      // Layer 3: asin_daily_metrics per marketplace
      const asinMetrics = await db.query(
        `SELECT m.country_code,
                COUNT(*) AS asin_rows,
                SUM(adm.units_sold) AS units,
                SUM(adm.revenue) AS revenue,
                SUM(adm.total_amazon_fees) AS total_amazon_fees,
                SUM(adm.net_profit) AS net_profit
         FROM asin_daily_metrics adm
         JOIN marketplaces m ON m.id = adm.marketplace_id
         WHERE adm.account_id = $1
           AND adm.metric_date = $2
         GROUP BY m.country_code
         ORDER BY revenue DESC`,
        [accountId, date]
      );

      // Layer 3b: check for NULL marketplace_id rows (cross-marketplace totals that shouldn't exist)
      const nullMpMetrics = await db.query(
        `SELECT COUNT(*) AS null_mp_rows,
                SUM(adm.units_sold) AS units,
                SUM(adm.revenue) AS revenue
         FROM asin_daily_metrics adm
         WHERE adm.account_id = $1
           AND adm.metric_date = $2
           AND adm.marketplace_id IS NULL`,
        [accountId, date]
      );

      // Totals
      const totals = {
        orders_raw: {
          order_lines: ordersRaw.rows.reduce((s, r) => s + parseInt(r.order_lines), 0),
          units: ordersRaw.rows.reduce((s, r) => s + parseInt(r.units), 0),
          gross_revenue: ordersRaw.rows.reduce((s, r) => s + parseFloat(r.gross_revenue || 0), 0),
        },
        order_profit: {
          order_lines: orderProfit.rows.reduce((s, r) => s + parseInt(r.order_lines), 0),
          units: orderProfit.rows.reduce((s, r) => s + parseInt(r.units), 0),
          revenue: orderProfit.rows.reduce((s, r) => s + parseFloat(r.revenue || 0), 0),
        },
        asin_daily_metrics: {
          asin_rows: asinMetrics.rows.reduce((s, r) => s + parseInt(r.asin_rows), 0),
          units: asinMetrics.rows.reduce((s, r) => s + parseInt(r.units), 0),
          revenue: asinMetrics.rows.reduce((s, r) => s + parseFloat(r.revenue || 0), 0),
        },
      };

      res.json({
        params: { accountId, date },
        totals,
        null_marketplace_rows: nullMpMetrics.rows[0],
        per_marketplace: {
          orders_raw: ordersRaw.rows,
          order_profit: orderProfit.rows,
          asin_daily_metrics: asinMetrics.rows,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/diagnostics/financial-check
 * Quick check: are there financial events in the DB? Do they match orders?
 *
 * Query params:
 *   accountId (required), date (required, YYYY-MM-DD)
 *
 * Example:
 *   /api/diagnostics/financial-check?accountId=1&date=2026-03-03
 */
router.get(
  '/financial-check',
  validate({ query: ['accountId', 'date'] }),
  async (req, res, next) => {
    try {
      const db = require('../database/pool');
      const accountId = parseInt(req.query.accountId, 10);
      const { date } = req.query;

      const dayjs = require('dayjs');
      const dateFrom = dayjs(date).subtract(30, 'day').format('YYYY-MM-DD');
      const dateTo = dayjs(date).add(31, 'day').format('YYYY-MM-DD');

      // 1. Total financial events for this account
      const totalEvents = await db.query(
        `SELECT COUNT(*) AS total,
                COUNT(DISTINCT amazon_order_id) AS distinct_orders,
                MIN(event_date) AS earliest,
                MAX(event_date) AS latest
         FROM financial_events_raw
         WHERE account_id = $1`,
        [accountId]
      );

      // 2. Financial events around the target date (±30 days)
      const nearDateEvents = await db.query(
        `SELECT COUNT(*) AS total,
                COUNT(DISTINCT amazon_order_id) AS distinct_orders,
                COUNT(DISTINCT event_type) AS distinct_event_types
         FROM financial_events_raw
         WHERE account_id = $1
           AND event_date >= $2 AND event_date < $3`,
        [accountId, dateFrom, dateTo]
      );

      // 3. Event types breakdown
      const eventTypes = await db.query(
        `SELECT event_type, fee_type, COUNT(*) AS cnt,
                SUM(amount) AS total_amount
         FROM financial_events_raw
         WHERE account_id = $1
           AND event_date >= $2 AND event_date < $3
         GROUP BY event_type, fee_type
         ORDER BY cnt DESC
         LIMIT 30`,
        [accountId, dateFrom, dateTo]
      );

      // 4. ASIN format check: how many look like ASINs vs SKUs
      const asinFormats = await db.query(
        `SELECT
           COUNT(*) AS total,
           COUNT(*) FILTER (WHERE asin ~ '^B[A-Z0-9]{9}$') AS asin_format,
           COUNT(*) FILTER (WHERE asin !~ '^B[A-Z0-9]{9}$' AND asin IS NOT NULL) AS sku_format,
           COUNT(*) FILTER (WHERE asin IS NULL) AS null_asin
         FROM financial_events_raw
         WHERE account_id = $1
           AND event_date >= $2 AND event_date < $3`,
        [accountId, dateFrom, dateTo]
      );

      // 5. Join test: how many financial events match orders via the buildFeeMap join
      const joinTest = await db.query(
        `SELECT COUNT(*) AS matched_rows,
                COUNT(DISTINCT fe.amazon_order_id) AS matched_orders
         FROM financial_events_raw fe
         JOIN orders_raw o
           ON o.amazon_order_id = fe.amazon_order_id
           AND o.account_id = fe.account_id
           AND (o.asin = fe.asin OR o.sku = fe.asin)
         WHERE fe.account_id = $1
           AND fe.event_date >= $2 AND fe.event_date < $3
           AND fe.event_type = 'ShipmentEvent'
           AND fe.amount < 0`,
        [accountId, dateFrom, dateTo]
      );

      // 6. Unmatched financial events (orders exist but ASIN/SKU doesn't match)
      const unmatchedTest = await db.query(
        `SELECT COUNT(*) AS unmatched_rows,
                COUNT(DISTINCT fe.amazon_order_id) AS unmatched_orders
         FROM financial_events_raw fe
         WHERE fe.account_id = $1
           AND fe.event_date >= $2 AND fe.event_date < $3
           AND fe.event_type = 'ShipmentEvent'
           AND fe.amount < 0
           AND NOT EXISTS (
             SELECT 1 FROM orders_raw o
             WHERE o.amazon_order_id = fe.amazon_order_id
               AND o.account_id = fe.account_id
               AND (o.asin = fe.asin OR o.sku = fe.asin)
           )`,
        [accountId, dateFrom, dateTo]
      );

      // 7. Sample unmatched: show fe.asin vs o.asin/o.sku for debugging
      const sampleUnmatched = await db.query(
        `SELECT fe.amazon_order_id, fe.asin AS fe_asin, fe.fee_type, fe.amount,
                o.asin AS order_asin, o.sku AS order_sku
         FROM financial_events_raw fe
         LEFT JOIN orders_raw o
           ON o.amazon_order_id = fe.amazon_order_id
           AND o.account_id = fe.account_id
         WHERE fe.account_id = $1
           AND fe.event_date >= $2 AND fe.event_date < $3
           AND fe.event_type = 'ShipmentEvent'
           AND fe.amount < 0
           AND NOT EXISTS (
             SELECT 1 FROM orders_raw o2
             WHERE o2.amazon_order_id = fe.amazon_order_id
               AND o2.account_id = fe.account_id
               AND (o2.asin = fe.asin OR o2.sku = fe.asin)
           )
         LIMIT 10`,
        [accountId, dateFrom, dateTo]
      );

      res.json({
        params: { accountId, date, searchRange: { from: dateFrom, to: dateTo } },
        overall: totalEvents.rows[0],
        nearDate: nearDateEvents.rows[0],
        eventTypes: eventTypes.rows,
        asinFormats: asinFormats.rows[0],
        joinTest: joinTest.rows[0],
        unmatchedFees: unmatchedTest.rows[0],
        sampleUnmatched: sampleUnmatched.rows,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/diagnostics/feemap-test
 * Simulates buildFeeMap for a specific date and shows what it returns.
 * This is the exact same query the profit engine uses.
 *
 * Query params:
 *   accountId (required), marketplaceId (required), date (required)
 *
 * Example:
 *   /api/diagnostics/feemap-test?accountId=1&marketplaceId=3&date=2026-03-03
 */
router.get(
  '/feemap-test',
  validate({ query: ['accountId', 'marketplaceId', 'date'] }),
  async (req, res, next) => {
    try {
      const db = require('../database/pool');
      const dayjs = require('dayjs');
      const accountId = parseInt(req.query.accountId, 10);
      const marketplaceId = parseInt(req.query.marketplaceId, 10);
      const { date } = req.query;

      // Same date range logic as computeForRange
      const dateFrom = date;
      const dateTo = dayjs(date).add(1, 'day').format('YYYY-MM-DD');
      const feeFrom = dayjs(dateFrom).subtract(30, 'day').format('YYYY-MM-DD');
      const feeTo = dayjs(dateTo).add(30, 'day').format('YYYY-MM-DD');

      // 1. Exact buildFeeMap query
      const feeMapResult = await db.query(
        `SELECT fe.amazon_order_id,
                COALESCE(o.asin, fe.asin) AS asin,
                fe.fee_type,
                SUM(fe.amount) AS total_amount
         FROM financial_events_raw fe
         JOIN orders_raw o
           ON o.amazon_order_id = fe.amazon_order_id
           AND o.account_id = fe.account_id
           AND (o.asin = fe.asin OR o.sku = fe.asin)
         WHERE fe.account_id = $1
           AND o.marketplace_id = $2
           AND fe.event_date >= $3 AND fe.event_date < $4
           AND fe.event_type = 'ShipmentEvent'
           AND fe.amount < 0
         GROUP BY fe.amazon_order_id, COALESCE(o.asin, fe.asin), fe.fee_type
         LIMIT 20`,
        [accountId, marketplaceId, feeFrom, feeTo]
      );

      // 2. Count of orders on this date
      const ordersOnDate = await db.query(
        `SELECT COUNT(*) AS total,
                COUNT(DISTINCT amazon_order_id) AS distinct_orders
         FROM orders_raw
         WHERE account_id = $1 AND marketplace_id = $2
           AND purchase_date::date >= $3::date
           AND purchase_date::date < $4::date`,
        [accountId, marketplaceId, dateFrom, dateTo]
      );

      // 3. Pick one order from that date and check its financial events
      const sampleOrder = await db.query(
        `SELECT amazon_order_id, asin, sku
         FROM orders_raw
         WHERE account_id = $1 AND marketplace_id = $2
           AND purchase_date::date >= $3::date
           AND purchase_date::date < $4::date
         LIMIT 1`,
        [accountId, marketplaceId, dateFrom, dateTo]
      );

      let sampleFees = null;
      if (sampleOrder.rows.length > 0) {
        const sample = sampleOrder.rows[0];
        sampleFees = await db.query(
          `SELECT fe.amazon_order_id, fe.asin AS fe_asin, fe.fee_type, fe.amount, fe.event_date,
                  o.asin AS order_asin, o.sku AS order_sku, o.marketplace_id AS order_mp
           FROM financial_events_raw fe
           LEFT JOIN orders_raw o
             ON o.amazon_order_id = fe.amazon_order_id
             AND o.account_id = fe.account_id
           WHERE fe.account_id = $1
             AND fe.amazon_order_id = $2
           ORDER BY fe.fee_type
           LIMIT 20`,
          [accountId, sample.amazon_order_id]
        );
      }

      // 4. Total feeMap entries (no LIMIT)
      const feeMapCount = await db.query(
        `SELECT COUNT(*) AS total_fee_entries,
                COUNT(DISTINCT fe.amazon_order_id) AS matched_orders
         FROM financial_events_raw fe
         JOIN orders_raw o
           ON o.amazon_order_id = fe.amazon_order_id
           AND o.account_id = fe.account_id
           AND (o.asin = fe.asin OR o.sku = fe.asin)
         WHERE fe.account_id = $1
           AND o.marketplace_id = $2
           AND fe.event_date >= $3 AND fe.event_date < $4
           AND fe.event_type = 'ShipmentEvent'
           AND fe.amount < 0`,
        [accountId, marketplaceId, feeFrom, feeTo]
      );

      res.json({
        params: { accountId, marketplaceId, date, feeFrom, feeTo },
        ordersOnDate: ordersOnDate.rows[0],
        feeMapCount: feeMapCount.rows[0],
        feeMapSample: feeMapResult.rows,
        sampleOrder: sampleOrder.rows[0] || null,
        sampleOrderFees: sampleFees?.rows || null,
      });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
