-- Migration 006: Fix financial_events_raw unique constraint for NULL amazon_order_id
--
-- Problem: The UNIQUE constraint (account_id, amazon_order_id, event_type, fee_type, event_date)
-- does not prevent duplicates when amazon_order_id IS NULL, because PostgreSQL treats
-- NULL != NULL in unique constraints. This causes ServiceFeeEvents (which have no order ID)
-- to fail on re-sync with duplicate key violations.
--
-- Fix: Create a partial unique index that covers the NULL amazon_order_id case.
-- The application code (upsertEvent) now uses the correct ON CONFLICT clause
-- depending on whether amazon_order_id is NULL or not.

-- Drop if it already exists (may have been created manually)
DROP INDEX IF EXISTS idx_fin_events_null_order_unique;

-- Clean up any existing duplicates first (keep the latest synced row)
DELETE FROM financial_events_raw a
USING financial_events_raw b
WHERE a.amazon_order_id IS NULL
  AND b.amazon_order_id IS NULL
  AND a.account_id = b.account_id
  AND a.event_type = b.event_type
  AND a.fee_type IS NOT DISTINCT FROM b.fee_type
  AND a.event_date = b.event_date
  AND a.id < b.id;

-- Now create partial unique index for events without an order ID
CREATE UNIQUE INDEX idx_fin_events_null_order_unique
ON financial_events_raw (account_id, event_type, fee_type, event_date)
WHERE amazon_order_id IS NULL;
