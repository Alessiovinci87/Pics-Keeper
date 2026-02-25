-- ============================================================
-- Migration 007: Fix unique index on account_daily_kpi for NULL marketplace_id
-- The standard UNIQUE constraint treats NULL != NULL, so the cross-marketplace
-- aggregate row (marketplace_id = NULL) doesn't get upserted properly.
-- Replace with a partial unique index.
-- ============================================================

-- Drop the old constraint
ALTER TABLE account_daily_kpi
  DROP CONSTRAINT IF EXISTS account_daily_kpi_account_id_marketplace_id_kpi_date_key;

-- Unique index for rows WITH marketplace_id
CREATE UNIQUE INDEX IF NOT EXISTS uq_account_kpi_with_mp
  ON account_daily_kpi (account_id, marketplace_id, kpi_date)
  WHERE marketplace_id IS NOT NULL;

-- Unique index for rows WITHOUT marketplace_id (cross-marketplace aggregate)
CREATE UNIQUE INDEX IF NOT EXISTS uq_account_kpi_without_mp
  ON account_daily_kpi (account_id, kpi_date)
  WHERE marketplace_id IS NULL;
