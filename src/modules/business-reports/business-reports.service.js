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
   *
   * Amazon's salesAndTrafficByAsin does NOT include a date field —
   * it aggregates over the full report period.  To get per-day per-ASIN
   * data (matching Shopkeeper) we request one report per day.
   *
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

      // Build list of individual days
      const days = [];
      let cursor = dayjs.utc(from);
      const end = dayjs.utc(to);
      while (cursor.isBefore(end) || cursor.isSame(end, 'day')) {
        days.push(cursor.format('YYYY-MM-DD'));
        cursor = cursor.add(1, 'day');
      }

      logger.info('Business reports sync starting', {
        marketplace: target.country_code,
        dateFrom: from,
        dateTo: to,
        totalDays: days.length,
      });

      const spApi = new SpApiClient(target);
      let totalUpserted = 0;
      let totalSkipped = 0;
      let totalErrors = 0;

      for (const day of days) {
        try {
          // 1. Request single-day report
          const reportId = await this.requestReport(spApi, target, day, day);

          // 2. Poll until ready
          const reportDocumentId = await this.waitForReport(spApi, reportId);

          // 3. Download & parse JSON
          const reportData = await this.downloadReport(spApi, reportDocumentId);

          // 4. Upsert into DB with this day as report_date
          const { upserted, skipped, errors } = await this.upsertData(target, reportData, day);

          totalUpserted += upserted;
          totalSkipped += skipped;
          totalErrors += errors;

          logger.info('Business report day synced', {
            marketplace: target.country_code,
            day,
            upserted,
            skipped,
          });
        } catch (dayErr) {
          totalErrors++;
          logger.warn('Business report day failed', {
            marketplace: target.country_code,
            day,
            error: dayErr.message,
          });
        }
      }

      await SyncLogger.complete(syncLog.id, {
        processed: totalUpserted + totalSkipped,
        inserted: totalUpserted,
        updated: 0,
      });

      logger.info('Business reports sync completed', {
        marketplace: target.country_code,
        totalDays: days.length,
        upserted: totalUpserted,
        skipped: totalSkipped,
        errors: totalErrors,
      });

      return { upserted: totalUpserted, skipped: totalSkipped, errors: totalErrors };
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
      // salesAndTrafficByAsin contains per-ASIN aggregated data
      // (no date field — date comes from the single-day report request)
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
   * @param {Object} target
   * @param {Array} rows - salesAndTrafficByAsin entries
   * @param {string} reportDate - YYYY-MM-DD date for these rows
   */
  async upsertData(target, rows, reportDate) {
    let upserted = 0;
    let skipped = 0;
    let errors = 0;

    for (const row of rows) {
      try {
        const asin = row.childAsin || row.parentAsin;
        if (!asin) {
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
          reportDate,
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
          date: reportDate,
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
