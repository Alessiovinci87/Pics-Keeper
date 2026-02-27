import { useState, useEffect } from 'react';
import { fetchCashSummary, registerPayout } from '../services/api';
import { formatCurrency, formatPct } from '../utils/format';

export default function CashPage({ accountId, dateRange }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    payoutDate: '', payoutAmount: '', periodStart: '', periodEnd: '', notes: '',
  });

  useEffect(() => {
    if (accountId) loadData();
  }, [accountId]);

  async function loadData() {
    setLoading(true);
    try {
      const result = await fetchCashSummary({ accountId });
      setData(result);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    try {
      await registerPayout({
        accountId,
        payoutDate: form.payoutDate,
        payoutAmount: form.payoutAmount,
        periodStart: form.periodStart,
        periodEnd: form.periodEnd,
        notes: form.notes,
      });
      setShowForm(false);
      setForm({ payoutDate: '', payoutAmount: '', periodStart: '', periodEnd: '', notes: '' });
      loadData();
    } catch (err) {
      alert('Errore: ' + err.message);
    }
  }

  if (!accountId) {
    return <div className="page-container"><p className="empty-msg">Seleziona un account per la riconciliazione.</p></div>;
  }

  return (
    <div className="page-container">
      <div className="page-header">
        <h1>Riconciliazione Pagamenti</h1>
        <button className="btn btn-primary" onClick={() => setShowForm(!showForm)}>
          {showForm ? 'Annulla' : '+ Registra Pagamento'}
        </button>
      </div>

      {showForm && (
        <form className="form-card" onSubmit={handleSubmit}>
          <div className="form-grid">
            <input type="date" placeholder="Data Pagamento" value={form.payoutDate} onChange={(e) => setForm({...form, payoutDate: e.target.value})} required />
            <input type="number" step="0.01" placeholder="Importo" value={form.payoutAmount} onChange={(e) => setForm({...form, payoutAmount: e.target.value})} required />
            <input type="date" placeholder="Periodo Da" value={form.periodStart} onChange={(e) => setForm({...form, periodStart: e.target.value})} required />
            <input type="date" placeholder="Periodo A" value={form.periodEnd} onChange={(e) => setForm({...form, periodEnd: e.target.value})} required />
            <input placeholder="Note" value={form.notes} onChange={(e) => setForm({...form, notes: e.target.value})} />
          </div>
          <button type="submit" className="btn btn-primary">Registra</button>
        </form>
      )}

      {loading ? (
        <div className="loading-state"><div className="spinner" /><p>Caricamento...</p></div>
      ) : !data ? (
        <div className="empty-state"><p>Nessun dato disponibile.</p></div>
      ) : (
        <>
          {data.summary && (
            <div className="summary-cards" style={{ padding: '20px 28px' }}>
              <div className="summary-card">
                <span className="card-label">Pagamenti</span>
                <span className="card-value">{data.summary.payout_count}</span>
              </div>
              <div className="summary-card">
                <span className="card-label">Totale Pagato</span>
                <span className="card-value">{formatCurrency(data.summary.total_payouts)}</span>
              </div>
              <div className="summary-card">
                <span className="card-label">Profitto Maturato</span>
                <span className="card-value">{formatCurrency(data.summary.total_accrued)}</span>
              </div>
              <div className="summary-card">
                <span className="card-label">Differenza</span>
                <span className="card-value">{formatCurrency(data.summary.total_difference)}</span>
              </div>
              <div className="summary-card">
                <span className="card-label">Drift Medio</span>
                <span className="card-value">{formatPct(data.summary.avg_drift_pct)}</span>
              </div>
            </div>
          )}

          {data.history && data.history.length > 0 && (
            <div className="data-table-wrapper">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Data Pagamento</th>
                    <th>Marketplace</th>
                    <th>Importo</th>
                    <th>Profitto Maturato</th>
                    <th>Differenza</th>
                    <th>Drift %</th>
                    <th>Periodo</th>
                    <th>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {data.history.map((p) => (
                    <tr key={p.id}>
                      <td>{p.payout_date}</td>
                      <td>{p.country_code || 'Tutti'}</td>
                      <td className="num">{formatCurrency(p.payout_amount)}</td>
                      <td className="num">{formatCurrency(p.accrued_profit)}</td>
                      <td className="num">{formatCurrency(p.difference)}</td>
                      <td className="num">{formatPct(p.difference_pct)}</td>
                      <td>{p.period_start} - {p.period_end}</td>
                      <td>{p.notes || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
