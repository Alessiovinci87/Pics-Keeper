-- ============================================================
-- Migration 010: Final purge of computed data after all fixes
-- Fee filtering fix (revenue charges counted as fees) requires full recompute.
-- Run compute-range after this migration to recalculate all profit data.
-- ============================================================

TRUNCATE order_profit, asin_daily_metrics, account_daily_kpi;
