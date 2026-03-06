const axios = require('axios');
const db = require('../../database/pool');
const logger = require('../../utils/logger');
const { syncDateRange, sleep } = require('../../utils/helpers');
const SpApiClient = require('../../services/sp-api.client');
const SyncLogger = require('../../services/sync-logger');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
dayjs.extend(utc);

/**
 * Orders Sync Service - fetches orders via SP-API Reports API.
 * Uses GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL report
 * (no Orders API endpoint needed — works with Reports role only).
 * Idempotent: uses ON CONFLICT to prevent duplicates.
 */
const OrdersService = {
  REPORT_TYPE: 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL',
  POLL_INTERVAL_MS: 15000,
  MAX_POLL_ATTEMPTS: 40, // ~10 minutes max

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
        from = dayjs.utc(overrideFrom).startOf('day').format('YYYY-MM-DD');
        to = overrideTo ? dayjs.utc(overrideTo).endOf('day').format('YYYY-MM-DD') : dayjs.utc().format('YYYY-MM-DD');
      } else {
        const range = syncDateRange(target.last_orders_sync_at, 30);
        from = dayjs.utc(range.from).format('YYYY-MM-DD');
        to = dayjs.utc(range.to).format('YYYY-MM-DD');
      }

      logger.info('Starting orders sync (Reports API)', {
        accountId: target.account_id,
        marketplace: target.country_code,
        from,
        to,
      });

      const spApi = new SpApiClient(target);

      // 1. Request report
      const reportResult = await spApi.createReport({
        reportType: this.REPORT_TYPE,
        marketplaceIds: [target.amazon_marketplace_id],
        dataStartTime: dayjs.utc(from).startOf('day').toISOString(),
        dataEndTime: dayjs.utc(to).endOf('day').toISOString(),
      });

      const reportId = reportResult.reportId;
      logger.info('Orders report requested', { reportId, marketplace: target.country_code });

      // 2. Poll until ready
      let reportDocumentId = null;
      for (let attempt = 1; attempt <= this.MAX_POLL_ATTEMPTS; attempt++) {
        await sleep(this.POLL_INTERVAL_MS);

        const report = await spApi.getReport(reportId);
        const status = report.processingStatus;

        logger.info('Orders report poll', { reportId, status, attempt });

        if (status === 'DONE') {
          reportDocumentId = report.reportDocumentId;
          break;
        }

        if (status === 'FATAL' || status === 'CANCELLED') {
          throw new Error(`Report ${reportId} failed with status: ${status}`);
        }
      }

      if (!reportDocumentId) {
        throw new Error(`Report ${reportId} timed out after ${this.MAX_POLL_ATTEMPTS} poll attempts`);
      }

      // 3. Download & parse TSV
      const doc = await spApi.getReportDocument(reportDocumentId);
      const response = await axios.get(doc.url, { responseType: 'text' });
      const reportRows = this.parseTsv(response.data);

      logger.info('Orders report downloaded', {
        marketplace: target.country_code,
        totalRows: reportRows.length,
      });

      // 4. Upsert orders
      let skipped = 0;
      let errors = 0;

      for (const row of reportRows) {
        const amazonOrderId = row['amazon-order-id'];
        const asin = row['asin'];

        if (!amazonOrderId || !asin) {
          skipped++;
          continue;
        }

        const orderStatus = row['order-status'] || 'UNKNOWN';

        // Skip if already synced with same status (unless force)
        if (!force) {
          const alreadySynced = await this.isOrderSynced(target.account_id, amazonOrderId, orderStatus);
          if (alreadySynced) {
            skipped++;
            continue;
          }
        }

        try {
          processed++;
          const result = await this.upsertOrderRow(target, row);
          if (result === 'inserted') inserted++;

          await this.ensureAsin(
            target.account_id,
            asin,
            row['sku'] || null,
            row['product-name'] || null
          );
        } catch (err) {
          errors++;
          logger.warn('Orders sync: failed to upsert order', {
            amazonOrderId,
            asin,
            error: err.message,
          });
        }
      }

      // Backfill images for ASINs missing image_url
      await this.backfillImages(target, spApi).catch((err) => {
        logger.warn('Image backfill failed (non-critical)', { error: err.message });
      });

      await SyncLogger.complete(syncLog.id, { processed, inserted, updated: 0, errors, totalOrders: reportRows.length, skipped });

      logger.info('Orders sync completed', {
        accountId: target.account_id,
        marketplace: target.country_code,
        totalOrders: reportRows.length,
        processed,
        inserted,
        skipped,
        errors,
      });

      return { processed, inserted, errors, totalOrders: reportRows.length, skipped };
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
   * Parse TSV report into array of objects.
   */
  parseTsv(tsv) {
    const lines = tsv.split('\n').filter((line) => line.trim().length > 0);
    if (lines.length < 2) return [];

    const headers = lines[0].split('\t').map((h) => h.trim());
    const rows = [];

    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split('\t');
      const row = {};
      for (let j = 0; j < headers.length; j++) {
        row[headers[j]] = (values[j] || '').trim();
      }
      rows.push(row);
    }

    return rows;
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
   * Upsert a single order from a report TSV row.
   */
  async upsertOrderRow(target, row) {
    const quantity = parseInt(row['quantity'] || '1', 10) || 1;
    const itemPrice = parseFloat(row['item-price'] || '0') || 0;
    const itemTax = parseFloat(row['item-tax'] || '0') || 0;
    const shippingPrice = parseFloat(row['shipping-price'] || '0') || 0;
    const shippingTax = parseFloat(row['shipping-tax'] || '0') || 0;
    const promotionDiscount = parseFloat(row['item-promotion-discount'] || '0') || 0;
    const orderStatus = row['order-status'] || 'UNKNOWN';
    const purchaseDate = row['purchase-date'];
    const currency = row['currency'] || target.currency;
    const sku = row['sku'] || null;

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
        row['amazon-order-id'],
        row['asin'],
        sku,
        quantity,
        itemPrice,
        itemTax,
        shippingPrice,
        shippingTax,
        promotionDiscount,
        orderStatus,
        purchaseDate,
        currency,
        JSON.stringify({ source: 'reports-api', report_row: row }),
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
