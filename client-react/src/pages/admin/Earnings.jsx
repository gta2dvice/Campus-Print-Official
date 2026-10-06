import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { adminApi, fmtMoney, fmtDate } from '../../lib/adminHelpers';
import StatusBadge from '../../components/admin/StatusBadge';
import '../../styles/admin-effects.css';

function StatBox({ number, label, highlight }) {
  return (
    <div className="admin-stat-card">
      <div className="text-xs font-bold uppercase tracking-wider text-slate-400">{label}</div>
      <div className={`mt-2 text-2xl font-black tracking-tight ${highlight ? 'text-blue-600' : 'text-slate-900'}`}>{number}</div>
    </div>
  );
}

export default function Earnings() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await adminApi('/api/admin/earnings');
        if (!res.ok) throw new Error('Failed to load earnings');
        const json = await res.json();
        if (!cancelled) setData(json);
      } catch (err) {
        if (!cancelled) setError(err.message || 'Failed to load earnings');
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  const max = data?.trend?.length ? Math.max(...data.trend.map((t) => t.amount), 1) : 1;

  return (
    <div className="space-y-6">
      {/* Financial Overview Header */}
      <div className="admin-card bg-gradient-to-r from-slate-900 to-indigo-950 text-white border-slate-800">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full bg-emerald-500/20 px-3 py-1 text-xs font-bold text-emerald-300 border border-emerald-400/30">
              <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
              Financial Analytics
            </div>
            <h2 className="mt-2 text-2xl font-black tracking-tight text-white">Shop Revenue & Payouts</h2>
            <p className="mt-1 text-xs text-slate-300">Complete summary of completed orders, revenue trends, and payouts.</p>
          </div>
          <div className="text-right">
            <div className="text-xs font-bold text-slate-400 uppercase tracking-wider">Lifetime Earnings</div>
            <div className="text-3xl font-black text-emerald-400">{data ? fmtMoney(data.total.amount) : '₹0'}</div>
          </div>
        </div>
      </div>

      {/* Stat Cards */}
      <div className="admin-stats-grid">
        <StatBox number={data ? fmtMoney(data.today.amount) : '–'} label="Today's Revenue" highlight />
        <StatBox number={data ? fmtMoney(data.week.amount) : '–'} label="This Week" />
        <StatBox number={data ? fmtMoney(data.month.amount) : '–'} label="This Month" />
        <StatBox number={data ? fmtMoney(data.total.amount) : '–'} label="Total Earnings" />
        <StatBox number={data ? data.total.count : '–'} label="Completed Orders" />
        <StatBox number={data ? fmtMoney(data.avgOrderValue) : '–'} label="Avg Order Value" />
      </div>

      {/* Revenue Trend Chart */}
      <div className="admin-card">
        <div className="mb-4">
          <h3 className="text-base font-extrabold text-slate-900">Revenue Trend (Last 14 Days)</h3>
          <p className="text-xs text-slate-500">Daily earnings breakdown for completed print orders</p>
        </div>

        {error ? (
          <div className="py-8 text-center text-xs font-semibold text-rose-600">Couldn't load earnings trend. {error}</div>
        ) : !data ? (
          <div className="py-12 text-center text-xs font-semibold text-slate-400">Loading trend analytics...</div>
        ) : !data.trend.length ? (
          <div className="py-8 text-center text-xs font-semibold text-slate-400">No completed orders in the last 14 days.</div>
        ) : (
          <div className="flex h-44 items-end gap-2 pt-6 pb-2 max-sm:gap-1">
            {data.trend.map((t) => (
              <div key={t.date} className="group relative flex h-full flex-1 flex-col items-center justify-end gap-2" title={`${t.date}: ${fmtMoney(t.amount)}`}>
                <div className="w-full rounded-t-lg bg-gradient-to-t from-blue-600 to-indigo-500 transition-all group-hover:from-blue-500 group-hover:to-indigo-400 group-hover:shadow-md" style={{ height: `${Math.max(8, (t.amount / max) * 100)}%` }} />
                <span className="text-[0.68rem] font-bold text-slate-400">{new Date(t.date).getDate()}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Recent Completed Transactions */}
      <div className="admin-card">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div>
            <h3 className="text-base font-extrabold text-slate-900">Recent Completed Transactions</h3>
            <p className="text-xs text-slate-500">Verified payouts from completed print jobs</p>
          </div>
          <Link to="/admin/transactions" className="text-xs font-bold text-blue-600 hover:text-blue-700 hover:underline">
            View All Transactions →
          </Link>
        </div>

        {!data ? (
          <div className="py-8 text-center text-xs font-semibold text-slate-400">Loading transaction history...</div>
        ) : !data.recentTransactions.length ? (
          <div className="py-8 text-center text-xs font-semibold text-slate-400">No completed transactions found.</div>
        ) : (
          <div className="admin-table-container">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Order ID</th>
                  <th>Customer Email</th>
                  <th>Amount</th>
                  <th className="text-right">Date</th>
                </tr>
              </thead>
              <tbody>
                {data.recentTransactions.map((t) => (
                  <tr key={t.id}>
                    <td data-label="Order ID" className="font-extrabold text-slate-900">#{String(t.id).padStart(4, '0')}</td>
                    <td data-label="Customer Email" className="font-medium text-slate-800">{t.customer_email}</td>
                    <td data-label="Amount" className="font-black text-emerald-600">{fmtMoney(t.total_price)}</td>
                    <td data-label="Date" className="text-right text-slate-400 text-xs font-medium">{fmtDate(t.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
