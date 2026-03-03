-- ============================================================
-- Business Report Daily — stores "Units Ordered" from
-- GET_SALES_AND_TRAFFIC_REPORT (same source as Shopkeeper)
-- ============================================================

CREATE TABLE business_report_daily (
    id              SERIAL PRIMARY KEY,
    account_id      INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    marketplace_id  INTEGER NOT NULL REFERENCES marketplaces(id),
    report_date     DATE NOT NULL,
    asin            VARCHAR(20) NOT NULL,
    sku             VARCHAR(50),
    units_ordered   INTEGER NOT NULL DEFAULT 0,
    ordered_product_sales   NUMERIC(14,2) NOT NULL DEFAULT 0,
    ordered_product_sales_b2b NUMERIC(14,2) NOT NULL DEFAULT 0,
    total_order_items       INTEGER NOT NULL DEFAULT 0,
    browser_sessions        INTEGER NOT NULL DEFAULT 0,
    mobile_app_sessions     INTEGER NOT NULL DEFAULT 0,
    sessions                INTEGER NOT NULL DEFAULT 0,
    browser_page_views      INTEGER NOT NULL DEFAULT 0,
    mobile_app_page_views   INTEGER NOT NULL DEFAULT 0,
    page_views              INTEGER NOT NULL DEFAULT 0,
    buy_box_percentage      NUMERIC(7,4) NOT NULL DEFAULT 0,
    unit_session_percentage NUMERIC(7,4) NOT NULL DEFAULT 0,
    currency        VARCHAR(5) NOT NULL DEFAULT 'EUR',
    synced_at       TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (account_id, marketplace_id, report_date, asin)
);

CREATE INDEX idx_brd_lookup ON business_report_daily(account_id, marketplace_id, report_date);
CREATE INDEX idx_brd_asin ON business_report_daily(account_id, asin, report_date);
