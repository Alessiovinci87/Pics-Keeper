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
 * Uses Orders API v0 (getOrders + getOrderItems).
 * Idempotent: uses ON CONFLICT to prevent duplicates.
 */
const OrdersService = {
  /**
   * Sync orders for a single account+marketplace.
   */
  async syncOrders(target, { dateFrom: overrideFrom, dateTo: overrideTo, force = false } = {}) {
    const syncLog = await SyncLogger.start(target.account_id, target.account_marketplace_id, 'orders');
    let processed = 0;
    let inserted = 0;

    try {
      let from, to;
      if (overrideFrom) {
        from = dayjs.utc(overrideFrom).startOf('day').toISOString();
        to = overrideTo ? dayjs.utc(overrideTo).endOf('day').toISOString() : dayjs.utc().toISOString();
      } else {
        ({ from, to } = syncDateRange(target.last_orders_sync_at, 30));
      }

      // SP-API requires CreatedBefore to be at least 2 minutes in the past
      const maxTo = dayjs.utc().subtract(3, 'minute');
      to = dayjs.utc(to).isAfter(maxTo) ? maxTo.toISOString() : dayjs.utc(to).toISOString();

      logger.info('Starting orders sync (v0 API)', {
        accountId: target.account_id,
        marketplace: target.country_code,
        from,
        to,
      });

      const spApi = new SpApiClient(target);
      let nextToken = null;
      let totalOrders = 0;
      let skipped = 0;
      let page = 0;
      let errors = 0;

      do {
        page++;
        const response = await spApi.getOrders({
          MarketplaceIds: [target.amazon_marketplace_id],
          CreatedAfter: from,
          CreatedBefore: to,
          NextToken: nextToken,
        });

        const orders = response.Orders || [];
        totalOrders += orders.length;

        for (const order of orders) {
          const orderId = order.AmazonOrderId;
          const orderStatus = order.OrderStatus || 'UNKNOWN';

          // Skip if already synced with same status (unless --force)
          if (!force) {
            const alreadySynced = await this.isOrderSynced(target.account_id, orderId, orderStatus);
            if (alreadySynced) {
              skipped++;
              continue;
            }
          }

          try {
            // v0: fetch items separately for each order
            const items = await spApi.getOrderItems(orderId);

            for (const item of items) {
              processed++;
              const result = await this.upsertOrderItem(target, order, item);
              if (result === 'inserted') inserted++;

              await this.ensureAsin(
                target.account_id,
                item.ASIN,
                item.SellerSKU,
                item.Title
              );
            }

            // Throttle between getOrderItems calls
            await sleep(500);
          } catch (itemErr) {
            errors++;
            logger.warn(`Orders sync ${target.country_code}: failed to process items for ${orderId}`, {
              error: itemErr.message,
              orderId,
              errors,
            });
          }
        }

        nextToken = response.NextToken || null;

        logger.info(`Orders sync ${target.country_code}: page ${page}, ${totalOrders} orders seen, ${skipped} skipped, ${processed} processed, ${errors} errors`);

        if (nextToken) {
          await sleep(2000);
        }
      } while (nextToken);

      // Backfill images for ASINs missing image_url
      await this.backfillImages(target, spApi).catch((err) => {
        logger.warn('Image backfill failed (non-critical)', { error: err.message });
      });

      await SyncLogger.complete(syncLog.id, { processed, inserted, updated: 0, errors, totalOrders, skipped });

      logger.info('Orders sync completed', {
        accountId: target.account_id,
        marketplace: target.country_code,
        totalOrders,
        processed,
        inserted,
        skipped,
        errors,
      });

      return { processed, inserted, errors, totalOrders, skipped };
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
   * Check if an order is already synced with the same status.
   */
  async isOrderSynced(accountId, amazonOrderId, currentStatus) {
    const result = await db.query(
      `SELECT order_status FROM orders_raw
       WHERE account_id = $1 AND amazon_order_id = $2
       LIMIT 1`,
      [accountId, amazonOrderId]
    );
    return result.rows.length > 0 && result.rows[0].order_status === currentStatus;
  },

  /**
   * Upsert a single order item (idempotent via ON CONFLICT).
   * Uses Orders API v0 response format.
   */
  async upsertOrderItem(target, order, item) {
    const result = await db.query(
      `INSERT INTO orders_raw (
        account_id, marketplace_id, amazon_order_id, asin, sku,
        quantity, item_price, item_tax, shipping_price, shipping_tax,
        promotion_discount, order_status, purchase_date, currency, raw_data
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      ON CONFLICT (account_id, amazon_order_id, asin) DO UPDATE SET
        marketplace_id = EXCLUDED.marketplace_id,
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
        this.extractAmount(item.ItemPrice),
        this.extractAmount(item.ItemTax),
        this.extractAmount(item.ShippingPrice),
        this.extractAmount(item.ShippingTax),
        this.extractAmount(item.PromotionDiscount),
        order.OrderStatus || 'UNKNOWN',
        order.PurchaseDate,
        item.ItemPrice?.CurrencyCode || order.Currency || target.currency,
        JSON.stringify({ order, item }),
      ]
    );

    return result.rows[0]?.is_insert ? 'inserted' : 'updated';
  },

  /**
   * Extract amount from SP-API v0 Money object { CurrencyCode, Amount }.
   */
  extractAmount(money) {
    if (!money || !money.Amount) return 0;
    return parseFloat(money.Amount) || 0;
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
         updated_at = NOW()`,
      [accountId, asin, sku || null, title || null]
    );
  },

  /**
   * Backfill product images and titles for ASINs missing image_url.
   */
  async backfillImages(target, spApi) {
    if (target.country_code !== 'IT') return;

    const toUpdate = await db.query(
      `SELECT asin FROM asins
       WHERE account_id = $1
       ORDER BY
         CASE WHEN image_url IS NULL OR title IS NULL THEN 0 ELSE 1 END,
         updated_at ASC
       LIMIT 20`,
      [target.account_id]
    );

    if (toUpdate.rows.length === 0) return;

    logger.info('Backfilling product images and IT titles', {
      accountId: target.account_id,
      count: toUpdate.rows.length,
    });

    for (const row of toUpdate.rows) {
      try {
        const catalog = await spApi.getCatalogItem(row.asin, target.amazon_marketplace_id);

        let imageUrl = null;
        const images = catalog?.images;
        if (images && images.length > 0) {
          const mainImage = images[0]?.images?.find((img) => img.variant === 'MAIN');
          imageUrl = mainImage?.link || images[0]?.images?.[0]?.link || null;
        }

        let title = null;
        const summaries = catalog?.summaries;
        if (summaries && summaries.length > 0) {
          title = summaries[0]?.itemName || null;
        }

        if (imageUrl || title) {
          await db.query(
            `UPDATE asins SET
              image_url = COALESCE($1, image_url),
              title = COALESCE($2, title),
              updated_at = NOW()
            WHERE account_id = $3 AND asin = $4`,
            [imageUrl, title, target.account_id, row.asin]
          );
        }
      } catch (err) {
        logger.warn('Failed to fetch catalog item image', {
          asin: row.asin,
          error: err.message,
        });
      }
    }
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
