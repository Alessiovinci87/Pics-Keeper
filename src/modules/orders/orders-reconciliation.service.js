const axios = require('axios');
const db = require('../../database/pool');
const logger = require('../../utils/logger');
const { sleep } = require('../../utils/helpers');
const SpApiClient = require('../../services/sp-api.client');
const SyncLogger = require('../../services/sync-logger');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
dayjs.extend(utc);

/**
 * Orders Reconciliation Service.
 *
 * Uses the SP-API Reports API (GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL)
 * to download a complete list of orders for a date range, then inserts any orders
 * missing from orders_raw.
 *
 * This is purely ADDITIVE — it never modifies or deletes existing records.
 */
const OrdersReconciliationService = {
  REPORT_TYPE: 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL',
  POLL_INTERVAL_MS: 15000,
  MAX_POLL_ATTEMPTS: 40, // ~10 minutes max

  /**
   * Run reconciliation for a single account+marketplace target.
   * @param {Object} target - from AccountService.getActiveSyncTargets()
   * @param {Object} options
   * @param {string} options.dateFrom - YYYY-MM-DD
   * @param {string} options.dateTo   - YYYY-MM-DD
   */
  async reconcile(target, { dateFrom, dateTo }) {
    const syncLog = await SyncLogger.start(target.account_id, target.account_marketplace_id, 'orders-reconciliation');

    try {
      logger.info('Orders reconciliation starting', {
        marketplace: target.country_code,
        dateFrom,
        dateTo,
      });

      const spApi = new SpApiClient(target);

      // 1. Request report
      const reportId = await this.requestReport(spApi, target, dateFrom, dateTo);

      // 2. Poll until ready
      const reportDocumentId = await this.waitForReport(spApi, reportId);

      // 3. Download & parse the TSV
      const reportRows = await this.downloadReport(spApi, reportDocumentId);

      logger.info('Report downloaded', {
        marketplace: target.country_code,
        totalRows: reportRows.length,
      });

      // 4. Reconcile — insert missing orders
      const { inserted, skipped, errors } = await this.insertMissing(target, reportRows);

      await SyncLogger.complete(syncLog.id, { processed: reportRows.length, inserted, updated: 0 });

      logger.info('Orders reconciliation completed', {
        marketplace: target.country_code,
        reportRows: reportRows.length,
        inserted,
        skipped,
        errors,
      });

      return { reportRows: reportRows.length, inserted, skipped, errors };
    } catch (err) {
      await SyncLogger.fail(syncLog.id, err.message);
      logger.error('Orders reconciliation failed', {
        marketplace: target.country_code,
        error: err.message,
      });
      throw err;
    }
  },

  /**
   * Step 1: Request the report from Amazon.
   */
  async requestReport(spApi, target, dateFrom, dateTo) {
    const result = await spApi.createReport({
      reportType: this.REPORT_TYPE,
      marketplaceIds: [target.amazon_marketplace_id],
      dataStartTime: dayjs.utc(dateFrom).startOf('day').toISOString(),
      dataEndTime: dayjs.utc(dateTo).endOf('day').toISOString(),
    });

    const reportId = result.reportId;
    logger.info('Report requested', { reportId, marketplace: target.country_code });
    return reportId;
  },

  /**
   * Step 2: Poll until the report is DONE (or FATAL/CANCELLED).
   */
  async waitForReport(spApi, reportId) {
    for (let attempt = 1; attempt <= this.MAX_POLL_ATTEMPTS; attempt++) {
      await sleep(this.POLL_INTERVAL_MS);

      const report = await spApi.getReport(reportId);
      const status = report.processingStatus;

      logger.info('Report poll', { reportId, status, attempt });

      if (status === 'DONE') {
        return report.reportDocumentId;
      }

      if (status === 'FATAL' || status === 'CANCELLED') {
        throw new Error(`Report ${reportId} failed with status: ${status}`);
      }

      // IN_QUEUE or IN_PROGRESS — keep polling
    }

    throw new Error(`Report ${reportId} timed out after ${this.MAX_POLL_ATTEMPTS} poll attempts`);
  },

  /**
   * Step 3: Download the report document and parse TSV.
   */
  async downloadReport(spApi, reportDocumentId) {
    const doc = await spApi.getReportDocument(reportDocumentId);
    const url = doc.url;

    const response = await axios.get(url, { responseType: 'text' });
    const tsv = response.data;

    return this.parseTsv(tsv);
  },

  /**
   * Parse a TSV string into an array of objects (header row → keys).
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
   * Step 4: Compare report rows with orders_raw and insert any missing orders.
   * Only inserts — never updates or deletes existing records.
   */
  async insertMissing(target, reportRows) {
    let inserted = 0;
    let skipped = 0;
    let errors = 0;

    for (const row of reportRows) {
      const amazonOrderId = row['amazon-order-id'];
      const asin = row['asin'];

      if (!amazonOrderId || !asin) {
        skipped++;
        continue;
      }

      try {
        // Check if this order+asin already exists
        const exists = await db.query(
          `SELECT 1 FROM orders_raw
           WHERE account_id = $1 AND amazon_order_id = $2 AND asin = $3
           LIMIT 1`,
          [target.account_id, amazonOrderId, asin]
        );

        if (exists.rows.length > 0) {
          skipped++;
          continue;
        }

        // Insert the missing order
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

        await db.query(
          `INSERT INTO orders_raw (
            account_id, marketplace_id, amazon_order_id, asin, sku,
            quantity, item_price, item_tax, shipping_price, shipping_tax,
            promotion_discount, order_status, purchase_date, currency, raw_data
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
          ON CONFLICT (account_id, amazon_order_id, asin) DO NOTHING`,
          [
            target.account_id,
            target.account_marketplace_id,
            amazonOrderId,
            asin,
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

        inserted++;

        // Ensure ASIN exists
        await db.query(
          `INSERT INTO asins (account_id, asin, sku, title)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (account_id, asin) DO NOTHING`,
          [target.account_id, asin, sku, row['product-name'] || null]
        );
      } catch (err) {
        errors++;
        logger.warn('Reconciliation: failed to insert order', {
          amazonOrderId,
          asin,
          error: err.message,
        });
      }
    }

    return { inserted, skipped, errors };
  },
};

module.exports = OrdersReconciliationService;
