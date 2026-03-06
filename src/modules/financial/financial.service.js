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
 *
 * IMPORTANT: The Financial Events API returns events for ALL marketplaces
 * of an account in a single call. We therefore sync once per account
 * (not per marketplace) and resolve each event's marketplace from orders_raw.
 */
const FinancialService = {
  /**
   * Cache of SellerSKU -> ASIN mappings per account.
   * Amazon Financial Events API only provides SellerSKU, not ASIN.
   * We resolve it from orders_raw and asins tables.
   * Cleared after each account sync to prevent stale data.
   */
  _skuToAsinCache: {},
  _orderMarketplaceCache: {},

  async resolveSkuToAsin(accountId, sellerSKU) {
    if (!sellerSKU) return null;

    // If it already looks like an ASIN (starts with B0 and 10 chars), return as-is
    if (/^B[A-Z0-9]{9}$/.test(sellerSKU)) return sellerSKU;

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

    // If no mapping found, return the SKU as-is (may be usable as identifier)
    logger.warn('Could not resolve SellerSKU to ASIN', { accountId, sellerSKU });
    return sellerSKU;
  },

  /**
   * Resolve the correct marketplace_id for an order from orders_raw.
   * Financial Events API returns events for ALL marketplaces, so we need
   * to look up the actual marketplace from the order data.
   *
   * Returns null if the order is not yet in orders_raw (event will be skipped
   * and retried on the next sync cycle after orders have been synced).
   */
  async resolveOrderMarketplace(accountId, amazonOrderId) {
    if (!amazonOrderId) return null;

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

    return null;
  },

  /**
   * Clear in-memory caches. Called after each account sync to prevent
   * stale data and unbounded memory growth.
   */
  clearCaches() {
    this._skuToAsinCache = {};
    this._orderMarketplaceCache = {};
  },

  /**
   * Sync financial events for an entire account (all marketplaces at once).
   *
   * The Financial Events API returns events for ALL marketplaces of the seller,
   * so we call it only ONCE per account and resolve each event's marketplace
   * from orders_raw. Events whose marketplace cannot be resolved (order not yet
   * synced) are skipped and will be picked up on the next cycle.
   *
   * @param {Array} accountTargets - All active marketplace targets for one account.
   */
  async syncFinancialEventsForAccount(accountTargets) {
    const accountId = accountTargets[0].account_id;
    const representative = accountTargets[0];

    // Build set of valid marketplace IDs for this account
    const validMarketplaceIds = new Set(accountTargets.map(t => t.account_marketplace_id));

    // Build currency lookup by marketplace
    const currencyByMarketplace = {};
    for (const t of accountTargets) {
      currencyByMarketplace[t.account_marketplace_id] = t.currency;
    }

    // Use earliest last_financial_sync_at across all marketplaces
    let earliestSync = accountTargets[0].last_financial_sync_at;
    for (const t of accountTargets) {
      if (!t.last_financial_sync_at) {
        earliestSync = null;
        break;
      }
      if (t.last_financial_sync_at < earliestSync) {
        earliestSync = t.last_financial_sync_at;
      }
    }

    const { from, to } = syncDateRange(earliestSync, config.sync?.maxDaysBack || 30);

    const syncLog = await SyncLogger.start(accountId, null, 'financial');
    let processed = 0;
    let inserted = 0;
    let skipped = 0;
    let pages = 0;

    try {
      logger.info('Starting financial sync for account', {
        accountId,
        marketplaces: accountTargets.map(t => t.country_code).join(', '),
        from,
        to,
      });

      const spApi = new SpApiClient(representative);
      let nextToken = null;

      do {
        pages++;
        const response = await spApi.listFinancialEvents({
          PostedAfter: from,
          PostedBefore: to,
          NextToken: nextToken,
        });

        const eventList = response.FinancialEvents || {};

        // Process ShipmentEventList (order-level charges + fees)
        for (const event of eventList.ShipmentEventList || []) {
          for (const itemCharges of event.ShipmentItemList || []) {
            const rows = await this.extractShipmentFees(accountId, event, itemCharges, currencyByMarketplace);
            for (const row of rows) {
              if (!row) { skipped++; continue; }
              if (!validMarketplaceIds.has(row.marketplace_id)) { skipped++; continue; }
              processed++;
              const res = await this.upsertEvent(row);
              if (res === 'inserted') inserted++;
            }
          }
        }

        // Process RefundEventList
        for (const event of eventList.RefundEventList || []) {
          for (const itemCharges of event.ShipmentItemList || []) {
            const rows = await this.extractRefundFees(accountId, event, itemCharges, currencyByMarketplace);
            for (const row of rows) {
              if (!row) { skipped++; continue; }
              if (!validMarketplaceIds.has(row.marketplace_id)) { skipped++; continue; }
              processed++;
              const res = await this.upsertEvent(row);
              if (res === 'inserted') inserted++;
            }
          }
        }

        // Process ServiceFeeEventList (e.g., subscription fees)
        for (const event of eventList.ServiceFeeEventList || []) {
          const row = this.extractServiceFee(accountId, accountTargets[0], event);
          processed++;
          const res = await this.upsertEvent(row);
          if (res === 'inserted') inserted++;
        }

        nextToken = response.NextToken || null;

        if (pages % 5 === 0) {
          logger.info(`Financial sync account ${accountId}: page ${pages}, ${processed} processed, ${skipped} skipped, ${inserted} inserted`);
        }
      } while (nextToken);

      this.clearCaches();

      await SyncLogger.complete(syncLog.id, { processed, inserted, updated: 0 });

      logger.info('Financial sync completed for account', {
        accountId,
        pages,
        processed,
        inserted,
        skipped,
      });

      return { processed, inserted, skipped };
    } catch (err) {
      this.clearCaches();
      await SyncLogger.fail(syncLog.id, err.message);
      logger.error('Financial sync failed for account', {
        accountId,
        error: err.message,
        pages,
        processed,
        skipped,
      });
      throw err;
    }
  },

  /**
   * Extract fee rows from a shipment event item.
   * Resolves SellerSKU -> ASIN via DB lookup.
   * Returns null entries for events whose marketplace cannot be resolved.
   */
  async extractShipmentFees(accountId, event, itemCharges, currencyByMarketplace) {
    const rows = [];
    const orderId = event.AmazonOrderId;
    const asin = await this.resolveSkuToAsin(accountId, itemCharges.SellerSKU);
    const postedDate = event.PostedDate;
    const marketplaceId = await this.resolveOrderMarketplace(accountId, orderId);

    if (!marketplaceId) {
      const count = (itemCharges.ItemChargeList || []).length +
                    (itemCharges.ItemFeeList || []).length +
                    (itemCharges.ItemTaxWithheldList || []).reduce((sum, t) => sum + (t.TaxesWithheld || []).length, 0);
      for (let i = 0; i < count; i++) rows.push(null);
      return rows;
    }

    const currency = currencyByMarketplace[marketplaceId] || 'EUR';

    // ItemChargeList: revenue components (Principal, Tax, ShippingCharge, etc.)
    for (const charge of itemCharges.ItemChargeList || []) {
      rows.push({
        account_id: accountId,
        marketplace_id: marketplaceId,
        amazon_order_id: orderId,
        asin,
        event_type: 'ShipmentEvent',
        fee_type: charge.ChargeType,
        amount: parseFloat(charge.ChargeAmount?.CurrencyAmount || 0),
        currency: charge.ChargeAmount?.CurrencyCode || currency,
        event_date: postedDate,
        posted_date: postedDate,
        raw_data: charge,
      });
    }

    // ItemFeeList: Amazon fees (referral, FBA, etc.)
    for (const fee of itemCharges.ItemFeeList || []) {
      rows.push({
        account_id: accountId,
        marketplace_id: marketplaceId,
        amazon_order_id: orderId,
        asin,
        event_type: 'ShipmentEvent',
        fee_type: fee.FeeType,
        amount: parseFloat(fee.FeeAmount?.CurrencyAmount || 0),
        currency: fee.FeeAmount?.CurrencyCode || currency,
        event_date: postedDate,
        posted_date: postedDate,
        raw_data: fee,
      });
    }

    // ItemTaxWithheldList: MarketplaceFacilitatorTax, etc.
    for (const tax of itemCharges.ItemTaxWithheldList || []) {
      for (const taxComponent of tax.TaxesWithheld || []) {
        rows.push({
          account_id: accountId,
          marketplace_id: marketplaceId,
          amazon_order_id: orderId,
          asin,
          event_type: 'ShipmentEvent',
          fee_type: taxComponent.ChargeType || 'MarketplaceFacilitatorTax',
          amount: parseFloat(taxComponent.ChargeAmount?.CurrencyAmount || 0),
          currency: taxComponent.ChargeAmount?.CurrencyCode || currency,
          event_date: postedDate,
          posted_date: postedDate,
          raw_data: taxComponent,
        });
      }
    }

    return rows;
  },

  /**
   * Extract refund event fees. Amounts are typically negative.
   * Resolves SellerSKU -> ASIN via DB lookup.
   * Returns null entries for events whose marketplace cannot be resolved.
   */
  async extractRefundFees(accountId, event, itemCharges, currencyByMarketplace) {
    const rows = [];
    const orderId = event.AmazonOrderId;
    const asin = await this.resolveSkuToAsin(accountId, itemCharges.SellerSKU);
    const postedDate = event.PostedDate;
    const marketplaceId = await this.resolveOrderMarketplace(accountId, orderId);

    if (!marketplaceId) {
      const count = (itemCharges.ItemChargeList || []).length + (itemCharges.ItemFeeList || []).length;
      for (let i = 0; i < count; i++) rows.push(null);
      return rows;
    }

    const currency = currencyByMarketplace[marketplaceId] || 'EUR';

    for (const charge of itemCharges.ItemChargeList || []) {
      rows.push({
        account_id: accountId,
        marketplace_id: marketplaceId,
        amazon_order_id: orderId,
        asin,
        event_type: 'RefundEvent',
        fee_type: charge.ChargeType,
        amount: parseFloat(charge.ChargeAmount?.CurrencyAmount || 0),
        currency: charge.ChargeAmount?.CurrencyCode || currency,
        event_date: postedDate,
        posted_date: postedDate,
        raw_data: charge,
      });
    }

    for (const fee of itemCharges.ItemFeeList || []) {
      rows.push({
        account_id: accountId,
        marketplace_id: marketplaceId,
        amazon_order_id: orderId,
        asin,
        event_type: 'RefundEvent',
        fee_type: fee.FeeType,
        amount: parseFloat(fee.FeeAmount?.CurrencyAmount || 0),
        currency: fee.FeeAmount?.CurrencyCode || currency,
        event_date: postedDate,
        posted_date: postedDate,
        raw_data: fee,
      });
    }

    return rows;
  },

  /**
   * Extract service fee event (subscription, etc.).
   * Service fees are account-level, not per marketplace.
   */
  extractServiceFee(accountId, defaultTarget, event) {
    const totalAmount = (event.FeeList || []).reduce((sum, f) => {
      return sum + parseFloat(f.FeeAmount?.CurrencyAmount || 0);
    }, 0);

    return {
      account_id: accountId,
      marketplace_id: defaultTarget.account_marketplace_id,
      amazon_order_id: null,
      asin: null,
      event_type: 'ServiceFeeEvent',
      fee_type: event.FeeDescription || 'ServiceFee',
      amount: totalAmount,
      currency: (event.FeeList?.[0]?.FeeAmount?.CurrencyCode) || defaultTarget.currency,
      event_date: event.PostedDate || new Date().toISOString(),
      posted_date: event.PostedDate,
      raw_data: event,
    };
  },

  /**
   * Upsert a single financial event (idempotent).
   * Uses different ON CONFLICT clauses for NULL vs non-NULL amazon_order_id,
   * because PostgreSQL treats NULL != NULL in unique constraints.
   */
  async upsertEvent(row) {
    const params = [
      row.account_id, row.marketplace_id, row.amazon_order_id, row.asin,
      row.event_type, row.fee_type, row.amount, row.currency,
      row.event_date, row.posted_date, JSON.stringify(row.raw_data),
    ];

    const insertCols = `INSERT INTO financial_events_raw (
        account_id, marketplace_id, amazon_order_id, asin,
        event_type, fee_type, amount, currency,
        event_date, posted_date, raw_data
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`;

    const doUpdate = `DO UPDATE SET
        marketplace_id = EXCLUDED.marketplace_id,
        amount = EXCLUDED.amount,
        asin = COALESCE(EXCLUDED.asin, financial_events_raw.asin),
        raw_data = EXCLUDED.raw_data,
        synced_at = NOW()
      RETURNING (xmax = 0) AS is_insert`;

    let query;
    if (row.amazon_order_id == null) {
      query = `${insertCols}
      ON CONFLICT (account_id, event_type, fee_type, event_date) WHERE amazon_order_id IS NULL
      ${doUpdate}`;
    } else {
      query = `${insertCols}
      ON CONFLICT (account_id, amazon_order_id, COALESCE(asin, ''), event_type, COALESCE(fee_type, ''), event_date) WHERE amazon_order_id IS NOT NULL
      ${doUpdate}`;
    }

    const result = await db.query(query, params);
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
   * Get refund events for a given date range (for profit engine).
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
