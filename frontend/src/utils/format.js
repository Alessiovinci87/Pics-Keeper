/**
 * Formatting utilities for the product dashboard.
 */

export function formatCurrency(value, currency = 'EUR') {
  const num = Number(value);
  if (isNaN(num)) return '€0.00';
  return new Intl.NumberFormat('it-IT', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(num);
}

export function formatNumber(value) {
  const num = Number(value);
  if (isNaN(num)) return '0';
  return new Intl.NumberFormat('it-IT').format(num);
}

export function formatPct(value) {
  const num = Number(value);
  if (isNaN(num)) return '0.00%';
  return `${num.toFixed(2)}%`;
}

export function profitColorClass(value) {
  const num = Number(value);
  if (num > 0) return 'positive';
  if (num < 0) return 'negative';
  return '';
}
