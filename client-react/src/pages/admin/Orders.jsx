import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import Toast from '../../components/Toast';
import StatusBadge from '../../components/admin/StatusBadge';
import Pagination from '../../components/admin/Pagination';
import { adminApi, fmtMoney, fmtDate, fmtPickup, LIVE_REFRESH_MS, STATUS_LABELS } from '../../lib/adminHelpers';

const STATUS_OPTIONS = ['pending', 'accepted', 'printing', 'ready', 'completed', 'rejected', 'cancelled'];

const ACTION_BUTTON_CLASSES = {
  accepted: 'admin-action-btn admin-action-btn-accept',
  rejected: 'admin-action-btn admin-action-btn-reject',
  printing: 'admin-action-btn admin-action-btn-print',
  ready: 'admin-action-btn admin-action-btn-ready',
  completed: 'admin-action-btn admin-action-btn-complete',
};

const NEXT_ACTIONS_CONFIG = {
  pending: [
    { status: 'accepted', label: 'Accept' },
    { status: 'rejected', label: 'Reject' },
  ],
  accepted: [{ status: 'printing', label: 'Start Printing' }],
  printing: [{ status: 'ready', label: 'Mark Ready' }],
  ready: [{ status: 'completed', label: 'Mark Completed' }],
};

const PAYMENT_METHOD_LABELS = {
  cashfree: 'Cashfree (online)',
  simulated: 'Test checkout',
  whatsapp: 'QR Payment',
  none: 'No payment (pay shop directly)',
};

