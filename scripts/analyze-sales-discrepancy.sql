-- ============================================================
-- Sales Discrepancy Analysis: orders_raw vs Seller Central Business Report
-- Period: 22-28 February 2026 | Marketplace: Amazon.it (ID=3)
-- ============================================================
-- Target from Business Report (Seller Central):
--   791 units ordered for IT in the week 22-28 Feb 2026
-- Current orders_raw query result: 842 units
-- Discrepancy: +51 units (842 - 791 = 51 extra units in DB)
-- ============================================================

-- ============================================================
-- STEP 1: Baseline - Total units in orders_raw (NO filters)
-- This is the raw 842 number
-- ============================================================
SELECT
  'Step 1: ALL orders (no status filter)' AS analysis,
  COUNT(*) AS order_lines,
  SUM(quantity) AS total_units
FROM orders_raw
WHERE marketplace_id = 3
  AND purchase_date >= '2026-02-22'
  AND purchase_date < '2026-03-01';

-- ============================================================
-- STEP 2: Breakdown by order_status
-- Identifies how many units are Cancelled/Pending
-- ============================================================
SELECT
  'Step 2: By order_status' AS analysis,
  order_status,
  COUNT(*) AS order_lines,
  SUM(quantity) AS total_units
FROM orders_raw
WHERE marketplace_id = 3
  AND purchase_date >= '2026-02-22'
  AND purchase_date < '2026-03-01'
GROUP BY order_status
ORDER BY total_units DESC;

-- ============================================================
-- STEP 3: Units excluding Cancelled and Pending
-- This is what profit.service.js uses
-- ============================================================
SELECT
  'Step 3: Excluding Cancelled+Pending' AS analysis,
  COUNT(*) AS order_lines,
  SUM(quantity) AS total_units
FROM orders_raw
WHERE marketplace_id = 3
  AND purchase_date >= '2026-02-22'
  AND purchase_date < '2026-03-01'
  AND order_status NOT IN ('Cancelled', 'Pending');

-- ============================================================
-- STEP 4: Daily breakdown (excluding Cancelled/Pending)
-- Compare with Business Report daily data:
--   22/02: 115 | 23/02: 128 | 24/02: 120 | 25/02: 141
--   26/02: 113 | 27/02: 79  | 28/02: 95  | Total: 791
-- ============================================================
SELECT
  'Step 4: Daily breakdown' AS analysis,
  purchase_date::date AS order_date,
  COUNT(*) AS order_lines,
  SUM(quantity) AS total_units
FROM orders_raw
WHERE marketplace_id = 3
  AND purchase_date >= '2026-02-22'
  AND purchase_date < '2026-03-01'
  AND order_status NOT IN ('Cancelled', 'Pending')
GROUP BY purchase_date::date
ORDER BY order_date;

-- ============================================================
-- STEP 5: Timezone edge cases
-- Check if orders near midnight UTC shift between days
-- Business Report uses marketplace local time (CET = UTC+1)
-- ============================================================
SELECT
  'Step 5: Timezone edge check (23:00-01:00 CET window)' AS analysis,
  purchase_date AT TIME ZONE 'Europe/Rome' AS local_time,
  (purchase_date AT TIME ZONE 'Europe/Rome')::date AS local_date,
  purchase_date::date AS utc_date,
  amazon_order_id,
  asin,
  quantity,
  order_status
FROM orders_raw
WHERE marketplace_id = 3
  AND (
    -- Orders that might be on 21/02 in CET but 22/02 in UTC
    (purchase_date >= '2026-02-21 23:00:00+00' AND purchase_date < '2026-02-22 00:00:00+00')
    OR
    -- Orders that might be on 28/02 in CET but 01/03 in UTC
    (purchase_date >= '2026-02-28 23:00:00+00' AND purchase_date < '2026-03-01 01:00:00+00')
    OR
    -- Orders on 01/03 UTC that are still 28/02 in CET
    (purchase_date >= '2026-03-01 00:00:00+00' AND purchase_date < '2026-03-01 01:00:00+00')
  )
  AND order_status NOT IN ('Cancelled', 'Pending')
ORDER BY purchase_date;

