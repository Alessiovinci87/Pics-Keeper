-- Migration 009: Fix financial_events_raw marketplace attribution
--
-- Problem: The previous financial sync called the Financial Events API once per
-- marketplace target. Since the API returns events for ALL marketplaces of the
-- account, events were misattributed to the wrong marketplace (fallback to the
-- sync target's marketplace when the order wasn't yet in orders_raw).
--
-- Fix: Update financial_events_raw.marketplace_id to match the actual
-- marketplace from orders_raw for all events where the order exists.
-- Then purge computed tables so they get recomputed with correct data.

-- Step 1: Fix marketplace_id on financial events using orders_raw as source of truth
UPDATE financial_events_raw fe
SET marketplace_id = o.marketplace_id
FROM orders_raw o
WHERE fe.account_id = o.account_id
  AND fe.amazon_order_id = o.amazon_order_id
  AND fe.amazon_order_id IS NOT NULL
  AND fe.marketplace_id != o.marketplace_id;

-- Step 2: Purge computed tables so they get recomputed with correct marketplace attribution
TRUNCATE order_profit;
TRUNCATE asin_daily_metrics;
TRUNCATE account_daily_kpi;
