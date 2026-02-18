-- Migration 004: Fix incorrect Amazon marketplace IDs
-- FR was A13V1IB3VIYBER (wrong), correct is A13V1IB3VIYZZH
-- US was ATVPDKIKX0DER (extra R), correct is ATVPDKIKX0DE

UPDATE marketplaces SET marketplace_id = 'A13V1IB3VIYZZH' WHERE country_code = 'FR';
UPDATE marketplaces SET marketplace_id = 'ATVPDKIKX0DE' WHERE country_code = 'US';
