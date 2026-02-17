import { useState, useEffect } from 'react';
import Sidebar from './components/Sidebar';
import DashboardHeader from './components/DashboardHeader';
import ProductTable from './components/ProductTable';
import mockProducts from './data/mockProducts';
import { fetchProducts } from './services/api';
import './App.css';

function App() {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [usingMock, setUsingMock] = useState(false);
  const [dateRange, setDateRange] = useState({
    from: new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0],
    to: new Date().toISOString().split('T')[0],
  });

  useEffect(() => {
    loadProducts();
  }, [dateRange]);

  async function loadProducts() {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchProducts({
        accountId: 1,
        dateFrom: dateRange.from,
        dateTo: dateRange.to,
      });
      setProducts(result.data);
      setUsingMock(false);
    } catch {
      // Backend not available — use mock data
      setProducts(mockProducts);
      setUsingMock(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="app-layout">
      <Sidebar activeSection="products" />
      <main className="main-content">
        {usingMock && (
          <div className="mock-banner">
            Dati demo — Il backend non è ancora connesso
          </div>
        )}
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
        ) : error ? (
          <div className="error-state">
            <p>Errore: {error}</p>
          </div>
        ) : (
          <ProductTable products={products} />
        )}
      </main>
    </div>
  );
}

export default App;
