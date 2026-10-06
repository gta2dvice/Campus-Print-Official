import { useCallback, useEffect, useState } from 'react';
import Toast from '../../components/Toast';
import useToast from './useToast';
import {
  saApi, fmtMoney, fmtDate, RoleBadge, ActiveBadge, StatusBadge,
  Loading, EmptyState, ErrorState, Pagination, Modal, DetailGrid, DetailItem,
} from './shared';

export default function Users() {
  const [search, setSearch] = useState('');
  const [role, setRole] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [appliedRole, setAppliedRole] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [openUserId, setOpenUserId] = useState(null);
  const [toast, showToast] = useToast();

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ search: appliedSearch, role: appliedRole, page, limit: 15 });
      const res = await saApi(`/api/super-admin/users?${params}`);
      if (!res.ok) throw new Error('Failed to load users');
      setData(await res.json());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [appliedSearch, appliedRole, page]);

  useEffect(() => { loadUsers(); }, [loadUsers]);

  function applyFilters() {
    setPage(1);
    setAppliedSearch(search.trim());
    setAppliedRole(role);
  }

  function resetFilters() {
    setSearch('');
    setRole('');
    setPage(1);
    setAppliedSearch('');
    setAppliedRole('');
  }

  async function toggleUserActive(userId, isActive) {
    if (!window.confirm(`Are you sure you want to ${isActive ? 'activate' : 'deactivate'} this account?`)) return;
    try {
      const res = await saApi(`/api/super-admin/users/${userId}/active`, { method: 'PATCH', body: JSON.stringify({ isActive }) });
      if (!res.ok) { const d = await res.json(); showToast(d.message || 'Update failed', 'error'); return; }
      showToast(`User ${isActive ? 'activated' : 'deactivated'} successfully.`);
      loadUsers();
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
          placeholder="Search by email…"
          className="rounded-[10px] border border-gray-200 bg-white px-[0.8rem] py-[0.55rem] text-[0.85rem] text-gray-900 outline-none focus:border-blue-500"
        />
        <select
          value={role}
          onChange={(e) => setRole(e.target.value)}
          className="rounded-[10px] border border-gray-200 bg-white px-[0.8rem] py-[0.55rem] text-[0.85rem] text-gray-900 outline-none focus:border-blue-500"
        >
          <option value="">All roles</option>
          <option value="student">Student</option>
          <option value="shop_admin">Shop Admin</option>
          <option value="super_admin">Super Admin</option>
        </select>
        <button onClick={applyFilters} className="rounded-full bg-blue-500 px-[1.1rem] py-2 text-[0.85rem] font-semibold text-white transition hover:bg-blue-600">Apply</button>
        <button onClick={resetFilters} className="rounded-full border border-gray-200 px-[1.1rem] py-2 text-[0.85rem] font-semibold text-gray-600 transition hover:border-blue-500 hover:bg-blue-500/[0.08] hover:text-blue-500">Reset</button>
      </div>

      <div className="rounded-[18px] border border-gray-300/50 bg-white/90 p-6 max-sm:p-4 shadow-sm backdrop-blur-md">
        {loading ? (
          <Loading />
        ) : error ? (
          <ErrorState>Couldn't load users. {error}</ErrorState>
        ) : !data.users.length ? (
          <EmptyState>No users match your filters.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="sa-table w-full border-collapse text-[0.85rem]">
              <thead>
                <tr>
                  {['Email', 'Role', 'Status', 'Joined', 'Actions'].map((h) => (
                    <th key={h} className="whitespace-nowrap border-b border-gray-200 px-3 py-[0.6rem] text-left text-[0.72rem] font-semibold uppercase tracking-wide text-gray-400">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.users.map((u) => (
                  <tr key={u.id} className="hover:bg-blue-500/[0.03]">
                    <td data-label="Email" className="whitespace-nowrap border-b border-gray-100 px-3 py-[0.7rem] text-gray-900">{u.email}</td>
                    <td data-label="Role" className="whitespace-nowrap border-b border-gray-100 px-3 py-[0.7rem]"><RoleBadge role={u.role} /></td>
                    <td data-label="Status" className="whitespace-nowrap border-b border-gray-100 px-3 py-[0.7rem]"><ActiveBadge isActive={u.is_active} /></td>
                    <td data-label="Joined" className="whitespace-nowrap border-b border-gray-100 px-3 py-[0.7rem] text-gray-900">{fmtDate(u.created_at)}</td>
                    <td data-label="Actions" className="whitespace-nowrap border-b border-gray-100 px-3 py-[0.7rem]">
                      <button onClick={() => setOpenUserId(u.id)} className="ml-1 rounded-full border border-gray-200 px-[0.7rem] py-[0.32rem] text-[0.72rem] font-semibold text-gray-600 hover:border-blue-500 hover:bg-blue-500/[0.08] hover:text-blue-500">View</button>
                      {u.role !== 'super_admin' && (
                        <button
                          onClick={() => toggleUserActive(u.id, !u.is_active)}
                          className={`ml-1 rounded-full px-[0.7rem] py-[0.32rem] text-[0.72rem] font-semibold text-white ${u.is_active ? 'bg-red-500 hover:bg-red-600' : 'bg-emerald-500 hover:bg-emerald-600'}`}
                        >
                          {u.is_active ? 'Deactivate' : 'Activate'}
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

      {openUserId && <UserModal userId={openUserId} onClose={() => setOpenUserId(null)} />}
      <Toast toast={toast} />
    </>
  );
}

function UserModal({ userId, onClose }) {
  const [user, setUser] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await saApi(`/api/super-admin/users/${userId}`);
        if (!res.ok) throw new Error('Failed to load user');
        const u = await res.json();
        if (!cancelled) setUser(u);
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    })();
    return () => { cancelled = true; };
  }, [userId]);

  return (
    <Modal title={user ? user.email : 'User Details'} onClose={onClose}>
      {error ? (
        <ErrorState>Couldn't load user. {error}</ErrorState>
      ) : !user ? (
        <Loading />
      ) : (
        <>
          <DetailGrid>
            <DetailItem label="Role"><RoleBadge role={user.role} /></DetailItem>
            <DetailItem label="Status"><ActiveBadge isActive={user.is_active} /></DetailItem>
            <DetailItem label="Joined">{fmtDate(user.created_at)}</DetailItem>
            <DetailItem label="Total Orders">{user.orders.length}</DetailItem>
          </DetailGrid>
          <h4 className="mb-3 mt-5 text-[0.9rem] font-bold text-gray-900">Order History</h4>
          {user.orders.length ? (
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
                  {user.orders.map((o) => (
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
            <EmptyState>No orders placed yet.</EmptyState>
          )}
        </>
      )}
    </Modal>
  );
}
