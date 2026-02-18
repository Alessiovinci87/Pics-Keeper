-- Migration 003: Widen percentage columns from NUMERIC(8,4) to NUMERIC(12,4)
-- Fix: "il campo numeric causa un overflow" when percentage calculations
-- produce large values (e.g., revenue near zero causes margin_pct to explode)

-- order_profit
ALTER TABLE order_profit ALTER COLUMN margin_pct TYPE NUMERIC(12,4);
ALTER TABLE order_profit ALTER COLUMN roi_pct TYPE NUMERIC(12,4);

-- asin_daily_metrics
ALTER TABLE asin_daily_metrics ALTER COLUMN margin_pct TYPE NUMERIC(12,4);
ALTER TABLE asin_daily_metrics ALTER COLUMN roi_pct TYPE NUMERIC(12,4);
ALTER TABLE asin_daily_metrics ALTER COLUMN acos_pct TYPE NUMERIC(12,4);
ALTER TABLE asin_daily_metrics ALTER COLUMN tacos_pct TYPE NUMERIC(12,4);

-- account_daily_kpi
ALTER TABLE account_daily_kpi ALTER COLUMN margin_pct TYPE NUMERIC(12,4);
ALTER TABLE account_daily_kpi ALTER COLUMN roi_pct TYPE NUMERIC(12,4);
ALTER TABLE account_daily_kpi ALTER COLUMN acos_pct TYPE NUMERIC(12,4);
ALTER TABLE account_daily_kpi ALTER COLUMN tacos_pct TYPE NUMERIC(12,4);

-- payout_reconciliation
ALTER TABLE payout_reconciliation ALTER COLUMN difference_pct TYPE NUMERIC(12,4);
