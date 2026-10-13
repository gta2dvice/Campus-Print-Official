import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  saApi, fmtDate, fmtPickup, LIVE_REFRESH_MS, StatusBadge,
  Loading, EmptyState, ErrorState, Pagination, Modal, DetailGrid, DetailItem,
} from './shared';
import { OrderFinance, fmtRupees } from './Finance';
import { canPreview, previewFile, downloadFile } from '../../lib/fileAccess';

// Manual payments the owner confirms by hand (no gateway to verify them).
const OWNER_CONFIRMABLE_METHODS = ['upi_qr', 'whatsapp', 'none'];

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
          <option value="completed">Completed (Ready for Pickup)</option>
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
                  {['Order ID', 'Student', 'Shop', 'Pickup', 'Details', 'Status', 'Customer Total', 'Printer', 'Extras', 'Date', ''].map((h) => (
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
                    <td data-label="Customer Total" className="whitespace-nowrap border-b border-gray-100 px-3 py-[0.7rem] font-semibold text-gray-900">{fmtRupees(o.finance?.customerTotal)}</td>
                    <td data-label="Printer" className="whitespace-nowrap border-b border-gray-100 px-3 py-[0.7rem] text-gray-900">{fmtRupees(o.finance?.printerPayable)}{o.finance?.basis === 'ESTIMATED' && <small className="ml-1 text-amber-600">est.</small>}</td>
                    <td data-label="Extras" className="whitespace-nowrap border-b border-gray-100 px-3 py-[0.7rem] text-gray-900">{fmtRupees(o.finance?.grossExtraRevenue)}{o.finance?.basis === 'ESTIMATED' && <small className="ml-1 text-amber-600">est.</small>}</td>
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

      {openOrderId && <OrderModal orderId={openOrderId} onClose={() => setOpenOrderId(null)} onChanged={() => loadOrders(true)} />}
    </>
  );
}

function OrderModal({ orderId, onClose, onChanged }) {
  const [order, setOrder] = useState(null);
  const [error, setError] = useState('');
  const [markingPaid, setMarkingPaid] = useState(false);
  const [markPaidMessage, setMarkPaidMessage] = useState('');

  const loadOrder = useCallback(async () => {
    const res = await saApi(`/api/super-admin/orders/${orderId}`);
    if (!res.ok) throw new Error('Failed to load order');
    return res.json();
  }, [orderId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const o = await loadOrder();
        if (!cancelled) setOrder(o);
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    })();
    return () => { cancelled = true; };
  }, [loadOrder]);

  // Owner confirms a UPI QR / manual payment after checking the received transfer.
  async function markPaid() {
    setMarkingPaid(true);
    setMarkPaidMessage('');
    try {
      const res = await saApi(`/api/super-admin/orders/${orderId}/mark-paid`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMarkPaidMessage(data.message || 'Could not mark as paid.');
        return;
      }
      setOrder(await loadOrder());
      setMarkPaidMessage('Payment marked as received.');
      onChanged?.();
    } catch {
      setMarkPaidMessage('Connection error. Please try again.');
    } finally {
      setMarkingPaid(false);
    }
  }

  const canMarkPaid = order?.payment?.status === 'pending' && OWNER_CONFIRMABLE_METHODS.includes(order.payment.method);

  // Pending → Accept → Completed (Ready for Pickup), or Reject. One request at a time.
  const [statusBusy, setStatusBusy] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const canHandle = ['pending', 'accepted', 'printing', 'ready'].includes(order?.status);

  async function changeStatus(action) {
    if (statusBusy) return;
    let body;
    if (action === 'reject') {
      const reason = window.prompt('Reason for rejecting this order (optional):');
      if (reason === null) return;
      body = JSON.stringify({ reason: reason.trim() });
    }
    setStatusBusy(true);
    setStatusMessage('');
    try {
      const res = await saApi(`/api/super-admin/orders/${orderId}/${action}`, { method: 'POST', body });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatusMessage(data.message || 'Could not update this order.');
      } else {
        setStatusMessage(action === 'accept' ? 'Accepted — moved to Completed (Ready for Pickup).' : 'Order rejected.');
      }
      setOrder(await loadOrder());
      onChanged?.();
    } catch {
      setStatusMessage('Connection error. Please try again.');
    } finally {
      setStatusBusy(false);
    }
  }

  async function openFile(file, mode) {
    const url = `/api/super-admin/orders/${orderId}/documents/${file.id}`;
    try {
      if (mode === 'preview') await previewFile(url);
      else await downloadFile(url, file.original_name);
    } catch (err) {
      setStatusMessage(err.message || 'Could not open this file.');
    }
  }

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
            <DetailItem label="Status">
              <StatusBadge status={order.status} />
              {canHandle && (
                <span className="ml-2 inline-flex gap-2">
                  <button onClick={() => changeStatus('accept')} disabled={statusBusy || order.payment_status !== 'PAID'} title={order.payment_status !== 'PAID' ? 'Confirm the payment first' : undefined} className="rounded-full border border-emerald-500 px-[0.7rem] py-[0.2rem] text-[0.72rem] font-semibold text-emerald-600 hover:bg-emerald-500/[0.08] disabled:opacity-50">
                    {statusBusy ? 'Saving…' : 'Accept'}
                  </button>
                  {order.status === 'pending' && (
                    <button onClick={() => changeStatus('reject')} disabled={statusBusy} className="rounded-full border border-red-500 px-[0.7rem] py-[0.2rem] text-[0.72rem] font-semibold text-red-600 hover:bg-red-500/[0.08] disabled:opacity-50">
                      Reject
                    </button>
                  )}
                </span>
              )}
              {statusMessage && <div className="mt-1 text-[0.75rem] text-gray-500">{statusMessage}</div>}
            </DetailItem>
            <DetailItem label="Color">{order.color_option === 'bw' ? 'Black & White' : 'Color'}</DetailItem>
            <DetailItem label="Paper Size">{order.paper_size}</DetailItem>
            <DetailItem label="Copies">{order.copies}</DetailItem>
            <DetailItem label="Customer Total"><strong>{fmtRupees(order.finance?.summary?.customerTotal)}</strong></DetailItem>
            <DetailItem label="Payment">
              {order.payment ? `${order.payment.method} · ${order.payment.status}` : 'No payment recorded'}
              {canMarkPaid && (
                <button onClick={markPaid} disabled={markingPaid} className="ml-2 rounded-full border border-emerald-500 px-[0.7rem] py-[0.2rem] text-[0.72rem] font-semibold text-emerald-600 hover:bg-emerald-500/[0.08]">
                  {markingPaid ? 'Saving…' : 'Mark Paid'}
                </button>
              )}
              {markPaidMessage && <div className="mt-1 text-[0.75rem] text-gray-500">{markPaidMessage}</div>}
            </DetailItem>
            <DetailItem label="Collection Location">{order.collection_location || '—'}</DetailItem>
            <DetailItem label="Collection Time">{order.collection_time || '—'}</DetailItem>
            <DetailItem label="Ticket">{order.ticket_number || '—'}</DetailItem>
            <DetailItem label="Printing Side">{order.printing_side === 'double' ? 'Double-Sided' : 'Single-Sided'}</DetailItem>
            <DetailItem label="Placed On">{fmtDate(order.created_at)}</DetailItem>
            {order.rejection_reason && <DetailItem label="Rejection Reason">{order.rejection_reason}</DetailItem>}
          </DetailGrid>
          <OrderFinance finance={order.finance} />
          <h4 className="mb-3 mt-5 text-[0.9rem] font-bold text-gray-900">Documents ({order.files.length})</h4>
          {order.files.length ? (
            <ul className="flex flex-col gap-2">
              {order.files.map((f) => (
                <li key={f.id} className="flex items-center justify-between gap-x-3 gap-y-1 rounded-[10px] bg-black/[0.02] px-[0.8rem] py-[0.6rem] text-[0.82rem] max-sm:flex-wrap">
                  <span className="min-w-0 [overflow-wrap:anywhere]">
                    {f.original_name} <small className="text-gray-400">({(f.size_bytes / 1024).toFixed(0)} KB)</small>
                    <small className="block text-gray-500">
                      {f.page_count ? `${f.page_count} pages` : 'pages —'} · {f.copies || 1}x · {f.color_mode === 'color' ? 'Color' : 'B&W'} · {f.printing_side === 'double' ? 'Double-sided' : 'Single-sided'}
                      {f.printing_charge != null && ` · printing ${fmtRupees(f.printing_charge)}`}
                    </small>
                  </span>
                  <span className="flex-shrink-0">
                    {f.file_deleted_at ? (
                      <span className="ml-3 text-[0.78rem] text-gray-400">File deleted</span>
                    ) : (
                      <>
                        {canPreview(f.mime_type) && (
                          <button type="button" onClick={() => openFile(f, 'preview')} className="ml-3 text-[0.78rem] font-semibold text-blue-500 hover:underline">Preview</button>
                        )}
                        <button type="button" onClick={() => openFile(f, 'download')} className="ml-3 text-[0.78rem] font-semibold text-blue-500 hover:underline">Download</button>
                      </>
                    )}
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
