import { useEffect, useState } from 'react';
import StatusBadge from '../../components/admin/StatusBadge';
import Pagination from '../../components/admin/Pagination';
import { adminApi, fmtMoney, fmtDate } from '../../lib/adminHelpers';
import '../../styles/admin-effects.css';

const PAY_STATUS_OPTIONS = ['success', 'refunded', 'pending', 'failed'];
const PAY_LABELS = { success: 'Success', refunded: 'Refunded', pending: 'Pending', failed: 'Failed' };

export default function Transactions() {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [appliedFilters, setAppliedFilters] = useState({ search: '', status: '' });
  const [page, setPage] = useState(1);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError('');
      try {
        const params = new URLSearchParams({ search: appliedFilters.search, status: appliedFilters.status, page, limit: 15 });
        const res = await adminApi(`/api/admin/transactions?${params}`);
        if (!res.ok) throw new Error('Failed to load transactions');
        const json = await res.json();
        if (!cancelled) setData(json);
      } catch (err) {
        if (!cancelled) { setError(err.message || 'Failed to load transactions'); setData(null); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [appliedFilters, page]);

  function applyFilters() {
    setPage(1);
    setAppliedFilters({ search: search.trim(), status });
  }

  function resetFilters() {
    setSearch('');
    setStatus('');
    setPage(1);
    setAppliedFilters({ search: '', status: '' });
  }

  return (
    <div className="space-y-6">
      {/* Filter Card Container */}
      <div className="admin-filter-card">
        <div className="admin-filter-group">
          <div className="admin-search-box">
            <svg className="admin-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line>
            </svg>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search transaction ref, order ID, or email…"
              className="admin-search-input"
            />
          </div>

          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="admin-select"
          >
            <option value="">All Payment Statuses</option>
            {PAY_STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>{PAY_LABELS[s]}</option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          <button onClick={applyFilters} className="admin-btn-primary">
            Apply Filters
          </button>
          <button onClick={resetFilters} className="admin-btn-secondary">
            Reset
          </button>
        </div>
      </div>

      {/* Transactions Table Container */}
      <div className="admin-card">
        {loading ? (
          <div className="py-12 text-center text-xs font-semibold text-slate-400">Loading payment records...</div>
        ) : error ? (
          <div className="py-8 text-center text-xs font-bold text-rose-600">Couldn't load transactions. {error}</div>
        ) : !data?.payments?.length ? (
          <div className="py-12 text-center text-xs font-semibold text-slate-400">No transaction records match your filters.</div>
        ) : (
          <div className="admin-table-container">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Transaction Ref</th>
                  <th>Order ID</th>
                  <th>Customer Email</th>
                  <th>Amount</th>
                  <th>Payment Status</th>
                  <th className="text-right">Date & Time</th>
                </tr>
              </thead>
              <tbody>
                {data.payments.map((p) => (
                  <tr key={p.transaction_ref}>
                    <td data-label="Transaction Ref" className="font-mono text-xs font-bold text-slate-900">{p.transaction_ref}</td>
                    <td data-label="Order ID" className="font-bold text-blue-600">#{String(p.order_id).padStart(4, '0')}</td>
                    <td data-label="Customer Email" className="font-medium text-slate-800">{p.customer_email}</td>
                    <td data-label="Amount" className="font-black text-slate-900">{fmtMoney(p.amount)}</td>
                    <td data-label="Payment Status">
                      <StatusBadge status={p.status} kind="payment" />
                    </td>
                    <td data-label="Date & Time" className="text-right text-xs text-slate-400 font-medium">{fmtDate(p.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && <Pagination page={data.page} limit={data.limit} total={data.total} onPage={setPage} />}
      </div>
    </div>
  );
}
