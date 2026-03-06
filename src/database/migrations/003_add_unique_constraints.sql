-- Migration 003: Add unique constraints required by ON CONFLICT upserts
-- The aggregation engine uses ON CONFLICT to upsert asin_daily_metrics
-- and account_daily_kpi, but only indexes existed (no unique constraints).

-- 1) Clean duplicate rows in asin_daily_metrics (keep the most recent one)
DELETE FROM asin_daily_metrics a
  USING asin_daily_metrics b
  WHERE a.account_id = b.account_id
    AND a.marketplace_id = b.marketplace_id
    AND a.asin = b.asin
    AND a.metric_date = b.metric_date
    AND a.id < b.id;

-- Drop old non-unique index and add unique constraint
DROP INDEX IF EXISTS idx_asin_metrics_lookup;
ALTER TABLE asin_daily_metrics
  ADD CONSTRAINT uq_asin_daily_metrics
  UNIQUE (account_id, marketplace_id, asin, metric_date);

-- 2) Clean duplicate rows in account_daily_kpi (keep the most recent one)
DELETE FROM account_daily_kpi a
  USING account_daily_kpi b
  WHERE a.account_id = b.account_id
    AND a.kpi_date = b.kpi_date
    AND a.id < b.id
    AND (a.marketplace_id = b.marketplace_id
         OR (a.marketplace_id IS NULL AND b.marketplace_id IS NULL));

-- Drop old non-unique index and add unique constraint (NULLS NOT DISTINCT for marketplace_id=NULL rows)
DROP INDEX IF EXISTS idx_account_kpi_mp;
ALTER TABLE account_daily_kpi
  ADD CONSTRAINT uq_account_daily_kpi
  UNIQUE NULLS NOT DISTINCT (account_id, marketplace_id, kpi_date);
