// In development, Vite proxy forwards /api/* to the backend.
// In production, set VITE_API_BASE to the backend URL.
const API_BASE = import.meta.env.VITE_API_BASE || '/api';

async function apiFetch(path, params = {}) {
  const qs = new URLSearchParams(params);
  const response = await fetch(`${API_BASE}${path}?${qs}`);
  if (!response.ok) throw new Error(`API error: ${response.status}`);
  return response.json();
}

async function apiPost(path, body) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`API error: ${response.status}`);
  return response.json();
}

async function apiPatch(path, body) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`API error: ${response.status}`);
  return response.json();
}

// ---- Accounts ----
export async function fetchAccounts() {
  return apiFetch('/accounts');
}

export async function createAccount(data) {
  return apiPost('/accounts', data);
}

export async function updateAccount(id, data) {
  return apiPatch(`/accounts/${id}`, data);
}

export async function deleteAccount(id) {
  const response = await fetch(`${API_BASE}/accounts/${id}`, { method: 'DELETE' });
  if (!response.ok) throw new Error(`API error: ${response.status}`);
  return response.json();
}

// ---- Products Dashboard ----
export async function fetchProducts({ accountId, dateFrom, dateTo, page = 1, limit = 50 } = {}) {
  const params = { accountId, page, limit };
  if (dateFrom) params.dateFrom = dateFrom;
  if (dateTo) params.dateTo = dateTo;
  return apiFetch('/dashboard/products', params);
}

// ---- Alerts ----
export async function fetchAlerts({ accountId, status, page = 1, limit = 50 } = {}) {
  const params = { accountId, page, limit };
  if (status) params.status = status;
  return apiFetch('/alerts', params);
}

export async function acknowledgeAlert(id) {
  return apiPatch(`/alerts/${id}/acknowledge`, {});
}

export async function resolveAlert(id) {
  return apiPatch(`/alerts/${id}/resolve`, {});
}

// ---- ASIN Costs ----
export async function fetchAsinCosts({ accountId, marketplaceId, page = 1, limit = 100 } = {}) {
  const params = { accountId, page, limit };
  if (marketplaceId) params.marketplaceId = marketplaceId;
  return apiFetch('/asin-costs', params);
}

export async function setAsinCosts(data) {
  return apiPost('/asin-costs', data);
}

// ---- Cash / Payouts ----
export async function fetchCashSummary({ accountId, dateFrom, dateTo } = {}) {
  const params = { accountId };
  if (dateFrom) params.dateFrom = dateFrom;
  if (dateTo) params.dateTo = dateTo;
  return apiFetch('/cash/summary', params);
}

export async function registerPayout(data) {
  return apiPost('/cash/payout', data);
}

// ---- Sync ----
export async function triggerSync(jobType) {
  return apiPost(`/sync/trigger/${jobType}`, {});
}

export async function fetchSyncLogs({ accountId, limit = 50 } = {}) {
  return apiFetch('/sync/log', { accountId, limit });
}

// ---- Health ----
export async function healthCheck() {
  return apiFetch('/health');
}
