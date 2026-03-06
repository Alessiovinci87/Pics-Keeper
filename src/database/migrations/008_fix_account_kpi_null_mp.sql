-- Migration 008: Fix account_daily_kpi upsert for NULL marketplace_id
--
-- Problem: The ON CONFLICT (account_id, marketplace_id, kpi_date) clause
-- doesn't work for NULL marketplace_id rows (PostgreSQL: NULL != NULL).
-- A partial unique index idx_account_kpi_null_mp_unique exists in the DB
-- but the code wasn't using it.
--
-- Fix: Ensure the partial unique index exists so the code's updated
-- ON CONFLICT (account_id, kpi_date) WHERE marketplace_id IS NULL works.

-- Create the partial unique index for NULL marketplace_id if it doesn't exist
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_kpi_null_mp_unique
ON account_daily_kpi (account_id, kpi_date)
WHERE marketplace_id IS NULL;

-- Clean up any duplicate NULL-marketplace rows (keep the latest)
DELETE FROM account_daily_kpi a
USING account_daily_kpi b
WHERE a.marketplace_id IS NULL
  AND b.marketplace_id IS NULL
  AND a.account_id = b.account_id
  AND a.kpi_date = b.kpi_date
  AND a.id < b.id;
