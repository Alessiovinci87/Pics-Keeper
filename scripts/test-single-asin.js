#!/usr/bin/env node
/**
 * Test single SP-API call for a specific ASIN on a specific date.
 * Usage: node scripts/test-single-asin.js [ASIN] [DATE]
 * Example: node scripts/test-single-asin.js B0BY9Q4KTT 2026-03-03
 */
require('dotenv').config();
const SpApiClient = require('../src/services/sp-api.client');
const AccountService = require('../src/modules/accounts/account.service');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
dayjs.extend(utc);

const ASIN = process.argv[2] || 'B0BY9Q4KTT';
const DATE = process.argv[3] || '2026-03-03';
const COUNTRY = process.argv[4] || 'IT';

async function main() {
  console.log(`\n=== Test SP-API call: ASIN ${ASIN}, Date ${DATE}, Country ${COUNTRY} ===\n`);

  // Get the Italy target
  const targets = await AccountService.getActiveSyncTargets();
  const target = targets.find((t) => t.country_code === COUNTRY);

  if (!target) {
    console.error(`No active target found for country ${COUNTRY}`);
    process.exit(1);
  }

  console.log('Target:', {
    account_id: target.account_id,
    marketplace: target.country_code,
    amazon_marketplace_id: target.amazon_marketplace_id,
    region: target.region,
  });

  const spApi = new SpApiClient(target);

  const from = dayjs.utc(DATE).startOf('day').toISOString();
  const to = dayjs.utc(DATE).endOf('day').toISOString();

  // Cap 'to' at now-3min (SP-API requirement)
  const maxTo = dayjs.utc().subtract(3, 'minute');
  const effectiveTo = dayjs.utc(to).isAfter(maxTo) ? maxTo.toISOString() : to;

  console.log(`\nDate range: ${from} -> ${effectiveTo}\n`);

  let allOrders = [];
  let paginationToken = null;
  let page = 0;

  do {
    page++;
    console.log(`Fetching page ${page}...`);

    const response = await spApi.searchOrders({
      marketplaceIds: [target.amazon_marketplace_id],
      createdAfter: from,
      createdBefore: effectiveTo,
      paginationToken,
    });

    const orders = response.orders || [];
    allOrders = allOrders.concat(orders);
    paginationToken = response.pagination?.nextToken || null;

    console.log(`  -> ${orders.length} orders on this page (total so far: ${allOrders.length})`);

    if (paginationToken) {
      await new Promise((r) => setTimeout(r, 2000));
    }
  } while (paginationToken);

  // Filter orders containing the target ASIN
  const matchingOrders = allOrders.filter((order) => {
    const items = order.orderItems || [];
    return items.some((item) => item.product?.asin === ASIN);
  });

  // Count total units for the ASIN
  let totalUnits = 0;
  const orderDetails = [];

  for (const order of matchingOrders) {
    const items = order.orderItems || [];
    for (const item of items) {
      if (item.product?.asin === ASIN) {
        const qty = item.quantityOrdered || 1;
        totalUnits += qty;
        orderDetails.push({
          orderId: order.orderId,
          status: order.fulfillment?.fulfillmentStatus,
          quantity: qty,
          purchaseDate: order.createdTime,
          sku: item.product?.sellerSku,
          title: item.product?.title?.substring(0, 60),
        });
      }
    }
  }

  // Count units excluding cancelled
  let unitsExclCancelled = 0;
  for (const od of orderDetails) {
    const st = (od.status || '').toUpperCase();
    if (st !== 'CANCELLED' && st !== 'CANCELED') {
      unitsExclCancelled += od.quantity;
    }
  }

  console.log(`\n=== RESULTS ===`);
  console.log(`Total orders fetched: ${allOrders.length}`);
  console.log(`Orders containing ASIN ${ASIN}: ${matchingOrders.length}`);
  console.log(`Total units (all statuses): ${totalUnits}`);
  console.log(`Total units (excl cancelled): ${unitsExclCancelled}`);
  console.log(`\nOrder details:`);
  console.table(orderDetails);

  // Also show status breakdown
  const statusCounts = {};
  for (const od of orderDetails) {
    const s = od.status || 'UNKNOWN';
    statusCounts[s] = (statusCounts[s] || 0) + od.quantity;
  }
  console.log('\nUnits by status:');
  console.table(statusCounts);

  process.exit(0);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
