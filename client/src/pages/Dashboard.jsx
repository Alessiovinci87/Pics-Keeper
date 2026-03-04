import { useState, useEffect, useCallback } from 'react';
import DateRangePicker from '../components/DateRangePicker';
import Filters from '../components/Filters';
import SummaryCards from '../components/SummaryCards';
import AsinTable from '../components/AsinTable';
import useDateRange from '../hooks/useDateRange';
import { getAsinDashboard, getAccountDashboard, getAccounts } from '../services/api';
import './Dashboard.css';

const PAGE_SIZE = 50;

export default function Dashboard() {
  const dateRange = useDateRange('last_30');
  const [marketplaceId, setMarketplaceId] = useState('');
  const [asinFilter, setAsinFilter] = useState('');
  const [accountId, setAccountId] = useState(null);
  const [accounts, setAccounts] = useState([]);

  const [asinData, setAsinData] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [sortKey, setSortKey] = useState('metric_date');
  const [sortDir, setSortDir] = useState('desc');
  const [error, setError] = useState(null);

  // Load accounts on mount
  useEffect(() => {
    getAccounts()
      .then((res) => {
        setAccounts(res.data || []);
        if (res.data?.length > 0) {
          setAccountId(res.data[0].id);
        }
      })
      .catch((err) => setError(err.message));
  }, []);

  const fetchData = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    setError(null);
    try {
      const params = {
        accountId,
        dateFrom: dateRange.dateFrom,
        dateTo: dateRange.dateTo,
        page,
        limit: PAGE_SIZE,
      };
      if (marketplaceId) params.marketplaceId = marketplaceId;
      if (asinFilter) params.asin = asinFilter;

      const [asinRes, accountRes] = await Promise.all([
        getAsinDashboard(params),
        getAccountDashboard({
          accountId,
          marketplaceId: marketplaceId || undefined,
          dateFrom: dateRange.dateFrom,
          dateTo: dateRange.dateTo,
        }),
      ]);

      let rows = asinRes.data || [];
      // Client-side sort
      rows.sort((a, b) => {
        let va = a[sortKey], vb = b[sortKey];
        if (typeof va === 'string') {
          return sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
        }
        va = Number(va) || 0;
        vb = Number(vb) || 0;
        return sortDir === 'asc' ? va - vb : vb - va;
      });

      setAsinData(rows);
      setTotalPages(Math.ceil((asinRes.pagination?.total || 0) / PAGE_SIZE));
      setSummary(accountRes.summary);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [accountId, dateRange.dateFrom, dateRange.dateTo, marketplaceId, asinFilter, page, sortKey, sortDir]);

  // Fetch when filters change
  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Reset page when filters change
  useEffect(() => {
    setPage(1);
  }, [dateRange.dateFrom, dateRange.dateTo, marketplaceId, asinFilter]);

  const handleSort = (key) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <h1>Sales Dashboard</h1>
        {accounts.length > 1 && (
          <select
            className="account-select"
            value={accountId || ''}
            onChange={(e) => setAccountId(Number(e.target.value))}
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        )}
      </header>

      <DateRangePicker {...dateRange} />
      <Filters
        marketplaceId={marketplaceId}
        setMarketplaceId={setMarketplaceId}
        asinFilter={asinFilter}
        setAsinFilter={setAsinFilter}
      />

      {error && <div className="error-banner">{error}</div>}

      <SummaryCards summary={summary} />

      <AsinTable
        data={asinData}
        loading={loading}
        page={page}
        totalPages={totalPages}
        onPageChange={setPage}
        sortKey={sortKey}
        sortDir={sortDir}
        onSort={handleSort}
      />
    </div>
  );
}