-- ============================================================
-- STEP 6: Daily breakdown using CET timezone
-- Business Report uses local marketplace time
-- ============================================================
SELECT
  'Step 6: Daily breakdown (CET timezone)' AS analysis,
  (purchase_date AT TIME ZONE 'Europe/Rome')::date AS local_date,
  COUNT(*) AS order_lines,
  SUM(quantity) AS total_units
FROM orders_raw
WHERE marketplace_id = 3
  AND purchase_date AT TIME ZONE 'Europe/Rome' >= '2026-02-22'
  AND purchase_date AT TIME ZONE 'Europe/Rome' < '2026-03-01'
  AND order_status NOT IN ('Cancelled', 'Pending')
GROUP BY (purchase_date AT TIME ZONE 'Europe/Rome')::date
ORDER BY local_date;

-- ============================================================
-- STEP 7: Check for duplicate order lines (same order, same ASIN)
-- The UNIQUE constraint should prevent this, but check raw_data
-- ============================================================
SELECT
  'Step 7: Potential duplicates' AS analysis,
  amazon_order_id,
  asin,
  COUNT(*) AS occurrences,
  SUM(quantity) AS total_qty
FROM orders_raw
WHERE marketplace_id = 3
  AND purchase_date >= '2026-02-22'
  AND purchase_date < '2026-03-01'
GROUP BY amazon_order_id, asin
HAVING COUNT(*) > 1;

-- ============================================================
-- STEP 8: Check ship_to_country from raw_data JSONB
-- Orders placed on Amazon.it but shipped to other countries
-- (or orders from other marketplaces shipped to IT)
-- ============================================================
SELECT
  'Step 8: Ship-to-country analysis' AS analysis,
  raw_data->'order'->>'ShipCountry' AS ship_country_1,
  raw_data->'order'->'ShippingAddress'->>'CountryCode' AS ship_country_2,
  raw_data->'order'->'DefaultShipFromLocationAddress'->>'CountryCode' AS ship_from,
  COUNT(*) AS order_lines,
  SUM(quantity) AS total_units
FROM orders_raw
WHERE marketplace_id = 3
  AND purchase_date >= '2026-02-22'
  AND purchase_date < '2026-03-01'
  AND order_status NOT IN ('Cancelled', 'Pending')
GROUP BY
  raw_data->'order'->>'ShipCountry',
  raw_data->'order'->'ShippingAddress'->>'CountryCode',
  raw_data->'order'->'DefaultShipFromLocationAddress'->>'CountryCode'
ORDER BY total_units DESC;

-- ============================================================
-- STEP 9: Check what account_daily_kpi shows for this period
-- This is what the dashboard actually displays
-- ============================================================
SELECT
  'Step 9: account_daily_kpi data' AS analysis,
  kpi_date,
  units_sold,
  orders_count,
  revenue,
  net_profit,
  margin_pct
FROM account_daily_kpi
WHERE marketplace_id = 3
  AND kpi_date >= '2026-02-22'
  AND kpi_date <= '2026-02-28'
ORDER BY kpi_date;

-- ============================================================
-- STEP 10: Compare with order_profit (profit engine output)
-- ============================================================
SELECT
  'Step 10: order_profit data' AS analysis,
  order_date,
  COUNT(*) AS order_lines,
  SUM(quantity) AS total_units,
  SUM(revenue) AS total_revenue
FROM order_profit
WHERE marketplace_id = 3
  AND order_date >= '2026-02-22'
  AND order_date <= '2026-02-28'
GROUP BY order_date
ORDER BY order_date;

-- ============================================================
-- SUMMARY: Expected reconciliation path
-- ============================================================
-- If Step 3 shows ~791 after excluding Cancelled/Pending → problem was status filter
-- If Step 6 (CET) differs from Step 4 (UTC) → timezone issue
-- If Step 8 shows non-IT countries → cross-border orders inflating count
-- If Step 7 finds duplicates → data integrity issue
--
-- RECOMMENDATION: The Business Report "Units Ordered" metric from Seller Central
-- should be the single source of truth. Our system should:
-- 1. Filter out Cancelled/Pending orders in ALL queries (not just profit engine)
-- 2. Use marketplace local timezone for date grouping
-- 3. Consider adding a business_report_daily table to store and reconcile against
--    the official Seller Central numbers
-- ============================================================
