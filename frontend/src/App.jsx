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
  const [loading, setLoading] = useState(true);
  const [backendConnected, setBackendConnected] = useState(false);
  const [selectedMarketplace, setSelectedMarketplace] = useState(null);
  const [dateRange, setDateRange] = useState({
    from: new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0],
    to: new Date().toISOString().split('T')[0],
  });

  // Load accounts on mount
  useEffect(() => {
    loadAccounts();
  }, []);

  // Load products when account or date changes
  useEffect(() => {
    if (section === 'products') {
      loadProducts();
    }
  }, [selectedAccountId, dateRange, section]);

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
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const result = await fetchProducts({
        accountId: selectedAccountId,
        dateFrom: dateRange.from,
        dateTo: dateRange.to,
      });
      setProducts(result.data || []);
    } catch {
      setProducts([]);
    } finally {
      setLoading(false);
    }
  }

  // Filter products by selected marketplace
  const filteredProducts = useMemo(() => {
    if (!selectedMarketplace) return products;
    return products
      .map((p) => {
        const mp = (p.marketplaces || []).find((m) => m.country_code === selectedMarketplace);
        if (!mp) return null;
        return {
          ...p,
          units_sold: mp.units_sold,
          orders_count: mp.orders_count,
          revenue: mp.revenue,
          total_amazon_fees: mp.total_amazon_fees,
          refunds: mp.refunds,
          ads_spend: mp.ads_spend,
          total_product_costs: mp.total_product_costs,
          net_profit: mp.net_profit,
          margin_pct: mp.margin_pct,
          roi_pct: mp.roi_pct,
          tacos_pct: mp.tacos_pct,
          marketplaces: [mp],
        };
      })
      .filter(Boolean);
  }, [products, selectedMarketplace]);

  function renderContent() {
    switch (section) {
      case 'products':
        return (
          <>
            <DashboardHeader
              products={filteredProducts}
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
              <ProductTable products={filteredProducts} />
            )}
          </>
        );
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
            Backend non connesso — Avvia il server con: npm start
          </div>
        )}
        {backendConnected && !selectedAccountId && section === 'products' && (
          <div className="mock-banner">
            Nessun account configurato — Vai su "Account" per aggiungerne uno
          </div>
        )}
        {renderContent()}
      </main>
    </div>
  );
}

export default App;
