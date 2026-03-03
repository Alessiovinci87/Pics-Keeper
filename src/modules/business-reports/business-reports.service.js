const axios = require('axios');
const zlib = require('zlib');
const { promisify } = require('util');
const gunzip = promisify(zlib.gunzip);
const db = require('../../database/pool');
const logger = require('../../utils/logger');
const { sleep } = require('../../utils/helpers');
const SpApiClient = require('../../services/sp-api.client');
const SyncLogger = require('../../services/sync-logger');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
dayjs.extend(utc);

/**
 * Business Reports Sync Service.
 *
 * Uses GET_SALES_AND_TRAFFIC_REPORT to download ASIN-level daily metrics
 * (Units Ordered, Ordered Product Sales, Sessions, etc.).
 *
 * This is the same data source Shopkeeper uses for "Units Ordered".
 */
const BusinessReportsService = {
  REPORT_TYPE: 'GET_SALES_AND_TRAFFIC_REPORT',
  POLL_INTERVAL_MS: 15000,
  MAX_POLL_ATTEMPTS: 40,

  /**
   * Sync business report data for a single account+marketplace.
   * @param {Object} target - from AccountService.getActiveSyncTargets()
   * @param {Object} options
   * @param {string} [options.dateFrom] - YYYY-MM-DD
   * @param {string} [options.dateTo]   - YYYY-MM-DD (inclusive)
   */
  async sync(target, { dateFrom, dateTo } = {}) {
    const syncLog = await SyncLogger.start(target.account_id, target.account_marketplace_id, 'business-reports');

    try {
      const from = dateFrom || dayjs.utc().subtract(7, 'day').format('YYYY-MM-DD');
      const to = dateTo || dayjs.utc().format('YYYY-MM-DD');

      logger.info('Business reports sync starting', {
        marketplace: target.country_code,
        dateFrom: from,
        dateTo: to,
      });

      const spApi = new SpApiClient(target);

      // 1. Request report
      const reportId = await this.requestReport(spApi, target, from, to);

      // 2. Poll until ready
      const reportDocumentId = await this.waitForReport(spApi, reportId);

      // 3. Download & parse JSON
      const reportData = await this.downloadReport(spApi, reportDocumentId);

      // 4. Upsert into DB
      const { upserted, skipped, errors } = await this.upsertData(target, reportData);

      await SyncLogger.complete(syncLog.id, { processed: upserted + skipped, inserted: upserted, updated: 0 });

      logger.info('Business reports sync completed', {
        marketplace: target.country_code,
        upserted,
        skipped,
        errors,
      });

      return { upserted, skipped, errors };
    } catch (err) {
      await SyncLogger.fail(syncLog.id, err.message);
      logger.error('Business reports sync failed', {
        marketplace: target.country_code,
        error: err.message,
      });
      throw err;
    }
  },

  /**
   * Request the GET_SALES_AND_TRAFFIC_REPORT.
   */
  async requestReport(spApi, target, dateFrom, dateTo) {
    const result = await spApi.createReport({
      reportType: this.REPORT_TYPE,
      marketplaceIds: [target.amazon_marketplace_id],
      dataStartTime: dayjs.utc(dateFrom).startOf('day').toISOString(),
      dataEndTime: dayjs.utc(dateTo).endOf('day').toISOString(),
      reportOptions: {
        dateGranularity: 'DAY',
        asinGranularity: 'CHILD',
      },
    });

    const reportId = result.reportId;
    logger.info('Business report requested', { reportId, marketplace: target.country_code });
    return reportId;
  },

  /**
   * Poll until report is DONE.
   */
  async waitForReport(spApi, reportId) {
    for (let attempt = 1; attempt <= this.MAX_POLL_ATTEMPTS; attempt++) {
      await sleep(this.POLL_INTERVAL_MS);

      const report = await spApi.getReport(reportId);
      const status = report.processingStatus;

      logger.info('Business report poll', { reportId, status, attempt });

      if (status === 'DONE') {
        return report.reportDocumentId;
      }
      if (status === 'FATAL' || status === 'CANCELLED') {
        throw new Error(`Business report ${reportId} failed: ${status}`);
      }
    }
    throw new Error(`Business report ${reportId} timed out after ${this.MAX_POLL_ATTEMPTS} polls`);
  },

  /**
   * Download and parse the report (JSON format, possibly gzip-compressed).
   */
  async downloadReport(spApi, reportDocumentId) {
    const doc = await spApi.getReportDocument(reportDocumentId);
    const isGzipped = doc.compressionAlgorithm === 'GZIP';

    // Download as arraybuffer to handle gzip properly
    const response = await axios.get(doc.url, {
      responseType: isGzipped ? 'arraybuffer' : 'text',
    });

    let jsonStr;
    if (isGzipped) {
      const decompressed = await gunzip(Buffer.from(response.data));
      jsonStr = decompressed.toString('utf-8');
    } else {
      jsonStr = response.data;
    }

    try {
      const parsed = JSON.parse(jsonStr);
      // GET_SALES_AND_TRAFFIC_REPORT returns:
      // { salesAndTrafficByAsin: [ { date, childAsin, ... } ] }
      return parsed.salesAndTrafficByAsin || [];
    } catch (err) {
      logger.error('Failed to parse business report JSON', {
        error: err.message,
        preview: jsonStr.substring(0, 200),
      });
      throw new Error('Business report parse error: ' + err.message);
    }
  },

  /**
   * Upsert report rows into business_report_daily.
   */
  async upsertData(target, rows) {
    let upserted = 0;
    let skipped = 0;
    let errors = 0;

    for (const row of rows) {
      try {
        const date = row.date;
        const asin = row.childAsin || row.parentAsin;
        if (!date || !asin) {
          skipped++;
          continue;
        }

        const traffic = row.trafficByAsin || {};
        const sales = row.salesByAsin || {};

        await db.query(`
          INSERT INTO business_report_daily (
            account_id, marketplace_id, report_date, asin, sku,
            units_ordered, ordered_product_sales, ordered_product_sales_b2b,
            total_order_items,
            browser_sessions, mobile_app_sessions, sessions,
            browser_page_views, mobile_app_page_views, page_views,
            buy_box_percentage, unit_session_percentage,
            currency, synced_at
          ) VALUES (
            $1, $2, $3, $4, $5,
            $6, $7, $8,
            $9,
            $10, $11, $12,
            $13, $14, $15,
            $16, $17,
            $18, NOW()
          )
          ON CONFLICT (account_id, marketplace_id, report_date, asin)
          DO UPDATE SET
            units_ordered = EXCLUDED.units_ordered,
            ordered_product_sales = EXCLUDED.ordered_product_sales,
            ordered_product_sales_b2b = EXCLUDED.ordered_product_sales_b2b,
            total_order_items = EXCLUDED.total_order_items,
            browser_sessions = EXCLUDED.browser_sessions,
            mobile_app_sessions = EXCLUDED.mobile_app_sessions,
            sessions = EXCLUDED.sessions,
            browser_page_views = EXCLUDED.browser_page_views,
            mobile_app_page_views = EXCLUDED.mobile_app_page_views,
            page_views = EXCLUDED.page_views,
            buy_box_percentage = EXCLUDED.buy_box_percentage,
            unit_session_percentage = EXCLUDED.unit_session_percentage,
            synced_at = NOW()
        `, [
          target.account_id,
          target.account_marketplace_id,
          date,
          asin,
          row.sku || null,
          sales.unitsOrdered || 0,
          this.extractAmount(sales.orderedProductSales),
          this.extractAmount(sales.orderedProductSalesB2B),
          sales.totalOrderItems || 0,
          traffic.browserSessions || 0,
          traffic.mobileAppSessions || 0,
          traffic.sessions || 0,
          traffic.browserPageViews || 0,
          traffic.mobileAppPageViews || 0,
          traffic.pageViews || 0,
          traffic.buyBoxPercentage || 0,
          traffic.unitSessionPercentage || 0,
          target.currency || 'EUR',
        ]);

        upserted++;
      } catch (err) {
        errors++;
        logger.warn('Business report upsert failed', {
          date: row.date,
          asin: row.childAsin,
          error: err.message,
        });
      }
    }

    return { upserted, skipped, errors };
  },

  /**
   * Extract numeric amount from Amazon money object { amount, currencyCode }.
   */
  extractAmount(moneyObj) {
    if (!moneyObj) return 0;
    if (typeof moneyObj === 'number') return moneyObj;
    if (typeof moneyObj === 'object' && moneyObj.amount !== undefined) {
      return parseFloat(moneyObj.amount) || 0;
    }
    return parseFloat(moneyObj) || 0;
  },
};

module.exports = BusinessReportsService;
