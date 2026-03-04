const db = require('../../database/pool');
const logger = require('../../utils/logger');
const { round, pct, roi, toDateStr } = require('../../utils/helpers');
const AdsService = require('../ads/ads.service');
const SyncLogger = require('../../services/sync-logger');

/**
 * Revenue charge types from ItemChargeList in ShipmentEvent.
 * These are NOT fees — they are revenue components.
 * buildFeeMap must EXCLUDE these from fee calculations.
 */
const REVENUE_CHARGE_TYPES = [
  'Principal',
  'Tax',
  'ShippingCharge',
  'ShippingTax',
  'GiftWrap',
  'GiftWrapTax',
  'RestockingFee',
  'Goodwill',
  'ExportCharge',
  'CODItemCharge',
  'CODOrderCharge',
];

/**
 * Known FBA fee types (for grouping).
 */
const FBA_FEE_TYPES = [
  'FBAPerUnitFulfillmentFee',
  'FBAPerOrderFulfillmentFee',
  'FBAWeightBasedFee',
];

/**
 * Known referral fee types.
 */
const REFERRAL_FEE_TYPES = [
  'Commission',
  'ReferralFee',
];

/**
 * Marketplace timezone map (no DB migration needed).
 * Used for timezone-aware date boundaries and order_date grouping
 * to match Amazon Business Report logic.
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
 * Profit Engine - computes net profit for each order line.
 *
 * Formula per order line (GROSS revenue, aligned with ShopKeeper):
 *   Revenue = item_price + item_tax + shipping_price + shipping_tax - promotion_discount
 *   - Referral Fee (Commission)
 *   - FBA Fee
 *   - Other Amazon Fees (only amount < 0 from financial events, excluding revenue charges)
 *   - MarketplaceFacilitatorTax (offsets IVA included in gross revenue)
 *   - Refund Amount (allocated to refund event date, not order date)
 *   - Ads Allocated (ads_spend_day / units_sold_day * quantity)
 *   - Product Cost (per marketplace)
 *   - Inbound Shipping
 *   - Customs
 *   - Prep Cost
 *   - Packaging
 *   - Storage Allocated (monthly / units_sold_month * quantity)
 *   = NET PROFIT
 */
