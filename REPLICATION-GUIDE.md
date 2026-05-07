# Amazon Sales Dashboard - Complete Replication Guide

> This document describes the working architecture of the Pics-Keeper project: a Node.js backend that syncs live Amazon sales data via SP-API + Ads API, computes profit per order, and serves an aggregated dashboard to a React frontend. Use this as a blueprint to replicate the system in another project.

---

## 1. HIGH-LEVEL ARCHITECTURE

```
Amazon SP-API (Orders v0)  ─────►  orders_raw  ─────┐
Amazon SP-API (Financial v0)  ──►  financial_events  ─┤
Amazon Ads API v3 (Reports)  ──►  ads_daily_spend  ──┤
                                                      ▼
                                              profit-engine
                                              (per order line)
                                                      │
                                                      ▼
                                              order_profit
                                                      │
                                                      ▼
                                              aggregation engine
                                              ┌───────┴────────┐
                                              ▼                ▼
                                    asin_daily_metrics  account_daily_kpi
                                              │
                                              ▼
                                    REST API (/api/dashboard/products)
                                              │
                                              ▼
                                    React frontend (ProductTable)
```

**Stack:** Node.js + Express + PostgreSQL + React 19 + Vite

---

## 2. AMAZON API SETUP

### 2.1 SP-API (Selling Partner API)

**App-level credentials** (shared across all seller accounts):
- `SP_API_APP_CLIENT_ID` — from Amazon Developer Console
- `SP_API_APP_CLIENT_SECRET` — from Amazon Developer Console

**Per-account credentials:**
- `sp_api_refresh_token` — stored in DB `accounts` table, obtained via OAuth flow per seller

**Authentication flow (LWA — Login with Amazon):**
```
POST https://api.amazon.com/auth/o2/token
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token
&refresh_token={account.sp_api_refresh_token}
&client_id={SP_API_APP_CLIENT_ID}
&client_secret={SP_API_APP_CLIENT_SECRET}
```
Returns `access_token` (valid ~1 hour). Cache it, refresh when expired (60s buffer).

**Base URLs by region:**
- EU (IT, DE, FR, ES, GB, NL, SE, PL, TR, BE): `https://sellingpartnerapi-eu.amazon.com`
- NA (US, CA): `https://sellingpartnerapi-na.amazon.com`

### 2.2 Ads API (Amazon Advertising)

**App-level credentials:**
- `ADS_API_CLIENT_ID`
- `ADS_API_CLIENT_SECRET`

**Per-account:**
- `ads_api_refresh_token` — stored in DB
- `ads_profile_ids` — JSONB array: `[{ countryCode: "IT", profileId: "123456" }, ...]`

**Authentication:** Same LWA flow, separate refresh token.

**Base URLs:**
- EU: `https://advertising-api-eu.amazon.com`
- NA: `https://advertising-api.amazon.com`

---

## 3. DATA SYNC PIPELINE (step by step)

### Step 1: Sync Orders (SP-API Orders v0)

**CRITICAL: Use Orders API v0, NOT v2026-01-01.** The v0 API has a different response format.

**Two API calls per order:**

```
GET /orders/v0/orders
  ?MarketplaceIds={marketplace_id}
  &CreatedAfter={dateFrom}
  &CreatedBefore={dateTo}  (must be at least 3 min in the past)
  &NextToken={token}       (for pagination)

GET /orders/v0/orders/{orderId}/orderItems
  → returns OrderItems array with pricing details
```

**Fields to extract from each OrderItem:**

| SP-API Field | DB Column | Notes |
|---|---|---|
| `ASIN` | asin | Product identifier |
| `SellerSKU` | sku | Seller's SKU |
| `QuantityOrdered` | quantity | |
| `ItemPrice.Amount` | item_price | TOTAL for line (not per-unit) |
| `ItemTax.Amount` | item_tax | Tax amount |
| `ShippingPrice.Amount` | shipping_price | |
| `ShippingTax.Amount` | shipping_tax | |
| `PromotionDiscount.Amount` | promotion_discount | |

**Money objects:** `{ CurrencyCode: "EUR", Amount: "12.99" }` — parse Amount as float, default to 0 if missing.

