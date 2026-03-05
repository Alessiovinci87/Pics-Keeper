-- Fix: financial_events_raw unique constraint doesn't match ON CONFLICT
-- when amazon_order_id or fee_type are NULL (PostgreSQL treats NULLs as distinct).
-- Replace with NULLS NOT DISTINCT to allow ON CONFLICT to work with NULL values.

-- Step 1: Drop the existing unique constraint
DO $$
BEGIN
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

-- Step 2: Remove duplicate rows, keeping only the most recent (highest id)
DELETE FROM financial_events_raw a
USING financial_events_raw b
WHERE a.id < b.id
  AND a.account_id IS NOT DISTINCT FROM b.account_id
  AND a.amazon_order_id IS NOT DISTINCT FROM b.amazon_order_id
  AND a.event_type IS NOT DISTINCT FROM b.event_type
  AND a.fee_type IS NOT DISTINCT FROM b.fee_type
  AND a.event_date IS NOT DISTINCT FROM b.event_date;

-- Step 3: Recreate with NULLS NOT DISTINCT so ON CONFLICT works with NULL values
ALTER TABLE financial_events_raw
  ADD CONSTRAINT financial_events_raw_unique_event
  UNIQUE NULLS NOT DISTINCT (account_id, amazon_order_id, event_type, fee_type, event_date);
