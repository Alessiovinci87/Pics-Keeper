// In development, Vite proxy forwards /api/* to the backend.
// In production, set VITE_API_BASE to the backend URL.
const API_BASE = import.meta.env.VITE_API_BASE || '/api';

/**
 * Fetch product dashboard data from the backend.
 * Falls back to mock data if the API is unavailable.
 */
export async function fetchProducts({ accountId = 1, dateFrom, dateTo, page = 1, limit = 50 } = {}) {
  const params = new URLSearchParams({ accountId, page, limit });
  if (dateFrom) params.append('dateFrom', dateFrom);
  if (dateTo) params.append('dateTo', dateTo);

  const response = await fetch(`${API_BASE}/dashboard/products?${params}`);
  if (!response.ok) throw new Error(`API error: ${response.status}`);
  return response.json();
}

export async function fetchAccounts() {
  const response = await fetch(`${API_BASE}/accounts`);
  if (!response.ok) throw new Error(`API error: ${response.status}`);
  return response.json();
}