**DB upsert (orders_raw):**
```sql
INSERT INTO orders_raw (account_id, marketplace_id, amazon_order_id, asin, sku,
  quantity, item_price, item_tax, shipping_price, shipping_tax,
  promotion_discount, order_status, purchase_date, currency, raw_data)
VALUES ($1, $2, ...)
ON CONFLICT (account_id, amazon_order_id, asin) DO UPDATE SET
  quantity = EXCLUDED.quantity,
  item_price = EXCLUDED.item_price,
  ...
  updated_at = NOW()
```

**Optimization:** Before fetching order items, check if order already exists with same status. Skip if already synced (saves API calls). Add `force` option to bypass this for re-syncs.

**Rate limiting:** 429 responses → exponential backoff (3s initial, 180s max). Wait 2s between pagination pages, 4s between marketplaces.

### Step 2: Sync Financial Events (SP-API Financial Events v0)

**IMPORTANT: Call ONCE per account, NOT per marketplace.** The API returns events for ALL marketplaces in one stream.

```
GET /finances/v0/financialEvents
  ?PostedAfter={dateFrom}
  &PostedBefore={dateTo}
  &NextToken={token}
```

**Event types to process:**

1. **ShipmentEventList** — revenue + fees per shipment
   - `ShipmentItemList[].ItemChargeList` — revenue components (Principal, Tax, ShippingCharge, ShippingTax, etc.)
   - `ShipmentItemList[].ItemFeeList` — actual fees (Commission, FBAPerUnitFulfillmentFee, etc.)
   - `ShipmentItemList[].ItemTaxWithheldList` — tax withheld (MarketplaceFacilitatorTax)

2. **RefundEventList** — same structure, negative amounts

3. **ServiceFeeEventList** — account-level fees (no order ID)

**Key challenge:** Financial events provide `SellerSKU`, not ASIN. You must resolve SKU→ASIN by looking up `orders_raw` or `asins` table. Cache these lookups in memory.

**Key challenge 2:** Each event needs a `marketplace_id`, but the API doesn't provide it directly. Resolve by looking up the `amazon_order_id` in `orders_raw` to find its marketplace.

**DB upsert (financial_events_raw):**
```sql
INSERT INTO financial_events_raw (account_id, marketplace_id, amazon_order_id, asin,
  event_type, fee_type, amount, currency, event_date, posted_date, raw_data)
VALUES (...)
ON CONFLICT (account_id, amazon_order_id, event_type, fee_type, event_date) DO UPDATE SET ...
```

### Step 3: Sync Ads (Amazon Advertising API v3)

**Three campaign types:** SP (Sponsored Products), SB (Sponsored Brands), SD (Sponsored Display).

For each campaign type, per marketplace:

```
POST /reporting/reports
{
  "reportTypeId": "spAdvertisedProduct",  // or sbPurchasedProduct, sdAdvertisedProduct
  "groupBy": ["asin"],
  "columns": ["advertiserName","campaignId","adGroupId","asin","date",
               "impressions","clicks","spend","sales14d","purchases14d"],
  "reportDate": { "startDate": "2026-03-01", "endDate": "2026-03-31" },
  "timeUnit": "DAILY",
  "format": "GZIP_JSON"
}
```

Poll for completion (GET /reporting/reports/{reportId}), download gzipped JSON.

**DB upsert (ads_daily_spend):**
```sql
INSERT INTO ads_daily_spend (account_id, marketplace_id, asin, spend_date,
  impressions, clicks, spend, sales, orders_count, currency, campaign_type, raw_data)
VALUES (...)
ON CONFLICT (account_id, marketplace_id, asin, spend_date, campaign_type) DO UPDATE SET ...
```

### Step 4: Compute Profit (Profit Engine)

For a given account+marketplace+date range:

