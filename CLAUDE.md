# CLAUDE.md - Istruzioni per Claude Code

## REGOLE CRITICHE - LEGGERE PRIMA DI FARE QUALSIASI COSA

### NON DISTRUGGERE IL DATABASE
- **MAI** eseguire `DROP TABLE`, `DELETE FROM`, `TRUNCATE` su tabelle con dati reali
- **MAI** rieseguire le migration da zero se il DB ha gia' dati
- **MAI** ricreare il database `amazon_finance` se esiste gia'
- Se devi modificare lo schema, crea una NUOVA migration incrementale (es. `006_nome_descrittivo.sql`)
- Prima di qualsiasi operazione distruttiva sul DB, CHIEDI CONFERMA all'utente

### NON SOVRASCRIVERE FILE CRITICI
- **MAI** sovrascrivere `.env` - contiene credenziali reali dell'utente
- **MAI** cancellare file nella cartella `src/database/migrations/`
- Se devi modificare un file, usa Edit (non Write) per cambiare solo le parti necessarie

### COSA E' SUCCESSO (Storico problemi risolti)
Una sessione precedente di Claude ha causato i seguenti problemi che sono stati risolti:
1. Le tabelle del DB sono state ricreate vuote (tutti i dati persi)
2. Il file `.env` e' stato sovrascritto con valori placeholder
3. Le credenziali SP-API e Ads API sono state cancellate

Questi problemi sono stati corretti. Il DB ora ha lo schema corretto con tutte le migration applicate (001-005), ma le tabelle dati sono vuote perche' l'utente deve ancora inserire il suo account e lasciare che il sistema sincronizzi i dati dalle API Amazon.

---

## Architettura del Progetto

### Stack
- **Backend:** Node.js + Express + PostgreSQL (porta 3000)
- **Frontend:** React 19 + Vite (porta 5173, proxy verso backend)
- **Database:** PostgreSQL, DB name: `amazon_finance`

### Struttura directory
```
Pics-Keeper/
  src/                          # Backend Node.js
    server.js                   # Entry point
    app.js                      # Express setup + middleware
    config/index.js             # Carica .env
    database/
      pool.js                   # Connection pool PostgreSQL
      migrate.js                # Runner migration
      migrations/               # 5 migration SQL (001-005)
    modules/                    # Business logic
      accounts/                 # CRUD account + marketplace linking
      orders/                   # Sync ordini da SP-API
      financial/                # Sync eventi finanziari da SP-API
      ads/                      # Sync spesa ads da Advertising API
      profit-engine/            # Calcolo profitto per riga ordine
      aggregation/              # Aggregazione metriche giornaliere
      alerts/                   # Sistema alerts (negative_profit, low_roi, ecc.)
      asin-costs/               # Gestione costi prodotto per marketplace
      cash/                     # Riconciliazione payout Amazon
    routes/                     # Route Express
      dashboard.routes.js       # GET /api/dashboard/asin, /api/dashboard/account
      product-dashboard.routes.js # GET /api/dashboard/products (per frontend)
      order.routes.js           # GET /api/order/:orderId
      alert.routes.js           # GET/PATCH /api/alerts
      cash.routes.js            # POST/GET /api/cash/payout, /api/cash/summary
      sync.routes.js            # POST /api/sync/trigger/:jobType, GET /api/sync/diagnose
    services/
      sp-api.client.js          # Client Amazon Selling Partner API
      ads-api.client.js         # Client Amazon Advertising API
      sync-logger.js            # Audit trail sync operations
    jobs/
      scheduler.js              # Cron jobs (ordini 10min, financial 15min, ads 15min, profit 20min, alerts 1h)
    middleware/                  # Error handler, validation
    utils/                      # Logger (winston), helpers, custom errors
  frontend/
    src/
      App.jsx                   # Main app con state management e routing
      components/
        ProductTable.jsx        # Dashboard prodotti con metriche
        MarketplaceBreakdown.jsx # Breakdown per marketplace
        AccountsPage.jsx        # CRUD accounts
        AlertsPage.jsx          # Gestione alerts
        AsinCostsPage.jsx       # Costi per ASIN
        CashPage.jsx            # Riconciliazione payout
        SyncPage.jsx            # Trigger sync manuale + log
      services/api.js           # Client HTTP (fetch-based)
      data/mockProducts.js      # Dati mock per demo
```

### Database Schema (18 tabelle)

