import { useEffect, useState } from 'react';
import { saApi, fmtMoney, fmtDate, PaymentBadge, Loading, EmptyState, ErrorState } from './shared';

function StatCard({ number, label }) {
  return (
    <div className="rounded-[18px] border border-gray-300/50 bg-white/90 p-5 shadow-sm backdrop-blur-md">
      <div className="text-[1.55rem] font-extrabold tracking-tight text-gray-900">{number}</div>
      <div className="mt-[0.2rem] text-[0.82rem] font-medium text-gray-600">{label}</div>
    </div>
  );
}

export default function Payments() {
  const [stats, setStats] = useState(null);
  const [tx, setTx] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const [statsRes, txRes] = await Promise.all([
          saApi('/api/super-admin/payments'),
          saApi('/api/super-admin/transactions?limit=8'),
        ]);
        if (!statsRes.ok || !txRes.ok) throw new Error('Failed to load payments');
        setStats(await statsRes.json());
        setTx(await txRes.json());
      } catch (err) {
        setError(err.message);
      }
    })();
  }, []);

  return (
    <>
      <div className="mb-6 grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] gap-4">
        <StatCard number={stats ? stats.total.count : '–'} label="Total Payments" />
        <StatCard number={stats ? stats.success.count : '–'} label="Successful" />
        <StatCard number={stats ? stats.refunded.count : '–'} label="Refunded" />
        <StatCard number={stats ? stats.failed.count : '–'} label="Failed" />
        <StatCard number={stats ? fmtMoney(stats.total.amount) : '–'} label="Total Transaction Value" />
        <StatCard number={stats ? `${stats.successRate}%` : '–'} label="Payment Success Rate" />
      </div>

      <div className="rounded-[18px] border border-gray-300/50 bg-white/90 p-6 max-sm:p-4 shadow-sm backdrop-blur-md">
        <div className="mb-[1.1rem] flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <h2 className="text-base font-bold text-gray-900">Recent Transactions</h2>
          <a href="/super-admin/transactions" className="text-[0.82rem] font-semibold text-blue-500 hover:text-blue-600 hover:underline">View All Transactions →</a>
        </div>
        {error && !tx ? (
          <ErrorState>Couldn't load payments. {error}</ErrorState>
        ) : !tx ? (
          <Loading />
        ) : !tx.payments.length ? (
          <EmptyState>No transactions yet.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="sa-table w-full border-collapse text-[0.85rem]">
              <thead>
                <tr>
                  {['Reference', 'Order', 'Customer', 'Amount', 'Status', 'Date'].map((h) => (
                    <th key={h} className="whitespace-nowrap border-b border-gray-200 px-3 py-[0.6rem] text-left text-[0.72rem] font-semibold uppercase tracking-wide text-gray-400">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tx.payments.map((p) => (
                  <tr key={p.id} className="hover:bg-blue-500/[0.03]">
                    <td data-label="Reference" className="whitespace-nowrap border-b border-gray-100 px-3 py-[0.7rem] text-gray-900">{p.transaction_ref}</td>
                    <td data-label="Order" className="whitespace-nowrap border-b border-gray-100 px-3 py-[0.7rem] text-gray-900">#{String(p.order_id).padStart(4, '0')}</td>
                    <td data-label="Customer" className="whitespace-nowrap border-b border-gray-100 px-3 py-[0.7rem] text-gray-900">{p.customer_email}</td>
                    <td data-label="Amount" className="whitespace-nowrap border-b border-gray-100 px-3 py-[0.7rem] font-semibold text-gray-900">{fmtMoney(p.amount)}</td>
                    <td data-label="Status" className="whitespace-nowrap border-b border-gray-100 px-3 py-[0.7rem]"><PaymentBadge status={p.status} /></td>
                    <td data-label="Date" className="whitespace-nowrap border-b border-gray-100 px-3 py-[0.7rem] text-gray-900">{fmtDate(p.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
