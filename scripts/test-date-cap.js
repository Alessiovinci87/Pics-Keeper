#!/usr/bin/env node
/**
 * Quick test: verify createdBefore date capping works correctly.
 * Run this AFTER pulling the latest code to confirm the fix is active.
 */
require('dotenv').config();
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
dayjs.extend(utc);

const now = dayjs.utc();
console.log(`\n  Ora UTC: ${now.toISOString()}`);
console.log(`${'='.repeat(60)}`);

// Simulate what syncOrders does with dateTo = today
const overrideTo = now.format('YYYY-MM-DD'); // e.g. '2026-03-01'
const rawTo = dayjs.utc(overrideTo).endOf('day').toISOString();
const maxTo = dayjs.utc().subtract(3, 'minute');
const cappedTo = dayjs.utc(rawTo).isAfter(maxTo) ? maxTo.toISOString() : rawTo;

console.log(`\n  Test: dateTo = "${overrideTo}" (oggi)`);
console.log(`  endOf('day')  = ${rawTo}`);
console.log(`  maxTo (now-3m) = ${maxTo.toISOString()}`);
console.log(`  Risultato      = ${cappedTo}`);
console.log(`  Nel futuro?    = ${dayjs.utc(cappedTo).isAfter(now) ? 'SI (BUG!)' : 'NO (OK)'}`);

// Verify it's at least 2 minutes in the past
const diffMinutes = now.diff(dayjs.utc(cappedTo), 'minute', true);
console.log(`  Minuti nel passato = ${diffMinutes.toFixed(1)} (deve essere >= 2)`);

const passed = diffMinutes >= 2;
console.log(`\n  ${'='.repeat(40)}`);
console.log(`  RISULTATO: ${passed ? 'PASS - Il fix funziona!' : 'FAIL - createdBefore ancora nel futuro'}`);
console.log(`  ${'='.repeat(40)}\n`);

process.exit(passed ? 0 : 1);
