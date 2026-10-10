import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import PageBackground from '../components/PageBackground';
import Footer from '../components/Footer';
import LogoLink from '../components/LogoLink';
import useDocumentTitle from '../lib/useDocumentTitle';
import '../styles/style.css';

// Guest order recovery: phone → OTP → recovery session → order history.
// A phone number alone never exposes orders; the OTP step gates everything.

const STEP = { PHONE: 'phone', OTP: 'otp', LIST: 'list' };

const CARD = {
  width: '100%',
  maxWidth: '560px',
  background: 'white',
  borderRadius: '1rem',
  boxShadow: '0 4px 20px rgba(0,0,0,0.08)',
  border: '1px solid #eee',
  padding: '1.75rem',
  color: '#333',
};

function StatusPill({ label, tone }) {
  const tones = {
    paid: { bg: '#dcfce7', fg: '#166534' },
    pending: { bg: '#fef9c3', fg: '#854d0e' },
    failed: { bg: '#fee2e2', fg: '#991b1b' },
    ready: { bg: '#dbeafe', fg: '#1e40af' },
    neutral: { bg: '#f3f4f6', fg: '#444' },
  };
  const t = tones[tone] || tones.neutral;
  return (
    <span style={{
      display: 'inline-block', padding: '0.15rem 0.6rem', borderRadius: '1rem',
      fontSize: '0.75rem', fontWeight: 700, background: t.bg, color: t.fg, letterSpacing: '0.02em',
    }}>{label}</span>
  );
}