export default function Orders() {
  const [searchParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState(searchParams.get('status') || '');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [appliedFilters, setAppliedFilters] = useState({ search: '', status: searchParams.get('status') || '', dateFrom: '', dateTo: '' });
  const [page, setPage] = useState(1);

  useEffect(() => {
    const urlStatus = searchParams.get('status') || '';
    setStatus(urlStatus);
    setPage(1);
    setAppliedFilters((f) => ({ ...f, status: urlStatus }));
  }, [searchParams]);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [toast, setToast] = useState(null);
  function showToast(message, type = 'success') {
    setToast({ message, type, show: true });
    setTimeout(() => setToast((t) => t && { ...t, show: false }), 3500);
  }

  const [modalOrder, setModalOrder] = useState(null);
  const [modalLoading, setModalLoading] = useState(false);
  const [modalError, setModalError] = useState('');
  const [markingPaid, setMarkingPaid] = useState(false);

  const [rejectOrderId, setRejectOrderId] = useState(null);
  const [rejectReason, setRejectReason] = useState('');

  async function loadOrders(silent = false) {
    if (!silent) {
      setLoading(true);
      setError('');
    }
    try {
      const params = new URLSearchParams({
        search: appliedFilters.search,
        status: appliedFilters.status,
        dateFrom: appliedFilters.dateFrom,
        dateTo: appliedFilters.dateTo,
        page,
        limit: 15,
      });
      const res = await adminApi(`/api/admin/orders?${params}`);
      if (!res.ok) throw new Error('Failed to load orders');
      const json = await res.json();
      setData(json);
      setError('');
    } catch (err) {
      if (!silent) {
        setError(err.message || 'Failed to load orders');
        setData(null);
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }

  useEffect(() => {
    loadOrders();
    const timer = setInterval(() => loadOrders(true), LIVE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [appliedFilters, page]);

  function applyFilters() {
    setPage(1);
    setAppliedFilters({ search: search.trim(), status, dateFrom, dateTo });
  }

  function resetFilters() {
    setSearch('');
    setStatus('');
    setDateFrom('');
    setDateTo('');
    setPage(1);
    setAppliedFilters({ search: '', status: '', dateFrom: '', dateTo: '' });
  }

  async function updateOrderStatus(orderId, newStatus, closeModal = false) {
    try {
      const res = await adminApi(`/api/admin/orders/${orderId}/status`, { method: 'PATCH', body: JSON.stringify({ status: newStatus }) });
      const respData = await res.json();
      if (!res.ok) { showToast(respData.message || 'Update failed', 'error'); return; }
      showToast(`Order marked as ${STATUS_LABELS[newStatus] || newStatus}.`);
      if (closeModal) setModalOrder(null);
      loadOrders();
    } catch {
      showToast('Connection error. Please try again.', 'error');
    }
  }

  async function openOrderModal(orderId) {
    setModalOrder({ id: orderId });
    setModalLoading(true);
    setModalError('');
    try {
      const res = await adminApi(`/api/admin/orders/${orderId}`);
      if (!res.ok) throw new Error('Failed to load order');
      const o = await res.json();
      setModalOrder(o);
    } catch (err) {
      setModalError(err.message || 'Failed to load order');
    } finally {
      setModalLoading(false);
    }
  }

  async function markOrderPaid() {
    if (!modalOrder?.id) return;
    setMarkingPaid(true);
    try {
      const res = await adminApi(`/api/admin/orders/${modalOrder.id}/mark-paid`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast(data.message || 'Could not mark as paid.', 'error');
        return;
      }
      setModalOrder((o) => (o ? { ...o, payment: data } : o));
      showToast('Payment marked as received.');
    } catch {
      showToast('Connection error. Please try again.', 'error');
    } finally {
      setMarkingPaid(false);
    }
  }

  function openRejectModal(orderId) {
    setRejectOrderId(orderId);
    setRejectReason('');
  }

  async function confirmReject() {
    if (!rejectOrderId) return;
    try {
      const res = await adminApi(`/api/admin/orders/${rejectOrderId}/reject`, { method: 'POST', body: JSON.stringify({ reason: rejectReason.trim() }) });
      const respData = await res.json();
      setRejectOrderId(null);
      if (!res.ok) { showToast(respData.message || 'Reject failed', 'error'); return; }
      showToast('Order rejected.');
      setModalOrder(null);
      loadOrders();
    } catch {
      setRejectOrderId(null);
      showToast('Connection error. Please try again.', 'error');
    }
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
              placeholder="Search Order ID, student name, or email…"
              className="admin-search-input"
            />
          </div>

          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="admin-select"
          >
            <option value="">All Statuses</option>
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>{STATUS_LABELS[s]}</option>
            ))}
          </select>

          <div className="flex items-center gap-2">
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="admin-date-input"
            />
            <span className="text-xs text-slate-400 font-bold">to</span>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="admin-date-input"
            />
          </div>
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

      {/* Orders Table Container */}
      <div className="admin-card">
        {loading ? (
          <div className="py-12 text-center text-xs font-semibold text-slate-400">Loading print orders...</div>
        ) : error ? (
          <div className="py-8 text-center text-xs font-bold text-rose-600">Couldn't load orders. {error}</div>
        ) : !data?.orders?.length ? (
          <div className="py-12 text-center text-xs font-semibold text-slate-400">No print orders match your selected filters.</div>
        ) : (
          <div className="admin-table-container">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Order ID</th>
                  <th>Customer & Contact</th>
                  <th>Pickup Slot</th>
                  <th>Specs</th>
                  <th>Status</th>
                  <th>Amount</th>
                  <th>Date</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.orders.map((o) => (
                  <tr key={o.id}>
                    <td data-label="Order ID" className="font-extrabold text-slate-900 whitespace-nowrap">#{String(o.id).padStart(4, '0')}</td>
                    <td data-label="Customer & Contact">
                      <div>
                        <div className="font-bold text-slate-900">{o.full_name || o.customer_email}</div>
                        <div className="text-[0.68rem] text-slate-400">{o.phone_number || o.customer_email}</div>
                      </div>
                    </td>
                    <td data-label="Pickup Slot" className="text-slate-600 font-medium whitespace-nowrap">{fmtPickup(o)}</td>
                    <td data-label="Specs" className="whitespace-nowrap">
                      <span className="inline-block rounded bg-slate-100 px-2 py-0.5 text-[0.7rem] font-bold text-slate-700">
                        {o.color_option === 'bw' ? 'B&W' : 'Color'} · {o.paper_size} · {o.copies}x
                      </span>
                    </td>
                    <td data-label="Status" className="whitespace-nowrap">
                      <StatusBadge status={o.status} />
                    </td>
                    <td data-label="Amount" className="font-black text-slate-900 whitespace-nowrap">{fmtMoney(o.total_price)}</td>
                    <td data-label="Date" className="text-[0.68rem] text-slate-400 whitespace-nowrap">{fmtDate(o.created_at)}</td>
                    <td data-label="Actions" className="text-right whitespace-nowrap">
                      <div className="admin-actions-cell">
                        <button
                          onClick={() => openOrderModal(o.id)}
                          className="admin-action-btn admin-action-btn-view"
                        >
                          Details
                        </button>
                        {(NEXT_ACTIONS_CONFIG[o.status] || []).map((a) => (
                          <button
                            key={a.status}
                            onClick={() => (a.status === 'rejected' ? openRejectModal(o.id) : updateOrderStatus(o.id, a.status))}
                            className={ACTION_BUTTON_CLASSES[a.status] || 'admin-action-btn admin-action-btn-print'}
                          >
                            {a.label}
                          </button>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && <Pagination page={data.page} limit={data.limit} total={data.total} onPage={setPage} />}
      </div>

      {/* Order Details Modal */}
      {modalOrder && (
        <div className="admin-modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) setModalOrder(null); }}>
          <div className="admin-modal-card">
            {/* Header */}
            <div className="admin-modal-header">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-50 text-blue-600 font-extrabold text-sm border border-blue-100 flex-shrink-0">
                  #{String(modalOrder.id).padStart(4, '0')}
                </div>
                <div>
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                    <h3 className="text-base font-black text-slate-900">Order #{String(modalOrder.id).padStart(4, '0')}</h3>
                    {modalOrder.status && <StatusBadge status={modalOrder.status} />}
                  </div>
                  <div className="text-xs text-slate-500 font-medium">Placed on {fmtDate(modalOrder.created_at)}</div>
                </div>
              </div>
              <button
                onClick={() => setModalOrder(null)}
                className="flex h-8 w-8 max-sm:h-10 max-sm:w-10 flex-shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-400 hover:bg-slate-200 hover:text-slate-800 transition"
                title="Close"
              >
                ✕
              </button>
            </div>

            {/* Body */}
            <div className="admin-modal-body">
              {modalLoading ? (
                <div className="py-12 text-center text-xs font-semibold text-slate-400">Loading order details...</div>
              ) : modalError ? (
                <div className="py-8 text-center text-xs font-bold text-rose-600">Couldn't load order details. {modalError}</div>
              ) : (
                <>
                  {/* Customer Contact Section */}
                  <div className="admin-modal-section">
                    <div className="admin-modal-section-title">
                      <svg className="w-4 h-4 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                      </svg>
                      Customer Contact
                    </div>
                    <div className="admin-modal-grid">
                      <div className="admin-modal-field">
                        <span className="admin-modal-label">Customer Name</span>
                        <span className="admin-modal-value">{modalOrder.full_name || 'N/A'}</span>
                      </div>
                      <div className="admin-modal-field">
                        <span className="admin-modal-label">Phone Number</span>
                        <span className="admin-modal-value">{modalOrder.phone_number || 'N/A'}</span>
                      </div>
                      <div className="admin-modal-field">
                        <span className="admin-modal-label">Email Address</span>
                        <span className="admin-modal-value">{modalOrder.customer_email || 'N/A'}</span>
                      </div>
                      <div className="admin-modal-field">
                        <span className="admin-modal-label">Room / Hostel</span>
                        <span className="admin-modal-value">{modalOrder.class_room_number || 'N/A'}</span>
                      </div>
                    </div>
                  </div>

                  {/* Print Specifications Section */}
                  <div className="admin-modal-section">
                    <div className="admin-modal-section-title">
                      <svg className="w-4 h-4 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
                      </svg>
                      Print Specifications
                    </div>
                    <div className="admin-modal-grid">
                      <div className="admin-modal-field">
                        <span className="admin-modal-label">Color Mode</span>
                        <span className="admin-modal-value">{modalOrder.color_option === 'bw' ? 'Black & White' : 'Color'}</span>
                      </div>
                      <div className="admin-modal-field">
                        <span className="admin-modal-label">Paper Size</span>
                        <span className="admin-modal-value">{modalOrder.paper_size || 'A4'}</span>
                      </div>
                      <div className="admin-modal-field">
                        <span className="admin-modal-label">Copies</span>
                        <span className="admin-modal-value">{modalOrder.copies}</span>
                      </div>
                      <div className="admin-modal-field">
                        <span className="admin-modal-label">Printing Side</span>
                        <span className="admin-modal-value">{modalOrder.printing_side === 'double' ? 'Double-Sided' : 'Single-Sided'}</span>
                      </div>
                      <div className="admin-modal-field">
                        <span className="admin-modal-label">Spiral Binding</span>
                        <span className="admin-modal-value">{modalOrder.spiral_binding ? 'Yes' : 'No'}</span>
                      </div>
                      <div className="admin-modal-field">
                        <span className="admin-modal-label">Express Delivery</span>
                        <span className="admin-modal-value">{modalOrder.express_delivery ? 'Yes' : 'No'}</span>
                      </div>
                      <div className="admin-modal-field">
                        <span className="admin-modal-label">Pickup Slot</span>
                        <span className="admin-modal-value">{fmtPickup(modalOrder)}</span>
                      </div>
                      <div className="admin-modal-field">
                        <span className="admin-modal-label">Total Price</span>
                        <span className="admin-modal-value text-blue-600 text-base font-black">{fmtMoney(modalOrder.total_price)}</span>
                      </div>
                    </div>
                  </div>

                  {/* Payment Section */}
                  <div className="admin-modal-section">
                    <div className="admin-modal-section-title">
                      <svg className="w-4 h-4 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
                      </svg>
                      Payment
                    </div>
                    {modalOrder.payment ? (
                      <div className="admin-modal-grid">
                        <div className="admin-modal-field">
                          <span className="admin-modal-label">Method</span>
                          <span className="admin-modal-value">{PAYMENT_METHOD_LABELS[modalOrder.payment.method] || modalOrder.payment.method || 'N/A'}</span>
                        </div>
                        <div className="admin-modal-field">
                          <span className="admin-modal-label">Status</span>
                          <span className="admin-modal-value flex flex-wrap items-center gap-2">
                            <StatusBadge status={modalOrder.payment.status} kind="payment" />
                            {modalOrder.payment.status === 'pending' && (
                              <button onClick={markOrderPaid} disabled={markingPaid} className="admin-action-btn admin-action-btn-accept max-sm:min-h-11">
                                {markingPaid ? 'Saving…' : 'Mark Paid'}
                              </button>
                            )}
                          </span>
                        </div>
                        {modalOrder.payment.transaction_ref && (
                          <div className="admin-modal-field">
                            <span className="admin-modal-label">Transaction Ref</span>
                            <span className="admin-modal-value break-all">{modalOrder.payment.transaction_ref}</span>
                          </div>
                        )}
                      </div>
                    ) : (
                      <p className="py-2 text-center text-xs font-semibold text-slate-400">No payment recorded.</p>
                    )}
                  </div>

                  {/* Uploaded Documents Section */}
                  <div className="admin-modal-section">
                    <div className="admin-modal-section-title">
                      <svg className="w-4 h-4 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                      </svg>
                      Uploaded Documents ({modalOrder.files?.length || 0})
                    </div>
                    {modalOrder.files?.length ? (
                      <div>
                        {modalOrder.files.map((f) => (
                          <div key={f.id} className="admin-doc-item">
                            <div className="flex items-center gap-3 min-w-0">
                              <div className="admin-doc-badge">PDF</div>
                              <div className="min-w-0">
                                <div className="admin-doc-name">{f.original_name}</div>
                                <div className="admin-doc-size">{(f.size_bytes / 1024).toFixed(0)} KB</div>
                              </div>
                            </div>
                            <div className="flex items-center gap-2 flex-shrink-0">
                              <a
                                href={`/api/admin/orders/${modalOrder.id}/documents/${f.id}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="admin-doc-btn admin-doc-btn-view"
                              >
                                View
                              </a>
                              <a
                                href={`/api/admin/orders/${modalOrder.id}/documents/${f.id}?download=1`}
                                className="admin-doc-btn admin-doc-btn-dl"
                              >
                                Download
                              </a>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="py-2 text-center text-xs font-semibold text-slate-400">No document files attached.</p>
                    )}
                  </div>
                </>
              )}
            </div>

            {/* Footer */}
            <div className="admin-modal-footer">
              <button onClick={() => setModalOrder(null)} className="admin-btn-secondary">
                Close
              </button>
              {modalOrder && (NEXT_ACTIONS_CONFIG[modalOrder.status] || []).length > 0 && (
                <div className="flex items-center gap-2">
                  {(NEXT_ACTIONS_CONFIG[modalOrder.status] || []).map((a) => (
                    <button
                      key={a.status}
                      onClick={() => (a.status === 'rejected' ? (setModalOrder(null), openRejectModal(modalOrder.id)) : updateOrderStatus(modalOrder.id, a.status, true))}
                      className={ACTION_BUTTON_CLASSES[a.status] || 'admin-action-btn admin-action-btn-print'}
                    >
                      {a.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Reject Reason Modal */}
      {rejectOrderId && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-xs admin-overlay-in" onClick={(e) => { if (e.target === e.currentTarget) setRejectOrderId(null); }}>
          <div className="w-full max-w-[420px] rounded-3xl bg-white p-6 shadow-2xl ring-1 ring-black/5 animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between border-b border-slate-100 pb-4">
              <h3 className="text-base font-extrabold text-slate-900">Reject Print Order</h3>
              <button onClick={() => setRejectOrderId(null)} className="text-slate-400 hover:text-slate-700 max-sm:flex max-sm:h-10 max-sm:w-10 max-sm:items-center max-sm:justify-center">✕</button>
            </div>
            <div className="mt-4 space-y-4">
              <p className="text-xs text-slate-600">Are you sure you want to reject order #{String(rejectOrderId).padStart(4, '0')}?</p>
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">Reason for rejection (optional)</label>
                <textarea
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  rows={2}
                  placeholder="e.g. Unsupported file format or unreadable document"
                  className="admin-input"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2 max-sm:flex-col-reverse">
                <button onClick={() => setRejectOrderId(null)} className="admin-btn-secondary">Cancel</button>
                <button onClick={confirmReject} className="admin-action-btn admin-action-btn-reject max-sm:min-h-11">Confirm Reject</button>
              </div>
            </div>
          </div>
        </div>
      )}

      <Toast toast={toast} />
    </div>
  );
}
