import { useState, useEffect } from 'react';
import { fetchAsinCosts, setAsinCosts } from '../services/api';
import { formatCurrency } from '../utils/format';

export default function AsinCostsPage({ accountId }) {
  const [costs, setCosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    asin: '', marketplaceId: '', productCost: '', inboundCost: '',
    customsCost: '', prepCost: '', packagingCost: '', storageMonthly: '',
  });

  useEffect(() => {
    if (accountId) loadCosts();
  }, [accountId]);

  async function loadCosts() {
    setLoading(true);
    try {
      const result = await fetchAsinCosts({ accountId });
      setCosts(result.data || []);
    } catch {
      setCosts([]);
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    try {
      await setAsinCosts({
        accountId,
        asin: form.asin,
        marketplaceId: parseInt(form.marketplaceId, 10),
        costs: {
          productCost: parseFloat(form.productCost) || 0,
          inboundCost: parseFloat(form.inboundCost) || 0,
          customsCost: parseFloat(form.customsCost) || 0,
          prepCost: parseFloat(form.prepCost) || 0,
          packagingCost: parseFloat(form.packagingCost) || 0,
          storageMonthly: parseFloat(form.storageMonthly) || 0,
        },
      });
      setShowForm(false);
      setForm({ asin: '', marketplaceId: '', productCost: '', inboundCost: '', customsCost: '', prepCost: '', packagingCost: '', storageMonthly: '' });
      loadCosts();
    } catch (err) {
      alert('Errore nel salvataggio: ' + err.message);
    }
  }

  if (!accountId) {
    return <div className="page-container"><p className="empty-msg">Seleziona un account per gestire i costi.</p></div>;
  }

  return (
    <div className="page-container">
      <div className="page-header">
        <h1>Costi ASIN</h1>
        <button className="btn btn-primary" onClick={() => setShowForm(!showForm)}>
          {showForm ? 'Annulla' : '+ Nuovo Costo'}
        </button>
      </div>

      {showForm && (
        <form className="form-card" onSubmit={handleSubmit}>
          <div className="form-grid">
            <input placeholder="ASIN" value={form.asin} onChange={(e) => setForm({...form, asin: e.target.value})} required />
            <input placeholder="Marketplace ID" type="number" value={form.marketplaceId} onChange={(e) => setForm({...form, marketplaceId: e.target.value})} required />
            <input placeholder="Costo Prodotto" type="number" step="0.01" value={form.productCost} onChange={(e) => setForm({...form, productCost: e.target.value})} />
            <input placeholder="Costo Inbound" type="number" step="0.01" value={form.inboundCost} onChange={(e) => setForm({...form, inboundCost: e.target.value})} />
            <input placeholder="Dogana" type="number" step="0.01" value={form.customsCost} onChange={(e) => setForm({...form, customsCost: e.target.value})} />
            <input placeholder="Prep" type="number" step="0.01" value={form.prepCost} onChange={(e) => setForm({...form, prepCost: e.target.value})} />
            <input placeholder="Packaging" type="number" step="0.01" value={form.packagingCost} onChange={(e) => setForm({...form, packagingCost: e.target.value})} />
            <input placeholder="Storage Mensile" type="number" step="0.01" value={form.storageMonthly} onChange={(e) => setForm({...form, storageMonthly: e.target.value})} />
          </div>
          <button type="submit" className="btn btn-primary">Salva</button>
        </form>
      )}

      {loading ? (
        <div className="loading-state"><div className="spinner" /><p>Caricamento costi...</p></div>
      ) : costs.length === 0 ? (
        <div className="empty-state"><p>Nessun costo ASIN configurato.</p></div>
      ) : (
        <div className="data-table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>ASIN</th>
                <th>Prodotto</th>
                <th>Marketplace</th>
                <th>Costo Prodotto</th>
                <th>Inbound</th>
                <th>Dogana</th>
                <th>Prep</th>
                <th>Packaging</th>
                <th>Storage/mese</th>
                <th>Dal</th>
              </tr>
            </thead>
            <tbody>
              {costs.map((c, i) => (
                <tr key={i}>
                  <td className="mono">{c.asin}</td>
                  <td>{c.asin_title || '-'}</td>
                  <td>{c.country_code} - {c.marketplace_name}</td>
                  <td className="num">{formatCurrency(c.product_cost)}</td>
                  <td className="num">{formatCurrency(c.inbound_cost)}</td>
                  <td className="num">{formatCurrency(c.customs_cost)}</td>
                  <td className="num">{formatCurrency(c.prep_cost)}</td>
                  <td className="num">{formatCurrency(c.packaging_cost)}</td>
                  <td className="num">{formatCurrency(c.storage_monthly_cost)}</td>
                  <td>{c.effective_from}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
