import './AsinTable.css';

function fmt(n, decimals = 2) {
  if (n == null) return '—';
  return Number(n).toLocaleString('it-IT', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function profitClass(val) {
  if (val == null) return '';
  return Number(val) >= 0 ? 'positive' : 'negative';
}

const COLUMNS = [
  { key: 'metric_date', label: 'Date', render: (r) => r.metric_date?.substring(0, 10) },
  { key: 'country_code', label: 'Mkt', render: (r) => r.country_code || '—' },
  { key: 'asin', label: 'ASIN' },
  { key: 'asin_title', label: 'Title', render: (r) => (r.asin_title || '—').substring(0, 50) },
  { key: 'units_sold', label: 'Units', render: (r) => fmt(r.units_sold, 0), align: 'right' },
  { key: 'orders_count', label: 'Orders', render: (r) => fmt(r.orders_count, 0), align: 'right' },
  { key: 'revenue', label: 'Revenue', render: (r) => `€ ${fmt(r.revenue)}`, align: 'right' },
  { key: 'total_amazon_fees', label: 'Amazon Fees', render: (r) => `€ ${fmt(r.total_amazon_fees)}`, align: 'right' },
  { key: 'ads_spend', label: 'Ads Spend', render: (r) => `€ ${fmt(r.ads_spend)}`, align: 'right' },
  { key: 'total_product_costs', label: 'Product Cost', render: (r) => `€ ${fmt(r.total_product_costs)}`, align: 'right' },
  { key: 'refunds', label: 'Refunds', render: (r) => `€ ${fmt(r.refunds)}`, align: 'right' },
  { key: 'net_profit', label: 'Net Profit', render: (r) => `€ ${fmt(r.net_profit)}`, align: 'right', className: (r) => profitClass(r.net_profit) },
  { key: 'margin_pct', label: 'Margin %', render: (r) => `${fmt(r.margin_pct)}%`, align: 'right', className: (r) => profitClass(r.margin_pct) },
  { key: 'roi_pct', label: 'ROI %', render: (r) => `${fmt(r.roi_pct)}%`, align: 'right', className: (r) => profitClass(r.roi_pct) },
  { key: 'acos_pct', label: 'ACoS %', render: (r) => `${fmt(r.acos_pct)}%`, align: 'right' },
  { key: 'tacos_pct', label: 'TACoS %', render: (r) => `${fmt(r.tacos_pct)}%`, align: 'right' },
];

export default function AsinTable({ data, loading, page, totalPages, onPageChange, sortKey, sortDir, onSort }) {
  return (
    <div className="asin-table-wrapper">
      <div className="asin-table-scroll">
        <table className="asin-table">
          <thead>
            <tr>
              {COLUMNS.map((col) => (
                <th
                  key={col.key}
                  className={col.align === 'right' ? 'text-right' : ''}
                  onClick={() => onSort(col.key)}
                  style={{ cursor: 'pointer' }}
                >
                  {col.label}
                  {sortKey === col.key && (
                    <span className="sort-indicator">{sortDir === 'asc' ? ' ▲' : ' ▼'}</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={COLUMNS.length} className="loading-cell">Loading...</td>
              </tr>
            ) : data.length === 0 ? (
              <tr>
                <td colSpan={COLUMNS.length} className="empty-cell">No data for selected period</td>
              </tr>
            ) : (
              data.map((row, i) => (
                <tr key={`${row.asin}-${row.metric_date}-${row.marketplace_id}-${i}`}>
                  {COLUMNS.map((col) => {
                    const extraClass = col.className ? col.className(row) : '';
                    return (
                      <td
                        key={col.key}
                        className={`${col.align === 'right' ? 'text-right' : ''} ${extraClass}`}
                      >
                        {col.render ? col.render(row) : row[col.key]}
                      </td>
                    );
                  })}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {totalPages > 1 && (
        <div className="pagination">
          <button disabled={page <= 1} onClick={() => onPageChange(page - 1)}>← Prev</button>
          <span className="page-info">Page {page} / {totalPages}</span>
          <button disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>Next →</button>
        </div>
      )}
    </div>
  );
}