export default function Orders() {
  useDocumentTitle('Your Orders – Campus Prints');
  const navigate = useNavigate();

  const [step, setStep] = useState(STEP.PHONE);
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [phoneMasked, setPhoneMasked] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [devOtp, setDevOtp] = useState('');
  const [orders, setOrders] = useState([]);
  const [docsByOrder, setDocsByOrder] = useState({}); // orderId -> { loading, documents, error }

  function resetMessages() { setError(''); setNotice(''); }

  async function submitPhone(e) {
    e.preventDefault();
    resetMessages();
    const digits = phone.replace(/\D/g, '').slice(-10);
    if (!/^[6-9][0-9]{9}$/.test(digits)) {
      setError('Enter a valid 10-digit mobile number.');
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/orders/lookup', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: digits }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.message || 'Could not send a code. Please try again.'); return; }
      setPhone(digits);
      setPhoneMasked(data.phoneMasked || '');
      setDevOtp(data.devOtp || '');
      setNotice(data.message || 'Verification code sent.');
      setStep(STEP.OTP);
    } catch {
      setError('Connection error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  async function submitOtp(e) {
    e.preventDefault();
    resetMessages();
    if (!/^[0-9]{6}$/.test(otp.trim())) {
      setError('Enter the 6-digit verification code.');
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/orders/verify-recovery', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, otp: otp.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.message || 'Verification failed. Please try again.'); return; }
      await loadHistory();
      setStep(STEP.LIST);
    } catch {
      setError('Connection error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  async function loadHistory() {
    const res = await fetch('/api/orders/history', { credentials: 'include' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401) {
        setError('Your recovery session expired. Please verify your phone number again.');
        setStep(STEP.PHONE);
        return;
      }
      setError(data.message || 'Could not load your orders.');
      return;
    }
    setPhoneMasked(data.phoneMasked || phoneMasked);
    setOrders(Array.isArray(data.orders) ? data.orders : []);
  }

  function viewTicket(order) {
    const token = order.ticketToken ? `&token=${encodeURIComponent(order.ticketToken)}` : '';
    navigate(`/ticket?id=${order.orderId}${token}`);
  }

  async function checkStatus(order) {
    resetMessages();
    try {
      const res = await fetch(`/api/orders/${order.orderId}/payment-status`, { credentials: 'include' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.message || 'Could not check status.'); return; }
      setOrders((prev) => prev.map((o) => o.orderId === order.orderId
        ? { ...o, paymentStatus: data.paymentStatus, ticketStatus: data.ticketStatus, ticketToken: data.ticketToken || o.ticketToken }
        : o));
      setNotice(`Order ${order.ticketId}: payment ${data.paymentStatus.toLowerCase()}.`);
    } catch {
      setError('Connection error. Please try again.');
    }
  }

  async function toggleDocuments(order) {
    const existing = docsByOrder[order.orderId];
    if (existing) {
      setDocsByOrder((prev) => ({ ...prev, [order.orderId]: { ...existing, open: !existing.open } }));
      return;
    }
    setDocsByOrder((prev) => ({ ...prev, [order.orderId]: { loading: true, open: true, documents: [] } }));
    try {
      const res = await fetch(`/api/orders/${order.orderId}/documents`, { credentials: 'include' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setDocsByOrder((prev) => ({ ...prev, [order.orderId]: { loading: false, open: true, documents: [], error: data.message || 'Could not load documents.' } }));
        return;
      }
      setDocsByOrder((prev) => ({ ...prev, [order.orderId]: { loading: false, open: true, documents: data.documents || [] } }));
    } catch {
      setDocsByOrder((prev) => ({ ...prev, [order.orderId]: { loading: false, open: true, documents: [], error: 'Connection error.' } }));
    }
  }

  function paymentTone(status) {
    if (status === 'PAID') return 'paid';
    if (status === 'FAILED') return 'failed';
    if (status === 'REFUNDED') return 'neutral';
    return 'pending';
  }

  return (
    <>
      <PageBackground />
      <LogoLink />
      <div className="page-content" style={{ minHeight: '70vh', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '6rem 1rem 3rem', gap: '1.25rem' }}>

        <div style={{ textAlign: 'center', maxWidth: '560px' }}>
          <h1 style={{ fontSize: '2rem', margin: '0 0 0.35rem', color: 'var(--text-primary, #111)' }}>Orders</h1>
          <p style={{ color: '#666', margin: 0 }}>Find your previous Campus Print orders with your phone number.</p>
        </div>

        {notice && <div style={{ ...CARD, padding: '0.85rem 1.25rem', maxWidth: '560px', background: '#eff6ff', borderColor: '#bfdbfe', color: '#1e40af' }}>{notice}</div>}
        {devOtp && step === STEP.OTP && (
          <div style={{ ...CARD, padding: '0.85rem 1.25rem', maxWidth: '560px', background: '#fff7ed', borderColor: '#fed7aa', color: '#9a3412' }}>
            <strong>Development mode:</strong> your code is <code style={{ fontSize: '1rem' }}>{devOtp}</code> (never shown in production).
          </div>
        )}
        {error && <div style={{ ...CARD, padding: '0.85rem 1.25rem', maxWidth: '560px', background: '#fef2f2', borderColor: '#fecaca', color: '#991b1b' }}>{error}</div>}

        {/* Step 1: phone */}
        {step === STEP.PHONE && (
          <form style={CARD} onSubmit={submitPhone}>
            <h2 style={{ marginTop: 0, fontSize: '1.2rem' }}>Find Your Orders</h2>
            <label style={{ display: 'block', fontSize: '0.85rem', color: '#666', marginBottom: '0.4rem' }}>Enter your registered phone number</label>
            <input
              type="tel" inputMode="numeric" autoComplete="tel" value={phone}
              onChange={(e) => setPhone(e.target.value)} placeholder="10-digit mobile number"
              style={{ width: '100%', padding: '0.75rem 1rem', borderRadius: '0.6rem', border: '1px solid #ddd', fontSize: '1rem', boxSizing: 'border-box' }}
            />
            <button className="btn btn-primary" type="submit" disabled={loading} style={{ marginTop: '1rem', width: '100%' }}>
              {loading ? 'Sending…' : 'Find Orders'}
            </button>
          </form>
        )}

        {/* Step 2: OTP */}
        {step === STEP.OTP && (
          <form style={CARD} onSubmit={submitOtp}>
            <h2 style={{ marginTop: 0, fontSize: '1.2rem' }}>Verify It's You</h2>
            <p style={{ fontSize: '0.9rem', color: '#666', marginTop: 0 }}>
              Enter the 6-digit code sent for {phoneMasked || 'your number'}.
            </p>
            <input
              type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} placeholder="6-digit code"
              style={{ width: '100%', padding: '0.75rem 1rem', borderRadius: '0.6rem', border: '1px solid #ddd', fontSize: '1.1rem', letterSpacing: '0.3em', textAlign: 'center', boxSizing: 'border-box' }}
            />
            <button className="btn btn-primary" type="submit" disabled={loading} style={{ marginTop: '1rem', width: '100%' }}>
              {loading ? 'Verifying…' : 'Verify & View Orders'}
            </button>
            <button type="button" className="btn btn-secondary" style={{ marginTop: '0.6rem', width: '100%' }}
              onClick={() => { resetMessages(); setOtp(''); setStep(STEP.PHONE); }}>
              Use a different number
            </button>
          </form>
        )}

        {/* Step 3: order list */}
        {step === STEP.LIST && (
          <div style={{ width: '100%', maxWidth: '560px', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h2 style={{ margin: 0, fontSize: '1.3rem', color: 'var(--text-primary, #111)' }}>Your Orders</h2>
              <span style={{ fontSize: '0.85rem', color: '#666' }}>{phoneMasked}</span>
            </div>

            {orders.length === 0 && (
              <div style={CARD}>
                <h3 style={{ marginTop: 0 }}>No orders found</h3>
                <p style={{ color: '#666', marginBottom: 0 }}>
                  Make sure you entered the same phone number used when placing your order.
                </p>
              </div>
            )}

            {orders.map((o) => {
              const docState = docsByOrder[o.orderId];
              const canViewTicket = o.paymentStatus === 'PAID';
              const isPending = o.paymentStatus === 'PENDING';
              return (
                <div key={o.orderId} style={CARD}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.75rem' }}>
                    <h3 style={{ margin: 0, fontSize: '1.25rem', letterSpacing: '0.02em' }}>{o.ticketId}</h3>
                    <span style={{ fontWeight: 700, fontSize: '1.1rem' }}>₹{o.amount}</span>
                  </div>

                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.75rem' }}>
                    <StatusPill label={`Payment: ${o.paymentStatus === 'PAID' ? '✓ Paid' : o.paymentStatus === 'PENDING' ? 'Pending' : o.paymentStatus === 'FAILED' ? 'Failed' : o.paymentStatus}`} tone={paymentTone(o.paymentStatus)} />
                    {canViewTicket && <StatusPill label={`Ticket: ${o.ticketStatus === 'READY' ? '✓ Ready' : 'Generating'}`} tone={o.ticketStatus === 'READY' ? 'ready' : 'pending'} />}
                  </div>

                  <div style={{ fontSize: '0.92rem', color: '#555', lineHeight: 1.6 }}>
                    {o.collectionLocation && <div>{o.collectionLocation}</div>}
                    {o.collectionTime && <div>{o.collectionTime}{o.collectionDate ? ` · ${o.collectionDate}` : ''}</div>}
                    <div>{o.fileCount} document{o.fileCount === 1 ? '' : 's'}</div>
                  </div>

                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.6rem', marginTop: '1rem' }}>
                    {canViewTicket && (
                      <button className="btn btn-primary" style={{ flex: '1 1 auto' }} onClick={() => viewTicket(o)}>View Ticket</button>
                    )}
                    {isPending && (
                      <button className="btn btn-secondary" style={{ flex: '1 1 auto' }} onClick={() => checkStatus(o)}>Check Status</button>
                    )}
                    {canViewTicket && (
                      <button className="btn btn-secondary" style={{ flex: '1 1 auto' }} onClick={() => toggleDocuments(o)}>
                        {docState?.open ? 'Hide Documents' : 'Documents'}
                      </button>
                    )}
                  </div>

                  {docState?.open && (
                    <div style={{ marginTop: '1rem', borderTop: '1px solid #eee', paddingTop: '0.9rem' }}>
                      <div style={{ fontSize: '0.8rem', fontWeight: 700, color: '#666', marginBottom: '0.5rem', letterSpacing: '0.05em' }}>DOCUMENTS</div>
                      {docState.loading && <p style={{ color: '#666', margin: 0 }}>Loading…</p>}
                      {docState.error && <p style={{ color: '#991b1b', margin: 0 }}>{docState.error}</p>}
                      {!docState.loading && !docState.error && docState.documents.length === 0 && (
                        <p style={{ color: '#666', margin: 0 }}>No documents available.</p>
                      )}
                      {docState.documents.map((d) => (
                        <div key={d.fileId} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', padding: '0.5rem 0' }}>
                          <span style={{ fontSize: '0.9rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>📄 {d.name}</span>
                          {d.expired ? (
                            <span style={{ fontSize: '0.8rem', color: '#999' }}>Expired</span>
                          ) : (
                            <span style={{ display: 'flex', gap: '0.75rem', flexShrink: 0 }}>
                              <a href={`/api/orders/${o.orderId}/documents/${d.fileId}`} target="_blank" rel="noreferrer" style={{ fontSize: '0.85rem', color: '#2563eb', fontWeight: 600 }}>View</a>
                              <a href={`/api/orders/${o.orderId}/documents/${d.fileId}?download=1`} style={{ fontSize: '0.85rem', color: '#2563eb', fontWeight: 600 }}>Download</a>
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}

            <button type="button" className="btn btn-secondary" style={{ alignSelf: 'center' }}
              onClick={() => { resetMessages(); setOrders([]); setOtp(''); setPhone(''); setStep(STEP.PHONE); }}>
              Look up a different number
            </button>
          </div>
        )}
      </div>
      <Footer />
    </>
  );
}
