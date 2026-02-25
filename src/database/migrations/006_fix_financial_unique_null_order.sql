-- ============================================================
-- Migration 006: Fix unique constraint for financial_events_raw
-- The original UNIQUE (account_id, amazon_order_id, event_type, fee_type, event_date)
-- doesn't work correctly when amazon_order_id IS NULL (e.g. ServiceFeeEvent).
-- We need a partial unique index for NULL order_id rows.
-- Also add ASIN to the constraint for multi-ASIN orders (Migration 007 merged).
-- ============================================================

-- Drop the old unique constraint
ALTER TABLE financial_events_raw
  DROP CONSTRAINT IF EXISTS financial_events_raw_account_id_amazon_order_id_event_type_f_key;
ALTER TABLE financial_events_raw
  DROP CONSTRAINT IF EXISTS financial_events_raw_account_id_amazon_order_id_event_type_fee_key;

-- Create unique index for events WITH order_id (includes ASIN for multi-ASIN orders)
CREATE UNIQUE INDEX IF NOT EXISTS uq_fin_events_with_order
  ON financial_events_raw (account_id, amazon_order_id, asin, event_type, fee_type, event_date)
  WHERE amazon_order_id IS NOT NULL;

-- Create unique index for events WITHOUT order_id (ServiceFeeEvent etc.)
CREATE UNIQUE INDEX IF NOT EXISTS uq_fin_events_without_order
  ON financial_events_raw (account_id, event_type, fee_type, event_date)
  WHERE amazon_order_id IS NULL;
