#!/usr/bin/env node
/**
 * Quick diagnostic: check business_report_daily table + dump report JSON structure.
 */
require('dotenv').config();

const db = require('../src/database/pool');
const AccountService = require('../src/modules/accounts/account.service');
const SpApiClient = require('../src/services/sp-api.client');
const axios = require('axios');
const zlib = require('zlib');
const { promisify } = require('util');
const gunzip = promisify(zlib.gunzip);
const dayjs = require('dayjs');

async function main() {
  // 1. Count rows in business_report_daily
  console.log('\n=== DB Diagnostic ===\n');

  const count = await db.query('SELECT COUNT(*) FROM business_report_daily');
  console.log('  Rows in business_report_daily:', count.rows[0].count);

  const sample = await db.query('SELECT * FROM business_report_daily LIMIT 3');
  if (sample.rows.length > 0) {
    console.log('  Sample rows:');
    sample.rows.forEach((r) => console.log('   ', JSON.stringify(r)));
  } else {
    console.log('  (table is empty)');
  }

  // 2. Download one report and dump its JSON structure
  console.log('\n=== Report JSON Structure (IT marketplace) ===\n');

  const targets = await AccountService.getActiveSyncTargets();
  const it = targets.find((t) => t.country_code === 'IT') || targets[0];

  if (!it) {
    console.log('  No active target found');
    await db.shutdown();
    return;
  }

  const spApi = new SpApiClient(it);

  // Request a 1-day report to keep it small
  const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD');
  const result = await spApi.createReport({
    reportType: 'GET_SALES_AND_TRAFFIC_REPORT',
    marketplaceIds: [it.amazon_marketplace_id],
    dataStartTime: dayjs(yesterday).startOf('day').toISOString(),
    dataEndTime: dayjs(yesterday).endOf('day').toISOString(),
    reportOptions: { dateGranularity: 'DAY', asinGranularity: 'CHILD' },
  });

  console.log('  Report requested:', result.reportId);

  // Poll
  let reportDocumentId;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 15000));
    const report = await spApi.getReport(result.reportId);
    console.log('  Poll:', report.processingStatus);
    if (report.processingStatus === 'DONE') {
      reportDocumentId = report.reportDocumentId;
      break;
    }
    if (report.processingStatus === 'FATAL' || report.processingStatus === 'CANCELLED') {
      throw new Error('Report failed: ' + report.processingStatus);
    }
  }

  if (!reportDocumentId) {
    console.log('  Report timed out');
    await db.shutdown();
    return;
  }

  // Download
  const doc = await spApi.getReportDocument(reportDocumentId);
  console.log('  compressionAlgorithm:', doc.compressionAlgorithm || '(none)');

  const isGzipped = doc.compressionAlgorithm === 'GZIP';
  const response = await axios.get(doc.url, {
    responseType: isGzipped ? 'arraybuffer' : 'text',
  });

  let jsonStr;
  if (isGzipped) {
    const buf = await gunzip(Buffer.from(response.data));
    jsonStr = buf.toString('utf-8');
  } else {
    jsonStr = response.data;
  }

  const parsed = JSON.parse(jsonStr);

  // Dump structure
  console.log('\n  Top-level keys:', Object.keys(parsed));

  if (parsed.salesAndTrafficByAsin) {
    const arr = parsed.salesAndTrafficByAsin;
    console.log('  salesAndTrafficByAsin length:', arr.length);
    if (arr.length > 0) {
      console.log('  First ASIN entry keys:', Object.keys(arr[0]));
      console.log('  First ASIN entry:', JSON.stringify(arr[0], null, 2).substring(0, 1000));
    }
  } else {
    console.log('  salesAndTrafficByAsin: NOT FOUND');
  }

  if (parsed.salesAndTrafficByDate) {
    const arr = parsed.salesAndTrafficByDate;
    console.log('\n  salesAndTrafficByDate length:', arr.length);
    if (arr.length > 0) {
      console.log('  First date entry keys:', Object.keys(arr[0]));
      console.log('  First date entry (preview):', JSON.stringify(arr[0], null, 2).substring(0, 500));
    }
  }

  console.log('\nDone.');
  await db.shutdown();
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
