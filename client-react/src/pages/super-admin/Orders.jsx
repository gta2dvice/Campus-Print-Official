import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  saApi, fmtMoney, fmtDate, fmtPickup, LIVE_REFRESH_MS, StatusBadge,
  Loading, EmptyState, ErrorState, Pagination, Modal, DetailGrid, DetailItem,
} from './shared';

export default function Orders() {
  const [searchParams] = useSearchParams();
  const initialStatus = searchParams.get('status') || '';
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState(initialStatus);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [applied, setApplied] = useState({ search: '', status: initialStatus, dateFrom: '', dateTo: '' });
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [openOrderId, setOpenOrderId] = useState(null);

  const loadOrders = useCallback(async (silent = false) => {
    if (!silent) {
      setLoading(true);
      setError('');
    }
    try {
      const params = new URLSearchParams({ ...applied, page, limit: 15 });
      const res = await saApi(`/api/super-admin/orders?${params}`);
      if (!res.ok) throw new Error('Failed to load orders');
      setData(await res.json());
      setError('');
    } catch (err) {
      if (!silent) setError(err.message);
    } finally {
      if (!silent) setLoading(false);
    }
  }, [applied, page]);

  useEffect(() => {
    loadOrders();
    const timer = setInterval(() => loadOrders(true), LIVE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [loadOrders]);

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
          placeholder="Search by Order ID or email…"
          className="rounded-[10px] border border-gray-200 bg-white px-[0.8rem] py-[0.55rem] text-[0.85rem] text-gray-900 outline-none focus:border-blue-500"
        />
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="rounded-[10px] border border-gray-200 bg-white px-[0.8rem] py-[0.55rem] text-[0.85rem] text-gray-900 outline-none focus:border-blue-500"
        >
          <option value="">All statuses</option>
          <option value="pending">Pending</option>
          <option value="accepted">Accepted</option>
          <option value="printing">Printing</option>
          <option value="ready">Ready</option>
          <option value="completed">Completed</option>
          <option value="rejected">Rejected</option>
          <option value="cancelled">Cancelled</option>
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
          <ErrorState>Couldn't load orders. {error}</ErrorState>
        ) : !data.orders.length ? (
          <EmptyState>No orders match your filters.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="sa-table w-full border-collapse text-[0.85rem]">
              <thead>
                <tr>
                  {['Order ID', 'Student', 'Shop', 'Pickup', 'Details', 'Status', 'Amount', 'Date', ''].map((h) => (
                    <th key={h} className="whitespace-nowrap border-b border-gray-200 px-3 py-[0.6rem] text-left text-[0.72rem] font-semibold uppercase tracking-wide text-gray-400">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.orders.map((o) => (
                  <tr key={o.id} className="hover:bg-blue-500/[0.03]">
                    <td data-label="Order ID" className="whitespace-nowrap border-b border-gray-100 px-3 py-[0.7rem] text-gray-900">#{String(o.id).padStart(4, '0')}</td>
                    <td data-label="Student" className="whitespace-nowrap border-b border-gray-100 px-3 py-[0.7rem] text-gray-900">{o.customer_email}</td>
                    <td data-label="Shop" className="whitespace-nowrap border-b border-gray-100 px-3 py-[0.7rem] text-gray-900">{o.shop_name || '—'}</td>
                    <td data-label="Pickup" className="whitespace-nowrap border-b border-gray-100 px-3 py-[0.7rem] text-gray-900">{fmtPickup(o)}</td>
                    <td data-label="Details" className="whitespace-nowrap border-b border-gray-100 px-3 py-[0.7rem] text-gray-900">{o.color_option === 'bw' ? 'B&W' : 'Color'} · {o.paper_size} · {o.copies}x</td>
                    <td data-label="Status" className="whitespace-nowrap border-b border-gray-100 px-3 py-[0.7rem]"><StatusBadge status={o.status} /></td>
                    <td data-label="Amount" className="whitespace-nowrap border-b border-gray-100 px-3 py-[0.7rem] font-semibold text-gray-900">{fmtMoney(o.total_price)}</td>
                    <td data-label="Date" className="whitespace-nowrap border-b border-gray-100 px-3 py-[0.7rem] text-gray-900">{fmtDate(o.created_at)}</td>
                    <td className="whitespace-nowrap border-b border-gray-100 px-3 py-[0.7rem]">
                      <button onClick={() => setOpenOrderId(o.id)} className="rounded-full border border-gray-200 px-[0.7rem] py-[0.32rem] text-[0.72rem] font-semibold text-gray-600 hover:border-blue-500 hover:bg-blue-500/[0.08] hover:text-blue-500">View</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination data={data} onPage={setPage} />
      </div>

      {openOrderId && <OrderModal orderId={openOrderId} onClose={() => setOpenOrderId(null)} />}
    </>
  );
}

function OrderModal({ orderId, onClose }) {
  const [order, setOrder] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await saApi(`/api/super-admin/orders/${orderId}`);
        if (!res.ok) throw new Error('Failed to load order');
        const o = await res.json();
        if (!cancelled) setOrder(o);
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    })();
    return () => { cancelled = true; };
  }, [orderId]);

  return (
    <Modal title={`Order #${String(orderId).padStart(4, '0')}`} onClose={onClose}>
      {error ? (
        <ErrorState>Couldn't load order. {error}</ErrorState>
      ) : !order ? (
        <Loading />
      ) : (
        <>
          <DetailGrid>
            <DetailItem label="Student">{order.customer_email}</DetailItem>
            <DetailItem label="Shop">{order.shop_name || '—'}</DetailItem>
            <DetailItem label="Status"><StatusBadge status={order.status} /></DetailItem>
            <DetailItem label="Color">{order.color_option === 'bw' ? 'Black & White' : 'Color'}</DetailItem>
            <DetailItem label="Paper Size">{order.paper_size}</DetailItem>
            <DetailItem label="Copies">{order.copies}</DetailItem>
            <DetailItem label="Amount"><strong>{fmtMoney(order.total_price)}</strong></DetailItem>
            <DetailItem label="Collection Location">{order.collection_location || '—'}</DetailItem>
            <DetailItem label="Collection Time">{order.collection_time || '—'}</DetailItem>
            <DetailItem label="Ticket">{order.ticket_number || '—'}</DetailItem>
            <DetailItem label="Printing Side">{order.printing_side === 'double' ? 'Double-Sided' : 'Single-Sided'}</DetailItem>
            <DetailItem label="Placed On">{fmtDate(order.created_at)}</DetailItem>
            {order.rejection_reason && <DetailItem label="Rejection Reason">{order.rejection_reason}</DetailItem>}
          </DetailGrid>
          <h4 className="mb-3 mt-5 text-[0.9rem] font-bold text-gray-900">Documents ({order.files.length})</h4>
          {order.files.length ? (
            <ul className="flex flex-col gap-2">
              {order.files.map((f) => (
                <li key={f.id} className="flex items-center justify-between gap-x-3 gap-y-1 rounded-[10px] bg-black/[0.02] px-[0.8rem] py-[0.6rem] text-[0.82rem] max-sm:flex-wrap">
                  <span className="min-w-0 [overflow-wrap:anywhere]">{f.original_name} <small className="text-gray-400">({(f.size_bytes / 1024).toFixed(0)} KB)</small></span>
                  <span className="flex-shrink-0">
                    <a href={`/api/super-admin/orders/${order.id}/documents/${f.id}`} target="_blank" rel="noopener noreferrer" className="ml-3 text-[0.78rem] font-semibold text-blue-500 hover:underline">View</a>
                    <a href={`/api/super-admin/orders/${order.id}/documents/${f.id}?download=1`} className="ml-3 text-[0.78rem] font-semibold text-blue-500 hover:underline">Download</a>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState>No documents uploaded for this order.</EmptyState>
          )}
        </>
      )}
    </Modal>
  );
}
