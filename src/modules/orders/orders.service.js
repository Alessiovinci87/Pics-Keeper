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
   * Sync orders for a single account+marketplace.
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
          const items = await spApi.getOrderItems(order.AmazonOrderId);

          for (const item of items) {
            processed++;
            const result = await this.upsertOrderItem(target, order, item);
            if (result === 'inserted') inserted++;

            // Upsert ASIN if new
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
