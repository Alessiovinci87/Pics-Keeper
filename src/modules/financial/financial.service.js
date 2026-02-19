const db = require('../../database/pool');
const config = require('../../config');
const logger = require('../../utils/logger');
const { syncDateRange } = require('../../utils/helpers');
const SpApiClient = require('../../services/sp-api.client');
const SyncLogger = require('../../services/sync-logger');

/**
 * Financial Events Sync Service.
 * Fetches financial events from Amazon SP-API Financial Events endpoint.
 * Handles: ShipmentEvents, RefundEvents, ServiceFeeEvents, etc.
 * Idempotent via ON CONFLICT.
 */
const FinancialService = {
  /**
   * Cache of SellerSKU -> ASIN mappings per account.
   * Amazon Financial Events API only provides SellerSKU, not ASIN.
   * We resolve it from orders_raw and asins tables.
   */
  _skuToAsinCache: {},
  _orderMarketplaceCache: {},

  async resolveSkuToAsin(accountId, sellerSKU) {
    if (!sellerSKU) return null;

    const cacheKey = `${accountId}:${sellerSKU}`;
    if (this._skuToAsinCache[cacheKey]) {
      return this._skuToAsinCache[cacheKey];
    }

    // Try orders_raw first (most reliable: has direct ASIN-SKU pairs from order items)
    const orderLookup = await db.query(
      `SELECT DISTINCT asin FROM orders_raw
       WHERE account_id = $1 AND sku = $2
       LIMIT 1`,
      [accountId, sellerSKU]
    );

    if (orderLookup.rows.length > 0) {
      this._skuToAsinCache[cacheKey] = orderLookup.rows[0].asin;
      return orderLookup.rows[0].asin;
    }

    // Fallback: check asins table
    const asinLookup = await db.query(
      `SELECT asin FROM asins
       WHERE account_id = $1 AND sku = $2
       LIMIT 1`,
      [accountId, sellerSKU]
    );

    if (asinLookup.rows.length > 0) {
      this._skuToAsinCache[cacheKey] = asinLookup.rows[0].asin;
      return asinLookup.rows[0].asin;
    }

    // If no mapping found, return null (SKU may be too long for asin column)
    logger.warn('Could not resolve SellerSKU to ASIN', {
      accountId,
      sellerSKU,
    });
    return null;
  },

  /**
   * Resolve the correct marketplace_id for an order from orders_raw.
   * Financial Events API returns events for ALL marketplaces, so we need
   * to look up the actual marketplace from the order data.
   */
  async resolveOrderMarketplace(accountId, amazonOrderId, fallbackMarketplaceId) {
    if (!amazonOrderId) return fallbackMarketplaceId;

    const cacheKey = `${accountId}:${amazonOrderId}`;
    if (this._orderMarketplaceCache[cacheKey]) {
      return this._orderMarketplaceCache[cacheKey];
    }

    const result = await db.query(
      `SELECT marketplace_id FROM orders_raw
       WHERE account_id = $1 AND amazon_order_id = $2
       LIMIT 1`,
      [accountId, amazonOrderId]
    );

    if (result.rows.length > 0) {
      this._orderMarketplaceCache[cacheKey] = result.rows[0].marketplace_id;
      return result.rows[0].marketplace_id;
    }

    return fallbackMarketplaceId;
  },

  /**
   * Sync financial events for a single account+marketplace.
   */
  async syncFinancialEvents(target) {
    const syncLog = await SyncLogger.start(target.account_id, target.account_marketplace_id, 'financial');
    let processed = 0;
    let inserted = 0;

    try {
      const { from, to } = syncDateRange(target.last_financial_sync_at, config.sync.maxDaysBack);

      logger.info('Starting financial sync', {
        accountId: target.account_id,
        marketplace: target.country_code,
        from,
        to,
      });

      const spApi = new SpApiClient(target);
      let nextToken = null;

      do {
        const response = await spApi.listFinancialEvents({
          PostedAfter: from,
          PostedBefore: to,
          NextToken: nextToken,
        });

        const eventList = response.FinancialEvents || {};

        // Process ShipmentEventList (order-level fees)
        for (const event of eventList.ShipmentEventList || []) {
          for (const itemCharges of event.ShipmentItemList || []) {
            const rows = await this.extractShipmentFees(target, event, itemCharges);
            for (const row of rows) {
              processed++;
              const res = await this.upsertEvent(row);
              if (res === 'inserted') inserted++;
            }
          }
        }

        // Process RefundEventList
        for (const event of eventList.RefundEventList || []) {
          for (const itemCharges of event.ShipmentItemList || []) {
            const rows = await this.extractRefundFees(target, event, itemCharges);
            for (const row of rows) {
              processed++;
              const res = await this.upsertEvent(row);
              if (res === 'inserted') inserted++;
            }
          }
        }

        // Process ServiceFeeEventList (e.g., subscription fees)
        for (const event of eventList.ServiceFeeEventList || []) {
          processed++;
          const row = this.extractServiceFee(target, event);
          const res = await this.upsertEvent(row);
          if (res === 'inserted') inserted++;
        }

        nextToken = response.NextToken || null;
      } while (nextToken);

      await SyncLogger.complete(syncLog.id, { processed, inserted, updated: 0 });

      logger.info('Financial sync completed', {
        accountId: target.account_id,
        marketplace: target.country_code,
        processed,
        inserted,
      });

      return { processed, inserted };
    } catch (err) {
      await SyncLogger.fail(syncLog.id, err.message);
      logger.error('Financial sync failed', {
        accountId: target.account_id,
        marketplace: target.country_code,
        error: err.message,
      });
      throw err;
    }
  },

  /**
   * Extract fee rows from a shipment event item.
   * Resolves SellerSKU -> ASIN via DB lookup.
   */
  async extractShipmentFees(target, event, itemCharges) {
    const rows = [];
    const orderId = event.AmazonOrderId;
    const asin = await this.resolveSkuToAsin(target.account_id, itemCharges.SellerSKU);
    const postedDate = event.PostedDate;
    // Resolve the actual marketplace from orders_raw (Financial API returns ALL marketplaces)
    const marketplaceId = await this.resolveOrderMarketplace(
      target.account_id, orderId, target.account_marketplace_id
    );

    // ItemChargeList: revenue components
    for (const charge of itemCharges.ItemChargeList || []) {
      rows.push({
        account_id: target.account_id,
        marketplace_id: marketplaceId,
        amazon_order_id: orderId,
        asin,
        event_type: 'ShipmentEvent',
        fee_type: charge.ChargeType,
        amount: parseFloat(charge.ChargeAmount?.CurrencyAmount || 0),
        currency: charge.ChargeAmount?.CurrencyCode || target.currency,
        event_date: postedDate,
        posted_date: postedDate,
        raw_data: charge,
      });
    }

    // ItemFeeList: Amazon fees (referral, FBA, etc.)
    for (const fee of itemCharges.ItemFeeList || []) {
      rows.push({
        account_id: target.account_id,
        marketplace_id: marketplaceId,
        amazon_order_id: orderId,
        asin,
        event_type: 'ShipmentEvent',
        fee_type: fee.FeeType,
        amount: parseFloat(fee.FeeAmount?.CurrencyAmount || 0),
        currency: fee.FeeAmount?.CurrencyCode || target.currency,
        event_date: postedDate,
        posted_date: postedDate,
        raw_data: fee,
      });
    }

    return rows;
  },

  /**
   * Extract refund event fees. Amounts are typically negative.
   * Resolves SellerSKU -> ASIN via DB lookup.
   */
  async extractRefundFees(target, event, itemCharges) {
    const rows = [];
    const orderId = event.AmazonOrderId;
    const asin = await this.resolveSkuToAsin(target.account_id, itemCharges.SellerSKU);
    const postedDate = event.PostedDate;
    // Resolve the actual marketplace from orders_raw (Financial API returns ALL marketplaces)
    const marketplaceId = await this.resolveOrderMarketplace(
      target.account_id, orderId, target.account_marketplace_id
    );

    for (const charge of itemCharges.ItemChargeList || []) {
      rows.push({
        account_id: target.account_id,
        marketplace_id: marketplaceId,
        amazon_order_id: orderId,
        asin,
        event_type: 'RefundEvent',
        fee_type: charge.ChargeType,
        amount: parseFloat(charge.ChargeAmount?.CurrencyAmount || 0),
        currency: charge.ChargeAmount?.CurrencyCode || target.currency,
        event_date: postedDate,
        posted_date: postedDate,
        raw_data: charge,
      });
    }

    for (const fee of itemCharges.ItemFeeList || []) {
      rows.push({
        account_id: target.account_id,
        marketplace_id: marketplaceId,
        amazon_order_id: orderId,
        asin,
        event_type: 'RefundEvent',
        fee_type: fee.FeeType,
        amount: parseFloat(fee.FeeAmount?.CurrencyAmount || 0),
        currency: fee.FeeAmount?.CurrencyCode || target.currency,
        event_date: postedDate,
        posted_date: postedDate,
        raw_data: fee,
      });
    }

    return rows;
  },

  /**
   * Extract service fee event (subscription, etc.).
   */
  extractServiceFee(target, event) {
    const totalAmount = (event.FeeList || []).reduce((sum, f) => {
      return sum + parseFloat(f.FeeAmount?.CurrencyAmount || 0);
    }, 0);

    return {
      account_id: target.account_id,
      marketplace_id: target.account_marketplace_id,
      amazon_order_id: null,
      asin: null,
      event_type: 'ServiceFeeEvent',
      fee_type: event.FeeDescription || 'ServiceFee',
      amount: totalAmount,
      currency: (event.FeeList?.[0]?.FeeAmount?.CurrencyCode) || target.currency,
      event_date: event.PostedDate || new Date().toISOString(),
      posted_date: event.PostedDate,
      raw_data: event,
    };
  },

  /**
   * Upsert a single financial event (idempotent).
   */
  async upsertEvent(row) {
    const result = await db.query(
      `INSERT INTO financial_events_raw (
        account_id, marketplace_id, amazon_order_id, asin,
        event_type, fee_type, amount, currency,
        event_date, posted_date, raw_data
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (account_id, amazon_order_id, event_type, fee_type, event_date)
      DO UPDATE SET
        marketplace_id = EXCLUDED.marketplace_id,
        amount = EXCLUDED.amount,
        asin = COALESCE(EXCLUDED.asin, financial_events_raw.asin),
        raw_data = EXCLUDED.raw_data,
        synced_at = NOW()
      RETURNING (xmax = 0) AS is_insert`,
      [
        row.account_id, row.marketplace_id, row.amazon_order_id, row.asin,
        row.event_type, row.fee_type, row.amount, row.currency,
        row.event_date, row.posted_date, JSON.stringify(row.raw_data),
      ]
    );
    return result.rows[0]?.is_insert ? 'inserted' : 'updated';
  },

  /**
   * Get financial events for an order (used by profit engine).
   */
  async getEventsByOrder(accountId, amazonOrderId) {
    const result = await db.query(
      `SELECT * FROM financial_events_raw
       WHERE account_id = $1 AND amazon_order_id = $2
       ORDER BY event_date, fee_type`,
      [accountId, amazonOrderId]
    );
    return result.rows;
  },

  /**
   * Get refund events for a given date range (for profit engine - refunds allocated to real date).
   */
  async getRefundsInRange(accountId, marketplaceId, dateFrom, dateTo) {
    const result = await db.query(
      `SELECT * FROM financial_events_raw
       WHERE account_id = $1 AND marketplace_id = $2
         AND event_type = 'RefundEvent'
         AND event_date >= $3 AND event_date < $4
       ORDER BY event_date`,
      [accountId, marketplaceId, dateFrom, dateTo]
    );
    return result.rows;
  },
};

module.exports = FinancialService;
