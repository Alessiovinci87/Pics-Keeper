import { useState, useEffect } from 'react';
import Sidebar from './components/Sidebar';
import DashboardHeader from './components/DashboardHeader';
import ProductTable from './components/ProductTable';
import AlertsPage from './components/AlertsPage';
import AsinCostsPage from './components/AsinCostsPage';
import CashPage from './components/CashPage';
import AccountsPage from './components/AccountsPage';
import SyncPage from './components/SyncPage';
import mockProducts from './data/mockProducts';
import { fetchProducts, fetchAccounts } from './services/api';
import './App.css';

function App() {
  const [section, setSection] = useState('products');
  const [accounts, setAccounts] = useState([]);
  const [selectedAccountId, setSelectedAccountId] = useState(null);
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [usingMock, setUsingMock] = useState(false);
  const [backendConnected, setBackendConnected] = useState(false);
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
    if (!selectedAccountId && !usingMock) {
      setProducts(mockProducts);
      setUsingMock(true);
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
      setUsingMock(false);
    } catch {
      setProducts(mockProducts);
      setUsingMock(true);
    } finally {
      setLoading(false);
    }
  }

  function renderContent() {
    switch (section) {
      case 'products':
        return (
          <>
            <DashboardHeader
              products={products}
              dateRange={dateRange}
              onDateChange={setDateRange}
            />
            {loading ? (
              <div className="loading-state">
                <div className="spinner" />
                <p>Caricamento prodotti...</p>
              </div>
            ) : (
              <ProductTable products={products} />
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
              products={products}
              dateRange={dateRange}
              onDateChange={setDateRange}
            />
            <ProductTable products={products} />
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
        {usingMock && section === 'products' && (
          <div className="mock-banner">
            Dati demo — {!backendConnected ? 'Il backend non e\' ancora connesso' : 'Nessun account configurato, mostrando dati di esempio'}
          </div>
        )}
        {!backendConnected && section !== 'products' && (
          <div className="mock-banner">
            Backend non connesso — Avvia il server con: npm start
          </div>
        )}
        {renderContent()}
      </main>
    </div>
  );
}

export default App;
