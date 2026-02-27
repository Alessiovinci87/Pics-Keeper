import { COUNTRY_FLAGS, COUNTRY_NAMES } from '../data/mockProducts';
import { formatCurrency, formatNumber, formatPct } from '../utils/format';

const MARKETPLACE_OPTIONS = [
  { code: null, label: 'Tutti i marketplace' },
  { code: 'IT', label: 'Italia' },
  { code: 'DE', label: 'Germania' },
  { code: 'FR', label: 'Francia' },
  { code: 'ES', label: 'Spagna' },
  { code: 'GB', label: 'Regno Unito' },
  { code: 'NL', label: 'Paesi Bassi' },
  { code: 'BE', label: 'Belgio' },
  { code: 'SE', label: 'Svezia' },
  { code: 'PL', label: 'Polonia' },
  { code: 'US', label: 'Stati Uniti' },
  { code: 'CA', label: 'Canada' },
];

export default function DashboardHeader({ products, dateRange, onDateChange, selectedMarketplace, onMarketplaceChange }) {
  // Compute summary from all products
  const summary = products.reduce(
    (acc, p) => ({
      revenue: acc.revenue + Number(p.revenue),
      units: acc.units + Number(p.units_sold),
      orders: acc.orders + Number(p.orders_count),
      profit: acc.profit + Number(p.net_profit),
      ads: acc.ads + Number(p.ads_spend),
      fees: acc.fees + Number(p.total_amazon_fees),
      costs: acc.costs + Number(p.total_product_costs),
      refunds: acc.refunds + Number(p.refunds),
    }),
    { revenue: 0, units: 0, orders: 0, profit: 0, ads: 0, fees: 0, costs: 0, refunds: 0 }
  );

  const margin = summary.revenue > 0 ? (summary.profit / summary.revenue) * 100 : 0;
  const tacos = summary.revenue > 0 ? (summary.ads / summary.revenue) * 100 : 0;

  return (
    <div className="dashboard-header">
      <div className="header-top">
        <div className="header-title-section">
          <h1 className="header-title">Prodotti</h1>
          <span className="header-subtitle">{products.length} prodotti attivi</span>
        </div>
        <div className="header-filters">
          <div className="header-marketplace-filter">
            <select
              value={selectedMarketplace || ''}
              onChange={(e) => onMarketplaceChange(e.target.value || null)}
            >
              {MARKETPLACE_OPTIONS.map((opt) => (
                <option key={opt.code || 'all'} value={opt.code || ''}>
                  {opt.code ? `${COUNTRY_FLAGS[opt.code] || ''} ${opt.label}` : opt.label}
                </option>
              ))}
            </select>
          </div>
          <div className="header-date-filter">
            <label>Da:</label>
            <input
              type="date"
              value={dateRange.from}
              onChange={(e) => onDateChange({ ...dateRange, from: e.target.value })}
            />
            <label>A:</label>
            <input
              type="date"
              value={dateRange.to}
              onChange={(e) => onDateChange({ ...dateRange, to: e.target.value })}
            />
          </div>
        </div>
      </div>

      <div className="summary-cards">
        <div className="summary-card">
          <span className="card-label">Vendite</span>
          <span className="card-value">{formatCurrency(summary.revenue)}</span>
        </div>
        <div className="summary-card">
          <span className="card-label">Unità</span>
          <span className="card-value">{formatNumber(summary.units)}</span>
        </div>
        <div className="summary-card">
          <span className="card-label">Ordini</span>
          <span className="card-value">{formatNumber(summary.orders)}</span>
        </div>
        <div className="summary-card card-profit">
          <span className="card-label">Profitto</span>
          <span className="card-value positive">{formatCurrency(summary.profit)}</span>
        </div>
        <div className="summary-card">
          <span className="card-label">Margine</span>
          <span className="card-value positive">{formatPct(margin)}</span>
        </div>
        <div className="summary-card">
          <span className="card-label">PPC</span>
          <span className="card-value negative">{formatCurrency(summary.ads)}</span>
        </div>
        <div className="summary-card">
          <span className="card-label">TACOS</span>
          <span className="card-value">{formatPct(tacos)}</span>
        </div>
        <div className="summary-card">
          <span className="card-label">Commissioni AMZ</span>
          <span className="card-value negative">{formatCurrency(summary.fees)}</span>
        </div>
      </div>
    </div>
  );
}
