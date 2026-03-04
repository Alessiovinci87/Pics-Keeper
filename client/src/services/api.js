const BASE = '/api';

async function request(path, params = {}) {
  const url = new URL(path, window.location.origin);
  Object.entries(params).forEach(([k, v]) => {
    if (v != null && v !== '') url.searchParams.set(k, v);
  });
  const res = await fetch(url);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `HTTP ${res.status}`);
  }
  return res.json();
}

export function getAccounts() {
  return request(`${BASE}/accounts`);
}

export function getAsinDashboard(params) {
  return request(`${BASE}/dashboard/asin`, params);
}

export function getAccountDashboard(params) {
  return request(`${BASE}/dashboard/account`, params);
}

export function getMarketplaces(accountId) {
  return request(`${BASE}/accounts/${accountId}`);
}
