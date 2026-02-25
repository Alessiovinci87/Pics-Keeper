-- ============================================================
-- Migration 008: Fix marketplace_id in financial_events_raw
-- The financial events API returns events for ALL marketplaces in one response.
-- Previously we were assigning the sync target's marketplace_id, which was wrong.
-- Now we resolve the correct marketplace via orders_raw (source of truth).
-- This migration fixes all existing rows where marketplace was misattributed.
-- ============================================================

UPDATE financial_events_raw fe
SET marketplace_id = o.marketplace_id
FROM orders_raw o
WHERE fe.amazon_order_id = o.amazon_order_id
  AND fe.account_id = o.account_id
  AND fe.marketplace_id != o.marketplace_id;
