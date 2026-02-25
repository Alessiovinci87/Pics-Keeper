const db = require('../../database/pool');
const logger = require('../../utils/logger');
const { round, pct, roi, toDateStr } = require('../../utils/helpers');
const AdsService = require('../ads/ads.service');
const SyncLogger = require('../../services/sync-logger');

/**
 * Profit Engine - computes net profit for each order line.
 *
 * Formula per order line:
 *   Revenue (item_price + item_tax + shipping_price + shipping_tax - promotion_discount)
 *   Revenue is GROSS (including VAT) to match Sellerboard/external tools.
 *   - Referral Fee
 *   - FBA Fee
 *   - Other Amazon Fees (includes MarketplaceFacilitatorTax to offset VAT in revenue)
 *   - Refund Amount (allocated to refund event date)
 *   - Ads Allocated (ads_spend_day / units_sold_day * quantity)
 *   - Product Cost (per marketplace)
 *   - Inbound Shipping
 *   - Customs
 *   - Prep Cost
 *   - Packaging
 *   - Storage Allocated (monthly / units_sold_month * quantity)
 *   = NET PROFIT
 *
 * ROI = net_profit / total_costs * 100
 * Margin = net_profit / revenue * 100
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

      // Get all orders in range
      const ordersResult = await db.query(
        `SELECT * FROM orders_raw
         WHERE account_id = $1 AND marketplace_id = $2
           AND purchase_date >= $3 AND purchase_date < $4
           AND LOWER(order_status) NOT LIKE '%cancel%'
         ORDER BY purchase_date`,
        [accountId, marketplaceId, dateFrom, dateTo]
      );

      // Pre-fetch financial events for the specific orders we're processing
      const orderIds = ordersResult.rows.map(o => o.amazon_order_id);
      const feeMap = await this.buildFeeMap(accountId, marketplaceId, orderIds);

      // Pre-fetch ASIN costs
      const costsMap = await this.buildCostsMap(accountId, marketplaceId);

      // Diagnostic: warn if no product costs configured (profit will be overstated)
      if (Object.keys(costsMap).length === 0 && ordersResult.rows.length > 0) {
        logger.warn('No product costs configured for this marketplace — profit will be overstated', {
          accountId, marketplaceId,
          hint: 'Configure costs via POST /api/asin-costs or the Costi Prodotto page',
        });
      }

      // Pre-fetch units sold per ASIN per day (for ads allocation)
      const unitsByDay = await this.buildUnitsByDayMap(accountId, marketplaceId, dateFrom, dateTo);

      // Pre-fetch storage allocation data (units sold per ASIN this month)
      const storageMap = await this.buildStorageMap(accountId, marketplaceId, dateFrom, dateTo);

      // Diagnostic: warn if no ads data exists (PPC will show as 0)
      if (ordersResult.rows.length > 0) {
        const adsCheck = await db.query(
          `SELECT COUNT(*) FROM ads_daily_spend
           WHERE account_id = $1 AND marketplace_id = $2
             AND spend_date >= $3 AND spend_date < $4`,
          [accountId, marketplaceId, dateFrom, dateTo]
        );
        if (parseInt(adsCheck.rows[0].count, 10) === 0) {
          logger.warn('No ads data found for this marketplace+period — PPC will show as 0', {
            accountId, marketplaceId, dateFrom, dateTo,
            hint: 'Ensure ads_profile_ids are configured in the account and ads sync has run',
          });
        }
      }

      // Diagnostic: warn if no financial events exist (fees will be 0)
      if (orderIds.length > 0 && Object.keys(feeMap).length === 0) {
        logger.warn('No financial events found for any orders — Amazon fees will be 0', {
          accountId, marketplaceId, ordersCount: orderIds.length,
          hint: 'Financial events sync may not have completed yet',
        });
      }

      for (const order of ordersResult.rows) {
        await this.computeOrderProfit(order, feeMap, costsMap, unitsByDay, storageMap);
        processed++;
      }

      // Remove order_profit records for orders that are now Cancelled or Pending
      // (they may have been computed before the status changed)
      await this.cleanupCancelledOrders(accountId, marketplaceId, dateFrom, dateTo);

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
   * Build a map of Amazon fees by order_id:asin -> fee_type -> amount.
   * Queries by specific order IDs (not date range) to avoid PostedDate vs PurchaseDate mismatch.
   * Also builds a fallback map by order_id only (for events with NULL ASIN from unresolved SKUs).
   */
  async buildFeeMap(accountId, marketplaceId, orderIds) {
    if (orderIds.length === 0) return {};

    // Deduplicate order IDs
    const uniqueOrderIds = [...new Set(orderIds)];

    const result = await db.query(
      `SELECT amazon_order_id, asin, fee_type, SUM(amount) AS total_amount
       FROM financial_events_raw
       WHERE account_id = $1 AND marketplace_id = $2
         AND amazon_order_id = ANY($3)
         AND event_type = 'ShipmentEvent'
       GROUP BY amazon_order_id, asin, fee_type`,
      [accountId, marketplaceId, uniqueOrderIds]
    );

    const map = {};
    for (const row of result.rows) {
      // Primary key: order_id:asin (exact match)
      const key = `${row.amazon_order_id}:${row.asin}`;
      if (!map[key]) map[key] = {};
      map[key][row.fee_type] = parseFloat(row.total_amount);

      // Fallback key: order_id:* (aggregated across all ASINs for the order)
      // Used when financial events have NULL ASIN (SKU resolution failed)
      if (row.asin === null) {
        const fallbackKey = `${row.amazon_order_id}:__fallback__`;
        if (!map[fallbackKey]) map[fallbackKey] = {};
        map[fallbackKey][row.fee_type] = (map[fallbackKey][row.fee_type] || 0) + parseFloat(row.total_amount);
      }
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
  async buildUnitsByDayMap(accountId, marketplaceId, dateFrom, dateTo) {
    const result = await db.query(
      `SELECT asin, purchase_date::date AS order_date, SUM(quantity) AS units
       FROM orders_raw
       WHERE account_id = $1 AND marketplace_id = $2
         AND purchase_date >= $3 AND purchase_date < $4
         AND LOWER(order_status) NOT LIKE '%cancel%'
       GROUP BY asin, purchase_date::date`,
      [accountId, marketplaceId, dateFrom, dateTo]
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
  async buildStorageMap(accountId, marketplaceId, dateFrom, dateTo) {
    // Get the month boundaries from the date range
    const result = await db.query(
      `SELECT asin,
        DATE_TRUNC('month', purchase_date) AS month,
        SUM(quantity) AS units_month
       FROM orders_raw
       WHERE account_id = $1 AND marketplace_id = $2
         AND purchase_date >= DATE_TRUNC('month', $3::date)
         AND purchase_date < DATE_TRUNC('month', $4::date) + INTERVAL '1 month'
         AND LOWER(order_status) NOT LIKE '%cancel%'
       GROUP BY asin, DATE_TRUNC('month', purchase_date)`,
      [accountId, marketplaceId, dateFrom, dateTo]
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
   */
  async computeOrderProfit(order, feeMap, costsMap, unitsByDay, storageMap) {
    const orderDate = toDateStr(order.purchase_date);
    const feeKey = `${order.amazon_order_id}:${order.asin}`;
    // Try exact match first, then fallback to NULL-ASIN entries (from unresolved SKUs)
    const fees = feeMap[feeKey] || feeMap[`${order.amazon_order_id}:__fallback__`] || {};
    const costs = costsMap[order.asin] || {};
    const qty = order.quantity || 1;

    // Revenue = item_price + item_tax + shipping_price + shipping_tax - promotion_discount
    // Uses GROSS revenue (including VAT) to match Sellerboard and other tools.
    // VAT is offset by MarketplaceFacilitatorTax in the fee deductions below.
    const revenue = round(
      parseFloat(order.item_price || 0) +
      parseFloat(order.item_tax || 0) +
      parseFloat(order.shipping_price || 0) +
      parseFloat(order.shipping_tax || 0) -
      parseFloat(order.promotion_discount || 0)
    , 4);

    // Amazon fees (from financial events, stored as negative, we use absolute values)
    const referralFee = round(Math.abs(fees['Commission'] || fees['ReferralFee'] || 0), 4);
    const fbaFee = round(Math.abs(
      (fees['FBAPerUnitFulfillmentFee'] || 0) +
      (fees['FBAPerOrderFulfillmentFee'] || 0) +
      (fees['FBAWeightBasedFee'] || 0)
    ), 4);

    // Other fees: everything not referral, FBA, or revenue charge types.
    // IMPORTANT: financial_events_raw stores BOTH ItemChargeList (revenue) and
    // ItemFeeList (fees) with event_type='ShipmentEvent'. We must exclude
    // revenue charge types to avoid double-counting revenue as costs.
    const knownFeeTypes = [
      'Commission', 'ReferralFee',
      'FBAPerUnitFulfillmentFee', 'FBAPerOrderFulfillmentFee', 'FBAWeightBasedFee',
    ];
    // Revenue/charge types from ItemChargeList — NOT Amazon fees.
    // These are revenue components or discounts already in orders_raw.
    const revenueChargeTypes = [
      'Principal', 'Tax', 'ShippingCharge', 'ShippingTax',
      'GiftWrap', 'GiftWrapTax', 'ShippingDiscount', 'PromotionDiscount',
      'Goodwill', 'ExportCharge', 'RestockingFee',
    ];
    let otherFees = 0;
    for (const [feeType, amount] of Object.entries(fees)) {
      if (knownFeeTypes.includes(feeType)) continue;
      if (revenueChargeTypes.includes(feeType)) continue;
      // MarketplaceFacilitatorTax is now INCLUDED as a fee to offset the VAT
      // added to gross revenue. This keeps profit correct while showing gross revenue.
      // Safety net: only count negative amounts (actual fee deductions by Amazon)
      if (amount < 0) {
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
      referralFee + fbaFee + otherFees + adsAllocated +
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
        revenue, referral_fee, fba_fee, other_amazon_fees,
        refund_amount, ads_allocated,
        product_cost, inbound_cost, customs_cost, prep_cost, packaging_cost, storage_allocated,
        total_costs, net_profit, margin_pct, roi_pct, currency, computed_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,NOW())
      ON CONFLICT (account_id, amazon_order_id, asin) DO UPDATE SET
        marketplace_id = EXCLUDED.marketplace_id,
        quantity = EXCLUDED.quantity,
        revenue = EXCLUDED.revenue,
        referral_fee = EXCLUDED.referral_fee,
        fba_fee = EXCLUDED.fba_fee,
        other_amazon_fees = EXCLUDED.other_amazon_fees,
        refund_amount = EXCLUDED.refund_amount,
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
        revenue, referralFee, fbaFee, otherFees,
        0, // refund_amount handled separately
        adsAllocated,
        productCost, inboundCost, customsCost, prepCost, packagingCost, storageAllocated,
        totalCosts, netProfit, marginPct, roiPct, order.currency,
      ]
    );
  },

  /**
   * Remove order_profit records for orders that are now Cancelled or Pending.
   * These records may have been created when the order was in a valid status,
   * but the order has since been cancelled.
   */
  async cleanupCancelledOrders(accountId, marketplaceId, dateFrom, dateTo) {
    const result = await db.query(
      `DELETE FROM order_profit op
       USING orders_raw o
       WHERE op.account_id = o.account_id
         AND op.amazon_order_id = o.amazon_order_id
         AND op.asin = o.asin
         AND o.account_id = $1
         AND o.marketplace_id = $2
         AND o.purchase_date >= $3
         AND o.purchase_date < $4
         AND LOWER(o.order_status) LIKE '%cancel%'`,
      [accountId, marketplaceId, dateFrom, dateTo]
    );

    if (result.rowCount > 0) {
      logger.info('Cleaned up cancelled/pending order profit records', {
        accountId,
        marketplaceId,
        deleted: result.rowCount,
      });
    }
  },

  /**
   * Process refunds: update order_profit with refund amounts on the actual refund event date.
   * This is separate from the main profit calculation because refunds happen
   * at a different time than the original order.
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

    let applied = 0;

    for (const refund of refunds.rows) {
      if (!refund.amazon_order_id) continue;

      const refundAmount = round(Math.abs(parseFloat(refund.refund_total)), 4);

      // Update the order_profit record with refund amount, then recalculate totals.
      // Refund reduces revenue (not a cost increase), so:
      //   net_profit = revenue - refund_amount - total_costs
      let result;
      if (refund.asin) {
        // Exact match by order_id + asin
        result = await db.query(
          `UPDATE order_profit SET
            refund_amount = $1,
            net_profit = revenue - $1 - total_costs,
            margin_pct = CASE WHEN revenue > 0
              THEN LEAST(GREATEST(ROUND(((revenue - $1 - total_costs) / revenue) * 100, 4), -9999), 9999)
              ELSE 0 END,
            roi_pct = CASE WHEN (product_cost + inbound_cost + customs_cost + prep_cost + packaging_cost + storage_allocated + ads_allocated) > 0
              THEN LEAST(GREATEST(ROUND(((revenue - $1 - total_costs) / (product_cost + inbound_cost + customs_cost + prep_cost + packaging_cost + storage_allocated + ads_allocated)) * 100, 4), -9999), 9999)
              ELSE 0 END,
            computed_at = NOW()
          WHERE account_id = $2 AND amazon_order_id = $3 AND asin = $4`,
          [refundAmount, accountId, refund.amazon_order_id, refund.asin]
        );
      } else {
        // NULL asin (SKU resolution failed) — apply to the highest-revenue line item
        // of that order so the refund isn't lost entirely
        result = await db.query(
          `UPDATE order_profit SET
            refund_amount = $1,
            net_profit = revenue - $1 - total_costs,
            margin_pct = CASE WHEN revenue > 0
              THEN LEAST(GREATEST(ROUND(((revenue - $1 - total_costs) / revenue) * 100, 4), -9999), 9999)
              ELSE 0 END,
            roi_pct = CASE WHEN (product_cost + inbound_cost + customs_cost + prep_cost + packaging_cost + storage_allocated + ads_allocated) > 0
              THEN LEAST(GREATEST(ROUND(((revenue - $1 - total_costs) / (product_cost + inbound_cost + customs_cost + prep_cost + packaging_cost + storage_allocated + ads_allocated)) * 100, 4), -9999), 9999)
              ELSE 0 END,
            computed_at = NOW()
          WHERE ctid = (
            SELECT ctid FROM order_profit
            WHERE account_id = $2 AND amazon_order_id = $3
            ORDER BY revenue DESC LIMIT 1
          )`,
          [refundAmount, accountId, refund.amazon_order_id]
        );
      }

      if (result.rowCount > 0) applied++;
    }

    logger.info('Refunds processed', {
      accountId,
      marketplaceId,
      refundsCount: refunds.rows.length,
      applied,
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
