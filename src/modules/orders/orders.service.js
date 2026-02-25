const db = require('../../database/pool');
const logger = require('../../utils/logger');
const { syncDateRange, sleep } = require('../../utils/helpers');
const SpApiClient = require('../../services/sp-api.client');
const SyncLogger = require('../../services/sync-logger');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
dayjs.extend(utc);

/**
 * Orders Sync Service - incrementally fetches orders from Amazon SP-API.
 * Idempotent: uses ON CONFLICT to prevent duplicates.
 *
 * Key fixes:
 * - Subtracts 3 minutes from "to" timestamp (SP-API requires CreatedBefore in the past)
 * - Rate limiting: 500ms delay between getOrderItems calls
 * - Adaptive backoff for 429 responses
 * - Only retries on 429, blocks retry on other 4xx errors
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

      // Subtract 3 minutes from "to" - SP-API requires CreatedBefore to be in the past
      const adjustedTo = dayjs.utc(to).subtract(3, 'minute').toISOString();

      logger.info('Starting orders sync', {
        accountId: target.account_id,
        marketplace: target.country_code,
        from,
        to: adjustedTo,
      });

      const spApi = new SpApiClient(target);
      let nextToken = null;

      do {
        const response = await spApi.getOrders({
          MarketplaceIds: [target.amazon_marketplace_id],
          CreatedAfter: from,
          CreatedBefore: adjustedTo,
          NextToken: nextToken,
        });

        const orders = response.Orders || [];

        for (const order of orders) {
          try {
            const items = await spApi.getOrderItems(order.AmazonOrderId);

            for (const item of items) {
              processed++;
              const result = await this.upsertOrderItem(target, order, item);
              if (result === 'inserted') inserted++;

              // Upsert ASIN if new
              await this.ensureAsin(target.account_id, item.ASIN, item.SellerSKU, item.Title);
            }

            // Rate limiting: 500ms delay between getOrderItems calls
            await sleep(500);
          } catch (itemErr) {
            // Log and continue with next order if single order fails
            logger.error('Failed to get order items', {
              orderId: order.AmazonOrderId,
              error: itemErr.message,
              status: itemErr.response?.status,
            });

            // Only retry on 429; skip other 4xx errors
            if (itemErr.response?.status === 429) {
              const retryAfter = parseInt(itemErr.response.headers?.['retry-after'] || '5', 10);
              logger.warn('Rate limited on getOrderItems, backing off', { retryAfter });
              await sleep(retryAfter * 1000);
              // Retry this order once
              try {
                const retryItems = await spApi.getOrderItems(order.AmazonOrderId);
                for (const item of retryItems) {
                  processed++;
                  const result = await this.upsertOrderItem(target, order, item);
                  if (result === 'inserted') inserted++;
                  await this.ensureAsin(target.account_id, item.ASIN, item.SellerSKU, item.Title);
                }
              } catch (retryErr) {
                logger.error('Retry failed for order items', {
                  orderId: order.AmazonOrderId,
                  error: retryErr.message,
                });
              }
            } else if (itemErr.response?.status >= 400 && itemErr.response?.status < 500) {
              // Skip 4xx errors (except 429) - don't retry
              logger.warn('Skipping order due to client error', {
                orderId: order.AmazonOrderId,
                status: itemErr.response.status,
              });
            }
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
   * Extracts proceeds from both legacy and v2026 API formats.
   */
  async upsertOrderItem(target, order, item) {
    // Support both legacy format and v2026 (item.proceeds.breakdowns)
    let itemPrice = 0;
    let itemTax = 0;
    let shippingPrice = 0;
    let shippingTax = 0;
    let promotionDiscount = 0;

    if (item.proceeds && item.proceeds.breakdowns) {
      // v2026 format: item.proceeds.breakdowns[].type / .subtotal.amount
      for (const bd of item.proceeds.breakdowns) {
        const amount = parseFloat(bd.subtotal?.amount || 0);
        switch (bd.type) {
          case 'PRODUCT':
            itemPrice = amount;
            break;
          case 'PRODUCT_TAX':
            itemTax = amount;
            break;
          case 'SHIPPING':
            shippingPrice = amount;
            break;
          case 'SHIPPING_TAX':
            shippingTax = amount;
            break;
          case 'PROMOTION':
            promotionDiscount = Math.abs(amount);
            break;
        }
      }
    } else {
      // Legacy format
      itemPrice = this.extractAmount(item.ItemPrice);
      itemTax = this.extractAmount(item.ItemTax);
      shippingPrice = this.extractAmount(item.ShippingPrice);
      shippingTax = this.extractAmount(item.ShippingTax);
      promotionDiscount = this.extractAmount(item.PromotionDiscount);
    }

    const result = await db.query(
      `INSERT INTO orders_raw (
        account_id, marketplace_id, amazon_order_id, asin, sku,
        quantity, item_price, item_tax, shipping_price, shipping_tax,
        promotion_discount, order_status, purchase_date, currency, raw_data
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      ON CONFLICT (account_id, amazon_order_id, asin) DO UPDATE SET
        quantity = EXCLUDED.quantity,
        item_price = EXCLUDED.item_price,
        item_tax = EXCLUDED.item_tax,
        shipping_price = EXCLUDED.shipping_price,
        shipping_tax = EXCLUDED.shipping_tax,
        promotion_discount = EXCLUDED.promotion_discount,
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
        itemPrice,
        itemTax,
        shippingPrice,
        shippingTax,
        promotionDiscount,
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
        p.marketplace_facilitator_tax,
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
