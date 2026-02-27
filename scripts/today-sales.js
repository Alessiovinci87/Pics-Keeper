#!/usr/bin/env node

/**
 * CLI script: Today's Sales Summary
 * Usage: node scripts/today-sales.js [accountId]
 *
 * Queries orders_raw directly for today's orders (timezone-aware per marketplace)
 * and prints a summary to the terminal.
 */

require('dotenv').config();
const db = require('../src/database/pool');
const AggregationService = require('../src/modules/aggregation/aggregation.service');

const accountId = parseInt(process.argv[2], 10) || 1;

async function main() {
  console.log(`\n=== TODAY'S SALES — Account #${accountId} ===\n`);

  const data = await AggregationService.getTodaySales(accountId);

  console.log(`Date: ${data.date}`);
  console.log(`Total Orders: ${data.totals.orders_count}`);
  console.log(`Total Units:  ${data.totals.units_sold}`);
  console.log(`Gross Revenue: €${data.totals.gross_revenue.toFixed(2)}\n`);

  if (data.by_marketplace.length > 0) {
    console.log('--- By Marketplace ---');
    for (const mp of data.by_marketplace) {
      console.log(
        `  ${mp.country_code} (${mp.marketplace_name}): ` +
        `${mp.orders_count} orders, ${mp.units_sold} units, ` +
        `${mp.currency} ${mp.gross_revenue.toFixed(2)}`
      );
    }
  } else {
    console.log('No orders today (yet).');
  }

  if (data.top_asins.length > 0) {
    console.log('\n--- Top ASINs (by units) ---');
    for (const a of data.top_asins.slice(0, 20)) {
      const title = a.title ? a.title.substring(0, 50) : '(no title)';
      console.log(
        `  ${a.asin} [${a.country_code}] — ${a.units_sold} units, ` +
        `${a.currency} ${a.gross_revenue.toFixed(2)} — ${title}`
      );
    }
    if (data.top_asins.length > 20) {
      console.log(`  ... and ${data.top_asins.length - 20} more ASINs`);
    }
  }

  console.log('');
}

main()
  .catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
  })
  .finally(() => db.shutdown());
