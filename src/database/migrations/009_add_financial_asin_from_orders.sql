-- ============================================================
-- Migration 009: Backfill ASIN in financial_events_raw from orders_raw
-- Some financial events may have SKU instead of ASIN. Resolve using orders_raw.
-- Also adds an index for faster marketplace resolution lookups.
-- ============================================================

-- Backfill ASIN where we have order data and the ASIN in financial doesn't match
UPDATE financial_events_raw fe
SET asin = o.asin
FROM orders_raw o
WHERE fe.amazon_order_id = o.amazon_order_id
  AND fe.account_id = o.account_id
  AND o.sku = fe.asin
  AND fe.asin != o.asin;

-- Add index for order_id -> marketplace resolution
CREATE INDEX IF NOT EXISTS idx_orders_raw_order_marketplace
  ON orders_raw (amazon_order_id, account_id, marketplace_id);