**Tabelle principali:**
- `accounts` - Account seller (name, seller_id, sp_api_refresh_token, ads_api_refresh_token, ads_profile_ids JSONB)
- `marketplaces` - 12 marketplace pre-caricati (DE, FR, IT, ES, GB, NL, SE, PL, TR, BE, US, CA)
- `account_marketplaces` - Link account<->marketplace con timestamp sync

**Tabelle dati raw (da API Amazon):**
- `orders_raw` - Ordini da SP-API (item_price, fees, status, ecc.)
- `financial_events_raw` - Eventi finanziari (ShipmentEvent, RefundEvent, fee_type, amount)
- `ads_daily_spend` - Spesa ads giornaliera per ASIN (impressions, clicks, spend, sales)

**Tabelle dati computati:**
- `order_profit` - Profitto calcolato per riga ordine (revenue - fees - refunds - ads - costi)
- `asin_daily_metrics` - Metriche giornaliere per ASIN (units, revenue, profit, margin%, ROI%, ACOS%)
- `account_daily_kpi` - KPI giornalieri per account

**Altre:**
- `asins` - Anagrafica ASIN (title, image_url, sku)
- `asin_costs` - Costi prodotto per marketplace (product, inbound, customs, prep, packaging, storage)
- `payout_reconciliation` - Riconciliazione payout Amazon
- `alerts` + `alert_thresholds` - Sistema alerts configurabile
- `sync_log` - Audit trail operazioni sync

### Migration applicate (in ordine)
1. `001_initial_schema.sql` - Schema completo + seed marketplaces
2. `002_widen_varchar_columns.sql` - ASIN varchar(20)->50, fee_type/event_type->255
3. `003_widen_pct_columns.sql` - Percentuali numeric(8,4)->numeric(12,4) per evitare overflow
4. `004_fix_marketplace_ids.sql` - Fix marketplace_id errati per FR e US
5. `005_purge_computed_data.sql` - Purge dati computati + fix marketplace attribution financial events

### Pipeline dati
```
SP-API -> orders_raw ─┐
                       ├──> profit-engine -> order_profit ──> aggregation -> asin_daily_metrics
Financial API -> financial_events_raw ─┘                                └──> account_daily_kpi
Ads API -> ads_daily_spend ─────────────┘                                        │
                                                                          alerts evaluation
```

### Variabili ambiente (.env)
```
PORT=3000
DB_HOST=localhost / DB_PORT=5432 / DB_NAME=amazon_finance / DB_USER=postgres / DB_PASSWORD=...
SP_API_APP_CLIENT_ID=...        # Credenziali app-level (non per-account)
SP_API_APP_CLIENT_SECRET=...
ADS_API_CLIENT_ID=...
ADS_API_CLIENT_SECRET=...
SYNC_MAX_DAYS_BACK=30           # Finestra sync in giorni
```

### Avvio applicazione
```bash
# Backend
npm install
node src/database/migrate.js    # Solo prima volta o dopo nuove migration
npm start                       # o: npm run dev (nodemon)

# Frontend (altra shell)
cd frontend && npm install && npm run dev
```

### Comandi utili
```bash
# Trigger sync manuale
curl -X POST http://localhost:3000/api/sync/trigger/orders
curl -X POST http://localhost:3000/api/sync/trigger/financial
curl -X POST http://localhost:3000/api/sync/trigger/ads
curl -X POST http://localhost:3000/api/sync/trigger/compute
curl -X POST http://localhost:3000/api/sync/trigger/alerts

# Diagnostica
curl "http://localhost:3000/api/sync/diagnose?accountId=1"
curl "http://localhost:3000/api/sync/log?accountId=1&limit=20"

# Reset sync (forza re-download)
curl -X POST http://localhost:3000/api/sync/reset -H "Content-Type: application/json" -d '{"accountId":1}'
```

### Problemi noti e soluzioni gia' implementate
1. **Financial Events API** non fornisce ASIN direttamente, solo SellerSKU -> risolto con lookup su orders_raw + asins
2. **Financial Events API** restituisce eventi di TUTTI i marketplace -> risolto con lookup marketplace da orders_raw
3. **Numeric overflow** su percentuali (ROI% puo' essere > 9999%) -> risolto con NUMERIC(12,4) + LEAST/GREATEST capping
4. **Ordini cancellati** restavano in order_profit -> risolto con cleanup in profit engine
5. **Rate limiting SP-API** -> risolto con delay 4s tra marketplace + retry su 429

### Cosa manca / TODO futuri
- [ ] Unit test (Jest configurato ma nessun test scritto)
- [ ] Autenticazione API (attualmente nessuna - ok per uso locale)
- [ ] Encryption token a riposo nel DB
- [ ] Monitoring/alerting su fallimenti job
