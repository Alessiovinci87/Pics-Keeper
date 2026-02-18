-- ============================================================
-- Amazon Financial Analysis Engine - Initial Schema
-- ============================================================

-- ------------------------------------
-- ENUM TYPES
-- ------------------------------------
CREATE TYPE sync_status AS ENUM ('idle', 'running', 'failed');
CREATE TYPE alert_severity AS ENUM ('info', 'warning', 'critical');
CREATE TYPE alert_status AS ENUM ('active', 'acknowledged', 'resolved');

-- ------------------------------------
-- ACCOUNTS
-- ------------------------------------
CREATE TABLE accounts (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(255) NOT NULL,
    seller_id       VARCHAR(100) NOT NULL UNIQUE,
    -- SP-API credentials (encrypted at rest in production)
    sp_api_refresh_token    TEXT,
    ads_api_refresh_token   TEXT,
    ads_profile_ids         JSONB DEFAULT '[]',
    is_active       BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ------------------------------------
-- MARKETPLACES
-- ------------------------------------
CREATE TABLE marketplaces (
    id              SERIAL PRIMARY KEY,
    marketplace_id  VARCHAR(20) NOT NULL UNIQUE,   -- e.g. A1PA6795UKMFR9
    country_code    VARCHAR(5) NOT NULL,            -- e.g. DE, IT, US
    name            VARCHAR(100) NOT NULL,          -- e.g. Amazon.de
    region          VARCHAR(20) NOT NULL,            -- EU, NA
    currency        VARCHAR(5) NOT NULL DEFAULT 'EUR',
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Seed EU + NA marketplaces
INSERT INTO marketplaces (marketplace_id, country_code, name, region, currency) VALUES
    ('A1PA6795UKMFR9', 'DE', 'Amazon.de', 'EU', 'EUR'),
    ('A13V1IB3VIYZZH', 'FR', 'Amazon.fr', 'EU', 'EUR'),
    ('APJ6JRA9NG5V4',  'IT', 'Amazon.it', 'EU', 'EUR'),
    ('A1RKKUPIHCS9HS', 'ES', 'Amazon.es', 'EU', 'EUR'),
    ('A1F83G8C2ARO7P', 'GB', 'Amazon.co.uk', 'EU', 'GBP'),
    ('A1805IZSGTT6HS', 'NL', 'Amazon.nl', 'EU', 'EUR'),
    ('A2NODRKZP88ZB9', 'SE', 'Amazon.se', 'EU', 'SEK'),
    ('A1C3SOZRARQ6R3', 'PL', 'Amazon.pl', 'EU', 'PLN'),
    ('A33AVAJ2PDY3EV', 'TR', 'Amazon.com.tr', 'EU', 'TRY'),
    ('A17E79C6D8DWNP', 'BE', 'Amazon.com.be', 'EU', 'EUR'),
    ('ATVPDKIKX0DE',   'US', 'Amazon.com', 'NA', 'USD'),
    ('A2EUQ1WTGCTBG2', 'CA', 'Amazon.ca', 'NA', 'CAD')
ON CONFLICT (marketplace_id) DO NOTHING;

-- ------------------------------------
-- ACCOUNT <-> MARKETPLACE link
-- ------------------------------------
CREATE TABLE account_marketplaces (
    id              SERIAL PRIMARY KEY,
    account_id      INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    marketplace_id  INTEGER NOT NULL REFERENCES marketplaces(id),
    is_active       BOOLEAN DEFAULT TRUE,
    last_orders_sync_at     TIMESTAMPTZ,
    last_financial_sync_at  TIMESTAMPTZ,
    last_ads_sync_at        TIMESTAMPTZ,
    sync_status     sync_status DEFAULT 'idle',
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (account_id, marketplace_id)
);

-- ------------------------------------
-- ASINS
-- ------------------------------------
CREATE TABLE asins (
    id              SERIAL PRIMARY KEY,
    account_id      INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    asin            VARCHAR(20) NOT NULL,
    sku             VARCHAR(100),
    title           TEXT,
    image_url       TEXT,
    is_active       BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (account_id, asin)
);

CREATE INDEX idx_asins_account ON asins(account_id);
CREATE INDEX idx_asins_asin ON asins(asin);

-- ------------------------------------
-- ASIN COSTS (per marketplace)
-- ------------------------------------
CREATE TABLE asin_costs (
    id                  SERIAL PRIMARY KEY,
    account_id          INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    asin                VARCHAR(20) NOT NULL,
    marketplace_id      INTEGER NOT NULL REFERENCES marketplaces(id),
    product_cost        NUMERIC(12,4) NOT NULL DEFAULT 0,
    inbound_cost        NUMERIC(12,4) NOT NULL DEFAULT 0,
    customs_cost        NUMERIC(12,4) NOT NULL DEFAULT 0,
    prep_cost           NUMERIC(12,4) NOT NULL DEFAULT 0,
    packaging_cost      NUMERIC(12,4) NOT NULL DEFAULT 0,
    storage_monthly_cost NUMERIC(12,4) NOT NULL DEFAULT 0,
    currency            VARCHAR(5) NOT NULL DEFAULT 'EUR',
    effective_from      DATE NOT NULL DEFAULT CURRENT_DATE,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (account_id, asin, marketplace_id, effective_from)
);

CREATE INDEX idx_asin_costs_lookup ON asin_costs(account_id, asin, marketplace_id);

-- ------------------------------------
-- ORDERS RAW (from SP-API)
-- ------------------------------------
CREATE TABLE orders_raw (
    id                  SERIAL PRIMARY KEY,
    account_id          INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    marketplace_id      INTEGER NOT NULL REFERENCES marketplaces(id),
    amazon_order_id     VARCHAR(50) NOT NULL,
    asin                VARCHAR(20) NOT NULL,
    sku                 VARCHAR(100),
    quantity            INTEGER NOT NULL DEFAULT 1,
    item_price          NUMERIC(12,4) DEFAULT 0,
    item_tax            NUMERIC(12,4) DEFAULT 0,
    shipping_price      NUMERIC(12,4) DEFAULT 0,
    shipping_tax        NUMERIC(12,4) DEFAULT 0,
    promotion_discount  NUMERIC(12,4) DEFAULT 0,
    order_status        VARCHAR(50),
    purchase_date       TIMESTAMPTZ NOT NULL,
    currency            VARCHAR(5),
    raw_data            JSONB,
    synced_at           TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (account_id, amazon_order_id, asin)
);

CREATE INDEX idx_orders_raw_account ON orders_raw(account_id);
CREATE INDEX idx_orders_raw_marketplace ON orders_raw(marketplace_id);
CREATE INDEX idx_orders_raw_asin ON orders_raw(asin);
CREATE INDEX idx_orders_raw_date ON orders_raw(purchase_date);
CREATE INDEX idx_orders_raw_order_id ON orders_raw(amazon_order_id);
CREATE INDEX idx_orders_raw_lookup ON orders_raw(account_id, marketplace_id, purchase_date);

-- ------------------------------------
-- FINANCIAL EVENTS RAW (from Financial Events API)
-- ------------------------------------
CREATE TABLE financial_events_raw (
    id                  SERIAL PRIMARY KEY,
    account_id          INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    marketplace_id      INTEGER NOT NULL REFERENCES marketplaces(id),
    amazon_order_id     VARCHAR(50),
    asin                VARCHAR(20),
    event_type          VARCHAR(100) NOT NULL,  -- ShipmentEvent, RefundEvent, etc.
    fee_type            VARCHAR(100),            -- FBAPerUnitFulfillmentFee, Commission, etc.
    amount              NUMERIC(12,4) NOT NULL DEFAULT 0,
    currency            VARCHAR(5),
    event_date          TIMESTAMPTZ NOT NULL,
    posted_date         TIMESTAMPTZ,
    raw_data            JSONB,
    synced_at           TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (account_id, amazon_order_id, event_type, fee_type, event_date)
);

CREATE INDEX idx_fin_events_account ON financial_events_raw(account_id);
CREATE INDEX idx_fin_events_order ON financial_events_raw(amazon_order_id);
CREATE INDEX idx_fin_events_asin ON financial_events_raw(asin);
CREATE INDEX idx_fin_events_date ON financial_events_raw(event_date);
CREATE INDEX idx_fin_events_type ON financial_events_raw(event_type);
CREATE INDEX idx_fin_events_lookup ON financial_events_raw(account_id, marketplace_id, event_date);

-- ------------------------------------
-- ADS DAILY SPEND (from Advertising API)
-- ------------------------------------
CREATE TABLE ads_daily_spend (
    id                  SERIAL PRIMARY KEY,
    account_id          INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    marketplace_id      INTEGER NOT NULL REFERENCES marketplaces(id),
    asin                VARCHAR(20) NOT NULL,
    spend_date          DATE NOT NULL,
    impressions         INTEGER DEFAULT 0,
    clicks              INTEGER DEFAULT 0,
    spend               NUMERIC(12,4) NOT NULL DEFAULT 0,
    sales               NUMERIC(12,4) DEFAULT 0,
    orders_count        INTEGER DEFAULT 0,
    currency            VARCHAR(5),
    campaign_type       VARCHAR(50),        -- SP, SB, SD
    raw_data            JSONB,
    synced_at           TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (account_id, marketplace_id, asin, spend_date, campaign_type)
);

CREATE INDEX idx_ads_account ON ads_daily_spend(account_id);
CREATE INDEX idx_ads_asin ON ads_daily_spend(asin);
CREATE INDEX idx_ads_date ON ads_daily_spend(spend_date);
CREATE INDEX idx_ads_lookup ON ads_daily_spend(account_id, marketplace_id, asin, spend_date);

-- ------------------------------------
-- ORDER PROFIT (computed by Profit Engine)
-- ------------------------------------
CREATE TABLE order_profit (
    id                      SERIAL PRIMARY KEY,
    account_id              INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    marketplace_id          INTEGER NOT NULL REFERENCES marketplaces(id),
    amazon_order_id         VARCHAR(50) NOT NULL,
    asin                    VARCHAR(20) NOT NULL,
    order_date              DATE NOT NULL,
    quantity                INTEGER NOT NULL DEFAULT 1,

    -- Revenue
    revenue                 NUMERIC(12,4) NOT NULL DEFAULT 0,

    -- Amazon fees (all stored as positive numbers, subtracted in calculations)
    referral_fee            NUMERIC(12,4) NOT NULL DEFAULT 0,
    fba_fee                 NUMERIC(12,4) NOT NULL DEFAULT 0,
    other_amazon_fees       NUMERIC(12,4) NOT NULL DEFAULT 0,

    -- Refunds
    refund_amount           NUMERIC(12,4) NOT NULL DEFAULT 0,

    -- Ads (allocated)
    ads_allocated           NUMERIC(12,4) NOT NULL DEFAULT 0,

    -- Product costs
    product_cost            NUMERIC(12,4) NOT NULL DEFAULT 0,
    inbound_cost            NUMERIC(12,4) NOT NULL DEFAULT 0,
    customs_cost            NUMERIC(12,4) NOT NULL DEFAULT 0,
    prep_cost               NUMERIC(12,4) NOT NULL DEFAULT 0,
    packaging_cost          NUMERIC(12,4) NOT NULL DEFAULT 0,
    storage_allocated       NUMERIC(12,4) NOT NULL DEFAULT 0,

    -- Calculated fields
    total_costs             NUMERIC(12,4) NOT NULL DEFAULT 0,
    net_profit              NUMERIC(12,4) NOT NULL DEFAULT 0,
    margin_pct              NUMERIC(8,4) NOT NULL DEFAULT 0,
    roi_pct                 NUMERIC(8,4) NOT NULL DEFAULT 0,

    currency                VARCHAR(5),
    computed_at             TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE (account_id, amazon_order_id, asin)
);

CREATE INDEX idx_order_profit_account ON order_profit(account_id);
CREATE INDEX idx_order_profit_marketplace ON order_profit(marketplace_id);
CREATE INDEX idx_order_profit_asin ON order_profit(asin);
CREATE INDEX idx_order_profit_date ON order_profit(order_date);
CREATE INDEX idx_order_profit_order ON order_profit(amazon_order_id);
CREATE INDEX idx_order_profit_lookup ON order_profit(account_id, marketplace_id, asin, order_date);

-- ------------------------------------
-- ASIN DAILY METRICS (aggregated)
-- ------------------------------------
CREATE TABLE asin_daily_metrics (
    id                      SERIAL PRIMARY KEY,
    account_id              INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    marketplace_id          INTEGER NOT NULL REFERENCES marketplaces(id),
    asin                    VARCHAR(20) NOT NULL,
    metric_date             DATE NOT NULL,

    units_sold              INTEGER NOT NULL DEFAULT 0,
    orders_count            INTEGER NOT NULL DEFAULT 0,
    revenue                 NUMERIC(12,4) NOT NULL DEFAULT 0,
    total_amazon_fees       NUMERIC(12,4) NOT NULL DEFAULT 0,
    refunds                 NUMERIC(12,4) NOT NULL DEFAULT 0,
    ads_spend               NUMERIC(12,4) NOT NULL DEFAULT 0,
    total_product_costs     NUMERIC(12,4) NOT NULL DEFAULT 0,
    net_profit              NUMERIC(12,4) NOT NULL DEFAULT 0,
    margin_pct              NUMERIC(8,4) NOT NULL DEFAULT 0,
    roi_pct                 NUMERIC(8,4) NOT NULL DEFAULT 0,
    acos_pct                NUMERIC(8,4) NOT NULL DEFAULT 0,
    tacos_pct               NUMERIC(8,4) NOT NULL DEFAULT 0,

    currency                VARCHAR(5),
    computed_at             TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE (account_id, marketplace_id, asin, metric_date)
);

CREATE INDEX idx_asin_metrics_lookup ON asin_daily_metrics(account_id, marketplace_id, asin, metric_date);

-- ------------------------------------
-- ACCOUNT DAILY KPI (aggregated)
-- ------------------------------------
CREATE TABLE account_daily_kpi (
    id                      SERIAL PRIMARY KEY,
    account_id              INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    marketplace_id          INTEGER REFERENCES marketplaces(id),  -- NULL = all marketplaces
    kpi_date                DATE NOT NULL,

    units_sold              INTEGER NOT NULL DEFAULT 0,
    orders_count            INTEGER NOT NULL DEFAULT 0,
    revenue                 NUMERIC(14,4) NOT NULL DEFAULT 0,
    total_amazon_fees       NUMERIC(14,4) NOT NULL DEFAULT 0,
    refunds                 NUMERIC(14,4) NOT NULL DEFAULT 0,
    ads_spend               NUMERIC(14,4) NOT NULL DEFAULT 0,
    total_product_costs     NUMERIC(14,4) NOT NULL DEFAULT 0,
    net_profit              NUMERIC(14,4) NOT NULL DEFAULT 0,
    margin_pct              NUMERIC(8,4) NOT NULL DEFAULT 0,
    roi_pct                 NUMERIC(8,4) NOT NULL DEFAULT 0,
    acos_pct                NUMERIC(8,4) NOT NULL DEFAULT 0,
    tacos_pct               NUMERIC(8,4) NOT NULL DEFAULT 0,

    currency                VARCHAR(5),
    computed_at             TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE (account_id, marketplace_id, kpi_date)
);

CREATE INDEX idx_account_kpi_lookup ON account_daily_kpi(account_id, kpi_date);
CREATE INDEX idx_account_kpi_mp ON account_daily_kpi(account_id, marketplace_id, kpi_date);

-- ------------------------------------
-- PAYOUT RECONCILIATION (Cash Analysis)
-- ------------------------------------
CREATE TABLE payout_reconciliation (
    id                      SERIAL PRIMARY KEY,
    account_id              INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    marketplace_id          INTEGER REFERENCES marketplaces(id),
    payout_date             DATE NOT NULL,
    payout_amount           NUMERIC(14,4) NOT NULL,
    accrued_profit          NUMERIC(14,4),          -- profit calculated for same period
    difference              NUMERIC(14,4),
    difference_pct          NUMERIC(8,4),
    period_start            DATE NOT NULL,
    period_end              DATE NOT NULL,
    notes                   TEXT,
    currency                VARCHAR(5),
    created_at              TIMESTAMPTZ DEFAULT NOW(),
    updated_at              TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_payout_account ON payout_reconciliation(account_id);
CREATE INDEX idx_payout_date ON payout_reconciliation(payout_date);

-- ------------------------------------
-- ALERTS
-- ------------------------------------
CREATE TABLE alerts (
    id                      SERIAL PRIMARY KEY,
    account_id              INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    marketplace_id          INTEGER REFERENCES marketplaces(id),
    asin                    VARCHAR(20),
    alert_type              VARCHAR(50) NOT NULL,     -- negative_profit, low_roi, high_acos, ads_spike, payout_drift
    severity                alert_severity NOT NULL DEFAULT 'warning',
    status                  alert_status NOT NULL DEFAULT 'active',
    title                   VARCHAR(500) NOT NULL,
    message                 TEXT,
    metric_value            NUMERIC(14,4),
    threshold_value         NUMERIC(14,4),
    context                 JSONB,                     -- additional structured data
    triggered_at            TIMESTAMPTZ DEFAULT NOW(),
    acknowledged_at         TIMESTAMPTZ,
    resolved_at             TIMESTAMPTZ
);

CREATE INDEX idx_alerts_account ON alerts(account_id);
CREATE INDEX idx_alerts_status ON alerts(status);
CREATE INDEX idx_alerts_type ON alerts(alert_type);
CREATE INDEX idx_alerts_triggered ON alerts(triggered_at);
CREATE INDEX idx_alerts_lookup ON alerts(account_id, status, triggered_at);

-- ------------------------------------
-- SYNC LOG (audit trail for all sync operations)
-- ------------------------------------
CREATE TABLE sync_log (
    id                  SERIAL PRIMARY KEY,
    account_id          INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    marketplace_id      INTEGER REFERENCES marketplaces(id),
    sync_type           VARCHAR(50) NOT NULL,   -- orders, financial, ads, profit, aggregation, alerts
    status              VARCHAR(20) NOT NULL,    -- started, completed, failed
    records_processed   INTEGER DEFAULT 0,
    records_inserted    INTEGER DEFAULT 0,
    records_updated     INTEGER DEFAULT 0,
    error_message       TEXT,
    started_at          TIMESTAMPTZ DEFAULT NOW(),
    completed_at        TIMESTAMPTZ,
    duration_ms         INTEGER
);

CREATE INDEX idx_sync_log_account ON sync_log(account_id);
CREATE INDEX idx_sync_log_type ON sync_log(sync_type);
CREATE INDEX idx_sync_log_started ON sync_log(started_at);

-- ------------------------------------
-- ALERT THRESHOLDS (configurable per account)
-- ------------------------------------
CREATE TABLE alert_thresholds (
    id              SERIAL PRIMARY KEY,
    account_id      INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    alert_type      VARCHAR(50) NOT NULL,
    threshold_value NUMERIC(14,4) NOT NULL,
    is_active       BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (account_id, alert_type)
);

-- Seed default thresholds (account_id=0 means global defaults)
-- These are used as fallbacks when account-specific thresholds are not set.
