import { useState, useEffect } from 'react';
import { triggerSync, fetchSyncLogs, resetSync, fixTitles } from '../services/api';

export default function SyncPage({ accountId }) {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [triggering, setTriggering] = useState(null);
  const [resetting, setResetting] = useState(false);
  const [fixingTitles, setFixingTitles] = useState(false);
  const [successMsg, setSuccessMsg] = useState(null);
  const [errorMsg, setErrorMsg] = useState(null);

  useEffect(() => {
    if (accountId) loadLogs();
  }, [accountId]);

  async function loadLogs() {
    setLoading(true);
    try {
      const result = await fetchSyncLogs({ accountId });
      setLogs(result.data || []);
    } catch {
      setLogs([]);
    } finally {
      setLoading(false);
    }
  }

  function formatError(err) {
    if (err.message && err.message.includes('404')) {
      return 'Backend non raggiungibile. Verifica che il server sia avviato (npm start).';
    }
    if (err.message && (err.message.includes('Failed to fetch') || err.message.includes('NetworkError'))) {
      return 'Impossibile connettersi al backend. Verifica che il server sia in esecuzione sulla porta 3000.';
    }
    return err.message || 'Errore sconosciuto';
  }

  async function handleTrigger(jobType) {
    setTriggering(jobType);
    setErrorMsg(null);
    try {
      await triggerSync(jobType);
      setTimeout(loadLogs, 2000);
    } catch (err) {
      setErrorMsg(formatError(err));
    } finally {
      setTriggering(null);
    }
  }

  async function handleFixTitles() {
    setFixingTitles(true);
    setErrorMsg(null);
    setSuccessMsg(null);
    try {
      const result = await fixTitles({ accountId });
      setSuccessMsg(`Titoli aggiornati: ${result.updated}/${result.total_asins} ASIN dal catalogo IT`);
    } catch (err) {
      setErrorMsg(formatError(err));
    } finally {
      setFixingTitles(false);
    }
  }

  async function handleReset() {
    if (!confirm('Resettare tutti i timestamp di sincronizzazione? Verrà avviato un re-sync completo degli ultimi 30 giorni.')) return;
    setResetting(true);
    setErrorMsg(null);
    try {
      await resetSync({ accountId });
      setTimeout(loadLogs, 3000);
    } catch (err) {
      setErrorMsg(formatError(err));
    } finally {
      setResetting(false);
    }
  }

  const jobTypes = [
    { key: 'orders', label: 'Sincronizza Ordini', desc: 'Scarica ordini da SP-API' },
    { key: 'financial', label: 'Sincronizza Finanziari', desc: 'Scarica eventi finanziari' },
    { key: 'ads', label: 'Sincronizza Ads', desc: 'Scarica spesa pubblicitaria' },
    { key: 'compute', label: 'Calcola Profitti', desc: 'Ricalcola profitti e aggregazioni' },
    { key: 'alerts', label: 'Valuta Avvisi', desc: 'Controlla soglie e genera avvisi' },
  ];

  if (!accountId) {
    return <div className="page-container"><p className="empty-msg">Seleziona un account per gestire la sincronizzazione.</p></div>;
  }

  return (
    <div className="page-container">
      <div className="page-header">
        <h1>Sincronizzazione</h1>
        <button className="btn btn-small" onClick={loadLogs}>Aggiorna Log</button>
      </div>

      {errorMsg && (
        <div className="mock-banner" style={{ margin: '0 20px 16px', background: 'var(--danger-bg, #fdecea)', color: 'var(--danger-color, #e74c3c)' }}>
          {errorMsg}
        </div>
      )}
      {successMsg && (
        <div className="mock-banner" style={{ margin: '0 20px 16px', background: '#e8f5e9', color: '#2e7d32' }}>
          {successMsg}
        </div>
      )}

      <div className="sync-actions">
        {jobTypes.map((job) => (
          <div key={job.key} className="sync-card">
            <div>
              <h3>{job.label}</h3>
              <p className="sync-desc">{job.desc}</p>
            </div>
            <button
              className="btn btn-primary"
              disabled={triggering === job.key}
              onClick={() => handleTrigger(job.key)}
            >
              {triggering === job.key ? 'Avvio...' : 'Avvia'}
            </button>
          </div>
        ))}
      </div>

      <div className="sync-actions" style={{ borderTop: '1px solid var(--border-color)', paddingTop: '16px' }}>
        <div className="sync-card">
          <div>
            <h3>Aggiorna Titoli in Italiano</h3>
            <p className="sync-desc">Scarica i titoli prodotto dal catalogo Amazon.it</p>
          </div>
          <button
            className="btn btn-primary"
            disabled={fixingTitles}
            onClick={handleFixTitles}
          >
            {fixingTitles ? 'Aggiornamento...' : 'Aggiorna Titoli'}
          </button>
        </div>
        <div className="sync-card" style={{ borderColor: 'var(--danger-color, #e74c3c)' }}>
          <div>
            <h3>Reset & Re-sync Completo</h3>
            <p className="sync-desc">Resetta i timestamp e riscarica tutti gli ordini degli ultimi 30 giorni per tutti i marketplace</p>
          </div>
          <button
            className="btn btn-danger"
            disabled={resetting}
            onClick={handleReset}
          >
            {resetting ? 'Reset in corso...' : 'Reset & Re-sync'}
          </button>
        </div>
      </div>

      <h2 style={{ padding: '20px 28px 10px', color: 'var(--text-primary)' }}>Log Recenti</h2>

      {loading ? (
        <div className="loading-state"><div className="spinner" /><p>Caricamento log...</p></div>
      ) : logs.length === 0 ? (
        <div className="empty-state"><p>Nessun log di sincronizzazione trovato.</p></div>
      ) : (
        <div className="data-table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>Tipo</th>
                <th>Marketplace</th>
                <th>Stato</th>
                <th>Processati</th>
                <th>Inseriti</th>
                <th>Durata</th>
                <th>Avviato</th>
                <th>Errore</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr key={log.id}>
                  <td>{log.sync_type}</td>
                  <td>{log.country_code || '-'}</td>
                  <td>
                    <span className={`status-badge ${log.status === 'completed' ? 'active' : log.status === 'failed' ? 'inactive' : 'pending'}`}>
                      {log.status}
                    </span>
                  </td>
                  <td className="num">{log.records_processed || 0}</td>
                  <td className="num">{log.records_inserted || 0}</td>
                  <td className="num">{log.duration_ms ? `${log.duration_ms}ms` : '-'}</td>
                  <td>{new Date(log.started_at).toLocaleString('it-IT')}</td>
                  <td className="error-cell">{log.error_message || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