1. **Cleanup cancelled orders** from `order_profit`
2. **Build fee map** from `financial_events_raw`:
   ```sql
   SELECT amazon_order_id, asin,
     SUM(CASE WHEN fee_type IN ('Commission','FBAPerUnitFulfillmentFee',...) THEN amount ELSE 0 END) AS referral_fee,
     ...
   FROM financial_events_raw
   WHERE account_id=$1 AND amount < 0
     AND fee_type NOT IN ('Principal','Tax','ShippingCharge','ShippingTax',
       'GiftWrap','GiftWrapTax','FreeReplacementReturnShipping',
       'ShippingChargeback','SHIPPING_CHARGEBACK','ShippingHB','GOODWILL',
       'Goodwill','RestockingFee','REVERSAL_REIMBURSEMENT')
   GROUP BY amazon_order_id, asin
   ```
   **CRITICAL:** The NOT IN list removes REVENUE charge types. Without this filter, revenue charges get counted as fees and profit calculations are completely wrong.

3. **Build costs map** from `asin_costs` (product, inbound, customs, prep, packaging, storage per unit)

4. **For each order line in orders_raw:**
   ```
   revenue = item_price + item_tax + shipping_price + shipping_tax - promotion_discount
   
   fees = referral_fee + fba_fee + other_fees + marketplace_facilitator_tax  (from fee map)
   costs = (product + inbound + customs + prep + packaging) * quantity + storage_allocated + ads_allocated
   refunds = allocated from RefundEvents
   
   net_profit = revenue - ABS(fees) - refunds - costs
   margin_pct = (net_profit / revenue) * 100
   roi_pct = (net_profit / invested_cost) * 100
   ```

5. **Ads allocation:** `(daily_ads_spend / daily_units_sold) * order_quantity`

6. **Upsert into order_profit table**

### Step 5: Aggregate Metrics

From `order_profit`, aggregate into:

**asin_daily_metrics** (grouped by account, marketplace, asin, date):
- units_sold, orders_count, revenue, total_amazon_fees, refunds, ads_spend, total_product_costs, net_profit
- Derived: margin_pct, roi_pct, acos_pct, tacos_pct

**account_daily_kpi** (grouped by account, marketplace, date):
- Same metrics, summed across all ASINs

### Step 6: Serve Dashboard API

```
GET /api/dashboard/products?accountId=1&countryCode=IT&dateFrom=2026-03-01&dateTo=2026-03-31&page=1&limit=50
```

Queries `asin_daily_metrics` with filters, returns:
```json
{
  "data": [
    {
      "asin": "B0...",
      "product_title": "...",
      "revenue": "1234.56",
      "net_profit": "456.78",
      "margin_pct": "37.00",
      "marketplaces": [
        { "country_code": "IT", "revenue": "800.00", ... },
        { "country_code": "DE", "revenue": "434.56", ... }
      ]
    }
  ],
  "summary": {
    "revenue": "5000.00",
    "units_sold": "200",
    "orders_count": "150",
    "net_profit": "1500.00",
    "ads_spend": "300.00",
    "total_amazon_fees": "800.00",
    ...
  },
  "pagination": { "page": 1, "limit": 50, "total": 12 }
}
```

**The summary aggregates across ALL ASINs in the date range (not just the current page).**

---

## 4. DATABASE SCHEMA (essential tables)

