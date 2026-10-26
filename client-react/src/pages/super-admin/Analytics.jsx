import { useEffect, useState } from 'react';
import { saApi, fmtMoney, StatusBadge, Loading, ErrorState, TrendChart } from './shared';
import { FinancialSummary } from './Finance';

function StatCard({ number, label }) {
  return (
    <div className="rounded-[18px] border border-gray-300/50 bg-white/90 p-5 shadow-sm backdrop-blur-md">
      <div className="text-[1.55rem] font-extrabold tracking-tight text-gray-900">{number}</div>
      <div className="mt-[0.2rem] text-[0.82rem] font-medium text-gray-600">{label}</div>
    </div>
  );
}

export default function Analytics() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const res = await saApi('/api/super-admin/analytics');
        if (!res.ok) throw new Error('Failed to load analytics');
        setData(await res.json());
      } catch (err) {
        setError(err.message);
      }
    })();
  }, []);

  if (error && !data) {
    return <ErrorState>Couldn't load analytics. {error}</ErrorState>;
  }
  if (!data) return <Loading />;

  const oc = data.orderStats.statusCounts;
  const total = data.orderStats.totalOrders;
  const maxStatus = Math.max(...Object.values(oc), 1);
  const refundTotal = data.orderStats.refundTotal || 0;
  const netRevenue = data.orderStats.netRevenue ?? data.orderStats.totalRevenue;
  const totalPages = data.orderStats.totalPages || 0;

  return (
    <>
      <div className="mb-6 grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] gap-4">
        <StatCard number={total} label="Total Orders" />
        <StatCard number={fmtMoney(netRevenue)} label="Collected Revenue (after refunds)" />
        <StatCard number={fmtMoney(refundTotal)} label="Refund Total" />
        <StatCard number={`${totalPages.toLocaleString()} pages`} label="Printing Volume" />
      </div>

      <FinancialSummary />

      <div className="mb-5 rounded-[18px] border border-gray-300/50 bg-white/90 p-6 max-sm:p-4 shadow-sm backdrop-blur-md">
        <h2 className="text-base font-bold text-gray-900">Orders Over Time (last 30 days)</h2>
        <TrendChart trend={data.orderStats.ordersOverTime} />
      </div>

      <div className="rounded-[18px] border border-gray-300/50 bg-white/90 p-6 max-sm:p-4 shadow-sm backdrop-blur-md">
        <h2 className="mb-2 text-base font-bold text-gray-900">Orders by Status</h2>
        {/* Legacy intermediate states (accepted / printing / ready) only show if an order is still in one. */}
        {Object.entries(oc).filter(([status, count]) => !['accepted', 'printing', 'ready'].includes(status) || count > 0).map(([status, count]) => (
          <div key={status} className="grid grid-cols-[130px_1fr_40px] items-center gap-[0.9rem] py-2 max-md:grid-cols-[110px_1fr_32px]">
            <StatusBadge status={status} />
            <div className="h-[10px] overflow-hidden rounded-full bg-black/[0.04]">
              <div className="h-full rounded-full bg-[linear-gradient(90deg,#3b82f6,#2563eb)]" style={{ width: `${(count / maxStatus) * 100}%` }} />
            </div>
            <span className="text-right text-[0.82rem] font-semibold text-gray-900">{count}</span>
          </div>
        ))}
      </div>
    </>
  );
}
