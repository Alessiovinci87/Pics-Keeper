const db = require('../../database/pool');
const logger = require('../../utils/logger');
const { round, pct, roi, toDateStr, chunk } = require('../../utils/helpers');
const SyncLogger = require('../../services/sync-logger');

const BATCH_SIZE = 1000;

/**
 * Profit Engine - computes net profit for each order line.
 *
 * Formula per order line:
 *   Revenue (item_price + shipping_price - promotion_discount)
 *   - Referral Fee
 *   - FBA Fee
 *   - Other Amazon Fees
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
   * Uses advisory lock to prevent concurrent runs for the same account+marketplace.
   * Processes orders in batches of BATCH_SIZE, each wrapped in a transaction.
   */
  async computeForRange(accountId, marketplaceId, dateFrom, dateTo) {
    const syncLog = await SyncLogger.start(accountId, marketplaceId, 'profit');
    let processed = 0;

    // Acquire advisory lock to prevent concurrent computation for same account+marketplace
    const lockKey = accountId * 100000 + marketplaceId;
    const lockResult = await db.query('SELECT pg_try_advisory_lock($1) AS acquired', [lockKey]);
    if (!lockResult.rows[0].acquired) {
      const msg = `Profit computation already running for account ${accountId}, marketplace ${marketplaceId}`;
      logger.warn(msg);
      await SyncLogger.fail(syncLog.id, msg);
      return { processed: 0, skipped: true };
    }

    try {
      logger.info('Starting profit computation', { accountId, marketplaceId, dateFrom, dateTo });

      // Pre-fetch all lookup data in parallel (bulk queries, no N+1)
      const [feeMap, costsMap, unitsByDay, storageMap, adsSpendMap, refundMap] = await Promise.all([
        this.buildFeeMap(accountId, marketplaceId, dateFrom, dateTo),
        this.buildCostsMap(accountId, marketplaceId),
        this.buildUnitsByDayMap(accountId, marketplaceId, dateFrom, dateTo),
        this.buildStorageMap(accountId, marketplaceId, dateFrom, dateTo),
        this.buildAdsSpendMap(accountId, marketplaceId, dateFrom, dateTo),
        this.buildRefundMap(accountId, marketplaceId, dateFrom, dateTo),
      ]);

      // Get all orders in range
      const ordersResult = await db.query(
        `SELECT * FROM orders_raw
         WHERE account_id = $1 AND marketplace_id = $2
           AND purchase_date >= $3 AND purchase_date < $4
           AND order_status NOT IN ('Cancelled', 'Pending')
         ORDER BY purchase_date`,
        [accountId, marketplaceId, dateFrom, dateTo]
      );

      // Process in batches, each wrapped in a transaction
      const batches = chunk(ordersResult.rows, BATCH_SIZE);

      for (const batch of batches) {
        await db.transaction(async (client) => {
          for (const order of batch) {
            await this.computeOrderProfit(client, order, feeMap, costsMap, unitsByDay, storageMap, adsSpendMap, refundMap);
            processed++;
          }
        });
        logger.debug('Batch committed', { accountId, marketplaceId, batchSize: batch.length, processed });
      }

      await SyncLogger.complete(syncLog.id, { processed, inserted: processed, updated: 0 });

      logger.info('Profit computation completed', { accountId, marketplaceId, processed });
      return { processed };
    } catch (err) {
      await SyncLogger.fail(syncLog.id, err.message);
      logger.error('Profit computation failed', { accountId, error: err.message });
      throw err;
    } finally {
      // Always release advisory lock
      await db.query('SELECT pg_advisory_unlock($1)', [lockKey]);
    }
  },

  /**
   * Build a map of Amazon fees by order_id:asin -> fee_type -> amount.
   */
  async buildFeeMap(accountId, marketplaceId, dateFrom, dateTo) {
    const result = await db.query(
      `SELECT amazon_order_id, asin, fee_type, SUM(amount) AS total_amount
       FROM financial_events_raw
       WHERE account_id = $1 AND marketplace_id = $2
         AND event_date >= $3 AND event_date < $4
         AND event_type = 'ShipmentEvent'
       GROUP BY amazon_order_id, asin, fee_type`,
      [accountId, marketplaceId, dateFrom, dateTo]
    );

    const map = {};
    for (const row of result.rows) {
      const key = `${row.amazon_order_id}:${row.asin}`;
      if (!map[key]) map[key] = {};
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
  async buildUnitsByDayMap(accountId, marketplaceId, dateFrom, dateTo) {
    const result = await db.query(
      `SELECT asin, purchase_date::date AS order_date, SUM(quantity) AS units
       FROM orders_raw
       WHERE account_id = $1 AND marketplace_id = $2
         AND purchase_date >= $3 AND purchase_date < $4
         AND order_status NOT IN ('Cancelled', 'Pending')
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
   * Build storage allocation map: asin:YYYY-MM -> units_sold_that_month.
   * Each month is computed independently — no cross-month mixing.
   */
  async buildStorageMap(accountId, marketplaceId, dateFrom, dateTo) {
    const result = await db.query(
      `SELECT asin,
        DATE_TRUNC('month', purchase_date) AS month,
        SUM(quantity) AS units_month
       FROM orders_raw
       WHERE account_id = $1 AND marketplace_id = $2
         AND purchase_date >= DATE_TRUNC('month', $3::date)
         AND purchase_date < DATE_TRUNC('month', $4::date) + INTERVAL '1 month'
         AND order_status NOT IN ('Cancelled', 'Pending')
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
   * Bulk pre-fetch ads spend: asin:date -> total_spend.
   * Replaces per-order AdsService.getDailySpendByAsin calls (N+1 elimination).
   */
  async buildAdsSpendMap(accountId, marketplaceId, dateFrom, dateTo) {
    const result = await db.query(
      `SELECT asin, spend_date, SUM(spend) AS total_spend
       FROM ads_daily_spend
       WHERE account_id = $1 AND marketplace_id = $2
         AND spend_date >= $3::date AND spend_date < $4::date
       GROUP BY asin, spend_date`,
      [accountId, marketplaceId, dateFrom, dateTo]
    );

    const map = {};
    for (const row of result.rows) {
      const key = `${row.asin}:${toDateStr(row.spend_date)}`;
      map[key] = parseFloat(row.total_spend);
    }
    return map;
  },

  /**
   * Bulk pre-fetch refund totals: order_id:asin -> refund_amount.
   * Replaces separate processRefunds pass (N+1 elimination).
   */
  async buildRefundMap(accountId, marketplaceId, dateFrom, dateTo) {
    const result = await db.query(
      `SELECT amazon_order_id, asin, SUM(amount) AS refund_total
       FROM financial_events_raw
       WHERE account_id = $1 AND marketplace_id = $2
         AND event_type = 'RefundEvent'
         AND event_date >= $3 AND event_date < $4
       GROUP BY amazon_order_id, asin`,
      [accountId, marketplaceId, dateFrom, dateTo]
    );

    const map = {};
    for (const row of result.rows) {
      if (!row.amazon_order_id) continue;
      const key = `${row.amazon_order_id}:${row.asin}`;
      map[key] = round(Math.abs(parseFloat(row.refund_total)), 4);
    }
    return map;
  },

  /**
   * Compute and upsert profit for a single order line.
   * All lookups are O(1) from pre-built maps. No service calls inside loop.
   * Refund is included in a clean total_costs calculation (no incremental mutation).
   */
  async computeOrderProfit(client, order, feeMap, costsMap, unitsByDay, storageMap, adsSpendMap, refundMap) {
    const orderDate = toDateStr(order.purchase_date);
    const feeKey = `${order.amazon_order_id}:${order.asin}`;
    const fees = feeMap[feeKey] || {};
    const costs = costsMap[order.asin] || {};
    const qty = order.quantity || 1;

    // Revenue = item_price + shipping_price - promotion_discount
    const revenue = round(
      parseFloat(order.item_price || 0) +
      parseFloat(order.shipping_price || 0) -
      parseFloat(order.promotion_discount || 0)
    , 4);

    // Amazon fees (from financial events, stored as negative, we use absolute values)
    const referralFee = round(Math.abs(fees['Commission'] || fees['ReferralFee'] || 0), 4);
    const fbaFee = round(Math.abs(
      (fees['FBAPerUnitFulfillmentFee'] || 0) +
      (fees['FBAPerOrderFulfillmentFee'] || 0) +
      (fees['FBAWeightBasedFee'] || 0)
    ), 4);

    // Other fees: everything not referral or FBA
    const knownFeeTypes = [
      'Commission', 'ReferralFee',
      'FBAPerUnitFulfillmentFee', 'FBAPerOrderFulfillmentFee', 'FBAWeightBasedFee',
    ];
    let otherFees = 0;
    for (const [feeType, amount] of Object.entries(fees)) {
      if (!knownFeeTypes.includes(feeType)) {
        otherFees += Math.abs(amount);
      }
    }
    otherFees = round(otherFees, 4);

    // Ads allocation: O(1) lookup from pre-built map (no per-order DB query)
    const dayKey = `${order.asin}:${orderDate}`;
    const unitsDay = unitsByDay[dayKey] || 1;
    const dailyAdsSpend = adsSpendMap[dayKey] || 0;
    const adsAllocated = round((dailyAdsSpend / unitsDay) * qty, 4);

    // Product costs (per unit * quantity)
    const productCost = round(parseFloat(costs.product_cost || 0) * qty, 4);
    const inboundCost = round(parseFloat(costs.inbound_cost || 0) * qty, 4);
    const customsCost = round(parseFloat(costs.customs_cost || 0) * qty, 4);
    const prepCost = round(parseFloat(costs.prep_cost || 0) * qty, 4);
    const packagingCost = round(parseFloat(costs.packaging_cost || 0) * qty, 4);

    // Storage allocation: uses correct month bucket per order (no cross-month mixing)
    const monthKey = `${order.asin}:${orderDate.substring(0, 7)}`;
    const unitsMonth = storageMap[monthKey] || 1;
    const storageMonthly = parseFloat(costs.storage_monthly_cost || 0);
    const storageAllocated = round((storageMonthly / unitsMonth) * qty, 4);

    // Refund: O(1) lookup from pre-built map
    const refundAmount = refundMap[feeKey] || 0;

    // Clean total_costs calculation (NOT incremental mutation):
    // total_costs = base_costs + refund_amount
    const baseCosts = round(
      referralFee + fbaFee + otherFees + adsAllocated +
      productCost + inboundCost + customsCost + prepCost + packagingCost + storageAllocated
    , 4);
    const totalCosts = round(baseCosts + refundAmount, 4);

    // net_profit = revenue - total_costs
    const netProfit = round(revenue - totalCosts, 4);
    const marginPct = pct(netProfit, revenue, 4);
    const investedCost = productCost + inboundCost + customsCost + prepCost + packagingCost + storageAllocated + adsAllocated;
    const roiPct = roi(netProfit, investedCost, 4);

    // Upsert using transaction client
    await client.query(
      `INSERT INTO order_profit (
        account_id, marketplace_id, amazon_order_id, asin, order_date, quantity,
        revenue, referral_fee, fba_fee, other_amazon_fees,
        refund_amount, ads_allocated,
        product_cost, inbound_cost, customs_cost, prep_cost, packaging_cost, storage_allocated,
        total_costs, net_profit, margin_pct, roi_pct, currency, computed_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,NOW())
      ON CONFLICT (account_id, amazon_order_id, asin) DO UPDATE SET
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
        refundAmount,
        adsAllocated,
        productCost, inboundCost, customsCost, prepCost, packagingCost, storageAllocated,
        totalCosts, netProfit, marginPct, roiPct, order.currency,
      ]
    );
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
