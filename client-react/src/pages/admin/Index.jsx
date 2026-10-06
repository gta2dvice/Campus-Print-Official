import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import StatusBadge from '../../components/admin/StatusBadge';
import { adminApi, fmtMoney, fmtPickup, LIVE_REFRESH_MS } from '../../lib/adminHelpers';

const STAT_ICONS = {
  doc: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></>,
  clock: <><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></>,
  printer: <><polyline points="6 9 6 2 18 2 18 9"></polyline><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path><rect x="6" y="14" width="12" height="8"></rect></>,
  checkcircle: <><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></>,
  wallet: <><line x1="12" y1="1" x2="12" y2="23"></line><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path></>,
  bag: <><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"></path><line x1="3" y1="6" x2="21" y2="6"></line><path d="M16 10a4 4 0 0 1-8 0"></path></>,
  shop: <><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><polyline points="9 22 9 12 15 12 15 22"></polyline></>,
  earnings: <><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"></path><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"></path><path d="M18 12a2 2 0 0 0 0 4h4v-4z"></path></>,
};

function Icon({ name, className = 'h-5 w-5' }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {STAT_ICONS[name]}
    </svg>
  );
}

const ICON_BG = {
  blue: 'bg-blue-50 text-blue-600 border border-blue-200',
  amber: 'bg-amber-50 text-amber-600 border border-amber-200',
  purple: 'bg-purple-50 text-purple-600 border border-purple-200',
  green: 'bg-emerald-50 text-emerald-600 border border-emerald-200',
};

const SUB_COLOR = {
  blue: 'text-blue-700 bg-blue-50 px-2.5 py-0.5 rounded-full border border-blue-200',
  amber: 'text-amber-700 bg-amber-50 px-2.5 py-0.5 rounded-full border border-amber-200',
  purple: 'text-purple-700 bg-purple-50 px-2.5 py-0.5 rounded-full border border-purple-200',
  green: 'text-emerald-700 bg-emerald-50 px-2.5 py-0.5 rounded-full border border-emerald-200',
};

