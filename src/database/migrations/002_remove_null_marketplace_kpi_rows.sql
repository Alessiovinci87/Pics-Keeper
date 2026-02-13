-- Migration: Remove "all marketplaces" rows (marketplace_id IS NULL) from account_daily_kpi.
--
-- These rows were previously written by aggregateAccountDailyTotal() to store
-- pre-aggregated totals across all marketplaces. The dashboard now computes
-- cross-marketplace aggregations dynamically at query time, so these rows are
-- no longer needed and should not be recreated.

DELETE FROM account_daily_kpi WHERE marketplace_id IS NULL;
