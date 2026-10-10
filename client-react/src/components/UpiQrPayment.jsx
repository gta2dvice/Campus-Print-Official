import { useCallback, useEffect, useRef, useState } from 'react';
import '../styles/style.css';

// UPI QR payment screen. Shows the dynamic QR (amount + reference), polls the
// backend for the real payment status, and only shows success once the BACKEND
// confirms it (a shop admin marks the order paid). It never self-marks paid.
export default function UpiQrPayment({ data, onClose, onViewTicket, showToast }) {
  // data: { id, orderId/ticketNumber, amount, paymentReference, qrDataUrl, upiUrl, expiresAt, ticketToken }
  const [qr, setQr] = useState(data);
  const [status, setStatus] = useState('PENDING'); // PENDING | PAID | FAILED | EXPIRED
  const [checking, setChecking] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(Date.now());
  const pollRef = useRef(null);

  const token = data.ticketToken;
  const orderDbId = data.id;

  const expiresMs = qr.expiresAt ? new Date(qr.expiresAt).getTime() : 0;
  const expired = status === 'EXPIRED' || (status === 'PENDING' && expiresMs && now > expiresMs);
  const secondsLeft = Math.max(0, Math.floor((expiresMs - now) / 1000));

  const checkStatus = useCallback(async (manual) => {
    if (manual) setChecking(true);
    try {
      const res = await fetch(`/api/orders/${orderDbId}/payment-status?token=${encodeURIComponent(token)}`, { credentials: 'include' });
      const d = await res.json().catch(() => ({}));
      if (res.ok && d.paymentStatus) {
        setStatus(d.paymentStatus);
        if (manual && d.paymentStatus === 'PENDING') {
          showToast?.('Still waiting for the shop to confirm your payment.', 'info');
        }
      } else if (manual) {
        showToast?.(d.message || 'Could not check status. Please retry.', 'error');
      }
    } catch {
      if (manual) showToast?.('Connection error while checking status.', 'error');
    } finally {
      if (manual) setChecking(false);
    }
  }, [orderDbId, token, showToast]);

  // Poll every 5s while pending; a ticking clock drives the expiry countdown.
  useEffect(() => {
    const clock = setInterval(() => setNow(Date.now()), 1000);
    pollRef.current = setInterval(() => { if (status === 'PENDING') checkStatus(false); }, 5000);
    return () => { clearInterval(clock); clearInterval(pollRef.current); };
  }, [checkStatus, status]);

  useEffect(() => {
    if (status === 'PAID' && pollRef.current) clearInterval(pollRef.current);
  }, [status]);

  async function refreshQr() {
    setRefreshing(true);
    try {
      const res = await fetch(`/api/orders/payment/upi-qr/${orderDbId}/refresh?token=${encodeURIComponent(token)}`, {
        method: 'POST', credentials: 'include',
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (d.code === 'ALREADY_PAID') { setStatus('PAID'); return; }
        showToast?.(d.message || 'Could not refresh the QR.', 'error');
        return;
      }
      setQr((prev) => ({ ...prev, qrDataUrl: d.qrDataUrl, upiUrl: d.upiUrl, expiresAt: d.expiresAt, paymentReference: d.paymentReference }));
      setStatus('PENDING');
      setNow(Date.now());
    } catch {
      showToast?.('Connection error while refreshing the QR.', 'error');
    } finally {
      setRefreshing(false);
    }
  }

  const amountText = `₹${Number(qr.amount).toFixed(2)}`;

  return (
    <div className="wa-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="wa-modal upi-modal" role="dialog" aria-modal="true" aria-labelledby="upiTitle">
        <h2 id="upiTitle" className="wa-title">
          <span aria-hidden="true">📱</span> {status === 'PAID' ? 'Payment Confirmed' : 'Scan to Pay'}
        </h2>

        <div className="wa-body">
          {status === 'PAID' ? (
            <div className="upi-success">
              <div className="upi-success-badge" aria-hidden="true">✓</div>
              <p className="upi-success-text">Your payment for <strong>{data.ticketNumber || data.orderId}</strong> has been confirmed.</p>
              <button type="button" className="btn btn-primary" onClick={onViewTicket}>View Ticket</button>
            </div>
          ) : (
            <>
              <div className="upi-amount">{amountText}</div>
              <div className="upi-meta">
                <div>Order: <strong>{data.ticketNumber || data.orderId}</strong></div>
                <div>Payment Reference: <strong className="wa-mono">{qr.paymentReference}</strong></div>
              </div>

              {!expired ? (
                <div className="upi-qr-box">
                  <img className="upi-qr-img" src={qr.qrDataUrl} alt="UPI payment QR code" />
                  <p className="wa-fineprint">Scan using PhonePe / Google Pay / Paytm or any UPI app.</p>
                  {secondsLeft > 0 && (
                    <p className="wa-fineprint">QR expires in {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')}</p>
                  )}
                </div>
              ) : (
                <div className="upi-expired">
                  <p className="upi-expired-text">⏱️ This QR has expired. Your order is still unpaid — generate a fresh QR to pay.</p>
                  <button type="button" className="btn btn-primary" onClick={refreshQr} disabled={refreshing}>
                    {refreshing ? 'Refreshing…' : 'Refresh QR'}
                  </button>
                </div>
              )}

              {!expired && (
                <a className="btn btn-primary upi-openapp" href={qr.upiUrl} rel="noreferrer">
                  Open UPI App
                </a>
              )}

              <div className="upi-status-row" role="status">
                <span className="upi-status-dot" aria-hidden="true"></span>
                <span>Payment Pending — waiting for confirmation…</span>
              </div>

              <div className="wa-security" role="note">
                🔒 Pay only the exact amount shown. Never share your UPI PIN, OTP, or card details. Our team confirms your payment before your order is marked paid — this can take a short while.
              </div>
            </>
          )}
        </div>

        <div className="wa-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            {status === 'PAID' ? 'Close' : 'Pay later'}
          </button>
          {status !== 'PAID' && (
            <button type="button" className="btn btn-primary" onClick={() => checkStatus(true)} disabled={checking}>
              {checking ? 'Checking…' : "I've completed payment"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
