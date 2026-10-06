// Shared helpers for the super-admin panel: fetch wrapper, formatters, badges, pagination.
// Ports client/super-admin/common.js into idiomatic React pieces.

export const STATUS_LABELS = {
  pending: 'Pending', accepted: 'Accepted', printing: 'Printing',
  ready: 'Ready', completed: 'Completed', rejected: 'Rejected', cancelled: 'Cancelled',
};
export const PAY_LABELS = { success: 'Success', refunded: 'Refunded', pending: 'Pending', failed: 'Failed' };
export const ROLE_LABELS = { student: 'Student', shop_admin: 'Shop Admin', super_admin: 'Super Admin' };
export const APPROVAL_LABELS = { approved: 'Approved', pending: 'Pending', rejected: 'Rejected' };

export function fmtMoney(n) {
  return `₹${Number(n || 0).toFixed(0)}`;
}

export function fmtDate(d) {
  return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function fmtPickup(order) {
  const loc = order?.collection_location || '';
  const time = order?.collection_time || '';
  if (loc && time) return `${loc} · ${time}`;
  return loc || time || '—';
}

export const LIVE_REFRESH_MS = 12000;

// Fetch wrapper matching the original common.js `api()` helper: always sends
// credentials, JSON headers, and redirects to the super-admin login on 401.
export async function saApi(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  if (res.status === 401) {
    window.location.href = '/super-admin/login';
    throw new Error('Unauthorized');
  }
  return res;
}

const STATUS_STYLES = {
  pending: 'bg-amber-500/10 text-amber-600',
  accepted: 'bg-blue-500/10 text-blue-600',
  printing: 'bg-violet-500/10 text-violet-600',
  ready: 'bg-emerald-500/10 text-emerald-600',
  completed: 'bg-gray-500/10 text-gray-600',
  rejected: 'bg-red-500/10 text-red-600',
  cancelled: 'bg-red-500/8 text-red-700',
  success: 'bg-emerald-500/10 text-emerald-600',
  refunded: 'bg-gray-500/10 text-gray-600',
  failed: 'bg-red-500/10 text-red-600',
};

function Badge({ className, children }) {
  return (
    <span className={`inline-flex items-center whitespace-nowrap rounded-full px-[0.7rem] py-[0.2rem] text-[0.72rem] font-semibold tracking-wide ${className}`}>
      {children}
    </span>
  );
}

export function StatusBadge({ status }) {
  return <Badge className={STATUS_STYLES[status] || 'bg-gray-500/10 text-gray-600'}>{STATUS_LABELS[status] || status}</Badge>;
}

export function PaymentBadge({ status }) {
  return <Badge className={STATUS_STYLES[status] || 'bg-gray-500/10 text-gray-600'}>{PAY_LABELS[status] || status}</Badge>;
}

const ROLE_STYLES = {
  student: 'bg-blue-500/10 text-blue-600',
  shop_admin: 'bg-violet-500/10 text-violet-600',
  super_admin: 'bg-emerald-500/10 text-emerald-600',
};

export function RoleBadge({ role }) {
  return <Badge className={ROLE_STYLES[role] || 'bg-gray-500/10 text-gray-600'}>{ROLE_LABELS[role] || role}</Badge>;
}

export function ActiveBadge({ isActive }) {
  return (
    <Badge className={isActive ? 'bg-emerald-500/10 text-emerald-600' : 'bg-red-500/10 text-red-600'}>
      {isActive ? 'Active' : 'Inactive'}
    </Badge>
  );
}

const APPROVAL_STYLES = {
  approved: 'bg-emerald-500/10 text-emerald-600',
  pending: 'bg-amber-500/10 text-amber-600',
  rejected: 'bg-red-500/10 text-red-600',
};

export function ApprovalBadge({ status }) {
  return <Badge className={APPROVAL_STYLES[status] || 'bg-gray-500/10 text-gray-600'}>{APPROVAL_LABELS[status] || status}</Badge>;
}

export function Pagination({ data, onPage }) {
  if (!data) return null;
  const totalPages = Math.max(1, Math.ceil(data.total / data.limit));
  if (totalPages <= 1) return null;
  return (
    <div className="mt-5 flex items-center justify-center gap-4 text-sm text-gray-600 max-sm:gap-3">
      <button
        className="whitespace-nowrap rounded-full border border-gray-200 px-3.5 py-1.5 text-[0.8rem] font-semibold max-sm:px-4 max-sm:py-2.5 text-gray-600 transition hover:border-blue-500 hover:bg-blue-500/[0.08] hover:text-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
        disabled={data.page <= 1}
        onClick={() => onPage(data.page - 1)}
      >
        ← Prev
      </button>
      <span className="whitespace-nowrap">Page {data.page} of {totalPages}</span>
      <button
        className="whitespace-nowrap rounded-full border border-gray-200 px-3.5 py-1.5 text-[0.8rem] font-semibold max-sm:px-4 max-sm:py-2.5 text-gray-600 transition hover:border-blue-500 hover:bg-blue-500/[0.08] hover:text-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
        disabled={data.page >= totalPages}
        onClick={() => onPage(data.page + 1)}
      >
        Next →
      </button>
    </div>
  );
}

export function Loading() {
  return <p className="py-6 text-center text-sm text-gray-400">Loading…</p>;
}

export function EmptyState({ children }) {
  return <div className="py-6 text-center text-sm text-gray-400">{children}</div>;
}

export function ErrorState({ children }) {
  return <p className="py-6 text-center text-sm text-red-500">{children}</p>;
}

export function TrendChart({ trend }) {
  if (!trend || !trend.length) return <EmptyState>No order activity yet.</EmptyState>;
  const max = Math.max(...trend.map((t) => t.count), 1);
  return (
    <div className="flex h-[140px] items-end gap-1.5 pt-2">
      {trend.map((t) => (
        <div key={t.date} className="flex h-full flex-1 flex-col items-center justify-end gap-1.5" title={`${t.date}: ${t.count} orders`}>
          <div
            className="w-full max-w-[22px] rounded-t bg-[linear-gradient(180deg,#3b82f6,#2563eb)]"
            style={{ height: `${Math.max(4, (t.count / max) * 100)}%` }}
          />
          <span className="text-[0.65rem] text-gray-400">{new Date(t.date).getDate()}</span>
        </div>
      ))}
    </div>
  );
}

export function Modal({ title, onClose, children }) {
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-gray-900/45 p-6 backdrop-blur-[2px] max-sm:p-3"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="max-h-[85vh] w-full max-w-[560px] overflow-y-auto rounded-[20px] bg-white shadow-[0_20px_60px_rgba(0,0,0,0.25)] max-sm:max-h-[calc(100dvh-24px)]">
        <div className="flex items-center justify-between gap-3 border-b border-gray-200 px-6 py-5 max-sm:px-4 max-sm:py-3">
          <h3 className="min-w-0 text-[1.05rem] font-bold text-gray-900 [overflow-wrap:anywhere]">{title}</h3>
          <button className="flex-shrink-0 text-base text-gray-400 hover:text-gray-600 max-sm:flex max-sm:h-10 max-sm:w-10 max-sm:items-center max-sm:justify-center" onClick={onClose}>✕</button>
        </div>
        <div className="p-6 max-sm:p-4">{children}</div>
      </div>
    </div>
  );
}

export function DetailGrid({ children }) {
  return <div className="grid grid-cols-2 gap-[0.9rem] max-md:grid-cols-1">{children}</div>;
}

export function DetailItem({ label, children }) {
  return (
    <div>
      <span className="mb-[0.15rem] block text-[0.72rem] uppercase tracking-wide text-gray-400">{label}</span>
      <span className="text-gray-900 [overflow-wrap:anywhere]">{children}</span>
    </div>
  );
}