const ProfitService = {
  /**
   * Recompute profit for all orders in a date range for one account+marketplace.
   */
  async computeForRange(accountId, marketplaceId, dateFrom, dateTo) {
    const syncLog = await SyncLogger.start(accountId, marketplaceId, 'profit');
    let processed = 0;

    try {
            logger.info('Starting profit computation', { accountId, marketplaceId, dateFrom, dateTo });

      // Resolve marketplace timezone for date boundaries and grouping
      const mpResult = await db.query(
        'SELECT country_code FROM marketplaces WHERE id = $1',
        [marketplaceId]
      );
      const tz = MARKETPLACE_TIMEZONES[mpResult.rows[0]?.country_code] || 'UTC';

      // Step 1: Cleanup cancelled orders from order_profit
      await this.cleanupCancelledOrders(accountId, marketplaceId);

      // Step 2: Get all non-cancelled orders in range (timezone-aware boundaries)
      const ordersResult = await db.query(
        `SELECT *, (purchase_date AT TIME ZONE $5)::date::text AS local_date
         FROM orders_raw
         WHERE account_id = $1 AND marketplace_id = $2
           AND (purchase_date AT TIME ZONE $5)::date >= $3::date
           AND (purchase_date AT TIME ZONE $5)::date < $4::date
           AND UPPER(order_status) NOT IN ('CANCELLED', 'CANCELED', 'PENDING')
         ORDER BY purchase_date`,
        [accountId, marketplaceId, dateFrom, dateTo, tz]
      );

      // Pre-fetch financial events (widen by 30 days each side — financial events
      // typically lag 7-14 days behind order purchase_date)
      const dayjs = require('dayjs');
      const feeFrom = dayjs.utc(dateFrom).subtract(30, 'day').format('YYYY-MM-DD');
      const feeTo = dayjs.utc(dateTo).add(30, 'day').format('YYYY-MM-DD');
      const feeMap = await this.buildFeeMap(accountId, marketplaceId, feeFrom, feeTo);

      // Pre-fetch ASIN costs
      const costsMap = await this.buildCostsMap(accountId, marketplaceId);

      // Pre-fetch units sold per ASIN per day (for ads allocation, timezone-aware)
      const unitsByDay = await this.buildUnitsByDayMap(accountId, marketplaceId, dateFrom, dateTo, tz);

      // Pre-fetch storage allocation data (units sold per ASIN this month, timezone-aware)
      const storageMap = await this.buildStorageMap(accountId, marketplaceId, dateFrom, dateTo, tz);


      for (const order of ordersResult.rows) {
        await this.computeOrderProfit(order, feeMap, costsMap, unitsByDay, storageMap);
        processed++;
      }

      // Process refunds: allocate to the actual refund event date
      await this.processRefunds(accountId, marketplaceId, dateFrom, dateTo);

      await SyncLogger.complete(syncLog.id, { processed, inserted: processed, updated: 0 });

      logger.info('Profit computation completed', { accountId, marketplaceId, processed });
      return { processed };
    } catch (err) {
      await SyncLogger.fail(syncLog.id, err.message);
      logger.error('Profit computation failed', { accountId, error: err.message });
      throw err;
    }
  },

  /**
   * Cleanup stale order_profit records:
   * 1. Delete records for orders that have been Cancelled
   * 2. Sync quantity from orders_raw when it changed (partial cancellation / amendment)
   *
   * NOT date-scoped — covers the entire account+marketplace.
   */
  async cleanupCancelledOrders(accountId, marketplaceId) {
    // 1. Delete cancelled orders from order_profit
    const deleted = await db.query(
      `DELETE FROM order_profit op
       USING orders_raw o
       WHERE op.account_id = o.account_id
         AND op.amazon_order_id = o.amazon_order_id
         AND op.asin = o.asin
         AND UPPER(o.order_status) IN ('CANCELLED', 'CANCELED', 'PENDING')
         AND op.account_id = $1
         AND op.marketplace_id = $2`,
      [accountId, marketplaceId]
    );

    if (deleted.rowCount > 0) {
      logger.info('Cleaned up cancelled order profits', {
        accountId, marketplaceId, deleted: deleted.rowCount,
      });
    }

    // 2. Sync stale quantities from orders_raw
    const synced = await db.query(
      `UPDATE order_profit op
       SET quantity = o.quantity, computed_at = NOW()
       FROM orders_raw o
       WHERE op.account_id = o.account_id
         AND op.amazon_order_id = o.amazon_order_id
         AND op.asin = o.asin
         AND op.quantity != o.quantity
         AND op.account_id = $1
         AND op.marketplace_id = $2`,
      [accountId, marketplaceId]
    );

    if (synced.rowCount > 0) {
      logger.info('Synced stale quantities in order_profit', {
        accountId, marketplaceId, updated: synced.rowCount,
      });
    }
  },

  /**
   * Build a map of Amazon fees by order_id:asin -> fee_type -> amount.
   *
   * CRITICAL FIX: Only includes actual fees (amount < 0) from financial events.
   * Excludes revenue charge types (Principal, Tax, ShippingCharge, etc.)
   * which were previously being counted as "otherFees" and inflating costs.
   */
  async buildFeeMap(accountId, marketplaceId, dateFrom, dateTo) {
    // JOIN with orders_raw to resolve SellerSKU → ASIN.
    // SP-API financial events often store SellerSKU (e.g. "68-YM50-I8G3")
    // instead of ASIN (e.g. "B0BY9Q4KTT"). Without this resolution,
    // the fee lookup key won't match the order's ASIN.
    const result = await db.query(
      `SELECT fe.amazon_order_id,
              COALESCE(o.asin, fe.asin) AS asin,
              fe.fee_type,
              SUM(fe.amount) AS total_amount
       FROM financial_events_raw fe
       LEFT JOIN orders_raw o
         ON o.amazon_order_id = fe.amazon_order_id
         AND o.account_id = fe.account_id
         AND (o.asin = fe.asin OR o.sku = fe.asin)
       WHERE fe.account_id = $1 AND fe.marketplace_id = $2
         AND fe.event_date >= $3 AND fe.event_date < $4
         AND fe.event_type = 'ShipmentEvent'
         AND fe.amount < 0
       GROUP BY fe.amazon_order_id, COALESCE(o.asin, fe.asin), fe.fee_type`,
      [accountId, marketplaceId, dateFrom, dateTo]
    );

    const map = {};
    for (const row of result.rows) {
      // Use ASIN from the row; if null, use a fallback key
      const asin = row.asin || '__fallback__';
      const key = `${row.amazon_order_id}:${asin}`;
      if (!map[key]) map[key] = {};

      // Skip revenue charge types even if they somehow have amount < 0
      if (REVENUE_CHARGE_TYPES.includes(row.fee_type)) continue;

      map[key][row.fee_type] = parseFloat(row.total_amount);
    }
    return map;
  },

  /**
   * Build costs map: asin -> cost record (latest effective_from).
   */
  async buildCostsMap(accountId, marketplaceId) {
    const result = await db.query(
      `SELECT DISTINCT ON (asin) *
       FROM asin_costs
       WHERE account_id = $1 AND marketplace_id = $2
       ORDER BY asin, effective_from DESC`,
      [accountId, marketplaceId]
    );

    const map = {};
    for (const row of result.rows) {
      map[row.asin] = row;
    }
    return map;
  },

  /**
   * Build map of units sold per ASIN per day (for ads allocation).
   */
  async buildUnitsByDayMap(accountId, marketplaceId, dateFrom, dateTo, tz) {
    const result = await db.query(
      `SELECT asin, (purchase_date AT TIME ZONE $5)::date AS order_date, SUM(quantity) AS units
       FROM orders_raw
       WHERE account_id = $1 AND marketplace_id = $2
         AND (purchase_date AT TIME ZONE $5)::date >= $3::date
         AND (purchase_date AT TIME ZONE $5)::date < $4::date
         AND UPPER(order_status) NOT IN ('CANCELLED', 'CANCELED', 'PENDING')
       GROUP BY asin, (purchase_date AT TIME ZONE $5)::date`,
      [accountId, marketplaceId, dateFrom, dateTo, tz]
    );


    const map = {};
    for (const row of result.rows) {
      const key = `${row.asin}:${toDateStr(row.order_date)}`;
      map[key] = parseInt(row.units, 10);
    }
    return map;
  },

  /**
   * Build storage allocation map: asin -> units_sold_this_month.
   */
  async buildStorageMap(accountId, marketplaceId, dateFrom, dateTo, tz) {
    const result = await db.query(
      `SELECT asin,
        DATE_TRUNC('month', (purchase_date AT TIME ZONE $5)::date) AS month,
        SUM(quantity) AS units_month
       FROM orders_raw
       WHERE account_id = $1 AND marketplace_id = $2
         AND (purchase_date AT TIME ZONE $5)::date >= DATE_TRUNC('month', $3::date)
         AND (purchase_date AT TIME ZONE $5)::date < DATE_TRUNC('month', $4::date) + INTERVAL '1 month'
         AND UPPER(order_status) NOT IN ('CANCELLED', 'CANCELED', 'PENDING')
       GROUP BY asin, DATE_TRUNC('month', (purchase_date AT TIME ZONE $5)::date)`,
      [accountId, marketplaceId, dateFrom, dateTo, tz]
    );


    const map = {};
    for (const row of result.rows) {
      const monthStr = toDateStr(row.month).substring(0, 7); // YYYY-MM
      const key = `${row.asin}:${monthStr}`;
      map[key] = parseInt(row.units_month, 10);
    }
    return map;
  },

  /**
   * Compute and upsert profit for a single order line.
   *
   * Revenue is GROSS (includes IVA/tax) to match ShopKeeper:
   *   item_price + item_tax + shipping_price + shipping_tax - promotion_discount
   */
  async computeOrderProfit(order, feeMap, costsMap, unitsByDay, storageMap) {
    // Use local_date from SQL (marketplace timezone) instead of UTC conversion
    const orderDate = order.local_date || toDateStr(order.purchase_date);
    const feeKey = `${order.amazon_order_id}:${order.asin}`;
    // Try exact key first, then fallback key (for ASIN-unresolved fees)
    const fees = feeMap[feeKey] || feeMap[`${order.amazon_order_id}:__fallback__`] || {};
    const costs = costsMap[order.asin] || {};
    const qty = order.quantity || 1;

    // GROSS Revenue = item_price + item_tax + shipping_price + shipping_tax - promotion_discount
    const revenue = round(
      parseFloat(order.item_price || 0) +
      parseFloat(order.item_tax || 0) +
      parseFloat(order.shipping_price || 0) +
      parseFloat(order.shipping_tax || 0) -
      parseFloat(order.promotion_discount || 0)
    , 4);

    // Amazon fees (from financial events, stored as negative, we use absolute values)
    let referralFee = 0;
    for (const feeType of REFERRAL_FEE_TYPES) {
      if (fees[feeType]) {
        referralFee = Math.abs(fees[feeType]);
        break;
      }
    }
    referralFee = round(referralFee, 4);

    let fbaFee = 0;
    for (const feeType of FBA_FEE_TYPES) {
      if (fees[feeType]) {
        fbaFee += Math.abs(fees[feeType]);
      }
    }
    fbaFee = round(fbaFee, 4);

    // MarketplaceFacilitatorTax: offsets the IVA included in gross revenue
    const mfTax = round(Math.abs(fees['MarketplaceFacilitatorTax-Principal'] || fees['MarketplaceFacilitatorTax'] || 0), 4);

    // Other fees: everything not referral, FBA, MarketplaceFacilitatorTax, or revenue charges
    const knownFeeTypes = new Set([
      ...REFERRAL_FEE_TYPES,
      ...FBA_FEE_TYPES,
      ...REVENUE_CHARGE_TYPES,
      'MarketplaceFacilitatorTax-Principal',
      'MarketplaceFacilitatorTax',
    ]);
    let otherFees = 0;
    for (const [feeType, amount] of Object.entries(fees)) {
      if (!knownFeeTypes.has(feeType)) {
        otherFees += Math.abs(amount);
      }
    }
    otherFees = round(otherFees, 4);

    // Ads allocation: (daily_ads_spend / daily_units_sold) * order_quantity
    const dayKey = `${order.asin}:${orderDate}`;
    const unitsDay = unitsByDay[dayKey] || 1;
    const adsData = await AdsService.getDailySpendByAsin(
      order.account_id, order.marketplace_id, order.asin, orderDate
    );
    const adsAllocated = round((parseFloat(adsData.total_spend) / unitsDay) * qty, 4);

    // Product costs (per unit * quantity)
    const productCost = round(parseFloat(costs.product_cost || 0) * qty, 4);
    const inboundCost = round(parseFloat(costs.inbound_cost || 0) * qty, 4);
    const customsCost = round(parseFloat(costs.customs_cost || 0) * qty, 4);
    const prepCost = round(parseFloat(costs.prep_cost || 0) * qty, 4);
    const packagingCost = round(parseFloat(costs.packaging_cost || 0) * qty, 4);

    // Storage allocation: (monthly_storage_cost / units_sold_month) * quantity
    const monthKey = `${order.asin}:${orderDate.substring(0, 7)}`;
    const unitsMonth = storageMap[monthKey] || 1;
    const storageMonthly = parseFloat(costs.storage_monthly_cost || 0);
    const storageAllocated = round((storageMonthly / unitsMonth) * qty, 4);

    // Totals
    const totalCosts = round(
      referralFee + fbaFee + otherFees + mfTax + adsAllocated +
      productCost + inboundCost + customsCost + prepCost + packagingCost + storageAllocated
    , 4);

    const netProfit = round(revenue - totalCosts, 4);
    const marginPct = pct(netProfit, revenue, 4);
    const investedCost = productCost + inboundCost + customsCost + prepCost + packagingCost + storageAllocated + adsAllocated;
    const roiPct = roi(netProfit, investedCost, 4);

    // Upsert
    await db.query(
      `INSERT INTO order_profit (
        account_id, marketplace_id, amazon_order_id, asin, order_date, quantity,
        revenue, referral_fee, fba_fee, other_amazon_fees, marketplace_facilitator_tax,
        refund_amount, ads_allocated,
        product_cost, inbound_cost, customs_cost, prep_cost, packaging_cost, storage_allocated,
        total_costs, net_profit, margin_pct, roi_pct, currency, computed_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,NOW())
      ON CONFLICT (account_id, amazon_order_id, asin) DO UPDATE SET
        marketplace_id = EXCLUDED.marketplace_id,
        order_date = EXCLUDED.order_date,
        quantity = EXCLUDED.quantity,
        revenue = EXCLUDED.revenue,
        referral_fee = EXCLUDED.referral_fee,
        fba_fee = EXCLUDED.fba_fee,
        other_amazon_fees = EXCLUDED.other_amazon_fees,
        marketplace_facilitator_tax = EXCLUDED.marketplace_facilitator_tax,
        ads_allocated = EXCLUDED.ads_allocated,
        product_cost = EXCLUDED.product_cost,
        inbound_cost = EXCLUDED.inbound_cost,
        customs_cost = EXCLUDED.customs_cost,
        prep_cost = EXCLUDED.prep_cost,
        packaging_cost = EXCLUDED.packaging_cost,
        storage_allocated = EXCLUDED.storage_allocated,
        total_costs = EXCLUDED.total_costs,
        net_profit = EXCLUDED.net_profit,
        margin_pct = EXCLUDED.margin_pct,
        roi_pct = EXCLUDED.roi_pct,
        computed_at = NOW()`,
      [
        order.account_id, order.marketplace_id, order.amazon_order_id, order.asin,
        orderDate, qty,
        revenue, referralFee, fbaFee, otherFees, mfTax,
        0, // refund_amount handled separately
        adsAllocated,
        productCost, inboundCost, customsCost, prepCost, packagingCost, storageAllocated,
        totalCosts, netProfit, marginPct, roiPct, order.currency,
      ]
    );
  },

  /**
   * Process refunds: allocate to the actual refund event date.
   * Refund amounts reduce profit. If ASIN is not resolved, use fallback
   * (order line with highest revenue).
   */
  async processRefunds(accountId, marketplaceId, dateFrom, dateTo) {
    // Get all refund events in the date range
    const refunds = await db.query(
      `SELECT amazon_order_id, asin, SUM(amount) AS refund_total
       FROM financial_events_raw
       WHERE account_id = $1 AND marketplace_id = $2
         AND event_type = 'RefundEvent'
         AND event_date >= $3 AND event_date < $4
       GROUP BY amazon_order_id, asin`,
      [accountId, marketplaceId, dateFrom, dateTo]
    );

    for (const refund of refunds.rows) {
      if (!refund.amazon_order_id) continue;

      const refundAmount = round(Math.abs(parseFloat(refund.refund_total)), 4);
      const asin = refund.asin;

      if (asin) {
        // Direct match: update the specific order+ASIN profit record
        await db.query(
          `UPDATE order_profit SET
            refund_amount = $1,
            total_costs = referral_fee + fba_fee + other_amazon_fees + marketplace_facilitator_tax +
                          ads_allocated + product_cost + inbound_cost + customs_cost +
                          prep_cost + packaging_cost + storage_allocated + $1,
            net_profit = revenue - (referral_fee + fba_fee + other_amazon_fees + marketplace_facilitator_tax +
                          ads_allocated + product_cost + inbound_cost + customs_cost +
                          prep_cost + packaging_cost + storage_allocated + $1),
            margin_pct = CASE WHEN revenue > 0
              THEN LEAST(9999.9999, GREATEST(-9999.9999,
                ROUND(((revenue - (referral_fee + fba_fee + other_amazon_fees + marketplace_facilitator_tax +
                  ads_allocated + product_cost + inbound_cost + customs_cost +
                  prep_cost + packaging_cost + storage_allocated + $1)) / revenue) * 100, 4)))
              ELSE 0 END,
            computed_at = NOW()
          WHERE account_id = $2 AND amazon_order_id = $3 AND asin = $4`,
          [refundAmount, accountId, refund.amazon_order_id, asin]
        );
      } else {
        // Fallback: ASIN not resolved. Allocate to the line with highest revenue.
        await db.query(
          `UPDATE order_profit SET
            refund_amount = $1,
            total_costs = referral_fee + fba_fee + other_amazon_fees + marketplace_facilitator_tax +
                          ads_allocated + product_cost + inbound_cost + customs_cost +
                          prep_cost + packaging_cost + storage_allocated + $1,
            net_profit = revenue - (referral_fee + fba_fee + other_amazon_fees + marketplace_facilitator_tax +
                          ads_allocated + product_cost + inbound_cost + customs_cost +
                          prep_cost + packaging_cost + storage_allocated + $1),
            margin_pct = CASE WHEN revenue > 0
              THEN LEAST(9999.9999, GREATEST(-9999.9999,
                ROUND(((revenue - (referral_fee + fba_fee + other_amazon_fees + marketplace_facilitator_tax +
                  ads_allocated + product_cost + inbound_cost + customs_cost +
                  prep_cost + packaging_cost + storage_allocated + $1)) / revenue) * 100, 4)))
              ELSE 0 END,
            computed_at = NOW()
          WHERE id = (
            SELECT id FROM order_profit
            WHERE account_id = $2 AND amazon_order_id = $3
            ORDER BY revenue DESC
            LIMIT 1
          )`,
          [refundAmount, accountId, refund.amazon_order_id]
        );
      }
    }

    logger.info('Refunds processed', {
      accountId,
      marketplaceId,
      refundsCount: refunds.rows.length,
    });
  },

  /**
   * Get profit detail for a single order.
   */
  async getOrderProfit(accountId, amazonOrderId) {
    const result = await db.query(
      `SELECT op.*, m.country_code, m.name AS marketplace_name
       FROM order_profit op
       LEFT JOIN marketplaces m ON m.id = op.marketplace_id
       WHERE op.account_id = $1 AND op.amazon_order_id = $2
       ORDER BY op.asin`,
      [accountId, amazonOrderId]
    );
    return result.rows;
  },
};

module.exports = ProfitService;
