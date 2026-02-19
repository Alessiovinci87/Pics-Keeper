-- Migration 005: Purge all computed data to force a fresh rebuild.
--
-- Why: Financial events were attributed to wrong marketplaces (the Financial
-- Events API returns events for ALL marketplaces, but they were stored with
-- whichever marketplace synced first). Also, order_profit records for
-- cancelled orders were never cleaned up, inflating unit counts.
--
-- This migration:
--   1. Deletes all computed/aggregated data (order_profit, asin_daily_metrics, account_daily_kpi)
--   2. Fixes financial_events_raw marketplace_id from orders_raw
--   3. Resets sync timestamps so data is re-synced and recomputed
--
-- Raw data (orders_raw, financial_events_raw, ads_daily_spend) is preserved.

-- Step 1: Purge all computed data
DELETE FROM account_daily_kpi;
DELETE FROM asin_daily_metrics;
DELETE FROM order_profit;

-- Step 2: Fix financial_events_raw marketplace_id using orders_raw as source of truth
UPDATE financial_events_raw fe
SET marketplace_id = o.marketplace_id
FROM (
  SELECT DISTINCT account_id, amazon_order_id, marketplace_id
  FROM orders_raw
) o
WHERE fe.account_id = o.account_id
  AND fe.amazon_order_id = o.amazon_order_id
  AND fe.marketplace_id != o.marketplace_id;

-- Step 3: Reset profit/aggregation timestamps to trigger recomputation
-- (orders and financial sync timestamps are preserved to avoid re-fetching from API)
UPDATE account_marketplaces SET sync_status = 'idle';
