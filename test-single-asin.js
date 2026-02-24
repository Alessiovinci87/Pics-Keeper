/**
 * Test script: verifica dati SP-API vs DB per un singolo ASIN.
 *
 * Uso: node test-single-asin.js [ASIN] [marketplace_country_code]
 * Es:  node test-single-asin.js B0XXXXXXXX FR
 *
 * Se non si passano parametri, prende l'ASIN con più ordini dal DB.
 */
require('dotenv').config();

const { Pool } = require('pg');
const SpApiClient = require('./src/services/sp-api.client');
const config = require('./src/config');

const pool = new Pool(config.db);

async function main() {
  const targetAsin = process.argv[2] || null;
  const targetCountry = process.argv[3] || null;

  try {
    // 1) Find ASIN to test
    let asin, countryCode;

    if (targetAsin && targetCountry) {
      asin = targetAsin;
      countryCode = targetCountry;
      console.log(`\n=== Test ASIN: ${asin} su ${countryCode} ===\n`);
    } else {
      // Pick the ASIN with most orders
      const { rows } = await pool.query(`
        SELECT o.asin, m.country_code, COUNT(*) as cnt,
               SUM(o.quantity) as units, SUM(o.item_price) as revenue
        FROM orders_raw o
        JOIN marketplaces m ON m.id = o.marketplace_id
        WHERE o.account_id = 1
        GROUP BY o.asin, m.country_code
        ORDER BY cnt DESC
        LIMIT 5
      `);

      if (rows.length === 0) {
        console.error('Nessun ordine nel DB. Impossibile testare.');
        process.exit(1);
      }

      console.log('\n=== Top 5 ASIN per numero ordini nel DB ===');
      console.table(rows);

      asin = rows[0].asin;
      countryCode = rows[0].country_code;
      console.log(`\nTesto: ${asin} su ${countryCode}\n`);
    }

    // 2) Get DB data for this ASIN
    const dbOrders = await pool.query(`
      SELECT o.amazon_order_id, o.asin, o.quantity, o.item_price, o.item_tax,
             o.shipping_price, o.shipping_tax, o.promotion_discount,
             o.order_status, o.purchase_date, o.currency,
             m.country_code
      FROM orders_raw o
      JOIN marketplaces m ON m.id = o.marketplace_id
      WHERE o.account_id = 1
        AND o.asin = $1
        AND m.country_code = $2
      ORDER BY o.purchase_date DESC
      LIMIT 10
    `, [asin, countryCode]);

    console.log(`=== DB: ${dbOrders.rows.length} ordini trovati (ultimi 10) ===`);
    for (const r of dbOrders.rows) {
      console.log(`  ${r.amazon_order_id} | qty=${r.quantity} | price=${r.item_price} | tax=${r.item_tax} | status=${r.order_status} | ${r.purchase_date}`);
    }

    // 3) Get account credentials + marketplace info
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
    console.log(`\nTarget: account=${target.account_id}, seller=${target.seller_id}, marketplace=${target.amazon_marketplace_id}, region=${target.region}`);

    // 4) Call SP-API for a few specific orders to compare
    const spApi = new SpApiClient(target);

    // Take first 3 orders from DB and verify each with the API
    const testOrders = dbOrders.rows.slice(0, 3);

    console.log(`\n=== Chiamata SP-API per ${testOrders.length} ordini ===\n`);

    for (const dbOrder of testOrders) {
      console.log(`--- Order: ${dbOrder.amazon_order_id} ---`);

      try {
        const apiItems = await spApi.getOrderItems(dbOrder.amazon_order_id);

        // Find the matching ASIN in the API response
        const apiItem = apiItems.find(i => i.ASIN === asin);

        if (!apiItem) {
          console.log(`  API: ASIN ${asin} NON trovato negli items!`);
          console.log(`  API items:`, apiItems.map(i => i.ASIN));
          continue;
        }

        const apiPrice = parseFloat(apiItem.ItemPrice?.Amount || 0);
        const apiTax = parseFloat(apiItem.ItemTax?.Amount || 0);
        const apiShipping = parseFloat(apiItem.ShippingPrice?.Amount || 0);
        const apiShippingTax = parseFloat(apiItem.ShippingTax?.Amount || 0);
        const apiPromoDiscount = parseFloat(apiItem.PromotionDiscount?.Amount || 0);
        const apiQty = apiItem.QuantityOrdered || 0;

        const dbPrice = parseFloat(dbOrder.item_price || 0);
        const dbTax = parseFloat(dbOrder.item_tax || 0);
        const dbShipping = parseFloat(dbOrder.shipping_price || 0);
        const dbShippingTax = parseFloat(dbOrder.shipping_tax || 0);
        const dbPromo = parseFloat(dbOrder.promotion_discount || 0);
        const dbQty = parseInt(dbOrder.quantity || 0);

        console.log(`  Campo            | DB          | API         | Match`);
        console.log(`  -----------------+-------------+-------------+------`);
        console.log(`  Quantity         | ${pad(dbQty)}| ${pad(apiQty)}| ${dbQty === apiQty ? 'OK' : 'MISMATCH!'}`);
        console.log(`  ItemPrice        | ${pad(dbPrice)}| ${pad(apiPrice)}| ${dbPrice === apiPrice ? 'OK' : 'MISMATCH!'}`);
        console.log(`  ItemTax          | ${pad(dbTax)}| ${pad(apiTax)}| ${dbTax === apiTax ? 'OK' : 'MISMATCH!'}`);
        console.log(`  ShippingPrice    | ${pad(dbShipping)}| ${pad(apiShipping)}| ${dbShipping === apiShipping ? 'OK' : 'MISMATCH!'}`);
        console.log(`  ShippingTax      | ${pad(dbShippingTax)}| ${pad(apiShippingTax)}| ${dbShippingTax === apiShippingTax ? 'OK' : 'MISMATCH!'}`);
        console.log(`  PromotionDiscount| ${pad(dbPromo)}| ${pad(apiPromoDiscount)}| ${dbPromo === apiPromoDiscount ? 'OK' : 'MISMATCH!'}`);
        console.log(`  Currency         | ${dbOrder.currency || 'N/A'}       | ${apiItem.ItemPrice?.CurrencyCode || 'N/A'}       |`);
        console.log();

        // Also show raw API data for reference
        console.log(`  RAW API response per questo item:`);
        console.log(`  `, JSON.stringify({
          ASIN: apiItem.ASIN,
          SellerSKU: apiItem.SellerSKU,
          Title: apiItem.Title?.substring(0, 60) + '...',
          QuantityOrdered: apiItem.QuantityOrdered,
          ItemPrice: apiItem.ItemPrice,
          ItemTax: apiItem.ItemTax,
          ShippingPrice: apiItem.ShippingPrice,
          ShippingTax: apiItem.ShippingTax,
          PromotionDiscount: apiItem.PromotionDiscount,
        }, null, 2));
        console.log();

      } catch (err) {
        console.log(`  ERRORE API: ${err.message}`);
      }
    }

    // 5) Summary: totals from DB
    const totals = await pool.query(`
      SELECT COUNT(*) as ordini, SUM(quantity) as units,
             SUM(item_price) as revenue, SUM(item_tax) as tax
      FROM orders_raw
      WHERE account_id = 1 AND asin = $1
        AND marketplace_id = (SELECT id FROM marketplaces WHERE country_code = $2)
    `, [asin, countryCode]);

    console.log(`\n=== TOTALI DB per ${asin} su ${countryCode} ===`);
    console.log(`  Ordini: ${totals.rows[0].ordini}`);
    console.log(`  Unità:  ${totals.rows[0].units}`);
    console.log(`  Revenue: ${totals.rows[0].revenue}`);
    console.log(`  Tax:     ${totals.rows[0].tax}`);

  } catch (err) {
    console.error('Errore:', err);
  } finally {
    await pool.end();
  }
}

function pad(val) {
  return String(val).padEnd(12);
}

main();