```sql
-- Pre-seeded marketplace reference
CREATE TABLE marketplaces (
  id VARCHAR(20) PRIMARY KEY,      -- Amazon marketplace ID (e.g., 'APJ6JRA9NG5V4' for IT)
  country_code VARCHAR(5) NOT NULL, -- 'IT', 'DE', 'FR', etc.
  name VARCHAR(100),
  currency VARCHAR(3) DEFAULT 'EUR',
  region VARCHAR(20) DEFAULT 'EU'
);

-- Seller accounts
CREATE TABLE accounts (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  seller_id VARCHAR(50) UNIQUE NOT NULL,
  sp_api_refresh_token TEXT,
  ads_api_refresh_token TEXT,
  ads_profile_ids JSONB DEFAULT '[]',
  is_active BOOLEAN DEFAULT TRUE
);

-- Account ↔ marketplace link (tracks sync progress)
CREATE TABLE account_marketplaces (
  id SERIAL PRIMARY KEY,
  account_id INTEGER REFERENCES accounts(id),
  marketplace_id VARCHAR(20) REFERENCES marketplaces(id),
  last_orders_sync TIMESTAMPTZ,
  last_financial_sync TIMESTAMPTZ,
  last_ads_sync TIMESTAMPTZ,
  UNIQUE(account_id, marketplace_id)
);

-- Raw orders from SP-API
CREATE TABLE orders_raw (
  id SERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL,
  marketplace_id VARCHAR(20) NOT NULL,
  amazon_order_id VARCHAR(50) NOT NULL,
  asin VARCHAR(50) NOT NULL,
  sku VARCHAR(100),
  quantity INTEGER DEFAULT 1,
  item_price NUMERIC(12,2) DEFAULT 0,
  item_tax NUMERIC(12,2) DEFAULT 0,
  shipping_price NUMERIC(12,2) DEFAULT 0,
  shipping_tax NUMERIC(12,2) DEFAULT 0,
  promotion_discount NUMERIC(12,2) DEFAULT 0,
  order_status VARCHAR(50),
  purchase_date TIMESTAMPTZ,
  currency VARCHAR(3) DEFAULT 'EUR',
  raw_data JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(account_id, amazon_order_id, asin)
);

-- Financial events from SP-API
CREATE TABLE financial_events_raw (
  id SERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL,
  marketplace_id VARCHAR(20),
  amazon_order_id VARCHAR(50),
  asin VARCHAR(50),
  event_type VARCHAR(255) NOT NULL,
  fee_type VARCHAR(255) NOT NULL,
  amount NUMERIC(12,4) DEFAULT 0,
  currency VARCHAR(3) DEFAULT 'EUR',
  event_date TIMESTAMPTZ,
  posted_date TIMESTAMPTZ,
  raw_data JSONB,
  UNIQUE(account_id, amazon_order_id, event_type, fee_type, event_date)
);

-- Ads daily spend
CREATE TABLE ads_daily_spend (
  id SERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL,
  marketplace_id VARCHAR(20) NOT NULL,
  asin VARCHAR(50) NOT NULL,
  spend_date DATE NOT NULL,
  impressions INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  spend NUMERIC(12,4) DEFAULT 0,
  sales NUMERIC(12,4) DEFAULT 0,
  orders_count INTEGER DEFAULT 0,
  currency VARCHAR(3) DEFAULT 'EUR',
  campaign_type VARCHAR(10) DEFAULT 'SP',
  raw_data JSONB,
  UNIQUE(account_id, marketplace_id, asin, spend_date, campaign_type)
);

-- Computed profit per order line
CREATE TABLE order_profit (
  id SERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL,
  marketplace_id VARCHAR(20),
  amazon_order_id VARCHAR(50) NOT NULL,
  asin VARCHAR(50) NOT NULL,
  order_date DATE,
  quantity INTEGER DEFAULT 1,
  revenue NUMERIC(12,4) DEFAULT 0,
  referral_fee NUMERIC(12,4) DEFAULT 0,
  fba_fee NUMERIC(12,4) DEFAULT 0,
  other_amazon_fees NUMERIC(12,4) DEFAULT 0,
  marketplace_facilitator_tax NUMERIC(12,4) DEFAULT 0,
  refund_amount NUMERIC(12,4) DEFAULT 0,
  ads_allocated NUMERIC(12,4) DEFAULT 0,
  product_cost NUMERIC(12,4) DEFAULT 0,
  inbound_cost NUMERIC(12,4) DEFAULT 0,
  customs_cost NUMERIC(12,4) DEFAULT 0,
  prep_cost NUMERIC(12,4) DEFAULT 0,
  packaging_cost NUMERIC(12,4) DEFAULT 0,
  storage_allocated NUMERIC(12,4) DEFAULT 0,
  total_costs NUMERIC(12,4) DEFAULT 0,
  net_profit NUMERIC(12,4) DEFAULT 0,
  margin_pct NUMERIC(12,4) DEFAULT 0,
  roi_pct NUMERIC(12,4) DEFAULT 0,
  currency VARCHAR(3) DEFAULT 'EUR',
  computed_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(account_id, amazon_order_id, asin)
);

-- Aggregated ASIN daily metrics (used by dashboard)
CREATE TABLE asin_daily_metrics (
  id SERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL,
  marketplace_id VARCHAR(20) NOT NULL,
  asin VARCHAR(50) NOT NULL,
  metric_date DATE NOT NULL,
  units_sold INTEGER DEFAULT 0,
  orders_count INTEGER DEFAULT 0,
  revenue NUMERIC(12,4) DEFAULT 0,
  total_amazon_fees NUMERIC(12,4) DEFAULT 0,
  refunds NUMERIC(12,4) DEFAULT 0,
  ads_spend NUMERIC(12,4) DEFAULT 0,
  total_product_costs NUMERIC(12,4) DEFAULT 0,
  net_profit NUMERIC(12,4) DEFAULT 0,
  margin_pct NUMERIC(12,4) DEFAULT 0,
  roi_pct NUMERIC(12,4) DEFAULT 0,
  acos_pct NUMERIC(12,4) DEFAULT 0,
  tacos_pct NUMERIC(12,4) DEFAULT 0,
  currency VARCHAR(3) DEFAULT 'EUR',
  UNIQUE(account_id, marketplace_id, asin, metric_date)
);

-- Product catalog
CREATE TABLE asins (
  id SERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL,
  asin VARCHAR(50) NOT NULL,
  sku VARCHAR(100),
  title VARCHAR(500),
  image_url TEXT,
  UNIQUE(account_id, asin)
);

-- Per-unit costs
CREATE TABLE asin_costs (
  id SERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL,
  asin VARCHAR(50) NOT NULL,
  marketplace_id VARCHAR(20) NOT NULL,
  product_cost NUMERIC(12,4) DEFAULT 0,
  inbound_cost NUMERIC(12,4) DEFAULT 0,
  customs_cost NUMERIC(12,4) DEFAULT 0,
  prep_cost NUMERIC(12,4) DEFAULT 0,
  packaging_cost NUMERIC(12,4) DEFAULT 0,
  storage_monthly_cost NUMERIC(12,4) DEFAULT 0,
  effective_from DATE DEFAULT CURRENT_DATE,
  currency VARCHAR(3) DEFAULT 'EUR',
  UNIQUE(account_id, asin, marketplace_id, effective_from)
);
```

