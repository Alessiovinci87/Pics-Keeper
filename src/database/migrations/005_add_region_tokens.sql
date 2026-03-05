-- Add region-specific SP-API refresh tokens
-- Structure: {"EU": "Atzr|...", "NA": "Atzr|..."}
-- Falls back to sp_api_refresh_token if region key not present
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS sp_api_region_tokens JSONB DEFAULT '{}';