function StatCard({ icon, color, number, label, sub }) {
  return (
    <div className="admin-stat-card">
      <div className="flex items-center justify-between gap-2">
        <div className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl ${ICON_BG[color]}`}>
          <Icon name={icon} className="h-5 w-5" />
        </div>
        <span className={`text-[0.68rem] font-extrabold whitespace-nowrap ${SUB_COLOR[color]}`}>{sub}</span>
      </div>
      <div className="mt-3">
        <div className="text-2xl font-black tracking-tight text-slate-900 leading-none">{number}</div>
        <div className="mt-1 text-xs font-semibold text-slate-500 truncate">{label}</div>
      </div>
    </div>
  );
}

export default function Index() {
  const [welcomeName, setWelcomeName] = useState('Shop Owner');
  const [data, setData] = useState(null);
  const [earnings, setEarnings] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    let loadedOnce = false;

    async function load() {
      try {
        const shopRes = await adminApi('/api/admin/shop-profile');
        if (shopRes.ok) {
          const shop = await shopRes.json();
          if (!cancelled && shop.shop_name) setWelcomeName(shop.shop_name);
        }
      } catch { /* keep default greeting */ }

      try {
        const [dashRes, earnRes] = await Promise.all([adminApi('/api/admin/dashboard'), adminApi('/api/admin/earnings')]);
        if (!dashRes.ok || !earnRes.ok) throw new Error('Failed to load dashboard');
        const dashData = await dashRes.json();
        const earnData = await earnRes.json();
        if (cancelled) return;
        setData(dashData);
        setEarnings(earnData);
        setError('');
        loadedOnce = true;
      } catch (err) {
        if (!cancelled && !loadedOnce) setError(err.message || 'Failed to load dashboard');
      }
    }

    load();
    const timer = setInterval(load, LIVE_REFRESH_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  const dateLabel = new Date().toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const c = data?.statusCounts;

  return (
    <div className="space-y-6">
      {/* Header Banner - Clean White Card */}
      <div className="admin-welcome-banner">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full bg-blue-50 px-3 py-1 text-xs font-bold text-blue-700 border border-blue-200">
            <span className="h-2 w-2 rounded-full bg-blue-600 animate-pulse" />
            Live Dashboard Overview
          </div>
          <h2 className="mt-2 text-xl md:text-2xl font-black tracking-tight text-slate-900">Welcome back, {welcomeName}! 👋</h2>
          <p className="mt-1 text-xs font-medium text-slate-500">Live order queue, print status, and store revenue analytics.</p>
        </div>
        <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-4 py-2 text-xs font-bold text-slate-700">
          <svg className="h-4 w-4 text-blue-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="18" rx="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line>
          </svg>
          <span>{dateLabel}</span>
        </div>
      </div>

      {/* Pending Alert Banner */}
      {c && c.pending > 0 && (
        <div className="admin-alert-banner">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-amber-500 text-slate-950 font-black shadow-sm">
              <Icon name="clock" className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-black text-amber-950 truncate">
                {c.pending} new pending print {c.pending === 1 ? 'order' : 'orders'} requiring confirmation!
              </div>
              <div className="text-xs font-medium text-amber-800 truncate">Review specs and confirm to start printing.</div>
            </div>
          </div>
          <Link
            to="/admin/orders?status=pending"
            className="admin-btn-primary bg-amber-600 hover:bg-amber-700 text-white flex-shrink-0"
          >
            Review Pending Orders →
          </Link>
        </div>
      )}

      {error && !data ? (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-6 text-center text-sm font-semibold text-rose-600">
          Couldn't load dashboard data. {error}
        </div>
      ) : !data ? (
        <div className="py-12 text-center text-sm font-medium text-slate-400">Loading live store dashboard...</div>
      ) : (
        <>
          {/* Stat Cards Grid */}
          <div className="admin-stats-grid">
            <StatCard icon="doc" color="blue" number={data.totalOrders} label="Total Orders" sub="This Month" />
            <StatCard icon="clock" color="amber" number={c.pending} label="Pending Orders" sub="Needs Action" />
            <StatCard icon="printer" color="purple" number={c.accepted + c.printing} label="In Progress" sub="Accepted + Printing" />
            <StatCard icon="checkcircle" color="green" number={c.completed} label="Completed Orders" sub="This Month" />
            <StatCard icon="wallet" color="green" number={fmtMoney(data.earningsToday)} label="Today's Earnings" sub={`${data.ordersToday} Orders Today`} />
          </div>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3 items-start">
            {/* Recent Orders List */}
            <div className="admin-card lg:col-span-2">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <div>
                  <h3 className="text-base font-extrabold text-slate-900">Recent Orders</h3>
                  <p className="text-xs text-slate-500">Incoming print requests</p>
                </div>
                <Link to="/admin/orders" className="text-xs font-bold text-blue-600 hover:text-blue-700 hover:underline">
                  View All Orders →
                </Link>
              </div>

              {!data.recentOrders || data.recentOrders.length === 0 ? (
                <div className="py-8 text-center text-xs font-medium text-slate-400">No orders received yet.</div>
              ) : (
                <div className="admin-table-container">
                  <table className="admin-table">
                    <thead>
                      <tr>
                        <th>Order ID</th>
                        <th>Customer</th>
                        <th>Pickup</th>
                        <th>Specs</th>
                        <th>Status</th>
                        <th className="text-right">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.recentOrders.map((o) => (
                        <tr key={o.id}>
                          <td data-label="Order ID" className="font-extrabold text-slate-900">#{String(o.id).padStart(4, '0')}</td>
                          <td data-label="Customer" className="text-slate-800 font-medium">{o.customer_email}</td>
                          <td data-label="Pickup" className="text-slate-500 font-medium">{fmtPickup(o)}</td>
                          <td data-label="Specs">
                            <span className="inline-block rounded bg-slate-100 px-2 py-0.5 text-[0.7rem] font-bold text-slate-700">
                              {o.color_option === 'bw' ? 'B&W' : 'Color'} · {o.paper_size} · {o.copies}x
                            </span>
                          </td>
                          <td data-label="Status">
                            <StatusBadge status={o.status} />
                          </td>
                          <td data-label="Amount" className="text-right font-black text-slate-900">{fmtMoney(o.total_price)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Side Column: Revenue Snapshot & Quick Links */}
            <div className="space-y-6">
              <div className="admin-card">
                <h3 className="text-base font-extrabold text-slate-900">Revenue Snapshot</h3>
                <div className="mt-3 text-3xl font-black tracking-tight text-blue-600">{fmtMoney(earnings?.today?.amount)}</div>
                <div className="mt-1 text-xs font-semibold text-slate-500">Earned Today ({earnings?.today?.count || 0} orders)</div>

                <div className="mt-5 space-y-2.5 border-t border-slate-100 pt-4 text-xs font-semibold">
                  <div className="flex items-center justify-between">
                    <span className="text-slate-500">Yesterday</span>
                    <span className="text-slate-900">{fmtMoney(earnings?.yesterday?.amount)}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-slate-500">Total Lifetime</span>
                    <span className="text-slate-900">{fmtMoney(earnings?.total?.amount)}</span>
                  </div>
                </div>

                <Link
                  to="/admin/earnings"
                  className="mt-4 block rounded-xl bg-slate-100 py-2.5 text-center text-xs font-bold text-slate-700 transition hover:bg-slate-200 text-decoration-none"
                >
                  Full Financial Analytics →
                </Link>
              </div>

              {/* Quick Actions */}
              <div className="admin-card">
                <h3 className="mb-3 text-base font-extrabold text-slate-900">Quick Shortcuts</h3>
                <div className="flex flex-col gap-2.5">
                  <Link
                    to="/admin/orders?status=pending"
                    className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50/50 p-3 text-decoration-none transition hover:border-blue-300 hover:bg-blue-50/50"
                  >
                    <div className="flex items-center gap-3">
                      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600 font-bold">
                        <Icon name="clock" className="h-4 w-4" />
                      </div>
                      <span className="text-xs font-bold text-slate-800">Pending Queue</span>
                    </div>
                    <span className="rounded-full bg-amber-500/10 border border-amber-300/40 px-2 py-0.5 text-[0.7rem] font-extrabold text-amber-700">
                      {c.pending} orders
                    </span>
                  </Link>

                  <Link
                    to="/admin/orders?status=ready"
                    className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50/50 p-3 text-decoration-none transition hover:border-blue-300 hover:bg-blue-50/50"
                  >
                    <div className="flex items-center gap-3">
                      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600 font-bold">
                        <Icon name="bag" className="h-4 w-4" />
                      </div>
                      <span className="text-xs font-bold text-slate-800">Ready for Pickup</span>
                    </div>
                    <span className="rounded-full bg-emerald-500/10 border border-emerald-300/40 px-2 py-0.5 text-[0.7rem] font-extrabold text-emerald-700">
                      {c.ready} orders
                    </span>
                  </Link>

                  <Link
                    to="/admin/shop-profile"
                    className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50/50 p-3 text-decoration-none transition hover:border-blue-300 hover:bg-blue-50/50"
                  >
                    <div className="flex items-center gap-3">
                      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-500/10 text-blue-600 font-bold">
                        <Icon name="shop" className="h-4 w-4" />
                      </div>
                      <span className="text-xs font-bold text-slate-800">Shop Hours & Info</span>
                    </div>
                    <span className="text-slate-400 font-bold">→</span>
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
