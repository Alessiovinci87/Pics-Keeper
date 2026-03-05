import { useState, useEffect, useMemo } from 'react';
import Sidebar from './components/Sidebar';
import DashboardHeader from './components/DashboardHeader';
import ProductTable from './components/ProductTable';
import AlertsPage from './components/AlertsPage';
import AsinCostsPage from './components/AsinCostsPage';
import CashPage from './components/CashPage';
import AccountsPage from './components/AccountsPage';
import SyncPage from './components/SyncPage';
import { fetchProducts, fetchAccounts } from './services/api';
import './App.css';

function App() {
  const [section, setSection] = useState('products');
  const [accounts, setAccounts] = useState([]);
  const [selectedAccountId, setSelectedAccountId] = useState(null);
  const [products, setProducts] = useState([]);
  const [summary, setSummary] = useState(null);
  const [pagination, setPagination] = useState({ page: 1, limit: 50, total: 0 });
  const [loading, setLoading] = useState(true);
  const [backendConnected, setBackendConnected] = useState(false);
  const [selectedMarketplace, setSelectedMarketplace] = useState(null);
  const [dateRange, setDateRange] = useState(() => {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    const t = `${yyyy}-${mm}-${dd}`;
    return { from: t, to: t };
  });

  // Load accounts on mount
  useEffect(() => {
    loadAccounts();
  }, []);

  // Load products when account, date, or page changes
  useEffect(() => {
    if (section === 'products') {
      loadProducts();
    }
  }, [selectedAccountId, dateRange, pagination.page, section]);

  // Reset to page 1 when filters change
  useEffect(() => {
    setPagination(prev => ({ ...prev, page: 1 }));
  }, [selectedAccountId, dateRange]);

  async function loadAccounts() {
    try {
      const result = await fetchAccounts();
      setAccounts(result.data || []);
      setBackendConnected(true);
      if (result.data && result.data.length > 0 && !selectedAccountId) {
        setSelectedAccountId(result.data[0].id);
      }
    } catch {
      setBackendConnected(false);
      setAccounts([]);
    }
  }

  async function loadProducts() {
    if (!selectedAccountId) {
      setProducts([]);
      setSummary(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const result = await fetchProducts({
        accountId: selectedAccountId,
        dateFrom: dateRange.from,
        dateTo: dateRange.to,
        page: pagination.page,
      });
      setProducts(result.data || []);
      setSummary(result.summary || null);
      setPagination(prev => ({
        ...prev,
        total: result.pagination?.total || 0,
        limit: result.pagination?.limit || 50,
      }));
    } catch {
      setProducts([]);
      setSummary(null);
    } finally {
      setLoading(false);
    }
  }

  // Filter products by selected marketplace.
  // Always show all products — if a product has no data for the selected
  // marketplace, show it with zeroed metrics so the user can still see
  // ads spend or identify where to take action.
  const filteredProducts = useMemo(() => {
    if (!selectedMarketplace) return products;

    return products.map((p) => {
      const mp = (p.marketplaces || []).find((m) => m.country_code === selectedMarketplace);
      const emptyMp = {
        country_code: selectedMarketplace,
        marketplace_name: selectedMarketplace,
        currency: 'EUR',
        units_sold: 0, orders_count: 0, revenue: 0,
        total_amazon_fees: 0, refunds: 0, ads_spend: 0,
        total_product_costs: 0, net_profit: 0,
        margin_pct: 0, roi_pct: 0, tacos_pct: 0,
      };
      const data = mp || emptyMp;
      return {
        ...p,
        units_sold: data.units_sold,
        orders_count: data.orders_count,
        revenue: data.revenue,
        total_amazon_fees: data.total_amazon_fees,
        refunds: data.refunds,
        ads_spend: data.ads_spend,
        total_product_costs: data.total_product_costs,
        net_profit: data.net_profit,
        margin_pct: data.margin_pct,
        roi_pct: data.roi_pct,
        tacos_pct: data.tacos_pct,
        marketplaces: mp ? [mp] : [],
      };
    });
  }, [products, selectedMarketplace]);

  function renderContent() {
    switch (section) {
      case 'products': {
        const totalPages = Math.ceil(pagination.total / pagination.limit) || 1;
        return (
          <>
            <DashboardHeader
              products={filteredProducts}
              summary={summary}
              dateRange={dateRange}
              onDateChange={setDateRange}
              selectedMarketplace={selectedMarketplace}
              onMarketplaceChange={setSelectedMarketplace}
            />
            {loading ? (
              <div className="loading-state">
                <div className="spinner" />
                <p>Caricamento prodotti...</p>
              </div>
            ) : (
              <>
                <ProductTable products={filteredProducts} />
                {totalPages > 1 && (
                  <div className="pagination-controls">
                    <button
                      disabled={pagination.page <= 1}
                      onClick={() => setPagination(prev => ({ ...prev, page: prev.page - 1 }))}
                    >
                      &larr; Precedente
                    </button>
                    <span className="pagination-info">
                      Pagina {pagination.page} di {totalPages} ({pagination.total} prodotti)
                    </span>
                    <button
                      disabled={pagination.page >= totalPages}
                      onClick={() => setPagination(prev => ({ ...prev, page: prev.page + 1 }))}
                    >
                      Successiva &rarr;
                    </button>
                  </div>
                )}
              </>
            )}
          </>
        );
      }
      case 'alerts':
        return <AlertsPage accountId={selectedAccountId} />;
      case 'costs':
        return <AsinCostsPage accountId={selectedAccountId} />;
      case 'cash':
        return <CashPage accountId={selectedAccountId} dateRange={dateRange} />;
      case 'accounts':
        return <AccountsPage accounts={accounts} onRefresh={loadAccounts} />;
      case 'sync':
        return <SyncPage accountId={selectedAccountId} />;
      default:
        return (
          <>
            <DashboardHeader
              products={filteredProducts}
              summary={summary}
              dateRange={dateRange}
              onDateChange={setDateRange}
              selectedMarketplace={selectedMarketplace}
              onMarketplaceChange={setSelectedMarketplace}
            />
            <ProductTable products={filteredProducts} />
          </>
        );
    }
  }

  return (
    <div className="app-layout">
      <Sidebar
        activeSection={section}
        onNavigate={setSection}
        accounts={accounts}
        selectedAccountId={selectedAccountId}
        onAccountChange={setSelectedAccountId}
        backendConnected={backendConnected}
      />
      <main className="main-content">
        {!backendConnected && (
          <div className="mock-banner">
            Backend non connesso – Avvia il server con: npm start
          </div>
        )}
        {backendConnected && !selectedAccountId && section === 'products' && (
          <div className="mock-banner">
            Nessun account configurato – Vai su "Account" per aggiungerne uno
          </div>
        )}
        {renderContent()}
      </main>
    </div>
  );
}

export default App;
