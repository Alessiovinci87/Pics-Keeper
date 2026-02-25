-- ============================================================
-- Migration 002: Widen ASIN to VARCHAR(50), fee_type/event_type to VARCHAR(255)
-- ============================================================

ALTER TABLE asins ALTER COLUMN asin TYPE VARCHAR(50);
ALTER TABLE asin_costs ALTER COLUMN asin TYPE VARCHAR(50);
ALTER TABLE orders_raw ALTER COLUMN asin TYPE VARCHAR(50);
ALTER TABLE financial_events_raw ALTER COLUMN asin TYPE VARCHAR(50);
ALTER TABLE financial_events_raw ALTER COLUMN fee_type TYPE VARCHAR(255);
ALTER TABLE financial_events_raw ALTER COLUMN event_type TYPE VARCHAR(255);
ALTER TABLE order_profit ALTER COLUMN asin TYPE VARCHAR(50);
ALTER TABLE asin_daily_metrics ALTER COLUMN asin TYPE VARCHAR(50);
ALTER TABLE ads_daily_spend ALTER COLUMN asin TYPE VARCHAR(50);
ALTER TABLE alerts ALTER COLUMN asin TYPE VARCHAR(50);
