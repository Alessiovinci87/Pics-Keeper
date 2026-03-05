-- Fix: financial_events_raw unique constraint doesn't match ON CONFLICT
-- when amazon_order_id or fee_type are NULL (PostgreSQL treats NULLs as distinct).
-- Replace with NULLS NOT DISTINCT to allow ON CONFLICT to work with NULL values.

-- Set lock timeout to 10 seconds so we don't hang forever waiting for locks
SET lock_timeout = '10s';

-- Step 1: Drop ALL existing unique constraints on the table
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'financial_events_raw'::regclass AND contype = 'u'
  LOOP
    EXECUTE 'ALTER TABLE financial_events_raw DROP CONSTRAINT ' || r.conname;
    RAISE NOTICE 'Dropped constraint: %', r.conname;
  END LOOP;
END $$;

-- Step 2: Remove duplicate rows keeping only the row with the highest id per group
DELETE FROM financial_events_raw a
USING (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY account_id,
      COALESCE(amazon_order_id, ''),
      event_type,
      COALESCE(fee_type, ''),
      event_date
    ORDER BY id DESC
  ) AS rn
  FROM financial_events_raw
) b
WHERE a.id = b.id AND b.rn > 1;

-- Step 3: Recreate with NULLS NOT DISTINCT so ON CONFLICT works with NULL values
ALTER TABLE financial_events_raw
  ADD CONSTRAINT financial_events_raw_unique_event
  UNIQUE NULLS NOT DISTINCT (account_id, amazon_order_id, event_type, fee_type, event_date);

-- Reset lock timeout
SET lock_timeout = 0;
