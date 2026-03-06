-- ============================================================
-- Widen VARCHAR columns that are too narrow for real SP-API data
-- ============================================================

-- SellerSKU used as ASIN fallback can exceed 20 chars
ALTER TABLE financial_events_raw ALTER COLUMN asin TYPE VARCHAR(50);
ALTER TABLE orders_raw ALTER COLUMN asin TYPE VARCHAR(50);
ALTER TABLE order_profit ALTER COLUMN asin TYPE VARCHAR(50);
ALTER TABLE asin_daily_metrics ALTER COLUMN asin TYPE VARCHAR(50);
ALTER TABLE asins ALTER COLUMN asin TYPE VARCHAR(50);
ALTER TABLE asin_costs ALTER COLUMN asin TYPE VARCHAR(50);
ALTER TABLE ads_daily_spend ALTER COLUMN asin TYPE VARCHAR(50);
ALTER TABLE alerts ALTER COLUMN asin TYPE VARCHAR(50);

-- Fee descriptions from SP-API can exceed 100 chars
ALTER TABLE financial_events_raw ALTER COLUMN fee_type TYPE VARCHAR(255);

-- Event types can be longer than expected
ALTER TABLE financial_events_raw ALTER COLUMN event_type TYPE VARCHAR(255);
