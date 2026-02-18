import { useState } from 'react';
import { createAccount, updateAccount } from '../services/api';

export default function AccountsPage({ accounts, onRefresh }) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    name: '', sellerId: '', spApiRefreshToken: '', adsApiRefreshToken: '', marketplaceIds: '',
  });

  async function handleCreate(e) {
    e.preventDefault();
    try {
      const marketplaceIds = form.marketplaceIds
        ? form.marketplaceIds.split(',').map((id) => parseInt(id.trim(), 10)).filter(Boolean)
        : [];
      await createAccount({
        name: form.name,
        sellerId: form.sellerId,
        spApiRefreshToken: form.spApiRefreshToken || undefined,
        adsApiRefreshToken: form.adsApiRefreshToken || undefined,
        marketplaceIds,
      });
      setShowForm(false);
      setForm({ name: '', sellerId: '', spApiRefreshToken: '', adsApiRefreshToken: '', marketplaceIds: '' });
      onRefresh();
    } catch (err) {
      alert('Errore: ' + err.message);
    }
  }

  async function toggleActive(id, currentActive) {
    try {
      await updateAccount(id, { isActive: !currentActive });
      onRefresh();
    } catch (err) {
      alert('Errore: ' + err.message);
    }
  }

  return (
    <div className="page-container">
      <div className="page-header">
        <h1>Account Seller</h1>
        <button className="btn btn-primary" onClick={() => setShowForm(!showForm)}>
          {showForm ? 'Annulla' : '+ Nuovo Account'}
        </button>
      </div>

      {showForm && (
        <form className="form-card" onSubmit={handleCreate}>
          <div className="form-grid">
            <input placeholder="Nome Account" value={form.name} onChange={(e) => setForm({...form, name: e.target.value})} required />
            <input placeholder="Seller ID" value={form.sellerId} onChange={(e) => setForm({...form, sellerId: e.target.value})} required />
            <input placeholder="SP-API Refresh Token" value={form.spApiRefreshToken} onChange={(e) => setForm({...form, spApiRefreshToken: e.target.value})} />
            <input placeholder="Ads API Refresh Token" value={form.adsApiRefreshToken} onChange={(e) => setForm({...form, adsApiRefreshToken: e.target.value})} />
            <input placeholder="Marketplace IDs (es: 1,2,3)" value={form.marketplaceIds} onChange={(e) => setForm({...form, marketplaceIds: e.target.value})} />
          </div>
          <p className="form-help">
            Marketplace IDs: 1=DE, 2=FR, 3=IT, 4=ES, 5=GB, 6=NL, 7=SE, 8=PL, 9=TR, 10=BE, 11=US, 12=CA
          </p>
          <button type="submit" className="btn btn-primary">Crea Account</button>
        </form>
      )}

      {accounts.length === 0 ? (
        <div className="empty-state">
          <p>Nessun account configurato.</p>
          <p style={{ color: 'var(--text-muted)', fontSize: '12px', marginTop: '8px' }}>
            Crea un account per iniziare a sincronizzare dati da Amazon.
          </p>
        </div>
      ) : (
        <div className="accounts-grid">
          {accounts.map((acc) => (
            <div key={acc.id} className="account-card">
              <div className="account-card-header">
                <h3>{acc.name}</h3>
                <span className={`status-badge ${acc.is_active ? 'active' : 'inactive'}`}>
                  {acc.is_active ? 'Attivo' : 'Inattivo'}
                </span>
              </div>
              <div className="account-card-body">
                <div className="account-field">
                  <span className="field-label">Seller ID</span>
                  <span className="field-value mono">{acc.seller_id}</span>
                </div>
                <div className="account-field">
                  <span className="field-label">SP-API</span>
                  <span className="field-value">{acc.sp_api_refresh_token ? 'Configurato' : 'Non configurato'}</span>
                </div>
                <div className="account-field">
                  <span className="field-label">Ads API</span>
                  <span className="field-value">{acc.ads_api_refresh_token ? 'Configurato' : 'Non configurato'}</span>
                </div>
                {acc.marketplaces && acc.marketplaces.length > 0 && acc.marketplaces[0].country_code && (
                  <div className="account-field">
                    <span className="field-label">Marketplace</span>
                    <span className="field-value">
                      {acc.marketplaces.map((m) => m.country_code).join(', ')}
                    </span>
                  </div>
                )}
              </div>
              <div className="account-card-footer">
                <button
                  className={`btn btn-small ${acc.is_active ? 'btn-danger' : 'btn-primary'}`}
                  onClick={() => toggleActive(acc.id, acc.is_active)}
                >
                  {acc.is_active ? 'Disattiva' : 'Attiva'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
