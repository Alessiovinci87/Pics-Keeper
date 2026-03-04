import { PRESETS } from '../hooks/useDateRange';
import './DateRangePicker.css';

export default function DateRangePicker({ preset, setPreset, customFrom, setCustomFrom, customTo, setCustomTo, dateFrom, dateTo }) {
  return (
    <div className="date-range-picker">
      <div className="drp-presets">
        {PRESETS.map((p) => (
          <button
            key={p.key}
            className={`drp-preset-btn ${preset === p.key ? 'active' : ''}`}
            onClick={() => setPreset(p.key)}
          >
            {p.label}
          </button>
        ))}
      </div>
      {preset === 'custom' && (
        <div className="drp-custom">
          <input
            type="date"
            value={customFrom}
            onChange={(e) => setCustomFrom(e.target.value)}
          />
          <span className="drp-separator">—</span>
          <input
            type="date"
            value={customTo}
            onChange={(e) => setCustomTo(e.target.value)}
          />
        </div>
      )}
      <div className="drp-display">
        <span className="drp-range-label">{dateFrom} — {dateTo}</span>
      </div>
    </div>
  );
}
