// Super Admin financial views: the per-order breakdown (printer's printing charges,
// Campus Print's extra charges, full summary) and the across-orders summary.
// All figures come from the server (services/orderFinance.js); nothing is
// recalculated here. "Gross extra-charge revenue" is NOT profit.
import { useEffect, useState } from 'react';
import { saApi, Loading, ErrorState } from './shared';

const SLOT_LOCATIONS = [
  { id: '', name: 'All locations' },
  { id: 'academic-block', name: 'Academic Block' },
  { id: 'red-canteen', name: 'Red Canteen' },
  { id: 'main-gate', name: 'Main Gate' },
  { id: 'hostel-gate', name: 'Hostel Gate' },
];

const PAYMENT_STATUS_LABELS = {
  PAID: 'Paid',
  PAYMENT_PENDING: 'Payment pending',
  PAYMENT_FAILED: 'Payment failed',
  REFUNDED: 'Refunded',
};

// Exact rupees (paise kept when present); null → "—" or a given fallback.
export function fmtRupees(n, fallback = '—') {
  if (n === null || n === undefined) return fallback;
  const value = Number(n);
  return `₹${Number.isInteger(value) ? value : value.toFixed(2)}`;
}

function Row({ label, value, strong, muted }) {
  return (
    <div className={`flex items-baseline justify-between gap-3 py-[0.3rem] text-[0.84rem] ${muted ? 'text-gray-400' : 'text-gray-700'}`}>
      <span>{label}</span>
      <span className={strong ? 'font-extrabold text-gray-900' : 'font-semibold'}>{value}</span>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div className="rounded-[12px] border border-gray-200 bg-black/[0.015] px-4 py-3">
      <h5 className="mb-1 text-[0.78rem] font-bold uppercase tracking-wide text-gray-500">{title}</h5>
      {children}
    </div>
  );
}

/** Per-order financial summary from GET /api/super-admin/orders/:id → finance. */
export function OrderFinance({ finance }) {
  if (!finance) return null;
  const { printing, extras, summary, notes, basis, deliveryLabel, deliveryCharge } = finance;
  const estimated = basis === 'ESTIMATED';
  const est = estimated ? ' (est.)' : '';

  // Determine selected delivery and its charge
  const deliveryText = deliveryLabel
    ? `${deliveryLabel} — ${fmtRupees(deliveryCharge ?? 0)}`
    : (extras?.classroomCharge > 0
        ? `Classroom Delivery — ${fmtRupees(extras.classroomCharge)}`
        : (extras?.deliveryCharge > 0
            ? `Hostel Gate Delivery — ${fmtRupees(extras.deliveryCharge)}`
            : `Counter Pickup — ${fmtRupees(0)}`));

  const bindingVal = (extras?.bindingCharge && extras.bindingCharge > 0)
    ? fmtRupees(extras.bindingCharge)
    : (summary?.totalBinding && summary.totalBinding > 0)
        ? fmtRupees(summary.totalBinding)
        : '₹0';

  return (
    <div className="mt-5 flex flex-col gap-3">
      <h4 className="text-[0.9rem] font-bold text-gray-900">
        Financial Summary{' '}
        {estimated && <span className="ml-1 rounded-full bg-amber-500/10 px-2 py-[0.1rem] text-[0.7rem] font-bold text-amber-700">Estimated</span>}
      </h4>

      <Section title="Financial Breakdown">
        <Row label={`Printing subtotal${est}`} value={fmtRupees(summary?.totalPrinting ?? printing?.totalPrinting, 'Not itemised')} />
        <Row label={`Service charge${est}`} value={fmtRupees(summary?.totalService ?? extras?.serviceCharge ?? 0)} />
        <Row label={`Selected delivery${est}`} value={deliveryText} />
        <Row label={`Binding amount${est}`} value={bindingVal} />
        <Row label="Customer total payable" value={fmtRupees(summary?.customerTotal)} strong />
        <Row label="Amount actually paid / captured" value={fmtRupees(summary?.amountPaid ?? 0)} />
        {summary?.refundedAmount > 0 && (
          <Row label="Refund amount" value={fmtRupees(summary.refundedAmount)} />
        )}
        <Row label="Payment status" value={PAYMENT_STATUS_LABELS[summary?.paymentStatus] || summary?.paymentStatus || 'PAYMENT_PENDING'} />
        <Row label={`Printer payable${est}`} value={summary?.printerPayable != null ? fmtRupees(summary.printerPayable) : 'Not available'} strong />
      </Section>

      {notes?.length > 0 && (
        <ul className="list-disc pl-5 text-[0.78rem] text-amber-700">
          {notes.map((note) => <li key={note}>{note}</li>)}
        </ul>
      )}
    </div>
  );
}

/** Across-orders summary from GET /api/super-admin/financials (PAID orders). */
export function FinancialSummary() {
  const [location, setLocation] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const params = new URLSearchParams(location ? { location } : {});
        const res = await saApi(`/api/super-admin/financials?${params}`);
        if (!res.ok) throw new Error('Failed to load financials');
        const json = await res.json();
        if (!cancelled) { setData(json); setError(''); }
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    })();
    return () => { cancelled = true; };
  }, [location]);

  const t = data?.totals;
  return (
    <div className="mb-5 rounded-[18px] border border-gray-300/50 bg-white/90 p-6 max-sm:p-4 shadow-sm backdrop-blur-md">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-bold text-gray-900">Financial Breakdown (paid orders)</h2>
        <select value={location} onChange={(e) => setLocation(e.target.value)} className="rounded-lg border border-gray-200 px-3 py-[0.4rem] text-[0.82rem]">
          {SLOT_LOCATIONS.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </div>
      {error && !data ? (
        <ErrorState>Couldn't load financials. {error}</ErrorState>
      ) : !t ? (
        <Loading />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          <Section title={`Itemised orders (${t.itemisedOrders})`}>
            <Row label="Printer payable (printing only)" value={fmtRupees(t.printerPayable)} strong />
            <Row label="Delivery charges (Hostel Gate)" value={fmtRupees(t.totalDelivery)} />
            <Row label="Service charges" value={fmtRupees(t.totalService)} />
            <Row label="Classroom surcharges" value={fmtRupees(t.totalClassroom)} />
            <Row label="Binding charges" value={fmtRupees(t.totalBinding)} />
            <Row label="Gross extra-charge revenue" value={fmtRupees(t.grossExtraRevenue)} strong />
            <Row label="Customer total" value={fmtRupees(t.itemisedCustomerTotal)} />
            <Row label="Reconciles" value={t.reconciled ? '✓ Yes' : '✗ Check orders'} />
          </Section>
          <Section title="All paid orders">
            <Row label="Paid orders" value={t.paidOrders} />
            <Row label={`Placed before itemising (${t.notItemisedOrders} orders)`} value={fmtRupees(t.notItemisedCustomerTotal)} />
            <Row label="Total customer payments" value={fmtRupees(t.customerTotal)} strong />
            <Row label="Refunded" value={fmtRupees(data.refunds.refundedAmount)} />
            {!location && data.byLocation.map((l) => (
              <Row key={l.locationId || 'none'} label={`${l.location || 'No location'} — ${l.paidOrders} orders`} value={`printer ${fmtRupees(l.printerPayable)} · extras ${fmtRupees(l.grossExtraRevenue)}`} />
            ))}
          </Section>
        </div>
      )}
    </div>
  );
}
