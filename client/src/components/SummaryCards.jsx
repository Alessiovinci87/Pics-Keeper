import './SummaryCards.css';

function fmt(n, decimals = 2) {
  if (n == null) return '—';
  return Number(n).toLocaleString('it-IT', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export default function SummaryCards({ summary }) {
  if (!summary) return null;

  const cards = [
    { label: 'Revenue', value: `€ ${fmt(summary.total_revenue)}`, color: '#4a7cff' },
    { label: 'Net Profit', value: `€ ${fmt(summary.total_profit)}`, color: Number(summary.total_profit) >= 0 ? '#22c55e' : '#ef4444' },
    { label: 'Units', value: fmt(summary.total_units, 0), color: '#8b5cf6' },
    { label: 'Orders', value: fmt(summary.total_orders, 0), color: '#f59e0b' },
    { label: 'Margin', value: `${fmt(summary.avg_margin)}%`, color: Number(summary.avg_margin) >= 0 ? '#22c55e' : '#ef4444' },
    { label: 'Ads Spend', value: `€ ${fmt(summary.total_ads_spend)}`, color: '#ec4899' },
    { label: 'TACoS', value: `${fmt(summary.avg_tacos)}%`, color: '#f97316' },
  ];

  return (
    <div className="summary-cards">
      {cards.map((c) => (
        <div key={c.label} className="summary-card">
          <div className="sc-label">{c.label}</div>
          <div className="sc-value" style={{ color: c.color }}>{c.value}</div>
        </div>
      ))}
    </div>
  );
}
