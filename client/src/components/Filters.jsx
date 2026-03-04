import './Filters.css';

const MARKETPLACES = [
  { id: '', label: 'All Marketplaces' },
  { id: '1', code: 'IT', label: 'Italy' },
  { id: '2', code: 'DE', label: 'Germany' },
  { id: '3', code: 'FR', label: 'France' },
  { id: '4', code: 'ES', label: 'Spain' },
  { id: '5', code: 'UK', label: 'United Kingdom' },
  { id: '6', code: 'NL', label: 'Netherlands' },
  { id: '7', code: 'SE', label: 'Sweden' },
  { id: '8', code: 'PL', label: 'Poland' },
  { id: '9', code: 'BE', label: 'Belgium' },
  { id: '10', code: 'US', label: 'United States' },
  { id: '11', code: 'CA', label: 'Canada' },
  { id: '12', code: 'MX', label: 'Mexico' },
];

export default function Filters({ marketplaceId, setMarketplaceId, asinFilter, setAsinFilter }) {
  return (
    <div className="filters-bar">
      <div className="filter-group">
        <label className="filter-label">Marketplace</label>
        <select
          className="filter-select"
          value={marketplaceId}
          onChange={(e) => setMarketplaceId(e.target.value)}
        >
          {MARKETPLACES.map((m) => (
            <option key={m.id} value={m.id}>
              {m.code ? `${m.code} — ${m.label}` : m.label}
            </option>
          ))}
        </select>
      </div>
      <div className="filter-group">
        <label className="filter-label">ASIN</label>
        <input
          type="text"
          className="filter-input"
          placeholder="Filter by ASIN..."
          value={asinFilter}
          onChange={(e) => setAsinFilter(e.target.value.toUpperCase())}
        />
      </div>
    </div>
  );
}

export { MARKETPLACES };
