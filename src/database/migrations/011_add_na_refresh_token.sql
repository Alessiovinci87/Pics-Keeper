-- ============================================================
-- Migration 011: Add separate SP-API refresh token for NA region
-- EU and NA require separate authorization on Seller Central.
-- ============================================================

ALTER TABLE accounts ADD COLUMN sp_api_refresh_token_na TEXT;

COMMENT ON COLUMN accounts.sp_api_refresh_token IS 'SP-API refresh token for EU region';
COMMENT ON COLUMN accounts.sp_api_refresh_token_na IS 'SP-API refresh token for NA region (US, CA, MX, BR)';
