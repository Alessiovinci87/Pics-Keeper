#!/usr/bin/env node
/**
 * Force re-sync financial events from Amazon SP-API for a specific date range.
 * This populates financial_events_raw with fee data (referral, FBA, etc.)
 * needed by the profit engine.
 *
 * Usage:
 *   node scripts/resync-financial.js 2026-01-01               # sync from Jan 1 to now
 *   node scripts/resync-financial.js 2026-01-01 2026-03-01    # sync specific range
 */
require('dotenv').config();
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
dayjs.extend(utc);

const FinancialService = require('../src/modules/financial/financial.service');
const AccountService = require('../src/modules/accounts/account.service');
const db = require('../src/database/pool');

const dateFrom = process.argv[2];
const dateTo = process.argv[3];

if (!dateFrom) {
  console.error('Usage: node scripts/resync-financial.js <YYYY-MM-DD> [YYYY-MM-DD]');
  console.error('Example: node scripts/resync-financial.js 2026-01-01');
  console.error('Example: node scripts/resync-financial.js 2026-01-01 2026-03-01');
  process.exit(1);
}

(async () => {
  try {
    const from = dayjs.utc(dateFrom);
    const to = dateTo ? dayjs.utc(dateTo) : dayjs.utc();

    console.log(`\n${'='.repeat(60)}`);
    console.log(`  RESYNC FINANCIAL EVENTS`);
    console.log(`  Range: ${from.format('YYYY-MM-DD')} → ${to.format('YYYY-MM-DD')}`);
    console.log(`${'='.repeat(60)}`);

    // Get all active sync targets
    const targets = await AccountService.getActiveSyncTargets();
    if (targets.length === 0) {
      console.error('  No active sync targets found!');
      process.exit(1);
    }

    // Financial API returns events for ALL marketplaces per account,
    // so we only need one target per account
    const processedAccounts = new Set();
    let totalProcessed = 0;
    let totalInserted = 0;

    for (const target of targets) {
      if (processedAccounts.has(target.account_id)) continue;

      console.log(`\n  [Account ${target.account_id}] Syncing financial events...`);

      // Override last_financial_sync_at to force the desired start date
      target.last_financial_sync_at = from.toISOString();

      const startTime = Date.now();
      const result = await FinancialService.syncFinancialEvents(target, processedAccounts);

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`  [Account ${target.account_id}] Done in ${elapsed}s — processed: ${result.processed}, inserted: ${result.inserted}`);

      totalProcessed += result.processed;
      totalInserted += result.inserted;
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`  COMPLETATO — processed: ${totalProcessed}, inserted: ${totalInserted}`);
    console.log(`${'='.repeat(60)}\n`);

    await db.shutdown();
  } catch (err) {
    console.error('ERRORE:', err.message);
    await db.shutdown();
    process.exit(1);
  }
})();
