// Shared helpers for the shop-admin panel (mirrors client/admin/common.js)

export const STATUS_LABELS = {
  pending: 'Pending',
  accepted: 'Accepted',
  printing: 'Printing',
  ready: 'Ready',
  completed: 'Completed · Ready for Pickup',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

export const STATUS_BADGE_CLASSES = {
  pending: 'bg-amber-500/10 text-amber-600 border-amber-500/20',
  accepted: 'bg-blue-500/10 text-blue-600 border-blue-500/20',
  printing: 'bg-violet-500/10 text-violet-600 border-violet-500/20',
  ready: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20',
  completed: 'bg-slate-500/10 text-slate-600 border-slate-500/20',
  rejected: 'bg-rose-500/10 text-rose-600 border-rose-500/20',
  cancelled: 'bg-rose-500/10 text-rose-600 border-rose-500/20',
  success: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20',
  refunded: 'bg-slate-500/10 text-slate-600 border-slate-500/20',
  failed: 'bg-rose-500/10 text-rose-600 border-rose-500/20',
};

export const PAY_LABELS = {
  success: 'Success',
  refunded: 'Refunded',
  pending: 'Pending',
  failed: 'Failed',
};

// Workflow: Pending → Accept → Completed (Ready for Pickup), or Pending → Reject.
export const NEXT_ACTIONS = {
  pending: [
    { status: 'completed', label: 'Accept', cls: 'bg-emerald-500 hover:bg-emerald-600 text-white' },
    { status: 'rejected', label: 'Reject', cls: 'bg-red-500 hover:bg-red-600 text-white' },
  ],
};

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

export async function adminApi(url, opts = {}) {
  const res = await fetch(url, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (res.status === 401) {
    window.location.href = '/admin/login';
    throw new Error('Unauthorized');
  }
  return res;
}
