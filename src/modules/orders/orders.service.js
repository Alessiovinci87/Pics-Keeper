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
 * Uses Orders API v2026-01-01 (searchOrders) which returns items + proceeds inline.
 * Idempotent: uses ON CONFLICT to prevent duplicates.
 */
const OrdersService = {
  /**
   * Sync orders for a single account+marketplace.
   * @param {Object} target - account+marketplace target
   * @param {Object} [options]
   * @param {string} [options.dateFrom] - override start date (YYYY-MM-DD) for manual resync
   */
  async syncOrders(target, { dateFrom: overrideFrom, dateTo: overrideTo, force = false } = {}) {
    const syncLog = await SyncLogger.start(target.account_id, target.account_marketplace_id, 'orders');
    let processed = 0;
    let inserted = 0;

    try {
      // If overrideFrom provided (manual resync), use it directly; otherwise incremental
      let from, to;
      if (overrideFrom) {
        from = dayjs.utc(overrideFrom).startOf('day').toISOString();
        to = overrideTo ? dayjs.utc(overrideTo).endOf('day').toISOString() : dayjs.utc().toISOString();
      } else {
        ({ from, to } = syncDateRange(target.last_orders_sync_at, 30));
      }

      // SP-API requires createdBefore to be at least 2 minutes in the past
      // Cap 'to' at now-3min to prevent future dates (e.g. endOf('day') on today)
      const maxTo = dayjs.utc().subtract(3, 'minute');
      to = dayjs.utc(to).isAfter(maxTo) ? maxTo.toISOString() : dayjs.utc(to).toISOString();

      logger.info('Starting orders sync', {
        accountId: target.account_id,
        marketplace: target.country_code,
        from,
        to,
      });

      const spApi = new SpApiClient(target);
      let paginationToken = null;
      let totalOrders = 0;
      let skipped = 0;
      let page = 0;
      let errors = 0;

      do {
        page++;
        const response = await spApi.searchOrders({
          marketplaceIds: [target.amazon_marketplace_id],
          createdAfter: from,
          createdBefore: to,
          paginationToken,
        });

        const orders = response.orders || [];
        totalOrders += orders.length;

        for (const order of orders) {
          const orderId = order.orderId;
          const orderStatus = order.fulfillment?.fulfillmentStatus || 'UNKNOWN';

          // Skip orders already synced with same status (optimization)
          // --force bypasses this check to ensure all SP-API orders are re-processed
          if (!force) {
            const alreadySynced = await this.isOrderSynced(target.account_id, orderId, orderStatus);
            if (alreadySynced) {
              skipped++;
              continue;
            }
          }

          try {
            // v2026-01-01: items are embedded in the order response
            const items = order.orderItems || [];

            for (const item of items) {
              processed++;
              const result = await this.upsertOrderItem(target, order, item);
              if (result === 'inserted') inserted++;

              // Upsert ASIN if new
              await this.ensureAsin(
                target.account_id,
                item.product?.asin,
                item.product?.sellerSku,
                item.product?.title
              );
            }
          } catch (itemErr) {
            errors++;
            logger.warn(`Orders sync ${target.country_code}: failed to process items for ${orderId}`, {
              error: itemErr.message,
              orderId,
              errors,
            });
          }
        }

        paginationToken = response.pagination?.nextToken || null;

        // Progress logging every page
        logger.info(`Orders sync ${target.country_code}: page ${page}, ${totalOrders} orders seen, ${skipped} skipped, ${processed} processed, ${errors} errors`);

        // Throttle between pages to avoid burning SP-API rate-limit tokens
        if (paginationToken) {
          await sleep(2000);
        }
      } while (paginationToken);

      // Backfill images for ASINs missing image_url (IT only)
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
   * If status changed (e.g., Pending -> Shipped), we re-process items.
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
   * Adapted for Orders API v2026-01-01 response format.
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
        order.orderId,
        item.product?.asin,
        item.product?.sellerSku || null,
        item.quantityOrdered || 1,
        this.extractProceeds(item, 'ITEM'),
        this.extractTaxDetail(item, 'ITEM'),
        this.extractProceeds(item, 'SHIPPING'),
        this.extractTaxDetail(item, 'SHIPPING'),
        this.extractProceeds(item, 'DISCOUNT'),
        order.fulfillment?.fulfillmentStatus || 'UNKNOWN',
        order.createdTime,
        order.proceeds?.grandTotal?.currencyCode || target.currency,
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
         updated_at = NOW()`,
      [accountId, asin, sku || null, title || null]
    );
  },

  /**
   * Extract proceeds amount from item breakdowns by type (ITEM, SHIPPING, DISCOUNT, etc.).
   * v2026-01-01 format: item.proceeds.breakdowns[].type / .subtotal.amount
   */
  extractProceeds(item, type) {
    const breakdowns = item.proceeds?.breakdowns || [];
    const breakdown = breakdowns.find((b) => b.type === type);
    return breakdown?.subtotal ? parseFloat(breakdown.subtotal.amount || 0) : 0;
  },

  /**
   * Extract detailed tax amount from item breakdowns by subtype (ITEM, SHIPPING, etc.).
   * v2026-01-01 format: TAX breakdown -> detailedBreakdowns[].subtype / .value.amount
   */
  extractTaxDetail(item, subtype) {
    const breakdowns = item.proceeds?.breakdowns || [];
    const taxBreakdown = breakdowns.find((b) => b.type === 'TAX');
    if (!taxBreakdown?.detailedBreakdowns) {
      // If no detailed breakdowns, return total tax for ITEM subtype, 0 otherwise
      if (subtype === 'ITEM' && taxBreakdown?.subtotal) {
        return parseFloat(taxBreakdown.subtotal.amount || 0);
      }
      return 0;
    }
    const detail = taxBreakdown.detailedBreakdowns.find((d) => d.subtype === subtype);
    return detail?.value ? parseFloat(detail.value.amount || 0) : 0;
  },

  /**
   * Backfill product images and titles for ASINs missing image_url.
   * Only runs during IT marketplace sync to ensure Italian language titles.
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
