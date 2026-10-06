import { useEffect, useState } from 'react';
import Icon from './Icon';
import { saApi, fmtMoney, fmtPickup, LIVE_REFRESH_MS, StatusBadge, Loading, EmptyState, ErrorState, TrendChart } from './shared';

export default function Index() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    let loadedOnce = false;

    async function load() {
      try {
        const res = await saApi('/api/super-admin/dashboard');
        if (!res.ok) throw new Error('Failed to load dashboard');
        const next = await res.json();
        if (cancelled) return;
        setData(next);
        setError('');
        loadedOnce = true;
      } catch (err) {
        if (!cancelled && !loadedOnce) setError(err.message);
      }
    }

    load();
    const timer = setInterval(load, LIVE_REFRESH_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  const dateLabel = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

  const attention = [];
  if (data) {
    if (data.shopStats.pending > 0) attention.push({ label: 'Shops awaiting approval', count: data.shopStats.pending, href: '/super-admin/shops?status=pending' });
    if (data.paymentStats.failed.count > 0) attention.push({ label: 'Failed payments', count: data.paymentStats.failed.count, href: '/super-admin/payments' });
    if (data.orderStats.statusCounts.pending > 0) attention.push({ label: 'Orders awaiting shop action', count: data.orderStats.statusCounts.pending, href: '/super-admin/orders?status=pending' });
  }

  return (
    <>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-[1.3rem] font-extrabold tracking-tight text-gray-900">Welcome back! 👋</h2>
          <p className="mt-1 text-[0.88rem] text-gray-600">Here's what's happening across Campus Print today.</p>
        </div>
        <div className="flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-[0.6rem] text-[0.82rem] font-semibold text-gray-900 shadow-sm">
          <Icon name="calendar" className="h-[15px] w-[15px] text-blue-500" />
          <span>{dateLabel}</span>
        </div>
      </div>

      {error && !data ? (
        <ErrorState>Couldn't load dashboard. {error}</ErrorState>
      ) : !data ? (
        <Loading />
      ) : (
        <>
          <div className="mb-6 grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] gap-4">
            <StatCard icon="users" color="blue" number={data.userStats.totalStudents + data.userStats.totalShopAdmins} label="Total Users" sub={`${data.userStats.activeStudents} Active Students`} subColor="text-blue-500" />
            <StatCard icon="shop" color="purple" number={data.shopStats.active} label="Active Printing Shops" sub={data.shopStats.pending > 0 ? `${data.shopStats.pending} Pending Approval` : `${data.shopStats.total} Total Shops`} subColor="text-violet-600" />
            <StatCard icon="doc" color="amber" number={data.orderStats.totalOrders} label="Total Orders" sub={`${data.orderStats.statusCounts.pending} Pending`} subColor="text-amber-600" />
            <StatCard icon="check" color="green" number={data.orderStats.statusCounts.completed} label="Completed Orders" sub={`${data.paymentStats.successRate}% Payment Success`} subColor="text-emerald-600" />
            <StatCard icon="card" color="green" number={fmtMoney(data.orderStats.totalRevenue)} label="Platform Revenue" sub="Total Completed" subColor="text-emerald-600" />
          </div>

          <div className="mb-5 grid grid-cols-[1fr_340px] items-start gap-5 max-[1100px]:grid-cols-1">
            <div className="rounded-[18px] border border-gray-300/50 bg-white/90 p-6 max-sm:p-4 shadow-sm backdrop-blur-md">
              <div className="mb-[1.1rem] flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <h2 className="text-base font-bold text-gray-900">Recent Orders</h2>
                <a href="/super-admin/orders" className="text-[0.82rem] font-semibold text-blue-500 hover:text-blue-600 hover:underline">View All Orders →</a>
              </div>
              {!data.recentOrders || data.recentOrders.length === 0 ? (
                <EmptyState>No orders yet.</EmptyState>
              ) : (
                <div className="overflow-x-auto">
                  <table className="sa-table w-full border-collapse text-[0.85rem]">
                    <thead>
                      <tr>
                        {['Order ID', 'Student', 'Shop', 'Pickup', 'Amount', 'Status'].map((h) => (
                          <th key={h} className="whitespace-nowrap border-b border-gray-200 px-3 py-[0.6rem] text-left text-[0.72rem] font-semibold uppercase tracking-wide text-gray-400">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {data.recentOrders.map((o) => (
                        <tr key={o.id} className="hover:bg-blue-500/[0.03]">
                          <td data-label="Order ID" className="whitespace-nowrap border-b border-gray-100 px-3 py-[0.7rem] text-gray-900">#{String(o.id).padStart(4, '0')}</td>
                          <td data-label="Student" className="whitespace-nowrap border-b border-gray-100 px-3 py-[0.7rem] text-gray-900">{o.customer_email}</td>
                          <td data-label="Shop" className="whitespace-nowrap border-b border-gray-100 px-3 py-[0.7rem] text-gray-900">{o.shop_name || '—'}</td>
                          <td data-label="Pickup" className="whitespace-nowrap border-b border-gray-100 px-3 py-[0.7rem] text-gray-900">{fmtPickup(o)}</td>
                          <td data-label="Amount" className="whitespace-nowrap border-b border-gray-100 px-3 py-[0.7rem] font-semibold text-gray-900">{fmtMoney(o.total_price)}</td>
                          <td data-label="Status" className="whitespace-nowrap border-b border-gray-100 px-3 py-[0.7rem]"><StatusBadge status={o.status} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="rounded-[18px] border border-gray-300/50 bg-white/90 p-6 max-sm:p-4 shadow-sm backdrop-blur-md">
              <h2 className="text-base font-bold text-gray-900">Orders Over Time</h2>
              <p className="mt-[0.15rem] mb-3 text-[0.88rem] text-gray-600">Last 30 days</p>
              <TrendChart trend={data.orderStats.ordersOverTime} />
            </div>
          </div>

          <div className="rounded-[18px] border border-gray-300/50 bg-white/90 p-6 max-sm:p-4 shadow-sm backdrop-blur-md">
            <h2 className="mb-[0.9rem] text-base font-bold text-gray-900">Needs Attention</h2>
            {attention.length === 0 ? (
              <div className="flex items-center gap-[0.6rem] p-4 text-[0.88rem] font-semibold text-emerald-500">
                <Icon name="check" className="h-5 w-5" />
                Nothing needs your attention right now.
              </div>
            ) : (
              attention.map((i) => (
                <a key={i.label} href={i.href} className="mb-2 flex items-center justify-between rounded-xl bg-amber-500/[0.06] px-[0.9rem] py-3 no-underline">
                  <span className="text-[0.85rem] font-semibold text-gray-900">{i.label}</span>
                  <span className="rounded-full bg-amber-500 px-[0.6rem] py-[0.15rem] text-[0.75rem] font-bold text-white">{i.count}</span>
                </a>
              ))
            )}
          </div>
        </>
      )}
    </>
  );
}

const ICON_COLORS = {
  blue: 'bg-blue-500/[0.12] text-blue-500',
  purple: 'bg-violet-600/[0.12] text-violet-600',
  amber: 'bg-amber-500/[0.12] text-amber-600',
  green: 'bg-emerald-500/[0.12] text-emerald-500',
};

function StatCard({ icon, color, number, label, sub, subColor }) {
  return (
    <div className="rounded-[18px] border border-gray-300/50 bg-white/90 p-5 px-[1.4rem] shadow-sm backdrop-blur-md transition hover:-translate-y-px hover:shadow-md">
      <div className={`mb-[0.9rem] flex h-[42px] w-[42px] items-center justify-center rounded-xl ${ICON_COLORS[color]}`}>
        <Icon name={icon} className="h-5 w-5" />
      </div>
      <div className="text-[1.55rem] font-extrabold tracking-tight text-gray-900">{number}</div>
      <div className="mt-[0.2rem] text-[0.82rem] font-medium text-gray-600">{label}</div>
      <div className={`mt-[0.35rem] text-[0.72rem] font-semibold ${subColor}`}>{sub}</div>
    </div>
  );
}
