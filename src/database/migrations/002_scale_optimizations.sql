-- ============================================================
-- Migration 002: Scale Optimizations
-- - Safer unique constraint on financial_events_raw
-- - Missing composite indexes for high-scale queries
-- ============================================================

-- ------------------------------------
-- 4. FINANCIAL EVENTS UNIQUENESS FIX
-- ------------------------------------
-- The old constraint UNIQUE(account_id, amazon_order_id, event_type, fee_type, event_date)
-- is unsafe: it collapses multiple events of the same type+fee on the same order+date
-- but with different amounts (e.g., two separate Commission charges on the same order
-- posted at the same timestamp). Adding amount and posted_date makes collisions far
-- less likely while still providing deduplication.

ALTER TABLE financial_events_raw
  DROP CONSTRAINT IF EXISTS financial_events_raw_account_id_amazon_order_id_event_type__key;

ALTER TABLE financial_events_raw
  ADD CONSTRAINT financial_events_raw_unique_event
  UNIQUE (account_id, amazon_order_id, event_type, fee_type, amount, posted_date);

-- ------------------------------------
-- 7. INDEX OPTIMIZATION
-- ------------------------------------
-- Composite indexes that cover the WHERE clauses used by profit engine bulk queries.
-- Only created IF NOT EXISTS to be idempotent.

-- financial_events_raw: covers buildFeeMap + buildRefundMap queries
CREATE INDEX IF NOT EXISTS idx_fin_events_profit_lookup
  ON financial_events_raw (account_id, marketplace_id, event_type, event_date);

-- ads_daily_spend: covers buildAdsSpendMap query
CREATE INDEX IF NOT EXISTS idx_ads_spend_profit_lookup
  ON ads_daily_spend (account_id, marketplace_id, spend_date);

-- order_profit: covers aggregation and dashboard queries by account+date
CREATE INDEX IF NOT EXISTS idx_order_profit_account_date
  ON order_profit (account_id, order_date);

-- orders_raw: covers buildStorageMap with month truncation
CREATE INDEX IF NOT EXISTS idx_orders_raw_account_mp_status_date
  ON orders_raw (account_id, marketplace_id, order_status, purchase_date);
