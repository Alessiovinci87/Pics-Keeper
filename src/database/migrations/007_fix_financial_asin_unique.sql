-- Migration 007: Include ASIN in financial_events_raw unique constraint
--
-- Problem: The unique constraint (account_id, amazon_order_id, event_type, fee_type, event_date)
-- does NOT include ASIN. Multi-item orders (multiple ASINs) lose fee data
-- because later ASINs' fees overwrite earlier ones on re-sync.
--
-- Fix: Drop the old constraint and create a new unique index that includes ASIN.
-- Uses COALESCE for NULL ASIN handling (from unresolved SKUs).

-- Step 1: Find and drop the old unique constraint
DO $$
DECLARE
  constr_name TEXT;
BEGIN
  SELECT c.conname INTO constr_name
  FROM pg_constraint c
  JOIN pg_class t ON c.conrelid = t.oid
  WHERE t.relname = 'financial_events_raw'
    AND c.contype = 'u'
    AND array_length(c.conkey, 1) = 5;

  IF constr_name IS NOT NULL THEN
    EXECUTE 'ALTER TABLE financial_events_raw DROP CONSTRAINT ' || quote_ident(constr_name);
    RAISE NOTICE 'Dropped constraint: %', constr_name;
  END IF;
END $$;

-- Step 2: Clean up any duplicate rows that would violate the new constraint
DELETE FROM financial_events_raw a
USING financial_events_raw b
WHERE a.amazon_order_id IS NOT NULL
  AND b.amazon_order_id IS NOT NULL
  AND a.account_id = b.account_id
  AND a.amazon_order_id = b.amazon_order_id
  AND a.event_type = b.event_type
  AND a.fee_type IS NOT DISTINCT FROM b.fee_type
  AND a.event_date = b.event_date
  AND a.asin IS NOT DISTINCT FROM b.asin
  AND a.id < b.id;

-- Step 3: Create new unique index that includes ASIN
-- Uses COALESCE to handle NULL asin and fee_type
CREATE UNIQUE INDEX IF NOT EXISTS idx_fin_events_unique_with_asin
ON financial_events_raw (account_id, amazon_order_id, COALESCE(asin, ''), event_type, COALESCE(fee_type, ''), event_date)
WHERE amazon_order_id IS NOT NULL;

-- Step 4: Also purge order_profit and asin_daily_metrics so they get recomputed
-- with the corrected fee data on next profit engine run
TRUNCATE order_profit;
TRUNCATE asin_daily_metrics;
TRUNCATE account_daily_kpi;
