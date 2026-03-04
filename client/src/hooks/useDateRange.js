import { useState, useMemo } from 'react';
import dayjs from 'dayjs';
import isoWeek from 'dayjs/plugin/isoWeek';
import quarterOfYear from 'dayjs/plugin/quarterOfYear';
dayjs.extend(isoWeek);
dayjs.extend(quarterOfYear);

const PRESETS = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'this_week', label: 'This Week' },
  { key: 'last_week', label: 'Last Week' },
  { key: 'last_7', label: 'Last 7 Days' },
  { key: 'last_14', label: 'Last 14 Days' },
  { key: 'last_30', label: 'Last 30 Days' },
  { key: 'this_month', label: 'This Month' },
  { key: 'last_month', label: 'Last Month' },
  { key: 'this_quarter', label: 'This Quarter' },
  { key: 'last_quarter', label: 'Last Quarter' },
  { key: 'this_year', label: 'This Year' },
  { key: 'last_year', label: 'Last Year' },
  { key: 'custom', label: 'Custom' },
];

function computeRange(key) {
  const now = dayjs();
  switch (key) {
    case 'today':
      return [now.startOf('day'), now.endOf('day')];
    case 'yesterday':
      return [now.subtract(1, 'day').startOf('day'), now.subtract(1, 'day').endOf('day')];
    case 'this_week':
      return [now.startOf('isoWeek'), now.endOf('day')];
    case 'last_week':
      return [now.subtract(1, 'week').startOf('isoWeek'), now.subtract(1, 'week').endOf('isoWeek')];
    case 'last_7':
      return [now.subtract(6, 'day').startOf('day'), now.endOf('day')];
    case 'last_14':
      return [now.subtract(13, 'day').startOf('day'), now.endOf('day')];
    case 'last_30':
      return [now.subtract(29, 'day').startOf('day'), now.endOf('day')];
    case 'this_month':
      return [now.startOf('month'), now.endOf('day')];
    case 'last_month':
      return [now.subtract(1, 'month').startOf('month'), now.subtract(1, 'month').endOf('month')];
    case 'this_quarter':
      return [now.startOf('quarter'), now.endOf('day')];
    case 'last_quarter':
      return [now.subtract(1, 'quarter').startOf('quarter'), now.subtract(1, 'quarter').endOf('quarter')];
    case 'this_year':
      return [now.startOf('year'), now.endOf('day')];
    case 'last_year':
      return [now.subtract(1, 'year').startOf('year'), now.subtract(1, 'year').endOf('year')];
    default:
      return [now.subtract(6, 'day').startOf('day'), now.endOf('day')];
  }
}

export { PRESETS };

export default function useDateRange(initialPreset = 'last_30') {
  const [preset, setPreset] = useState(initialPreset);
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');

  const range = useMemo(() => {
    if (preset === 'custom' && customFrom && customTo) {
      return {
        dateFrom: customFrom,
        dateTo: customTo,
      };
    }
    const [from, to] = computeRange(preset);
    return {
      dateFrom: from.format('YYYY-MM-DD'),
      dateTo: to.format('YYYY-MM-DD'),
    };
  }, [preset, customFrom, customTo]);

  return {
    preset,
    setPreset,
    customFrom,
    setCustomFrom,
    customTo,
    setCustomTo,
    ...range,
  };
}
