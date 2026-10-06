import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import Toast from '../../components/Toast';
import useToast from './useToast';
import {
  saApi, fmtMoney, fmtDate, ActiveBadge, ApprovalBadge, StatusBadge,
  Loading, EmptyState, ErrorState, Pagination, Modal, DetailGrid, DetailItem,
} from './shared';

export default function Shops() {
  const [searchParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState(searchParams.get('status') || '');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [appliedStatus, setAppliedStatus] = useState(searchParams.get('status') || '');
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [openShopId, setOpenShopId] = useState(null);
  const [toast, showToast] = useToast();

  const loadShops = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ search: appliedSearch, status: appliedStatus, page, limit: 15 });
      const res = await saApi(`/api/super-admin/shops?${params}`);
      if (!res.ok) throw new Error('Failed to load shops');
      setData(await res.json());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [appliedSearch, appliedStatus, page]);

  useEffect(() => { loadShops(); }, [loadShops]);

  function applyFilters() {
    setPage(1);
    setAppliedSearch(search.trim());
    setAppliedStatus(status);
  }

  function resetFilters() {
    setSearch('');
    setStatus('');
    setPage(1);
    setAppliedSearch('');
    setAppliedStatus('');
  }

  async function approveShop(shopId) {
    try {
      const res = await saApi(`/api/super-admin/shops/${shopId}/approval`, { method: 'PATCH', body: JSON.stringify({ status: 'approved' }) });
      if (!res.ok) { const d = await res.json(); showToast(d.message || 'Approval failed', 'error'); return; }
      showToast('Shop approved.');
      loadShops();
    } catch {
      showToast('Connection error. Please try again.', 'error');
    }
  }

  async function toggleShopActive(shopId, isActive) {
    if (!window.confirm(`Are you sure you want to ${isActive ? 'activate' : 'deactivate'} this shop?`)) return;
    try {
      const res = await saApi(`/api/super-admin/shops/${shopId}/active`, { method: 'PATCH', body: JSON.stringify({ isActive }) });
      if (!res.ok) { const d = await res.json(); showToast(d.message || 'Update failed', 'error'); return; }
      showToast(`Shop ${isActive ? 'activated' : 'deactivated'} successfully.`);
      loadShops();
    } catch {
      showToast('Connection error. Please try again.', 'error');
    }
  }

  return (
    <>
      <div className="sa-filter-bar mb-5 flex flex-wrap items-center gap-[0.6rem]">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by shop name…"
          className="rounded-[10px] border border-gray-200 bg-white px-[0.8rem] py-[0.55rem] text-[0.85rem] text-gray-900 outline-none focus:border-blue-500"
        />
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="rounded-[10px] border border-gray-200 bg-white px-[0.8rem] py-[0.55rem] text-[0.85rem] text-gray-900 outline-none focus:border-blue-500"
        >
          <option value="">All shops</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
          <option value="pending">Pending Approval</option>
        </select>
        <button onClick={applyFilters} className="rounded-full bg-blue-500 px-[1.1rem] py-2 text-[0.85rem] font-semibold text-white transition hover:bg-blue-600">Apply</button>
        <button onClick={resetFilters} className="rounded-full border border-gray-200 px-[1.1rem] py-2 text-[0.85rem] font-semibold text-gray-600 transition hover:border-blue-500 hover:bg-blue-500/[0.08] hover:text-blue-500">Reset</button>
      </div>

      <div className="rounded-[18px] border border-gray-300/50 bg-white/90 p-6 max-sm:p-4 shadow-sm backdrop-blur-md">
        {loading ? (
          <Loading />
        ) : error ? (
          <ErrorState>Couldn't load shops. {error}</ErrorState>
        ) : !data.shops.length ? (
          <EmptyState>No shops match your filters.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="sa-table w-full border-collapse text-[0.85rem]">
              <thead>
                <tr>
                  {['Shop', 'Owner', 'Status', 'Approval', 'Orders', 'Earnings', 'Actions'].map((h) => (
                    <th key={h} className="whitespace-nowrap border-b border-gray-200 px-3 py-[0.6rem] text-left text-[0.72rem] font-semibold uppercase tracking-wide text-gray-400">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.shops.map((s) => (
                  <tr key={s.id} className="hover:bg-blue-500/[0.03]">
                    <td data-label="Shop" className="whitespace-nowrap border-b border-gray-100 px-3 py-[0.7rem] text-gray-900">{s.shop_name}</td>
                    <td data-label="Owner" className="whitespace-nowrap border-b border-gray-100 px-3 py-[0.7rem] text-gray-900">{s.owner_email || '—'}</td>
                    <td data-label="Status" className="whitespace-nowrap border-b border-gray-100 px-3 py-[0.7rem]"><ActiveBadge isActive={s.is_active} /></td>
                    <td data-label="Approval" className="whitespace-nowrap border-b border-gray-100 px-3 py-[0.7rem]"><ApprovalBadge status={s.approval_status} /></td>
                    <td data-label="Orders" className="whitespace-nowrap border-b border-gray-100 px-3 py-[0.7rem] text-gray-900">{s.total_orders}</td>
                    <td data-label="Earnings" className="whitespace-nowrap border-b border-gray-100 px-3 py-[0.7rem] font-semibold text-gray-900">{fmtMoney(s.total_earnings)}</td>
                    <td data-label="Actions" className="whitespace-nowrap border-b border-gray-100 px-3 py-[0.7rem]">
                      <button onClick={() => setOpenShopId(s.id)} className="ml-1 rounded-full border border-gray-200 px-[0.7rem] py-[0.32rem] text-[0.72rem] font-semibold text-gray-600 hover:border-blue-500 hover:bg-blue-500/[0.08] hover:text-blue-500">View</button>
                      {s.approval_status === 'pending' && (
                        <button onClick={() => approveShop(s.id)} className="ml-1 rounded-full bg-emerald-500 px-[0.7rem] py-[0.32rem] text-[0.72rem] font-semibold text-white hover:bg-emerald-600">Approve</button>
                      )}
                      {s.approval_status !== 'pending' && (
                        <button
                          onClick={() => toggleShopActive(s.id, !s.is_active)}
                          className={`ml-1 rounded-full px-[0.7rem] py-[0.32rem] text-[0.72rem] font-semibold text-white ${s.is_active ? 'bg-red-500 hover:bg-red-600' : 'bg-emerald-500 hover:bg-emerald-600'}`}
                        >
                          {s.is_active ? 'Deactivate' : 'Activate'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination data={data} onPage={setPage} />
      </div>

      {openShopId && <ShopModal shopId={openShopId} onClose={() => setOpenShopId(null)} />}
      <Toast toast={toast} />
    </>
  );
}

function ShopModal({ shopId, onClose }) {
  const [shop, setShop] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await saApi(`/api/super-admin/shops/${shopId}`);
        if (!res.ok) throw new Error('Failed to load shop');
        const s = await res.json();
        if (!cancelled) setShop(s);
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    })();
    return () => { cancelled = true; };
  }, [shopId]);

  return (
    <Modal title={shop ? shop.shop_name : 'Shop Details'} onClose={onClose}>
      {error ? (
        <ErrorState>Couldn't load shop. {error}</ErrorState>
      ) : !shop ? (
        <Loading />
      ) : (
        <>
          <DetailGrid>
            <DetailItem label="Owner">{shop.owner_email || '—'}</DetailItem>
            <DetailItem label="Status"><ActiveBadge isActive={shop.is_active} /></DetailItem>
            <DetailItem label="Approval"><ApprovalBadge status={shop.approval_status} /></DetailItem>
            <DetailItem label="Phone">{shop.phone || '—'}</DetailItem>
            <DetailItem label="Address">{shop.address || '—'}</DetailItem>
            <DetailItem label="Hours">{shop.opens_at && shop.closes_at ? `${shop.opens_at} – ${shop.closes_at}` : '—'}</DetailItem>
          </DetailGrid>
          <h4 className="mb-3 mt-5 text-[0.9rem] font-bold text-gray-900">Recent Orders</h4>
          {shop.recentOrders.length ? (
            <div className="overflow-x-auto">
              <table className="sa-table w-full border-collapse text-[0.85rem]">
                <thead>
                  <tr>
                    {['Order ID', 'Status', 'Amount', 'Date'].map((h) => (
                      <th key={h} className="whitespace-nowrap border-b border-gray-200 px-3 py-[0.6rem] text-left text-[0.72rem] font-semibold uppercase tracking-wide text-gray-400">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {shop.recentOrders.map((o) => (
                    <tr key={o.id}>
                      <td data-label="Order ID" className="whitespace-nowrap border-b border-gray-100 px-3 py-[0.7rem] text-gray-900">#{String(o.id).padStart(4, '0')}</td>
                      <td data-label="Status" className="whitespace-nowrap border-b border-gray-100 px-3 py-[0.7rem]"><StatusBadge status={o.status} /></td>
                      <td data-label="Amount" className="whitespace-nowrap border-b border-gray-100 px-3 py-[0.7rem] font-semibold text-gray-900">{fmtMoney(o.total_price)}</td>
                      <td data-label="Date" className="whitespace-nowrap border-b border-gray-100 px-3 py-[0.7rem] text-gray-900">{fmtDate(o.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState>No orders yet.</EmptyState>
          )}
        </>
      )}
    </Modal>
  );
}
