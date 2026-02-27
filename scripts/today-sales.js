#!/usr/bin/env node
/**
 * Today's sales: sync orders for all marketplaces, then print today's summary.
 *
 * Usage:
 *   node scripts/today-sales.js              # sync + show
 *   node scripts/today-sales.js --no-sync    # show only (skip sync)
 *   node scripts/today-sales.js --account 1  # specific account
 */
require('dotenv').config();
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
dayjs.extend(utc);

const OrdersService = require('../src/modules/orders/orders.service');
const AccountService = require('../src/modules/accounts/account.service');
const AggregationService = require('../src/modules/aggregation/aggregation.service');

const args = process.argv.slice(2);
const skipSync = args.includes('--no-sync');
const accountIdx = args.indexOf('--account');
const accountFilter = accountIdx !== -1 ? parseInt(args[accountIdx + 1], 10) : null;

(async () => {
  try {
    const targets = await AccountService.getActiveSyncTargets();
    const filteredTargets = accountFilter
      ? targets.filter((t) => t.account_id === accountFilter)
      : targets;

    if (filteredTargets.length === 0) {
      console.log('No active sync targets found.');
      process.exit(0);
    }

    // Step 1: Sync today's orders (unless --no-sync)
    if (!skipSync) {
      const todayStart = dayjs.utc().startOf('day').toISOString();
      console.log(`\nSyncing orders from ${todayStart}...\n`);

      for (const target of filteredTargets) {
        try {
          console.log(`  [${target.country_code}] syncing...`);
          const result = await OrdersService.syncOrders(target, { dateFrom: todayStart });
          console.log(`  [${target.country_code}] done — processed: ${result.processed}, inserted: ${result.inserted}`);
        } catch (err) {
          console.error(`  [${target.country_code}] FAILED: ${err.message}`);
        }
      }
    } else {
      console.log('\nSkipping sync (--no-sync flag)');
    }

    // Step 2: Query today's sales for each unique account
    const accountIds = [...new Set(filteredTargets.map((t) => t.account_id))];

    for (const accountId of accountIds) {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`  VENDUTO OGGI — Account ${accountId}`);
      console.log(`${'='.repeat(60)}\n`);

      const sales = await AggregationService.getTodaySales(accountId);

      // Totals
      console.log(`  Data:     ${sales.date}`);
      console.log(`  Ordini:   ${sales.totals.orders_count}`);
      console.log(`  Unità:    ${sales.totals.units_sold}`);
      console.log(`  Ricavo:   €${sales.totals.gross_revenue.toFixed(2)}`);

      // By marketplace
      if (sales.by_marketplace.length > 0) {
        console.log(`\n  Per marketplace:`);
        console.log(`  ${'—'.repeat(50)}`);
        for (const mp of sales.by_marketplace) {
          const rev = parseFloat(mp.gross_revenue || 0).toFixed(2);
          console.log(`  ${mp.country_code.padEnd(5)} | ${String(mp.units_sold).padStart(4)} unità | ${String(mp.orders_count).padStart(4)} ordini | ${mp.currency} ${rev}`);
        }
      }

      // By ASIN (top 15)
      if (sales.by_asin.length > 0) {
        console.log(`\n  Top ASIN:`);
        console.log(`  ${'—'.repeat(50)}`);
        const top = sales.by_asin.slice(0, 15);
        for (const item of top) {
          const title = (item.asin_title || '').substring(0, 30);
          const rev = parseFloat(item.gross_revenue || 0).toFixed(2);
          console.log(`  ${item.asin} [${item.country_code}] | ${String(item.units_sold).padStart(3)} pz | ${item.currency} ${rev} | ${title}`);
        }
      }

      if (sales.by_marketplace.length === 0) {
        console.log('\n  Nessun ordine trovato per oggi.');
      }
    }

    console.log('\n');
    process.exit(0);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
})();
