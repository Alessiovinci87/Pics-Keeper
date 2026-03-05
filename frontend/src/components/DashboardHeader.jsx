import { useState, useRef, useEffect } from 'react';
import { COUNTRY_FLAGS } from '../data/mockProducts';
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

function fmt(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function getPresets() {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  const dayOfWeek = today.getDay() === 0 ? 7 : today.getDay(); // Mon=1

  const thisWeekStart = new Date(today); thisWeekStart.setDate(today.getDate() - dayOfWeek + 1);
  const lastWeekStart = new Date(thisWeekStart); lastWeekStart.setDate(thisWeekStart.getDate() - 7);
  const lastWeekEnd = new Date(thisWeekStart); lastWeekEnd.setDate(thisWeekStart.getDate() - 1);

  const thisMonthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const lastMonthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const lastMonthEnd = new Date(today.getFullYear(), today.getMonth(), 0);

  const thisQuarterMonth = Math.floor(today.getMonth() / 3) * 3;
  const thisQuarterStart = new Date(today.getFullYear(), thisQuarterMonth, 1);
  const lastQuarterStart = new Date(today.getFullYear(), thisQuarterMonth - 3, 1);
  const lastQuarterEnd = new Date(today.getFullYear(), thisQuarterMonth, 0);

  const thisYearStart = new Date(today.getFullYear(), 0, 1);
  const lastYearStart = new Date(today.getFullYear() - 1, 0, 1);
  const lastYearEnd = new Date(today.getFullYear() - 1, 11, 31);

  return [
    { label: 'Oggi', from: fmt(today), to: fmt(today) },
    { label: 'Ieri', from: fmt(yesterday), to: fmt(yesterday) },
    { label: 'Ultimi 7 giorni', from: fmt(new Date(today.getTime() - 6 * 86400000)), to: fmt(today) },
    { label: 'Ultimi 14 giorni', from: fmt(new Date(today.getTime() - 13 * 86400000)), to: fmt(today) },
    { label: 'Ultimi 30 giorni', from: fmt(new Date(today.getTime() - 29 * 86400000)), to: fmt(today) },
    { label: 'Ultimi 60 giorni', from: fmt(new Date(today.getTime() - 59 * 86400000)), to: fmt(today) },
    { label: 'Ultimi 90 giorni', from: fmt(new Date(today.getTime() - 89 * 86400000)), to: fmt(today) },
    { divider: true },
    { label: 'Questa settimana', from: fmt(thisWeekStart), to: fmt(today) },
    { label: 'Settimana scorsa', from: fmt(lastWeekStart), to: fmt(lastWeekEnd) },
    { label: 'Questo mese', from: fmt(thisMonthStart), to: fmt(today) },
    { label: 'Mese scorso', from: fmt(lastMonthStart), to: fmt(lastMonthEnd) },
    { label: 'Questo trimestre', from: fmt(thisQuarterStart), to: fmt(today) },
    { label: 'Trimestre scorso', from: fmt(lastQuarterStart), to: fmt(lastQuarterEnd) },
    { label: 'Quest\'anno', from: fmt(thisYearStart), to: fmt(today) },
    { label: 'Anno scorso', from: fmt(lastYearStart), to: fmt(lastYearEnd) },
  ];
}

function formatDateLabel(from, to) {
  const presets = getPresets();
  const match = presets.find(p => !p.divider && p.from === from && p.to === to);
  if (match) return match.label;

  const fmtDate = (d) => {
    const [y, m, day] = d.split('-');
    return `${day}/${m}/${y}`;
  };
  if (from === to) return fmtDate(from);
  return `${fmtDate(from)} - ${fmtDate(to)}`;
}

export default function DashboardHeader({ products, summary: backendSummary, dateRange, onDateChange, selectedMarketplace, onMarketplaceChange }) {
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [customFrom, setCustomFrom] = useState(dateRange.from);
  const [customTo, setCustomTo] = useState(dateRange.to);
  const pickerRef = useRef(null);

  useEffect(() => {
    function handleClickOutside(e) {
      if (pickerRef.current && !pickerRef.current.contains(e.target)) {
        setShowDatePicker(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    setCustomFrom(dateRange.from);
    setCustomTo(dateRange.to);
  }, [dateRange]);

  function selectPreset(preset) {
    onDateChange({ from: preset.from, to: preset.to });
    setShowDatePicker(false);
  }

  function applyCustomRange() {
    if (customFrom && customTo) {
      onDateChange({ from: customFrom, to: customTo });
      setShowDatePicker(false);
    }
  }

  // Always use backend summary (covers all pages, already filtered by marketplace)
  const summary = backendSummary
    ? {
        revenue: backendSummary.revenue,
        units: backendSummary.units_sold,
        orders: backendSummary.orders_count,
        profit: backendSummary.net_profit,
        ads: backendSummary.ads_spend,
        fees: backendSummary.total_amazon_fees,
        costs: backendSummary.total_product_costs,
        refunds: backendSummary.refunds,
      }
    : { revenue: 0, units: 0, orders: 0, profit: 0, ads: 0, fees: 0, costs: 0, refunds: 0 };

  const margin = summary.revenue > 0 ? (summary.profit / summary.revenue) * 100 : 0;
  const tacos = summary.revenue > 0 ? (summary.ads / summary.revenue) * 100 : 0;
  const presets = getPresets();

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

          {/* Shopkeeper-style date picker */}
          <div className="date-picker-container" ref={pickerRef}>
            <button
              className="date-picker-trigger"
              onClick={() => setShowDatePicker(!showDatePicker)}
            >
              <span className="date-picker-icon">&#128197;</span>
              <span className="date-picker-label">{formatDateLabel(dateRange.from, dateRange.to)}</span>
              <span className={`date-picker-arrow ${showDatePicker ? 'open' : ''}`}>&#9660;</span>
            </button>

            {showDatePicker && (
              <div className="date-picker-dropdown">
                <div className="date-picker-presets">
                  {presets.map((preset, i) =>
                    preset.divider ? (
                      <div key={`div-${i}`} className="date-picker-divider" />
                    ) : (
                      <button
                        key={preset.label}
                        className={`date-preset-btn ${preset.from === dateRange.from && preset.to === dateRange.to ? 'active' : ''}`}
                        onClick={() => selectPreset(preset)}
                      >
                        {preset.label}
                      </button>
                    )
                  )}
                </div>
                <div className="date-picker-custom">
                  <span className="date-custom-title">Personalizzato</span>
                  <div className="date-custom-inputs">
                    <div className="date-custom-field">
                      <label>Da</label>
                      <input
                        type="date"
                        value={customFrom}
                        onChange={(e) => setCustomFrom(e.target.value)}
                      />
                    </div>
                    <div className="date-custom-field">
                      <label>A</label>
                      <input
                        type="date"
                        value={customTo}
                        onChange={(e) => setCustomTo(e.target.value)}
                      />
                    </div>
                  </div>
                  <button className="btn btn-primary date-apply-btn" onClick={applyCustomRange}>
                    Applica
                  </button>
                </div>
              </div>
            )}
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
          <span className={`card-value ${summary.profit >= 0 ? 'positive' : 'negative'}`}>{formatCurrency(summary.profit)}</span>
        </div>
        <div className="summary-card">
          <span className="card-label">Margine</span>
          <span className={`card-value ${margin >= 0 ? 'positive' : 'negative'}`}>{formatPct(margin)}</span>
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
