import { useCallback, useEffect, useState } from 'react';
import { saApi, fmtMoney, fmtDate, PaymentBadge, Loading, EmptyState, ErrorState, Pagination } from './shared';

export default function Transactions() {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [applied, setApplied] = useState({ search: '', status: '', dateFrom: '', dateTo: '' });
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const loadTransactions = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ ...applied, page, limit: 15 });
      const res = await saApi(`/api/super-admin/transactions?${params}`);
      if (!res.ok) throw new Error('Failed to load transactions');
      setData(await res.json());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [applied, page]);

  useEffect(() => { loadTransactions(); }, [loadTransactions]);

  function applyFilters() {
    setPage(1);
    setApplied({ search: search.trim(), status, dateFrom, dateTo });
  }

  function resetFilters() {
    setSearch('');
    setStatus('');
    setDateFrom('');
    setDateTo('');
    setPage(1);
    setApplied({ search: '', status: '', dateFrom: '', dateTo: '' });
  }

  return (
    <>
      <div className="sa-filter-bar mb-5 flex flex-wrap items-center gap-[0.6rem]">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by order ID, email, or reference…"
          className="rounded-[10px] border border-gray-200 bg-white px-[0.8rem] py-[0.55rem] text-[0.85rem] text-gray-900 outline-none focus:border-blue-500"
        />
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="rounded-[10px] border border-gray-200 bg-white px-[0.8rem] py-[0.55rem] text-[0.85rem] text-gray-900 outline-none focus:border-blue-500"
        >
          <option value="">All statuses</option>
          <option value="success">Success</option>
          <option value="refunded">Refunded</option>
          <option value="pending">Pending</option>
          <option value="failed">Failed</option>
        </select>
        <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="rounded-[10px] border border-gray-200 bg-white px-[0.8rem] py-[0.55rem] text-[0.85rem] text-gray-900 outline-none focus:border-blue-500" />
        <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="rounded-[10px] border border-gray-200 bg-white px-[0.8rem] py-[0.55rem] text-[0.85rem] text-gray-900 outline-none focus:border-blue-500" />
        <button onClick={applyFilters} className="rounded-full bg-blue-500 px-[1.1rem] py-2 text-[0.85rem] font-semibold text-white transition hover:bg-blue-600">Apply</button>
        <button onClick={resetFilters} className="rounded-full border border-gray-200 px-[1.1rem] py-2 text-[0.85rem] font-semibold text-gray-600 transition hover:border-blue-500 hover:bg-blue-500/[0.08] hover:text-blue-500">Reset</button>
      </div>

      <div className="rounded-[18px] border border-gray-300/50 bg-white/90 p-6 max-sm:p-4 shadow-sm backdrop-blur-md">
        {loading ? (
          <Loading />
        ) : error ? (
          <ErrorState>Couldn't load transactions. {error}</ErrorState>
        ) : !data.payments.length ? (
          <EmptyState>No transactions match your filters.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="sa-table w-full border-collapse text-[0.85rem]">
              <thead>
                <tr>
                  {['Reference', 'Order', 'Customer', 'Shop', 'Amount', 'Status', 'Date'].map((h) => (
                    <th key={h} className="whitespace-nowrap border-b border-gray-200 px-3 py-[0.6rem] text-left text-[0.72rem] font-semibold uppercase tracking-wide text-gray-400">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.payments.map((p) => (
                  <tr key={p.id} className="hover:bg-blue-500/[0.03]">
                    <td data-label="Reference" className="whitespace-nowrap border-b border-gray-100 px-3 py-[0.7rem] text-gray-900">{p.transaction_ref}</td>
                    <td data-label="Order" className="whitespace-nowrap border-b border-gray-100 px-3 py-[0.7rem] text-gray-900">#{String(p.order_id).padStart(4, '0')}</td>
                    <td data-label="Customer" className="whitespace-nowrap border-b border-gray-100 px-3 py-[0.7rem] text-gray-900">{p.customer_email}</td>
                    <td data-label="Shop" className="whitespace-nowrap border-b border-gray-100 px-3 py-[0.7rem] text-gray-900">{p.shop_name || '—'}</td>
                    <td data-label="Amount" className="whitespace-nowrap border-b border-gray-100 px-3 py-[0.7rem] font-semibold text-gray-900">{fmtMoney(p.amount)}</td>
                    <td data-label="Status" className="whitespace-nowrap border-b border-gray-100 px-3 py-[0.7rem]"><PaymentBadge status={p.status} /></td>
                    <td data-label="Date" className="whitespace-nowrap border-b border-gray-100 px-3 py-[0.7rem] text-gray-900">{fmtDate(p.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination data={data} onPage={setPage} />
      </div>
    </>
  );
}
