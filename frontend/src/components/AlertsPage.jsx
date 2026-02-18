import { useState, useEffect } from 'react';
import { fetchAlerts, acknowledgeAlert, resolveAlert } from '../services/api';

export default function AlertsPage({ accountId }) {
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('active');

  useEffect(() => {
    if (accountId) loadAlerts();
  }, [accountId, filter]);

  async function loadAlerts() {
    setLoading(true);
    try {
      const result = await fetchAlerts({ accountId, status: filter || undefined });
      setAlerts(result.data || []);
    } catch {
      setAlerts([]);
    } finally {
      setLoading(false);
    }
  }

  async function handleAcknowledge(id) {
    await acknowledgeAlert(id);
    loadAlerts();
  }

  async function handleResolve(id) {
    await resolveAlert(id);
    loadAlerts();
  }

  const severityClass = (s) => s === 'critical' ? 'negative' : s === 'warning' ? 'warning-text' : '';

  if (!accountId) {
    return <div className="page-container"><p className="empty-msg">Seleziona un account per vedere gli avvisi.</p></div>;
  }

  return (
    <div className="page-container">
      <div className="page-header">
        <h1>Avvisi</h1>
        <div className="page-filters">
          {['active', 'acknowledged', 'resolved', ''].map((f) => (
            <button
              key={f}
              className={`filter-btn ${filter === f ? 'active' : ''}`}
              onClick={() => setFilter(f)}
            >
              {f || 'Tutti'}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="loading-state"><div className="spinner" /><p>Caricamento avvisi...</p></div>
      ) : alerts.length === 0 ? (
        <div className="empty-state"><p>Nessun avviso trovato.</p></div>
      ) : (
        <div className="alerts-list">
          {alerts.map((alert) => (
            <div key={alert.id} className={`alert-card severity-${alert.severity}`}>
              <div className="alert-header">
                <span className={`alert-severity ${severityClass(alert.severity)}`}>
                  {alert.severity.toUpperCase()}
                </span>
                <span className="alert-type">{alert.alert_type}</span>
                <span className="alert-date">
                  {new Date(alert.triggered_at).toLocaleString('it-IT')}
                </span>
              </div>
              <h3 className="alert-title">{alert.title}</h3>
              <p className="alert-message">{alert.message}</p>
              {alert.country_code && (
                <span className="alert-marketplace">{alert.country_code}</span>
              )}
              {alert.status === 'active' && (
                <div className="alert-actions">
                  <button className="btn btn-small" onClick={() => handleAcknowledge(alert.id)}>
                    Conferma
                  </button>
                  <button className="btn btn-small btn-resolve" onClick={() => handleResolve(alert.id)}>
                    Risolvi
                  </button>
                </div>
              )}
              {alert.status === 'acknowledged' && (
                <div className="alert-actions">
                  <button className="btn btn-small btn-resolve" onClick={() => handleResolve(alert.id)}>
                    Risolvi
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