---

## 5. REVENUE FORMULA

**GROSS revenue (ShopKeeper-style, includes tax):**
```
revenue = item_price + item_tax + shipping_price + shipping_tax - promotion_discount
```

**This is NOT the same as Amazon "Vendite di prodotti ordinati"** in Business Reports, which is just `item_price` (product sales only). Our formula matches the total customer payment.

---

## 6. KEY GOTCHAS & LESSONS LEARNED

1. **SP-API v0 vs v2026-01-01:** The v0 API uses PascalCase (`AmazonOrderId`, `ItemPrice.Amount`). The v2026 API uses camelCase with different structure. Stick with v0 for orders — it's proven and stable.

2. **ItemPrice is TOTAL, not per-unit.** If customer orders 3 units at 10€ each, `ItemPrice.Amount = "30.00"`. Do NOT multiply by quantity again.

3. **Financial Events API returns ALL marketplaces.** Call once per account, resolve marketplace from orders_raw lookup.

4. **Revenue charges are NOT fees.** When building the fee map from financial_events_raw, you MUST exclude: Principal, Tax, ShippingCharge, ShippingTax, GiftWrap, GiftWrapTax, FreeReplacementReturnShipping, ShippingChargeback, SHIPPING_CHARGEBACK, ShippingHB, GOODWILL, Goodwill, RestockingFee, REVERSAL_REIMBURSEMENT. Without this filter, your profit calculations will be completely wrong.

5. **isOrderSynced optimization** can prevent re-syncing corrected data. After fixing your order extraction code, you need a `force` mode that bypasses the "already synced" check to re-download all items.

6. **Timezone-aware date grouping.** Italian orders at 23:30 UTC on March 2 are actually March 3 in Rome. Use `AT TIME ZONE 'Europe/Rome'` in SQL.

7. **Ads allocation formula:** `(daily_total_ads_spend / daily_total_units_sold) * order_quantity`. Fallback to 1 if units_sold = 0 to avoid division by zero.

8. **Rate limiting:** SP-API returns 429 with `x-amzn-ratelimit-limit` header. Use exponential backoff 3s→180s. Wait 2s between pages, 4-30s between marketplaces.

9. **Financial events SellerSKU → ASIN resolution:** Financial events only have SellerSKU. Look up the ASIN via orders_raw or asins table. Cache in memory during sync.

