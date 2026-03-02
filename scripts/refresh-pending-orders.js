#!/usr/bin/env node
/**
 * Refresh status of PENDING orders by re-fetching them from SP-API.
 * Orders stuck as PENDING may have since been shipped or cancelled.
 *
 * Usage:
 *   node scripts/refresh-pending-orders.js            # refresh all pending orders
 *   node scripts/refresh-pending-orders.js FR          # refresh only FR pending orders
 *   node scripts/refresh-pending-orders.js IT,FR,DE    # refresh specific marketplaces
 */
require('dotenv').config();
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
dayjs.extend(utc);

const db = require('../src/database/pool');
const AccountService = require('../src/modules/accounts/account.service');
const SpApiClient = require('../src/services/sp-api.client');
const { sleep } = require('../src/utils/helpers');

const countryFilter = process.argv[2]
  ? process.argv[2].toUpperCase().split(',')
  : null;

(async () => {
  try {
    // Find all PENDING orders grouped by marketplace
    const pendingResult = await db.query(`
      SELECT
        o.account_id,
        o.marketplace_id,
        m.country_code,
        COUNT(DISTINCT o.amazon_order_id) AS pending_count,
        MIN(o.purchase_date) AS oldest_pending
      FROM orders_raw o
      JOIN marketplaces m ON m.id = o.marketplace_id
      WHERE o.order_status = 'PENDING'
      ${countryFilter ? `AND m.country_code IN (${countryFilter.map((_, i) => `$${i + 1}`).join(',')})` : ''}
      GROUP BY o.account_id, o.marketplace_id, m.country_code
      ORDER BY pending_count DESC
    `, countryFilter || []);

    if (pendingResult.rows.length === 0) {
      console.log('Nessun ordine PENDING trovato.');
      await db.shutdown();
      return;
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log('  REFRESH ORDINI PENDING');
    if (countryFilter) console.log(`  Filtro: ${countryFilter.join(', ')}`);
    console.log(`${'='.repeat(60)}\n`);

    for (const row of pendingResult.rows) {
      console.log(`  [${row.country_code}] ${row.pending_count} ordini pending (dal ${dayjs(row.oldest_pending).format('YYYY-MM-DD')})`);
    }
    console.log('');

    // Get sync targets for auth info
    const targets = await AccountService.getActiveSyncTargets();

    let totalUpdated = 0;
    let totalErrors = 0;

    for (const pendingGroup of pendingResult.rows) {
      const target = targets.find(
        t => t.account_id === pendingGroup.account_id &&
             t.account_marketplace_id === pendingGroup.marketplace_id
      );

      if (!target) {
        console.log(`  [${pendingGroup.country_code}] SKIP — nessun sync target attivo`);
        continue;
      }

      // Get individual pending order IDs
      const orderIds = await db.query(
        `SELECT DISTINCT amazon_order_id
         FROM orders_raw
         WHERE account_id = $1 AND marketplace_id = $2 AND order_status = 'PENDING'
         ORDER BY amazon_order_id`,
        [pendingGroup.account_id, pendingGroup.marketplace_id]
      );

      console.log(`  [${pendingGroup.country_code}] Verifico ${orderIds.rows.length} ordini...`);

      const spApi = new SpApiClient(target);
      let updated = 0;
      let errors = 0;

      for (const row of orderIds.rows) {
        try {
          // Fetch single order from SP-API using getOrder
          const response = await spApi.request('GET', `/orders/2026-01-01/orders/${row.amazon_order_id}`, {
            includedData: 'FULFILLMENT',
          });

          const newStatus = response.fulfillment?.fulfillmentStatus || 'UNKNOWN';

          if (newStatus !== 'PENDING') {
            // Update all items for this order
            await db.query(
              `UPDATE orders_raw SET order_status = $1, synced_at = NOW()
               WHERE account_id = $2 AND amazon_order_id = $3`,
              [newStatus, pendingGroup.account_id, row.amazon_order_id]
            );
            updated++;
          }

          // Rate limit: 1 request per second for getOrder
          await sleep(1000);
        } catch (err) {
          errors++;
          if (errors <= 3) {
            console.error(`    [${pendingGroup.country_code}] Errore su ${row.amazon_order_id}: ${err.message}`);
          }
        }
      }

      console.log(`  [${pendingGroup.country_code}] DONE — ${updated} aggiornati, ${errors} errori`);
      totalUpdated += updated;
      totalErrors += errors;

      // Pause between marketplaces
      await sleep(3000);
    }

    console.log(`\n  Totale: ${totalUpdated} ordini aggiornati, ${totalErrors} errori\n`);
    await db.shutdown();
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
})();
