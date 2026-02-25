-- ============================================================
-- Migration 004: Add marketplace_facilitator_tax column to order_profit
-- This tracks MarketplaceFacilitatorTax separately (offsets IVA in gross revenue)
-- ============================================================

ALTER TABLE order_profit
  ADD COLUMN IF NOT EXISTS marketplace_facilitator_tax NUMERIC(12,4) NOT NULL DEFAULT 0;
