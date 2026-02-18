export default function Sidebar({ activeSection, onNavigate, accounts, selectedAccountId, onAccountChange, backendConnected }) {
  const navItems = [
    { key: 'products', icon: '\u2630', label: 'Prodotti' },
    { key: 'alerts', icon: '\uD83D\uDD14', label: 'Avvisi' },
    { key: 'costs', icon: '\uD83D\uDCB5', label: 'Costi ASIN' },
    { key: 'cash', icon: '\uD83D\uDCB0', label: 'Riconciliazione' },
    { key: 'accounts', icon: '\uD83D\uDC64', label: 'Account' },
    { key: 'sync', icon: '\u26A1', label: 'Sync' },
  ];

  return (
    <aside className="sidebar">
      <div className="sidebar-logo">
        <span className="logo-icon">&#9881;</span>
        <span className="logo-text">Pics Keeper</span>
      </div>

      {/* Account selector */}
      <div className="sidebar-account-selector">
        <label className="account-selector-label">Account</label>
        {accounts && accounts.length > 0 ? (
          <select
            className="account-select"
            value={selectedAccountId || ''}
            onChange={(e) => onAccountChange(parseInt(e.target.value, 10))}
          >
            {accounts.map((acc) => (
              <option key={acc.id} value={acc.id}>
                {acc.name}
              </option>
            ))}
          </select>
        ) : (
          <div className="account-select-empty">
            {backendConnected ? 'Nessun account' : 'Non connesso'}
          </div>
        )}
        <div className={`connection-indicator ${backendConnected ? 'connected' : 'disconnected'}`}>
          <span className="indicator-dot" />
          <span>{backendConnected ? 'Connesso' : 'Offline'}</span>
        </div>
      </div>

      <nav className="sidebar-nav">
        {navItems.map((item) => (
          <a
            key={item.key}
            href="#"
            className={`nav-item ${activeSection === item.key ? 'active' : ''}`}
            onClick={(e) => { e.preventDefault(); onNavigate(item.key); }}
          >
            <span className="nav-icon">{item.icon}</span>
            <span>{item.label}</span>
          </a>
        ))}
      </nav>
    </aside>
  );
}
