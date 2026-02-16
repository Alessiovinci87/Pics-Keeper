-- ============================================================
-- Migration: Add ads_sync_enabled flag to account_marketplaces
-- Allows per-marketplace control of Amazon Advertising sync
-- ============================================================

ALTER TABLE account_marketplaces
  ADD COLUMN ads_sync_enabled BOOLEAN NOT NULL DEFAULT FALSE;

-- Enable ads sync for marketplaces where accounts already have ads credentials
UPDATE account_marketplaces am
SET ads_sync_enabled = TRUE
FROM accounts a
WHERE am.account_id = a.id
  AND a.ads_api_refresh_token IS NOT NULL
  AND a.ads_api_refresh_token != '';
