const db = require('../../database/pool');
const logger = require('../../utils/logger');
const { syncDateRange } = require('../../utils/helpers');
const SpApiClient = require('../../services/sp-api.client');
const SyncLogger = require('../../services/sync-logger');

/**
 * Orders Sync Service - incrementally fetches orders from Amazon SP-API.
 * Idempotent: uses ON CONFLICT to prevent duplicates.
 */
const OrdersService = {
  /**
   * Build a map of Amazon marketplace ID -> internal DB marketplace_id.
   */
  async getMarketplaceMap() {
    const result = await db.query(
      `SELECT id, marketplace_id AS amazon_marketplace_id, currency FROM marketplaces`
    );
    const map = {};
    for (const row of result.rows) {
      map[row.amazon_marketplace_id] = { id: row.id, currency: row.currency };
    }
    return map;
  },

  /**
   * Sync orders for ALL marketplaces of an account in a single API call per region.
   * Groups targets by region (EU/NA) and fetches all marketplace orders at once.
   */
  async syncAllOrders(targets) {
    if (!targets.length) return;

    const accountId = targets[0].account_id;
    const marketplaceMap = await this.getMarketplaceMap();

    // Group targets by region
    const byRegion = {};
    for (const t of targets) {
      if (!byRegion[t.region]) byRegion[t.region] = [];
      byRegion[t.region].push(t);
    }

    for (const [region, regionTargets] of Object.entries(byRegion)) {
      const allMarketplaceIds = regionTargets.map((t) => t.amazon_marketplace_id);

      // Use the oldest last_orders_sync_at to ensure we capture all orders
      const oldestSync = regionTargets.reduce((oldest, t) => {
        if (!t.last_orders_sync_at) return null; // null means never synced -> go back maxDaysBack
        if (oldest === null) return null;
        return t.last_orders_sync_at < oldest ? t.last_orders_sync_at : oldest;
      }, regionTargets[0].last_orders_sync_at);

      const { from, to } = syncDateRange(oldestSync, 30);
      const syncLog = await SyncLogger.start(accountId, null, 'orders');
      let processed = 0;
      let inserted = 0;

      logger.info('Starting unified orders sync', {
        accountId,
        region,
        marketplaces: regionTargets.map((t) => t.country_code).join(','),
        from,
        to,
      });

      try {
        // Use any target from this region for API auth (same account, same credentials)
        const spApi = new SpApiClient(regionTargets[0]);
        let nextToken = null;

        do {
          const response = await spApi.getOrders({
            MarketplaceIds: allMarketplaceIds,
            CreatedAfter: from,
            CreatedBefore: to,
            NextToken: nextToken,
          });

          const orders = response.Orders || [];

          for (const order of orders) {
            // Resolve the correct internal marketplace_id from the order
            const orderMpId = order.MarketplaceId;
            const mpInfo = orderMpId ? marketplaceMap[orderMpId] : null;

            // Fallback: match by SalesChannel (e.g. "Amazon.it")
            let resolvedMpId = mpInfo?.id;
            let resolvedCurrency = mpInfo?.currency;
            if (!resolvedMpId && order.SalesChannel) {
              const channelTarget = regionTargets.find(
                (t) => order.SalesChannel.toLowerCase().includes(t.country_code.toLowerCase())
              );
              if (channelTarget) {
                resolvedMpId = channelTarget.account_marketplace_id;
                resolvedCurrency = channelTarget.currency;
              }
            }

            // Final fallback: use first target's marketplace
            if (!resolvedMpId) {
              resolvedMpId = regionTargets[0].account_marketplace_id;
              resolvedCurrency = regionTargets[0].currency;
            }

            let items;
            try {
              items = await spApi.getOrderItems(order.AmazonOrderId);
            } catch (itemErr) {
              logger.warn('getOrderItems failed, skipping order', {
                orderId: order.AmazonOrderId,
                error: itemErr.message,
              });
              continue;
            }

            for (const item of items) {
              processed++;
              const result = await this.upsertOrderItemUnified(
                accountId, resolvedMpId, order, item, resolvedCurrency
              );
              if (result === 'inserted') inserted++;
              await this.ensureAsin(accountId, item.ASIN, item.SellerSKU, item.Title);
            }
          }

          nextToken = response.NextToken || null;
        } while (nextToken);

        await SyncLogger.complete(syncLog.id, { processed, inserted, updated: 0 });

        logger.info('Unified orders sync completed', {
          accountId,
          region,
          processed,
          inserted,
        });
      } catch (err) {
        await SyncLogger.fail(syncLog.id, err.message);
        logger.error('Unified orders sync failed', {
          accountId,
          region,
          error: err.message,
        });
        throw err;
      }
    }
  },

  /**
   * Sync orders for a single account+marketplace (legacy, kept for backward compat).
   */
  async syncOrders(target) {
    const syncLog = await SyncLogger.start(target.account_id, target.account_marketplace_id, 'orders');
    let processed = 0;
    let inserted = 0;

    try {
      const { from, to } = syncDateRange(target.last_orders_sync_at, 30);

      logger.info('Starting orders sync', {
        accountId: target.account_id,
        marketplace: target.country_code,
        from,
        to,
      });

      const spApi = new SpApiClient(target);
      let nextToken = null;

      do {
        const response = await spApi.getOrders({
          MarketplaceIds: [target.amazon_marketplace_id],
          CreatedAfter: from,
          CreatedBefore: to,
          NextToken: nextToken,
        });

        const orders = response.Orders || [];

        for (const order of orders) {
          let items;
          try {
            items = await spApi.getOrderItems(order.AmazonOrderId);
          } catch (itemErr) {
            logger.warn('getOrderItems failed, skipping order', {
              orderId: order.AmazonOrderId,
              error: itemErr.message,
            });
            continue;
          }

          for (const item of items) {
            processed++;
            const result = await this.upsertOrderItem(target, order, item);
            if (result === 'inserted') inserted++;
            await this.ensureAsin(target.account_id, item.ASIN, item.SellerSKU, item.Title);
          }
        }

        nextToken = response.NextToken || null;
      } while (nextToken);

      await SyncLogger.complete(syncLog.id, { processed, inserted, updated: 0 });

      logger.info('Orders sync completed', {
        accountId: target.account_id,
        marketplace: target.country_code,
        processed,
        inserted,
      });

      return { processed, inserted };
    } catch (err) {
      await SyncLogger.fail(syncLog.id, err.message);
      logger.error('Orders sync failed', {
        accountId: target.account_id,
        marketplace: target.country_code,
        error: err.message,
      });
      throw err;
    }
  },

  /**
   * Upsert order item with resolved marketplace (for unified sync).
   */
  async upsertOrderItemUnified(accountId, marketplaceId, order, item, currency) {
    const result = await db.query(
      `INSERT INTO orders_raw (
        account_id, marketplace_id, amazon_order_id, asin, sku,
        quantity, item_price, item_tax, shipping_price, shipping_tax,
        promotion_discount, order_status, purchase_date, currency, raw_data
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      ON CONFLICT (account_id, amazon_order_id, asin) DO UPDATE SET
        marketplace_id = EXCLUDED.marketplace_id,
        quantity = EXCLUDED.quantity,
        item_price = CASE WHEN EXCLUDED.item_price > 0 THEN EXCLUDED.item_price ELSE orders_raw.item_price END,
        item_tax = CASE WHEN EXCLUDED.item_tax > 0 THEN EXCLUDED.item_tax ELSE orders_raw.item_tax END,
        shipping_price = CASE WHEN EXCLUDED.shipping_price > 0 THEN EXCLUDED.shipping_price ELSE orders_raw.shipping_price END,
        shipping_tax = CASE WHEN EXCLUDED.shipping_tax > 0 THEN EXCLUDED.shipping_tax ELSE orders_raw.shipping_tax END,
        promotion_discount = CASE WHEN EXCLUDED.promotion_discount > 0 THEN EXCLUDED.promotion_discount ELSE orders_raw.promotion_discount END,
        order_status = EXCLUDED.order_status,
        raw_data = EXCLUDED.raw_data,
        synced_at = NOW()
      RETURNING (xmax = 0) AS is_insert`,
      [
        accountId,
        marketplaceId,
        order.AmazonOrderId,
        item.ASIN,
        item.SellerSKU || null,
        item.QuantityOrdered || 1,
        this.extractAmount(item.ItemPrice),
        this.extractAmount(item.ItemTax),
        this.extractAmount(item.ShippingPrice),
        this.extractAmount(item.ShippingTax),
        this.extractAmount(item.PromotionDiscount),
        order.OrderStatus,
        order.PurchaseDate,
        order.OrderTotal?.CurrencyCode || currency,
        JSON.stringify({ order, item }),
      ]
    );

    return result.rows[0]?.is_insert ? 'inserted' : 'updated';
  },

  /**
   * Upsert a single order item (idempotent via ON CONFLICT).
   */
  async upsertOrderItem(target, order, item) {
    const result = await db.query(
      `INSERT INTO orders_raw (
        account_id, marketplace_id, amazon_order_id, asin, sku,
        quantity, item_price, item_tax, shipping_price, shipping_tax,
        promotion_discount, order_status, purchase_date, currency, raw_data
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      ON CONFLICT (account_id, amazon_order_id, asin) DO UPDATE SET
        quantity = EXCLUDED.quantity,
        item_price = CASE WHEN EXCLUDED.item_price > 0 THEN EXCLUDED.item_price ELSE orders_raw.item_price END,
        item_tax = CASE WHEN EXCLUDED.item_tax > 0 THEN EXCLUDED.item_tax ELSE orders_raw.item_tax END,
        shipping_price = CASE WHEN EXCLUDED.shipping_price > 0 THEN EXCLUDED.shipping_price ELSE orders_raw.shipping_price END,
        shipping_tax = CASE WHEN EXCLUDED.shipping_tax > 0 THEN EXCLUDED.shipping_tax ELSE orders_raw.shipping_tax END,
        promotion_discount = CASE WHEN EXCLUDED.promotion_discount > 0 THEN EXCLUDED.promotion_discount ELSE orders_raw.promotion_discount END,
        order_status = EXCLUDED.order_status,
        raw_data = EXCLUDED.raw_data,
        synced_at = NOW()
      RETURNING (xmax = 0) AS is_insert`,
      [
        target.account_id,
        target.account_marketplace_id,
        order.AmazonOrderId,
        item.ASIN,
        item.SellerSKU || null,
        item.QuantityOrdered || 1,
        this.extractAmount(item.ItemPrice),
        this.extractAmount(item.ItemTax),
        this.extractAmount(item.ShippingPrice),
        this.extractAmount(item.ShippingTax),
        this.extractAmount(item.PromotionDiscount),
        order.OrderStatus,
        order.PurchaseDate,
        order.OrderTotal?.CurrencyCode || target.currency,
        JSON.stringify({ order, item }),
      ]
    );

    return result.rows[0]?.is_insert ? 'inserted' : 'updated';
  },

  /**
   * Ensure ASIN exists in the asins table.
   */
  async ensureAsin(accountId, asin, sku, title) {
    await db.query(
      `INSERT INTO asins (account_id, asin, sku, title)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (account_id, asin) DO UPDATE SET
         sku = COALESCE(EXCLUDED.sku, asins.sku),
         title = COALESCE(EXCLUDED.title, asins.title),
         updated_at = NOW()`,
      [accountId, asin, sku || null, title || null]
    );
  },

  /**
   * Extract numeric amount from Amazon Money object { CurrencyCode, Amount }.
   */
  extractAmount(moneyObj) {
    if (!moneyObj) return 0;
    return parseFloat(moneyObj.Amount || moneyObj.amount || 0);
  },

  /**
   * Get a single order with all its items and profit data.
   */
  async getOrderDetail(accountId, amazonOrderId) {
    const orderItems = await db.query(
      `SELECT
        o.*,
        p.revenue, p.referral_fee, p.fba_fee, p.other_amazon_fees,
        p.refund_amount, p.ads_allocated, p.product_cost, p.inbound_cost,
        p.customs_cost, p.prep_cost, p.packaging_cost, p.storage_allocated,
        p.total_costs, p.net_profit, p.margin_pct, p.roi_pct,
        m.country_code, m.name AS marketplace_name
      FROM orders_raw o
      LEFT JOIN order_profit p ON p.account_id = o.account_id
        AND p.amazon_order_id = o.amazon_order_id AND p.asin = o.asin
      LEFT JOIN marketplaces m ON m.id = o.marketplace_id
      WHERE o.account_id = $1 AND o.amazon_order_id = $2
      ORDER BY o.asin`,
      [accountId, amazonOrderId]
    );
    return orderItems.rows;
  },
};

module.exports = OrdersService;
