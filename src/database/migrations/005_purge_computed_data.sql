-- ============================================================
-- Migration 005: Purge all computed data for clean recalculation
-- After fixing revenue formula, fee filtering, and marketplace attribution
-- ============================================================

TRUNCATE order_profit, asin_daily_metrics, account_daily_kpi;
