export default function Sidebar({ activeSection }) {
  return (
    <aside className="sidebar">
      <div className="sidebar-logo">
        <span className="logo-icon">&#9881;</span>
        <span className="logo-text">Pics Keeper</span>
      </div>
      <nav className="sidebar-nav">
        <a href="#" className={`nav-item ${activeSection === 'dashboard' ? 'active' : ''}`}>
          <span className="nav-icon">&#9632;</span>
          <span>Dashboard</span>
        </a>
        <a href="#" className={`nav-item ${activeSection === 'products' ? 'active' : ''}`}>
          <span className="nav-icon">&#9776;</span>
          <span>Prodotti</span>
        </a>
        <a href="#" className={`nav-item ${activeSection === 'orders' ? 'active' : ''}`}>
          <span className="nav-icon">&#128230;</span>
          <span>Ordini</span>
        </a>
        <a href="#" className={`nav-item ${activeSection === 'alerts' ? 'active' : ''}`}>
          <span className="nav-icon">&#128276;</span>
          <span>Avvisi</span>
        </a>
        <a href="#" className={`nav-item ${activeSection === 'costs' ? 'active' : ''}`}>
          <span className="nav-icon">&#128181;</span>
          <span>Costi ASIN</span>
        </a>
        <a href="#" className={`nav-item ${activeSection === 'cash' ? 'active' : ''}`}>
          <span className="nav-icon">&#128176;</span>
          <span>Riconciliazione</span>
        </a>
        <a href="#" className={`nav-item ${activeSection === 'accounts' ? 'active' : ''}`}>
          <span className="nav-icon">&#128100;</span>
          <span>Account</span>
        </a>
      </nav>
    </aside>
  );
}
