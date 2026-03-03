#!/usr/bin/env node
/**
 * Validate orders for a specific day: query DB before/after resync.
 * Compares DB data with what SP-API returns for the same day.
 *
 * Usage:
 *   node scripts/validate-day.js 2026-03-02              # validate all active marketplaces
 *   node scripts/validate-day.js 2026-03-02 IT,FR,ES     # validate specific countries
 *   node scripts/validate-day.js 2026-03-02 --skip-sync  # only show DB counts, no resync
 */
require('dotenv').config();
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
dayjs.extend(utc);

const OrdersService = require('../src/modules/orders/orders.service');
const AccountService = require('../src/modules/accounts/account.service');
const db = require('../src/database/pool');

const args = process.argv.slice(2).filter(a => a !== '--skip-sync');
const skipSync = process.argv.includes('--skip-sync');

const dateStr = args[0];
const countryFilter = args[1] ? args[1].toUpperCase().split(',') : null;

if (!dateStr) {
  console.error('Usage: node scripts/validate-day.js <YYYY-MM-DD> [country1,country2,...] [--skip-sync]');
  console.error('Example: node scripts/validate-day.js 2026-03-02 IT,FR,ES');
  process.exit(1);
}

const dayStart = dayjs.utc(dateStr).startOf('day').toISOString();
const dayEnd = dayjs.utc(dateStr).endOf('day').toISOString();

async function queryDayCounts() {
  const res = await db.query(`
    SELECT m.country_code,
           COUNT(*) AS righe,
           COALESCE(SUM(o.quantity), 0) AS unita,
           COUNT(DISTINCT o.amazon_order_id) AS ordini
    FROM orders_raw o
    JOIN marketplaces m ON m.id = o.marketplace_id
    WHERE o.purchase_date >= $1
      AND o.purchase_date < $2
      AND o.order_status != 'CANCELLED'
    GROUP BY m.country_code
    ORDER BY unita DESC
  `, [dayStart, dayEnd]);
  return res.rows;
}

function printTable(title, rows) {
  console.log(`\n  ${title}`);
  console.log('  ' + '-'.repeat(50));
  console.log('  Paese  |  Righe  |  Unità  |  Ordini');
  console.log('  ' + '-'.repeat(50));
  let totUnita = 0, totOrdini = 0, totRighe = 0;
  for (const r of rows) {
    const unita = parseInt(r.unita);
    const ordini = parseInt(r.ordini);
    const righe = parseInt(r.righe);
    console.log(`  ${r.country_code.padEnd(7)}|  ${String(righe).padEnd(7)}|  ${String(unita).padEnd(7)}|  ${ordini}`);
    totUnita += unita;
    totOrdini += ordini;
    totRighe += righe;
  }
  console.log('  ' + '-'.repeat(50));
  console.log(`  ${'TOTALE'.padEnd(7)}|  ${String(totRighe).padEnd(7)}|  ${String(totUnita).padEnd(7)}|  ${totOrdini}`);
}

(async () => {
  try {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`  VALIDAZIONE ORDINI — ${dateStr}`);
    if (countryFilter) console.log(`  Filtro paesi: ${countryFilter.join(', ')}`);
    if (skipSync) console.log(`  Modalità: solo lettura DB (no resync)`);
    console.log(`${'='.repeat(60)}`);

    // --- STEP 1: DB counts BEFORE resync ---
    const before = await queryDayCounts();
    printTable(`DB PRIMA del resync (${dateStr})`, before);

    if (skipSync) {
      console.log('\n  --skip-sync attivo: resync saltato.\n');
      await db.shutdown();
      return;
    }

    // --- STEP 2: Resync from SP-API ---
    console.log(`\n  Lancio resync SP-API per ${dateStr} con --force ...\n`);

    const targets = await AccountService.getActiveSyncTargets();
    const filtered = countryFilter
      ? targets.filter(t => countryFilter.includes(t.country_code))
      : targets;

    if (filtered.length === 0) {
      console.log('  Nessun sync target trovato.');
      await db.shutdown();
      return;
    }

    const syncResults = [];

    for (const target of filtered) {
      console.log(`  [${target.country_code}] Syncing ${dateStr} ...`);
      try {
        const result = await OrdersService.syncOrders(target, {
          dateFrom: dateStr,
          dateTo: dateStr,
          force: true,
        });
        console.log(`  [${target.country_code}] OK — ordini API: ${result.totalOrders}, processed: ${result.processed}, inserted: ${result.inserted}, skipped: ${result.skipped}`);
        syncResults.push({
          country_code: target.country_code,
          api_orders: result.totalOrders,
          processed: result.processed,
          inserted: result.inserted,
        });
      } catch (err) {
        console.error(`  [${target.country_code}] ERRORE — ${err.message}`);
        syncResults.push({
          country_code: target.country_code,
          api_orders: 0,
          processed: 0,
          inserted: 0,
          error: err.message,
        });
      }
    }

    // --- STEP 3: DB counts AFTER resync ---
    const after = await queryDayCounts();
    printTable(`DB DOPO il resync (${dateStr})`, after);

    // --- STEP 4: Comparison ---
    console.log(`\n  CONFRONTO (prima → dopo)`);
    console.log('  ' + '-'.repeat(60));
    console.log('  Paese  |  Prima  |  Dopo   |  Diff   |  API Orders');
    console.log('  ' + '-'.repeat(60));

    const beforeMap = {};
    for (const r of before) beforeMap[r.country_code] = parseInt(r.unita);
    const afterMap = {};
    for (const r of after) afterMap[r.country_code] = parseInt(r.unita);
    const syncMap = {};
    for (const r of syncResults) syncMap[r.country_code] = r.api_orders;

    const allCountries = [...new Set([...Object.keys(beforeMap), ...Object.keys(afterMap), ...Object.keys(syncMap)])].sort();

    let totBefore = 0, totAfter = 0, totApi = 0;
    for (const cc of allCountries) {
      const b = beforeMap[cc] || 0;
      const a = afterMap[cc] || 0;
      const api = syncMap[cc] || 0;
      const diff = a - b;
      const diffStr = diff > 0 ? `+${diff}` : String(diff);
      console.log(`  ${cc.padEnd(7)}|  ${String(b).padEnd(7)}|  ${String(a).padEnd(7)}|  ${diffStr.padEnd(7)}|  ${api}`);
      totBefore += b;
      totAfter += a;
      totApi += api;
    }
    const totDiff = totAfter - totBefore;
    const totDiffStr = totDiff > 0 ? `+${totDiff}` : String(totDiff);
    console.log('  ' + '-'.repeat(60));
    console.log(`  ${'TOTALE'.padEnd(7)}|  ${String(totBefore).padEnd(7)}|  ${String(totAfter).padEnd(7)}|  ${totDiffStr.padEnd(7)}|  ${totApi}`);

    console.log(`\n  Confronta "Dopo" e "API Orders" con i dati di Shopkeeper per ${dateStr}.`);
    console.log(`  Se coincidono → la sync funziona correttamente, il gap è solo storico.\n`);

    await db.shutdown();
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
})();
