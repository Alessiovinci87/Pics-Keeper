-- Fix: financial_events_raw unique constraint doesn't match ON CONFLICT
-- when amazon_order_id or fee_type are NULL (PostgreSQL treats NULLs as distinct).
-- Replace with NULLS NOT DISTINCT to allow ON CONFLICT to work with NULL values.

ALTER TABLE financial_events_raw
  DROP CONSTRAINT IF EXISTS financial_events_raw_account_id_amazon_order_id_event_type_f_key,
  DROP CONSTRAINT IF EXISTS financial_events_raw_account_id_amazon_order_id_event_type_fee_key;

-- Try dropping by common auto-generated constraint names
DO $$
BEGIN
  -- Drop the existing unique constraint (name may vary)
  EXECUTE (
    SELECT 'ALTER TABLE financial_events_raw DROP CONSTRAINT ' || conname
    FROM pg_constraint
    WHERE conrelid = 'financial_events_raw'::regclass
      AND contype = 'u'
    LIMIT 1
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'No existing unique constraint found, continuing...';
END $$;

-- Recreate with NULLS NOT DISTINCT so ON CONFLICT works with NULL values
ALTER TABLE financial_events_raw
  ADD CONSTRAINT financial_events_raw_unique_event
  UNIQUE NULLS NOT DISTINCT (account_id, amazon_order_id, event_type, fee_type, event_date);
