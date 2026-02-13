-- Migration: Add indexes to support dashboard API queries
-- These indexes optimize the read-only dashboard endpoints when
-- marketplaceId filter is omitted (account-wide queries).

-- ASIN dashboard: covers WHERE account_id = $1 AND metric_date BETWEEN ...
-- without requiring marketplace_id in the predicate.
CREATE INDEX IF NOT EXISTS idx_asin_metrics_account_date
  ON asin_daily_metrics(account_id, metric_date);

-- Order profit: covers WHERE account_id = $1 AND amazon_order_id = $2
-- for the order breakdown endpoint (compound filter).
CREATE INDEX IF NOT EXISTS idx_order_profit_account_order
  ON order_profit(account_id, amazon_order_id);
