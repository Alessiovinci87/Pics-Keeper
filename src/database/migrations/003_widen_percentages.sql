-- ============================================================
-- Migration 003: Widen percentage columns from NUMERIC(8,4) to NUMERIC(12,4)
-- to avoid overflow on extreme values
-- ============================================================

ALTER TABLE order_profit ALTER COLUMN margin_pct TYPE NUMERIC(12,4);
ALTER TABLE order_profit ALTER COLUMN roi_pct TYPE NUMERIC(12,4);

ALTER TABLE asin_daily_metrics ALTER COLUMN margin_pct TYPE NUMERIC(12,4);
ALTER TABLE asin_daily_metrics ALTER COLUMN roi_pct TYPE NUMERIC(12,4);
ALTER TABLE asin_daily_metrics ALTER COLUMN acos_pct TYPE NUMERIC(12,4);
ALTER TABLE asin_daily_metrics ALTER COLUMN tacos_pct TYPE NUMERIC(12,4);

ALTER TABLE account_daily_kpi ALTER COLUMN margin_pct TYPE NUMERIC(12,4);
ALTER TABLE account_daily_kpi ALTER COLUMN roi_pct TYPE NUMERIC(12,4);
ALTER TABLE account_daily_kpi ALTER COLUMN acos_pct TYPE NUMERIC(12,4);
ALTER TABLE account_daily_kpi ALTER COLUMN tacos_pct TYPE NUMERIC(12,4);
