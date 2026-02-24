/**
 * Test script: chiama SP-API e cerca ordini per un ASIN specifico.
 *
 * Uso: node test-single-asin.js <ASIN> <country_code> [days_back]
 * Es:  node test-single-asin.js B0BY9Q4KTT IT 30
 */
require('dotenv').config();

const { Pool } = require('pg');
const SpApiClient = require('./src/services/sp-api.client');
const config = require('./src/config');

const pool = new Pool(config.db);

async function main() {
  const asin = process.argv[2];
  const countryCode = process.argv[3];
  const daysBack = parseInt(process.argv[4] || '30', 10);

  if (!asin || !countryCode) {
    console.error('Uso: node test-single-asin.js <ASIN> <country_code> [days_back]');
    console.error('Es:  node test-single-asin.js B0BY9Q4KTT IT 30');
    process.exit(1);
  }

  try {
    console.log(`\n=== Test ASIN: ${asin} su ${countryCode} (ultimi ${daysBack} giorni) ===\n`);

    // 1) Get account credentials + marketplace info
    const { rows: targets } = await pool.query(`
      SELECT a.id as account_id, a.seller_id, a.sp_api_refresh_token,
             am.id as account_marketplace_id,
             m.marketplace_id as amazon_marketplace_id,
             m.country_code, m.region, m.currency
      FROM accounts a
      JOIN account_marketplaces am ON am.account_id = a.id
      JOIN marketplaces m ON m.id = am.marketplace_id
      WHERE a.id = 1 AND m.country_code = $1
    `, [countryCode]);

    if (targets.length === 0) {
      console.error(`Nessun target trovato per country=${countryCode}`);
      process.exit(1);
    }

    const target = targets[0];
    console.log(`Target: seller=${target.seller_id}, marketplace=${target.amazon_marketplace_id}, region=${target.region}\n`);

    // 2) Build date range
    const now = new Date();
    const from = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000);
    // SP-API requires CreatedBefore to be at least 2 min in the past
    const to = new Date(now.getTime() - 5 * 60 * 1000);

    const fromISO = from.toISOString().replace(/\.\d{3}Z$/, 'Z');
    const toISO = to.toISOString().replace(/\.\d{3}Z$/, 'Z');

    console.log(`Date range: ${fromISO} -> ${toISO}\n`);

    // 3) Call SP-API getOrders - paginate through all orders
    const spApi = new SpApiClient(target);

    let nextToken = null;
    let totalOrders = 0;
    let matchingOrders = [];
    let pageNum = 0;

    console.log(`Scarico ordini da SP-API per ${countryCode}...`);
    console.log(`(cerco ASIN ${asin} negli order items)\n`);

    do {
      pageNum++;
      const response = await spApi.getOrders({
        MarketplaceIds: [target.amazon_marketplace_id],
        CreatedAfter: fromISO,
        CreatedBefore: toISO,
        NextToken: nextToken,
      });

      const orders = response.Orders || [];
      totalOrders += orders.length;
      nextToken = response.NextToken || null;

      console.log(`  Pagina ${pageNum}: ${orders.length} ordini (totale finora: ${totalOrders})${nextToken ? ' [altra pagina...]' : ' [fine]'}`);

      // For each order, get items and check for our ASIN
      for (const order of orders) {
        // Skip cancelled orders
        if (order.OrderStatus === 'Canceled') continue;

        try {
          const items = await spApi.getOrderItems(order.AmazonOrderId);
          const match = items.find(i => i.ASIN === asin);

          if (match) {
            matchingOrders.push({
              orderId: order.AmazonOrderId,
              status: order.OrderStatus,
              purchaseDate: order.PurchaseDate,
              qty: match.QuantityOrdered,
              itemPrice: match.ItemPrice,
              itemTax: match.ItemTax,
              shippingPrice: match.ShippingPrice,
              shippingTax: match.ShippingTax,
              promoDiscount: match.PromotionDiscount,
              sku: match.SellerSKU,
              title: match.Title,
            });

            console.log(`    >>> TROVATO! ${order.AmazonOrderId} | qty=${match.QuantityOrdered} | price=${match.ItemPrice?.Amount} ${match.ItemPrice?.CurrencyCode} | status=${order.OrderStatus} | ${order.PurchaseDate}`);
          }
        } catch (err) {
          console.log(`    Errore getOrderItems(${order.AmazonOrderId}): ${err.message}`);
        }
      }

      // Safety: stop after 500 orders to avoid excessive API calls
      if (totalOrders >= 500 && nextToken) {
        console.log(`\n  *** Fermato a ${totalOrders} ordini per sicurezza. Ci sono altre pagine. ***`);
        break;
      }

    } while (nextToken);

    // 4) Print results
    console.log(`\n${'='.repeat(70)}`);
    console.log(`RISULTATI: ${matchingOrders.length} ordini trovati per ASIN ${asin} su ${countryCode}`);
    console.log(`(su ${totalOrders} ordini totali scansionati)`);
    console.log(`${'='.repeat(70)}\n`);

    if (matchingOrders.length === 0) {
      console.log('Nessun ordine trovato per questo ASIN nel periodo.');
    } else {
      // Summary
      let totalUnits = 0;
      let totalRevenue = 0;
      let totalTax = 0;

      for (const o of matchingOrders) {
        totalUnits += o.qty || 0;
        totalRevenue += parseFloat(o.itemPrice?.Amount || 0);
        totalTax += parseFloat(o.itemTax?.Amount || 0);
      }

      console.log(`TOTALI API:`);
      console.log(`  Ordini:  ${matchingOrders.length}`);
      console.log(`  Unità:   ${totalUnits}`);
      console.log(`  Revenue: ${totalRevenue.toFixed(2)} ${matchingOrders[0]?.itemPrice?.CurrencyCode || ''}`);
      console.log(`  Tax:     ${totalTax.toFixed(2)}`);
      console.log(`  Titolo:  ${matchingOrders[0]?.title || 'N/A'}`);
      console.log(`  SKU:     ${matchingOrders[0]?.sku || 'N/A'}`);

      console.log(`\nDettaglio ordini:`);
      for (const o of matchingOrders) {
        console.log(`  ${o.purchaseDate} | ${o.orderId} | qty=${o.qty} | price=${o.itemPrice?.Amount} | tax=${o.itemTax?.Amount} | ship=${o.shippingPrice?.Amount || '0'} | promo=${o.promoDiscount?.Amount || '0'} | ${o.status}`);
      }
    }

    // 5) Also check DB for comparison
    const dbTotals = await pool.query(`
      SELECT COUNT(*) as ordini, SUM(quantity) as units,
             SUM(item_price) as revenue, SUM(item_tax) as tax
      FROM orders_raw
      WHERE account_id = 1 AND asin = $1
        AND marketplace_id = (SELECT id FROM marketplaces WHERE country_code = $2)
    `, [asin, countryCode]);

    const db = dbTotals.rows[0];
    console.log(`\nTOTALI DB (per confronto):`);
    console.log(`  Ordini:  ${db.ordini}`);
    console.log(`  Unità:   ${db.units || 0}`);
    console.log(`  Revenue: ${db.revenue || 0}`);
    console.log(`  Tax:     ${db.tax || 0}`);

    if (parseInt(db.ordini) === 0 && matchingOrders.length > 0) {
      console.log(`\n  ⚠ Il DB è vuoto per IT - gli ordini sync non hanno ancora coperto questo marketplace.`);
      console.log(`  Una volta lanciata la sync ordini per IT, questi dati verranno importati.`);
    }

  } catch (err) {
    console.error('Errore:', err);
  } finally {
    await pool.end();
  }
}

main();