10. **Summary across all pages:** The dashboard summary cards must aggregate across ALL ASINs in the date range, not just the current page of results.

---

## 7. MARKETPLACE IDS (pre-seed these)

```sql
INSERT INTO marketplaces (id, country_code, name, currency, region) VALUES
  ('APJ6JRA9NG5V4', 'IT', 'Amazon.it', 'EUR', 'EU'),
  ('A1PA6795UKMFR9', 'DE', 'Amazon.de', 'EUR', 'EU'),
  ('A13V1IB3VIYZZH', 'FR', 'Amazon.fr', 'EUR', 'EU'),
  ('A1RKKUPIHCS9HS', 'ES', 'Amazon.es', 'EUR', 'EU'),
  ('A1F83G8C2ARO7P', 'GB', 'Amazon.co.uk', 'GBP', 'EU'),
  ('A1805IZSGTT6HS', 'NL', 'Amazon.nl', 'EUR', 'EU'),
  ('AMEN7PMS3EDWL', 'BE', 'Amazon.com.be', 'EUR', 'EU'),
  ('A2NODRKZP88ZB9', 'SE', 'Amazon.se', 'SEK', 'EU'),
  ('A1C3SOZRARQ6R3', 'PL', 'Amazon.pl', 'PLN', 'EU'),
  ('A33AVAJ2PDY3EV', 'TR', 'Amazon.com.tr', 'TRY', 'EU'),
  ('ATVPDKIKX0DER', 'US', 'Amazon.com', 'USD', 'NA'),
  ('A2EUQ1WTGCTBG2', 'CA', 'Amazon.ca', 'CAD', 'NA');
```

---

## 8. ENV VARIABLES NEEDED

```env
PORT=3000
DB_HOST=localhost
DB_PORT=5432
DB_NAME=amazon_finance
DB_USER=postgres
DB_PASSWORD=your_password

SP_API_APP_CLIENT_ID=amzn1.application-oa2-client.xxxxx
SP_API_APP_CLIENT_SECRET=xxxxx
ADS_API_CLIENT_ID=amzn1.application-oa2-client.xxxxx
ADS_API_CLIENT_SECRET=xxxxx

SYNC_MAX_DAYS_BACK=30
```

---

## 9. SYNC EXECUTION ORDER

For initial setup or full re-sync:
1. **Orders** → fills `orders_raw` + `asins`
2. **Financial** → fills `financial_events_raw` (needs orders_raw for marketplace resolution)
3. **Ads** → fills `ads_daily_spend`
4. **Compute** → reads all 3 raw tables → writes `order_profit`
5. **Aggregate** → reads `order_profit` + `ads_daily_spend` → writes `asin_daily_metrics` + `account_daily_kpi`

Dependencies: Financial needs Orders first. Compute needs all three. Aggregate needs Compute.

---

## 10. MANUAL TRIGGER ENDPOINTS

```
POST /api/sync/trigger/orders          — sync orders for all marketplaces
POST /api/sync/trigger/financial       — sync financial events
POST /api/sync/trigger/ads             — sync ads data
POST /api/sync/trigger/compute         — run profit engine (last 7 days)
POST /api/sync/trigger/alerts          — evaluate alert thresholds

POST /api/sync/trigger/compute-range   — profit engine for custom range
  Body: { "accountId": 1, "dateFrom": "2026-03-01", "dateTo": "2026-03-31" }

POST /api/sync/trigger/orders/IT       — sync orders for Italy only
  Body: { "force": true }              — bypass "already synced" check

POST /api/sync/reset                   — reset sync timestamps (forces full re-download)
  Body: { "accountId": 1 }
```

---

## 11. KNOWN OPEN ISSUES IN THIS PROJECT

1. **Revenue discrepancy:** IT marketplace shows 541€ vs Amazon's 896€ for 03/03/2026. Likely cause: the `force` re-sync never executed because of a syntax error in sync.routes.js at the time. The syntax error is now fixed on this branch, but the data may not have been re-synced.

2. **Amazon fees showing 0:** Financial events may not be matching orders correctly, or financial sync didn't run after the orders were re-synced.

3. **To fix both:** Run force orders re-sync → financial sync → compute-range for the affected dates.
