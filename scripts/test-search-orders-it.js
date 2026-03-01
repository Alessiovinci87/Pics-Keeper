#!/usr/bin/env node
/**
 * Diagnostic: call SP-API searchOrders for Italy from a given date.
 * Shows raw response structure + parsed proceeds to verify data extraction.
 *
 * Usage:
 *   node scripts/test-search-orders-it.js                  # from 2024-03-01
 *   node scripts/test-search-orders-it.js 2024-06-01       # custom start date
 */
require('dotenv').config();
const SpApiClient = require('../src/services/sp-api.client');
const AccountService = require('../src/modules/accounts/account.service');
const db = require('../src/database/pool');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
dayjs.extend(utc);

const dateFrom = process.argv[2] || '2024-03-01';

(async () => {
  try {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`  TEST searchOrders — IT — dal ${dateFrom}`);
    console.log(`${'='.repeat(70)}\n`);

    // 1) Get the IT sync target
    const targets = await AccountService.getActiveSyncTargets();
    const itTarget = targets.find(t => t.country_code === 'IT');

    if (!itTarget) {
      console.error('  ERROR: nessun target IT attivo trovato in account_marketplaces');
      await db.shutdown();
      process.exit(1);
    }

    console.log(`  Account ID:       ${itTarget.account_id}`);
    console.log(`  Marketplace ID:   ${itTarget.amazon_marketplace_id}`);
    console.log(`  Region:           ${itTarget.region}`);
    console.log(`  Currency:         ${itTarget.currency}`);
    console.log('');

    // 2) Build date range: one day only to keep response small
    const from = dayjs.utc(dateFrom).startOf('day').toISOString();
    const to = dayjs.utc(dateFrom).endOf('day').toISOString();

    console.log(`  createdAfter:     ${from}`);
    console.log(`  createdBefore:    ${to}`);
    console.log('');

    // 3) Make the SP-API call
    const spApi = new SpApiClient(itTarget);

    console.log('  Invio chiamata searchOrders...\n');
    const response = await spApi.searchOrders({
      marketplaceIds: [itTarget.amazon_marketplace_id],
      createdAfter: from,
      createdBefore: to,
    });

    // 4) Show raw response structure
    console.log(`  --- RISPOSTA RAW (chiavi top-level) ---`);
    console.log(`  Chiavi:`, Object.keys(response));
    console.log(`  Ordini ricevuti: ${(response.orders || []).length}`);
    console.log(`  Pagination:`, JSON.stringify(response.pagination || 'nessuna'));
    console.log('');

    const orders = response.orders || [];

    if (orders.length === 0) {
      console.log('  Nessun ordine trovato per questa data.\n');
      console.log('  Possibili cause:');
      console.log('    - Nessun ordine effettivo il ' + dateFrom);
      console.log('    - La risposta usa un formato diverso (controlla chiavi sopra)');
      console.log('    - Problema di autenticazione o marketplace ID errato');

      // Dump the full raw response for debugging
      console.log('\n  --- FULL RAW RESPONSE ---');
      console.log(JSON.stringify(response, null, 2).substring(0, 3000));
      await db.shutdown();
      process.exit(0);
    }

    // 5) Show first 3 orders in detail
    const sample = orders.slice(0, 3);
    for (let i = 0; i < sample.length; i++) {
      const order = sample[i];
      console.log(`  ${'─'.repeat(60)}`);
      console.log(`  ORDINE ${i + 1}: ${order.orderId || order.AmazonOrderId || 'N/A'}`);

      // Show order-level keys
      console.log(`    Chiavi ordine: ${Object.keys(order).join(', ')}`);
      console.log(`    createdTime:   ${order.createdTime || 'N/A'}`);
      console.log(`    fulfillment:   ${JSON.stringify(order.fulfillment || 'N/A')}`);

      // Proceeds at order level
      if (order.proceeds) {
        console.log(`    proceeds.grandTotal: ${JSON.stringify(order.proceeds.grandTotal || 'N/A')}`);
      }

      // Items
      const items = order.orderItems || order.OrderItems || [];
      console.log(`    Items count:   ${items.length}`);

      for (let j = 0; j < items.length; j++) {
        const item = items[j];
        console.log(`\n    ITEM ${j + 1}:`);
        console.log(`      Chiavi item:  ${Object.keys(item).join(', ')}`);

        // Product info
        const product = item.product || {};
        console.log(`      ASIN:         ${product.asin || item.ASIN || 'N/A'}`);
        console.log(`      SKU:          ${product.sellerSku || item.SellerSKU || 'N/A'}`);
        console.log(`      Title:        ${(product.title || item.Title || 'N/A').substring(0, 50)}`);
        console.log(`      Quantity:     ${item.quantityOrdered || item.QuantityOrdered || 'N/A'}`);

        // Proceeds / breakdowns
        if (item.proceeds) {
          console.log(`      proceeds keys: ${Object.keys(item.proceeds).join(', ')}`);
          const breakdowns = item.proceeds.breakdowns || [];
          console.log(`      breakdowns (${breakdowns.length}):`);
          for (const bd of breakdowns) {
            console.log(`        type: ${bd.type}, subtotal: ${JSON.stringify(bd.subtotal)}`);
            if (bd.detailedBreakdowns) {
              for (const db of bd.detailedBreakdowns) {
                console.log(`          subtype: ${db.subtype}, value: ${JSON.stringify(db.value)}`);
              }
            }
          }

          // Parse like the app does
          const itemPrice = extractProceeds(item, 'ITEM');
          const itemTax = extractTaxDetail(item, 'ITEM');
          const shippingPrice = extractProceeds(item, 'SHIPPING');
          const shippingTax = extractTaxDetail(item, 'SHIPPING');
          const discount = extractProceeds(item, 'DISCOUNT');

          console.log(`      --- PARSED ---`);
          console.log(`      item_price:          ${itemPrice}`);
          console.log(`      item_tax:            ${itemTax}`);
          console.log(`      shipping_price:      ${shippingPrice}`);
          console.log(`      shipping_tax:        ${shippingTax}`);
          console.log(`      promotion_discount:  ${discount}`);
          console.log(`      GROSS REVENUE:       ${(itemPrice + itemTax + shippingPrice + shippingTax - discount).toFixed(2)}`);
        } else {
          console.log(`      proceeds: ASSENTE — i dati non contengono proceeds!`);

          // Check for legacy format (ItemPrice, ItemTax, etc.)
          if (item.ItemPrice || item.itemPrice) {
            console.log(`      ** Formato legacy rilevato **`);
            console.log(`      ItemPrice:     ${JSON.stringify(item.ItemPrice || item.itemPrice)}`);
            console.log(`      ItemTax:       ${JSON.stringify(item.ItemTax || item.itemTax)}`);
            console.log(`      ShippingPrice: ${JSON.stringify(item.ShippingPrice || item.shippingPrice)}`);
          }
        }
      }
    }

    // 6) Summary of ALL orders for this date
    console.log(`\n  ${'═'.repeat(60)}`);
    console.log(`  RIEPILOGO — ${orders.length} ordini il ${dateFrom}`);
    console.log(`  ${'═'.repeat(60)}`);

    let totalUnits = 0;
    let totalRevenue = 0;
    let ordersWithProceeds = 0;
    let ordersWithoutProceeds = 0;

    for (const order of orders) {
      const items = order.orderItems || order.OrderItems || [];
      for (const item of items) {
        const qty = item.quantityOrdered || item.QuantityOrdered || 1;
        totalUnits += qty;

        if (item.proceeds?.breakdowns) {
          ordersWithProceeds++;
          const ip = extractProceeds(item, 'ITEM');
          const it = extractTaxDetail(item, 'ITEM');
          const sp = extractProceeds(item, 'SHIPPING');
          const st = extractTaxDetail(item, 'SHIPPING');
          const disc = extractProceeds(item, 'DISCOUNT');
          totalRevenue += (ip + it + sp + st - disc);
        } else {
          ordersWithoutProceeds++;
        }
      }
    }

    console.log(`  Ordini:               ${orders.length}`);
    console.log(`  Unità:                ${totalUnits}`);
    console.log(`  Con proceeds:         ${ordersWithProceeds}`);
    console.log(`  Senza proceeds:       ${ordersWithoutProceeds}`);
    console.log(`  Ricavo lordo totale:  €${totalRevenue.toFixed(2)}`);

    if (ordersWithoutProceeds > 0) {
      console.log(`\n  ⚠  ${ordersWithoutProceeds} item senza proceeds! Il parsing potrebbe essere sbagliato.`);
      console.log(`     Controlla il formato della risposta sopra.`);
    }

    console.log('');
    await db.shutdown();
  } catch (err) {
    console.error('\n  ERRORE:', err.message);
    if (err.response?.data) {
      console.error('  Response body:', JSON.stringify(err.response.data, null, 2));
    }
    console.error('  Stack:', err.stack);
    await db.shutdown();
    process.exit(1);
  }
})();

// --- Helpers (same logic as orders.service.js) ---

function extractProceeds(item, type) {
  const breakdowns = item.proceeds?.breakdowns || [];
  const breakdown = breakdowns.find(b => b.type === type);
  return breakdown?.subtotal ? parseFloat(breakdown.subtotal.amount || 0) : 0;
}

function extractTaxDetail(item, subtype) {
  const breakdowns = item.proceeds?.breakdowns || [];
  const taxBreakdown = breakdowns.find(b => b.type === 'TAX');
  if (!taxBreakdown?.detailedBreakdowns) {
    if (subtype === 'ITEM' && taxBreakdown?.subtotal) {
      return parseFloat(taxBreakdown.subtotal.amount || 0);
    }
    return 0;
  }
  const detail = taxBreakdown.detailedBreakdowns.find(d => d.subtype === subtype);
  return detail?.value ? parseFloat(detail.value.amount || 0) : 0;
}
