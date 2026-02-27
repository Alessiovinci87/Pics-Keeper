#!/usr/bin/env node
/**
 * Manual orders sync - run from project root:
 *   node scripts/sync-orders-now.js
 */
require('dotenv').config();
const OrdersService = require('../src/modules/orders/orders.service');
const AccountService = require('../src/modules/accounts/account.service');

(async () => {
  try {
    const targets = await AccountService.getActiveSyncTargets();
    console.log('Targets:', targets.map(t => t.country_code).join(', '));

    for (const target of targets) {
      console.log(`Syncing orders for ${target.country_code}...`);
      await OrdersService.syncOrders(target);
      console.log(`${target.country_code} done`);
    }

    console.log('All done');
    process.exit(0);
  } catch (err) {
    console.error('Sync failed:', err.message);
    process.exit(1);
  }
})();
