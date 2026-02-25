const db = require('../../database/pool');
const logger = require('../../utils/logger');
const { syncDateRange } = require('../../utils/helpers');
const SpApiClient = require('../../services/sp-api.client');
const SyncLogger = require('../../services/sync-logger');

/**
 * Financial Events Sync Service.
 * Fetches financial events from Amazon SP-API Financial Events endpoint.
 * Handles: ShipmentEvents, RefundEvents, ServiceFeeEvents, etc.
 *
 * CRITICAL FIX: The Financial Events API returns events for ALL marketplaces
 * in a single response. We must:
 * 1. Call the API ONCE per account (not per marketplace)
 * 2. Resolve the correct marketplace for each event via orders_raw lookup
 * 3. Include ASIN in the unique constraint for multi-ASIN orders
 */
const FinancialService = {
  /**
   * Sync financial events for a single account.
   * Called ONCE per account - the API returns events across all marketplaces.
   *
   * @param {object} target - Account sync target (any marketplace target for the account)
   * @param {Set} [processedAccounts] - Set of already-processed account IDs (to skip duplicates)
   */
  async syncFinancialEvents(target, processedAccounts) {
    // Skip if this account was already processed in this sync cycle
    if (processedAccounts && processedAccounts.has(target.account_id)) {
      logger.info('Financial sync already done for this account, skipping', {
        accountId: target.account_id,
        marketplace: target.country_code,
      });
      return { processed: 0, inserted: 0, skipped: true };
    }

    const syncLog = await SyncLogger.start(target.account_id, target.account_marketplace_id, 'financial');
    let processed = 0;
    let inserted = 0;

    try {
      const { from, to } = syncDateRange(target.last_financial_sync_at, 30);

      logger.info('Starting financial sync (account-level)', {
        accountId: target.account_id,
        from,
        to,
      });

      // Pre-build marketplace resolution map: amazon_order_id -> marketplace_id
      const mpMap = await this.buildMarketplaceMap(target.account_id);

      const spApi = new SpApiClient(target);
      let nextToken = null;

      do {
        const response = await spApi.listFinancialEvents({
          PostedAfter: from,
          PostedBefore: to,
          NextToken: nextToken,
        });

        const eventList = response.FinancialEvents || {};

        // Process ShipmentEventList (order-level charges + fees)
        for (const event of eventList.ShipmentEventList || []) {
          for (const itemCharges of event.ShipmentItemList || []) {
            const rows = this.extractShipmentFees(target, event, itemCharges, mpMap);
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
            const rows = this.extractRefundFees(target, event, itemCharges, mpMap);
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

      // Mark this account as processed
      if (processedAccounts) {
        processedAccounts.add(target.account_id);
      }

      await SyncLogger.complete(syncLog.id, { processed, inserted, updated: 0 });

      logger.info('Financial sync completed (account-level)', {
        accountId: target.account_id,
        processed,
        inserted,
      });

      return { processed, inserted };
    } catch (err) {
      await SyncLogger.fail(syncLog.id, err.message);
      logger.error('Financial sync failed', {
        accountId: target.account_id,
        error: err.message,
      });
      throw err;
    }
  },

  /**
   * Build a map of amazon_order_id -> marketplace_id from orders_raw.
   * Used to resolve the correct marketplace for each financial event.
   */
  async buildMarketplaceMap(accountId) {
    const result = await db.query(
      `SELECT DISTINCT amazon_order_id, marketplace_id
       FROM orders_raw
       WHERE account_id = $1`,
      [accountId]
    );

    const map = {};
    for (const row of result.rows) {
      map[row.amazon_order_id] = row.marketplace_id;
    }
    return map;
  },

  /**
   * Resolve marketplace_id for a financial event.
   * Uses orders_raw as source of truth. Falls back to the sync target marketplace.
   */
  resolveMarketplaceId(orderId, target, mpMap) {
    if (orderId && mpMap[orderId]) {
      return mpMap[orderId];
    }
    // Fallback: use the target marketplace (best guess)
    return target.account_marketplace_id;
  },

  /**
   * Resolve ASIN from SellerSKU. The API sometimes gives SKU, not ASIN.
   * We try to resolve via orders_raw if the SKU doesn't look like an ASIN.
   */
  async resolveAsin(accountId, orderId, sellerSku) {
    if (!sellerSku) return null;

    // If it already looks like an ASIN (starts with B0 and 10 chars), return as-is
    if (/^B[A-Z0-9]{9}$/.test(sellerSku)) return sellerSku;

    // Try to look up the ASIN from orders_raw
    if (orderId) {
      const result = await db.query(
        `SELECT asin FROM orders_raw
         WHERE account_id = $1 AND amazon_order_id = $2 AND sku = $3
         LIMIT 1`,
        [accountId, orderId, sellerSku]
      );
      if (result.rows.length > 0) return result.rows[0].asin;
    }

    // Fallback: return the SKU as-is (may be an ASIN in non-standard format)
    return sellerSku;
  },

  /**
   * Extract fee rows from a shipment event item.
   * Maps Amazon fee types to our normalized structure.
   * Resolves marketplace from orders_raw, not from sync target.
   */
  extractShipmentFees(target, event, itemCharges, mpMap) {
    const rows = [];
    const orderId = event.AmazonOrderId;
    const asin = itemCharges.SellerSKU;
    const postedDate = event.PostedDate;
    const resolvedMp = this.resolveMarketplaceId(orderId, target, mpMap);

    // ItemChargeList: revenue components (Principal, Tax, ShippingCharge, etc.)
    for (const charge of itemCharges.ItemChargeList || []) {
      rows.push({
        account_id: target.account_id,
        marketplace_id: resolvedMp,
        amazon_order_id: orderId,
        asin: asin,
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
        marketplace_id: resolvedMp,
        amazon_order_id: orderId,
        asin: asin,
        event_type: 'ShipmentEvent',
        fee_type: fee.FeeType,
        amount: parseFloat(fee.FeeAmount?.CurrencyAmount || 0),
        currency: fee.FeeAmount?.CurrencyCode || target.currency,
        event_date: postedDate,
        posted_date: postedDate,
        raw_data: fee,
      });
    }

    // ItemTaxWithheldList: MarketplaceFacilitatorTax, etc.
    for (const tax of itemCharges.ItemTaxWithheldList || []) {
      for (const taxComponent of tax.TaxesWithheld || []) {
        rows.push({
          account_id: target.account_id,
          marketplace_id: resolvedMp,
          amazon_order_id: orderId,
          asin: asin,
          event_type: 'ShipmentEvent',
          fee_type: taxComponent.ChargeType || 'MarketplaceFacilitatorTax',
          amount: parseFloat(taxComponent.ChargeAmount?.CurrencyAmount || 0),
          currency: taxComponent.ChargeAmount?.CurrencyCode || target.currency,
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
   */
  extractRefundFees(target, event, itemCharges, mpMap) {
    const rows = [];
    const orderId = event.AmazonOrderId;
    const postedDate = event.PostedDate;
    const resolvedMp = this.resolveMarketplaceId(orderId, target, mpMap);

    for (const charge of itemCharges.ItemChargeList || []) {
      rows.push({
        account_id: target.account_id,
        marketplace_id: resolvedMp,
        amazon_order_id: orderId,
        asin: itemCharges.SellerSKU,
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
        marketplace_id: resolvedMp,
        amazon_order_id: orderId,
        asin: itemCharges.SellerSKU,
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
   * Uses separate ON CONFLICT targets for rows with/without amazon_order_id
   * (due to partial unique indexes from migration 006).
   */
  async upsertEvent(row) {
    if (row.amazon_order_id) {
      // Events WITH order_id: unique on (account_id, amazon_order_id, asin, event_type, fee_type, event_date)
      const result = await db.query(
        `INSERT INTO financial_events_raw (
          account_id, marketplace_id, amazon_order_id, asin,
          event_type, fee_type, amount, currency,
          event_date, posted_date, raw_data
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (account_id, amazon_order_id, asin, event_type, fee_type, event_date)
          WHERE amazon_order_id IS NOT NULL
        DO UPDATE SET
          marketplace_id = EXCLUDED.marketplace_id,
          amount = EXCLUDED.amount,
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
    } else {
      // Events WITHOUT order_id: unique on (account_id, event_type, fee_type, event_date)
      const result = await db.query(
        `INSERT INTO financial_events_raw (
          account_id, marketplace_id, amazon_order_id, asin,
          event_type, fee_type, amount, currency,
          event_date, posted_date, raw_data
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (account_id, event_type, fee_type, event_date)
          WHERE amazon_order_id IS NULL
        DO UPDATE SET
          amount = EXCLUDED.amount,
          raw_data = EXCLUDED.raw_data,
          synced_at = NOW()
        RETURNING (xmax = 0) AS is_insert`,
        [
          row.account_id, row.marketplace_id, null, null,
          row.event_type, row.fee_type, row.amount, row.currency,
          row.event_date, row.posted_date, JSON.stringify(row.raw_data),
        ]
      );
      return result.rows[0]?.is_insert ? 'inserted' : 'updated';
    }
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
