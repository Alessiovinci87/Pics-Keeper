-- ============================================================
-- Business Report Daily - stores Seller Central Business Report data
-- for reconciliation against orders_raw / order_profit data.
--
-- This is the single source of truth from Amazon Seller Central.
-- Data can be imported manually (CSV upload) or via SP-API reports.
-- ============================================================

CREATE TABLE IF NOT EXISTS business_report_daily (
    id                      SERIAL PRIMARY KEY,
    account_id              INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    marketplace_id          INTEGER NOT NULL REFERENCES marketplaces(id),
    report_date             DATE NOT NULL,

    -- Core metrics from Business Report
    ordered_product_sales   NUMERIC(14,4) NOT NULL DEFAULT 0,   -- Vendite di prodotti ordinati
    ordered_product_sales_b2b NUMERIC(14,4) NOT NULL DEFAULT 0,
    units_ordered           INTEGER NOT NULL DEFAULT 0,          -- Unità ordinate
    units_ordered_b2b       INTEGER NOT NULL DEFAULT 0,
    total_order_items       INTEGER NOT NULL DEFAULT 0,          -- Totale articoli ordinati
    total_order_items_b2b   INTEGER NOT NULL DEFAULT 0,

    -- Traffic metrics
    page_views              INTEGER NOT NULL DEFAULT 0,
    page_views_b2b          INTEGER NOT NULL DEFAULT 0,
    sessions                INTEGER NOT NULL DEFAULT 0,
    sessions_b2b            INTEGER NOT NULL DEFAULT 0,

    -- Conversion metrics
    buy_box_pct             NUMERIC(8,4) NOT NULL DEFAULT 0,     -- % Buy Box
    buy_box_pct_b2b         NUMERIC(8,4) NOT NULL DEFAULT 0,
    unit_session_pct        NUMERIC(8,4) NOT NULL DEFAULT 0,     -- % conversione (unità/sessione)
    unit_session_pct_b2b    NUMERIC(8,4) NOT NULL DEFAULT 0,

    currency                VARCHAR(5),
    imported_at             TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE (account_id, marketplace_id, report_date)
);

CREATE INDEX idx_brd_lookup ON business_report_daily(account_id, marketplace_id, report_date);
CREATE INDEX idx_brd_date ON business_report_daily(report_date);

-- ============================================================
-- Reconciliation view: compares orders_raw vs business_report_daily
-- ============================================================
CREATE OR REPLACE VIEW v_sales_reconciliation AS
SELECT
    br.account_id,
    br.marketplace_id,
    m.country_code,
    m.name AS marketplace_name,
    br.report_date,

    -- Business Report (source of truth)
    br.units_ordered AS br_units,
    br.ordered_product_sales AS br_sales,
    br.sessions AS br_sessions,
    br.unit_session_pct AS br_conversion_pct,

    -- orders_raw (our data, using CET timezone for IT/EU)
    COALESCE(ord.db_units, 0) AS db_units,
    COALESCE(ord.db_order_lines, 0) AS db_order_lines,
    COALESCE(ord.db_sales, 0) AS db_sales,

    -- Discrepancy
    COALESCE(ord.db_units, 0) - br.units_ordered AS units_diff,
    CASE WHEN br.units_ordered > 0
        THEN ROUND(((COALESCE(ord.db_units, 0) - br.units_ordered)::numeric / br.units_ordered) * 100, 2)
        ELSE 0 END AS units_diff_pct,

    COALESCE(ord.db_sales, 0) - br.ordered_product_sales AS sales_diff,
    CASE WHEN br.ordered_product_sales > 0
        THEN ROUND(((COALESCE(ord.db_sales, 0) - br.ordered_product_sales) / br.ordered_product_sales) * 100, 2)
        ELSE 0 END AS sales_diff_pct

FROM business_report_daily br
JOIN marketplaces m ON m.id = br.marketplace_id
LEFT JOIN LATERAL (
    SELECT
        SUM(o.quantity) AS db_units,
        COUNT(*) AS db_order_lines,
        SUM(o.item_price + o.shipping_price - o.promotion_discount) AS db_sales
    FROM orders_raw o
    WHERE o.account_id = br.account_id
      AND o.marketplace_id = br.marketplace_id
      AND (o.purchase_date AT TIME ZONE
            CASE m.country_code
                WHEN 'GB' THEN 'Europe/London'
                WHEN 'US' THEN 'America/New_York'
                WHEN 'CA' THEN 'America/Toronto'
                WHEN 'TR' THEN 'Europe/Istanbul'
                ELSE 'Europe/Rome'
            END
          )::date = br.report_date
      AND UPPER(o.order_status) != 'CANCELLED'
) ord ON TRUE
ORDER BY br.report_date, m.country_code;
